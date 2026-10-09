-- 0089_regnskap_salg.sql
-- Fakturaene og innbetalingene bokføres av seg selv i regnskapet. Hver faktura og kreditnota får et
-- bilag i serie F (kundefordringen mot salgsinntekten og den utgående avgiften per mva-sats, med
-- mva-koden fra Skatteetatens standard mva-koder for SAF-T), og hver innbetaling og refusjon et
-- bilag i serie B (banken mot kundefordringen; det som er betalt utover fakturaen, er purregebyret
-- så langt fakturaen er purret med gebyr). Posteringene regnes i API-et
-- (server/src/salgBokforing.ts), og databasen kontrollerer dem. Workeren bokfører det som mangler
-- hvert minutt (og regnskapet gjør det når det vises), og en faktura eller betaling som er slettet,
-- får bilaget reversert. Det som er fra før startdatoen (regnskap_oppsett.salg_fra), bokføres ikke:
-- det hører til den inngående balansen (flyttes datoen fram, reverseres det som er bokført før den,
-- og flyttes den tilbake, bokføres det på nytt).

alter table faktura.bilag drop constraint bilag_kilde_check;
alter table faktura.bilag add constraint bilag_kilde_check
  check (kilde in ('lonn', 'nav_refusjon', 'anlegg', 'periodisering', 'manuell', 'faktura', 'innbetaling'));
drop policy bilag_les on faktura.bilag;
create policy bilag_les on faktura.bilag for select
  using ((kilde in ('lonn', 'nav_refusjon') and faktura.kan(org_id, 'personal_les'))
         or (kilde in ('anlegg', 'periodisering', 'manuell', 'faktura', 'innbetaling') and faktura.kan(org_id, 'regnskap')));
-- Bilaget for en faktura eller betaling (også de reverserte), så det som mangler, finnes raskt.
create index bilag_kilde_id on faktura.bilag (kilde_id) where kilde_id is not null;

-- mva_kode: koden fra Skatteetatens standard mva-koder (SAF-T): 3, 31, 32 og 33 for salg med
-- utgående avgift (høy, middels, råfisk og lav sats), 5 for salg fritatt for avgift og 6 for salg
-- utenfor merverdiavgiftsloven. Står både på inntekten (grunnlaget) og på avgiften.
alter table faktura.posteringer add column mva_kode text check (mva_kode is null or mva_kode ~ '^[0-9]{1,2}$');

-- En reversering får mva-kodene fra bilaget den reverserer (så grunnlaget og avgiften går i null
-- også per kode).
create or replace function faktura.reverser_bilag(_bilag uuid, _tekst text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b faktura.bilag;
  ny uuid;
begin
  select * into b from faktura.bilag where id = _bilag for update;
  if b.id is null or b.reverserer is not null or b.reversert_av is not null then
    raise exception 'Bilaget kan ikke reverseres' using errcode = 'FA409';
  end if;
  insert into faktura.bilag (org_id, serie, aar, nummer, dato, tekst, kilde, kilde_id, reverserer)
  values (b.org_id, b.serie, b.aar, faktura.neste_bilagsnummer(b.org_id, b.serie, b.aar), b.dato, left(_tekst, 300), b.kilde, b.kilde_id, b.id)
  returning id into ny;
  insert into faktura.posteringer (org_id, bilag_id, rekke, konto, belop, tekst, mva_kode)
  select p.org_id, ny, p.rekke, p.konto, -p.belop, p.tekst, p.mva_kode from faktura.posteringer p where p.bilag_id = b.id;
  update faktura.bilag set reversert_av = ny where id = b.id;
  return ny;
end $$;
revoke execute on function faktura.reverser_bilag(uuid, text) from public;

-- salg_fra: fakturaene (fakturadatoen) og innbetalingene (betalingsdatoen) fra og med denne datoen
-- bokføres (null: alle). uten_mva: salg uten avgift for den som er mva-registrert: unntatt
-- (utenfor merverdiavgiftsloven, f.eks. helsetjenester: 3200 og kode 6) eller fritatt (3100 og kode 5).
alter table faktura.regnskap_oppsett
  add column salg_fra date,
  add column uten_mva text not null default 'unntatt' check (uten_mva in ('unntatt', 'fritatt'));
grant insert (salg_fra, uten_mva), update (salg_fra, uten_mva) on faktura.regnskap_oppsett to faktura_app;

-- Organisasjonene som alt har fakturaer, får fakturaene og innbetalingene fra og med 1. januar i år
-- bokført (det som er fra før, hører til den inngående balansen); de kan velge en annen dato.
alter table faktura.regnskap_oppsett disable trigger regnskap_oppsett_revisjon;
insert into faktura.regnskap_oppsett (org_id, salg_fra)
select o.id, date_trunc('year', faktura.i_dag())::date
  from faktura.organisasjoner o
 where exists (select 1 from faktura.fakturaer f where f.org_id = o.id and f.status <> 'utkast')
on conflict (org_id) do update set salg_fra = excluded.salg_fra;
alter table faktura.regnskap_oppsett enable trigger regnskap_oppsett_revisjon;

-- Fører bilaget for en faktura eller kreditnota (serie F, på fakturadatoen) eller en innbetaling
-- eller refusjon (serie B, på betalingsdatoen), én gang (ett gjeldende bilag; er det reversert fordi
-- startdatoen ble flyttet fram, kan det føres på nytt). _posteringer: [{konto, belop, tekst,
-- mva_kode}], minst to som går i null, med kundefordringen (fakturaens sum) eller banken
-- (betalingens beløp) på én linje.
create function faktura.bokfor_salg(_org uuid, _kilde text, _kilde_id uuid, _dato date, _tekst text, _posteringer jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  f faktura.fakturaer;
  p faktura.betalinger;
  belop numeric(14,2);
  serie text;
  fra date;
  b uuid;
begin
  perform faktura.krev(_org, 'regnskap');
  select salg_fra into fra from faktura.regnskap_oppsett where org_id = _org;
  if fra is not null and _dato < fra then
    raise exception 'Det er fra før startdatoen for salget i regnskapet' using errcode = 'FA409';
  end if;
  if _kilde = 'faktura' then
    select * into f from faktura.fakturaer where org_id = _org and id = _kilde_id;
    if f.id is null then raise exception 'Fant ikke fakturaen' using errcode = 'FA404'; end if;
    if f.status = 'utkast' then raise exception 'Fakturaen er ikke utstedt' using errcode = 'FA409'; end if;
    if _dato is distinct from f.fakturadato then
      raise exception 'Bilaget for faktura % skal ha fakturadatoen', f.fakturanummer using errcode = 'FA400';
    end if;
    belop := f.sum_inkl_mva;
    serie := 'F';
  elsif _kilde = 'innbetaling' then
    select * into p from faktura.betalinger where org_id = _org and id = _kilde_id;
    if p.id is null then raise exception 'Fant ikke betalingen' using errcode = 'FA404'; end if;
    if _dato is distinct from p.betalt_dato then
      raise exception 'Bilaget for en betaling skal ha betalingsdatoen' using errcode = 'FA400';
    end if;
    belop := p.belop;
    serie := 'B';
  else
    raise exception 'Ukjent kilde for bilaget' using errcode = 'FA400';
  end if;
  if exists (select 1 from faktura.bilag where org_id = _org and kilde = _kilde and kilde_id = _kilde_id
                and reverserer is null and reversert_av is null) then
    raise exception 'Det er alt bokført' using errcode = 'FA409';
  end if;
  if length(btrim(coalesce(_tekst, ''))) = 0 then
    raise exception 'Bilaget mangler tekst' using errcode = 'FA400';
  end if;
  if jsonb_typeof(_posteringer) <> 'array' or jsonb_array_length(_posteringer) < 2 or jsonb_array_length(_posteringer) > 100 then
    raise exception 'Bilaget må ha minst to linjer' using errcode = 'FA400';
  end if;
  if exists (select 1 from jsonb_array_elements(_posteringer) x where coalesce((x->>'belop')::numeric(14,2), 0) = 0) then
    raise exception 'En linje i bilaget er på 0 kr' using errcode = 'FA400';
  end if;
  if (select sum((x->>'belop')::numeric(14,2)) from jsonb_array_elements(_posteringer) x) <> 0 then
    raise exception 'Bilaget går ikke i null' using errcode = 'FA400';
  end if;
  if not exists (select 1 from jsonb_array_elements(_posteringer) x where (x->>'belop')::numeric(14,2) = belop) then
    raise exception 'Bilaget har ingen linje på % kr', belop using errcode = 'FA400';
  end if;
  insert into faktura.bilag (org_id, serie, aar, nummer, dato, tekst, kilde, kilde_id)
  values (_org, serie, extract(year from _dato)::int, faktura.neste_bilagsnummer(_org, serie, extract(year from _dato)::int), _dato,
          left(btrim(_tekst), 300), _kilde, _kilde_id)
  returning id into b;
  insert into faktura.posteringer (org_id, bilag_id, rekke, konto, belop, tekst, mva_kode)
  select _org, b, y.n, y.x->>'konto', (y.x->>'belop')::numeric(14,2), left(nullif(btrim(y.x->>'tekst'), ''), 200), nullif(y.x->>'mva_kode', '')
    from jsonb_array_elements(_posteringer) with ordinality as y(x, n);
  return b;
end $$;

-- Reverserer bilaget for en faktura eller betaling som er slettet, eller som er fra før startdatoen
-- (på datoen bilaget har). Ellers rettes en faktura med en kreditnota, og en betaling tas bort fra
-- fakturaen.
create function faktura.reverser_salg(_org uuid, _bilag uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b faktura.bilag;
  fra date;
  grunn text;
begin
  perform faktura.krev(_org, 'regnskap');
  select * into b from faktura.bilag where org_id = _org and id = _bilag and kilde in ('faktura', 'innbetaling') for update;
  if b.id is null then raise exception 'Fant ikke bilaget' using errcode = 'FA404'; end if;
  select salg_fra into fra from faktura.regnskap_oppsett where org_id = _org;
  if fra is not null and b.dato < fra then
    grunn := 'Reversert, fra før startdatoen for salget: ';
  elsif b.kilde = 'faktura' and exists (select 1 from faktura.fakturaer where org_id = _org and id = b.kilde_id) then
    raise exception 'Fakturaen finnes: rett den med en kreditnota' using errcode = 'FA409';
  elsif b.kilde = 'innbetaling' and exists (select 1 from faktura.betalinger where org_id = _org and id = b.kilde_id) then
    raise exception 'Betalingen finnes: ta den bort fra fakturaen' using errcode = 'FA409';
  else
    grunn := case when b.kilde = 'faktura' then 'Reversert, fakturaen er slettet: ' else 'Reversert, betalingen er tatt bort: ' end;
  end if;
  return faktura.reverser_bilag(_bilag, grunn || b.tekst);
end $$;

revoke execute on function faktura.bokfor_salg(uuid, text, uuid, date, text, jsonb), faktura.reverser_salg(uuid, uuid) from public;
grant execute on function faktura.bokfor_salg(uuid, text, uuid, date, text, jsonb), faktura.reverser_salg(uuid, uuid) to faktura_app;
