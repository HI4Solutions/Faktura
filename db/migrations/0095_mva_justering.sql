-- 0095_mva_justering.sql
-- Justering av inngående merverdiavgift for kapitalvarer (merverdiavgiftsloven kapittel 9,
-- server/src/mvaJustering.ts).
--
-- En kapitalvare er et anleggsmiddel der den inngående avgiften på kostprisen er minst 50 000 kr
-- (maskiner, inventar og andre driftsmidler) eller 100 000 kr (fast eiendom: ny-, på- og ombygging).
-- Endres bruken i justeringsperioden (fem år for løsøre, ti for fast eiendom, med det første året),
-- så fradragsprosenten blir minst ti prosentpoeng høyere eller lavere enn ved anskaffelsen, justeres
-- en femdel (en tidel) av avgiften ganger endringen, i den siste terminen i året. Ved salg i perioden
-- justeres resten av perioden samlet, i terminen for salget.
--
-- Justeringen føres i serie V (kilde mva_justering): den inngående avgiften (kode 1, som i
-- mva-meldingen står med spesifikasjonen «justering») mot kostnadskontoen for justeringen, eller mot
-- gevinst eller tap ved salget. For året er bilaget knyttet til raden i mva_justeringer (ett gjeldende
-- per år); den samlede justeringen ved salg til anleggsmiddelet (ett gjeldende). Linjene per
-- anleggsmiddel står i mva_justeringslinjer.

-- ---------------------------------------------------------------------------
-- Kapitalvarene: avgiften og fradraget ved anskaffelsen, og bruken
-- ---------------------------------------------------------------------------

-- Fradragsprosenten per år når kapitalvaren har sin egen bruk: {"2027": 40, ...}.
create function faktura.mva_bruk_gyldig(_b jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(_b) = 'object'
     and not exists (select 1 from jsonb_each(_b) e
                      where e.key !~ '^(20[0-9]{2}|2100)$' or jsonb_typeof(e.value) <> 'number'
                         or (e.value #>> '{}')::numeric < 0 or (e.value #>> '{}')::numeric > 100)
$$;

-- mva_inngaende: den inngående avgiften på kostprisen (hele, også det som ikke ble trukket fra);
-- mva_fradrag: fradragsprosenten ved anskaffelsen; mva_felles: bruken følger fradragsprosenten for
-- fellesanskaffelser hvert år (ellers egen prosent per år i mva_bruk, som gjelder til den endres).
alter table faktura.anleggsmidler
  add column mva_inngaende numeric(14,2) check (mva_inngaende is null or (mva_inngaende > 0 and mva_inngaende < 1000000000000)),
  add column mva_fradrag numeric(5,2) check (mva_fradrag is null or mva_fradrag between 0 and 100),
  add column mva_felles boolean not null default true,
  add column mva_bruk jsonb not null default '{}' check (faktura.mva_bruk_gyldig(mva_bruk)),
  add constraint anleggsmidler_mva_check check ((mva_inngaende is null) = (mva_fradrag is null));
grant insert (mva_inngaende, mva_fradrag, mva_felles, mva_bruk), update (mva_inngaende, mva_fradrag, mva_felles, mva_bruk)
  on faktura.anleggsmidler to faktura_app;

-- Som før, og: avgiften, fradraget og bruken kan ikke endres etter salg eller utrangering (den samlede
-- justeringen er regnet av dem), og et anleggsmiddel med en bokført mva-justering slettes ikke.
create or replace function faktura.anleggsmidler_foer() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  bokfort boolean;
begin
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('anleggsmidler:' || new.org_id::text, 0));
    new.nummer := coalesce((select max(nummer) from faktura.anleggsmidler where org_id = new.org_id), 0) + 1;
    return new;
  end if;
  bokfort := exists (select 1 from faktura.anleggshendelser where anleggsmiddel_id = old.id and not reversert);
  if tg_op = 'DELETE' then
    if bokfort then
      raise exception 'Anleggsmiddelet har bokførte bilag. Reverser dem først, eller registrer salg eller utrangering.' using errcode = 'FA409';
    end if;
    if exists (select 1 from faktura.mva_justeringslinjer l join faktura.bilag b on b.id = l.bilag_id
                where l.anleggsmiddel_id = old.id and b.reverserer is null and b.reversert_av is null) then
      raise exception 'Anleggsmiddelet har en bokført mva-justering. Angre den først (Regnskap → Mva).' using errcode = 'FA409';
    end if;
    return old;
  end if;
  new.nummer := old.nummer;
  if bokfort and (new.kategori, new.kostpris, new.anskaffet, new.avskrives_fra, new.konto, new.tidligere_til, new.tidligere_avskrevet)
                 is distinct from (old.kategori, old.kostpris, old.anskaffet, old.avskrives_fra, old.konto, old.tidligere_til, old.tidligere_avskrevet) then
    raise exception 'Anleggsmiddelet har bokførte bilag: kategorien, kostprisen, datoene og kontoen kan ikke endres. Reverser bilagene først, eller bruk nedskrivning.'
      using errcode = 'FA409';
  end if;
  if old.avgang_dato is not null and new.avgang_dato is not null
     and (new.levetid_mnd, new.restverdi, new.avskrivningskonto, new.mva_inngaende, new.mva_fradrag, new.mva_felles, new.mva_bruk)
         is distinct from (old.levetid_mnd, old.restverdi, old.avskrivningskonto, old.mva_inngaende, old.mva_fradrag, old.mva_felles, old.mva_bruk) then
    raise exception 'Anleggsmiddelet er solgt eller utrangert' using errcode = 'FA409';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Bilagene: serie V, kilde mva_justering
-- ---------------------------------------------------------------------------

alter table faktura.bilag drop constraint bilag_kilde_check;
alter table faktura.bilag add constraint bilag_kilde_check
  check (kilde in ('lonn', 'nav_refusjon', 'anlegg', 'periodisering', 'manuell', 'faktura', 'innbetaling', 'utgift', 'utgift_betaling', 'bank', 'mva',
                   'aarsoppgjor', 'mva_justering'));
drop policy bilag_les on faktura.bilag;
create policy bilag_les on faktura.bilag for select
  using ((kilde in ('lonn', 'nav_refusjon') and faktura.kan(org_id, 'personal_les'))
         or (kilde in ('anlegg', 'periodisering', 'manuell', 'faktura', 'innbetaling', 'utgift', 'utgift_betaling', 'bank', 'mva', 'aarsoppgjor',
                       'mva_justering')
             and faktura.kan(org_id, 'regnskap')));

-- Året: fradragsprosenten for fellesanskaffelser når den er satt (null: regnet fra omsetningen i
-- året). Justeringen for året er bilaget med kilde mva_justering og kilde_id lik raden.
create table faktura.mva_justeringer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  aar int not null check (aar between 2000 and 2100),
  fradrag numeric(5,2) check (fradrag is null or fradrag between 0 and 100),
  oppdatert timestamptz not null default now(),
  unique (org_id, aar),
  unique (org_id, id)
);
alter table faktura.mva_justeringer enable row level security;
create policy mva_justeringer_les on faktura.mva_justeringer for select using (faktura.kan(org_id, 'regnskap'));
create policy mva_justeringer_ny on faktura.mva_justeringer for insert with check (faktura.kan(org_id, 'regnskap'));
create policy mva_justeringer_endre on faktura.mva_justeringer for update using (faktura.kan(org_id, 'regnskap')) with check (faktura.kan(org_id, 'regnskap'));
grant select on faktura.mva_justeringer to faktura_app;
grant insert (org_id, aar, fradrag), update (fradrag, oppdatert) on faktura.mva_justeringer to faktura_app;
create trigger mva_justeringer_org_id before update on faktura.mva_justeringer
  for each row execute function faktura.org_id_uendret();
create trigger mva_justeringer_revisjon after insert or update or delete on faktura.mva_justeringer
  for each row execute function faktura.revider();

-- Linjene i et justeringsbilag: anleggsmiddelet, årene (samlet justering: fra salgsåret til slutten
-- av perioden), fradragsprosenten og beløpet (positivt: mer fradrag). Gjelder så lenge bilaget ikke
-- er reversert.
create table faktura.mva_justeringslinjer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  bilag_id uuid not null,
  anleggsmiddel_id uuid not null,
  aar int not null check (aar between 2000 and 2100),
  aar_til int not null,
  fradrag numeric(5,2) not null check (fradrag between 0 and 100),
  belop numeric(14,2) not null check (belop <> 0),
  foreign key (org_id, bilag_id) references faktura.bilag(org_id, id),
  foreign key (org_id, anleggsmiddel_id) references faktura.anleggsmidler(org_id, id) on delete cascade,
  check (aar_til >= aar)
);
create index mva_justeringslinjer_bilag on faktura.mva_justeringslinjer (bilag_id);
create index mva_justeringslinjer_anlegg on faktura.mva_justeringslinjer (anleggsmiddel_id, aar);
alter table faktura.mva_justeringslinjer enable row level security;
create policy mva_justeringslinjer_les on faktura.mva_justeringslinjer for select using (faktura.kan(org_id, 'regnskap') or faktura.er_system());
grant select on faktura.mva_justeringslinjer to faktura_app, faktura_system;
grant select on faktura.mva_justeringer to faktura_system;

-- Fører justeringen (serie V, kilde mva_justering) og reverserer den gjeldende først (endret):
--  - for året (_anleggsmiddel null): den 31. desember; året må være over og ikke låst;
--  - samlet ved salg (_anleggsmiddel): på salgsdatoen; anleggsmiddelet må være solgt i året.
-- Posteringene regnes i API-et og workeren (mvaJustering.ts): den inngående avgiften med mva-koden
-- mot kostnadskontoen (eller gevinst og tap). _linjer: [{anleggsmiddel_id, aar, aar_til, fradrag,
-- belop}], som til sammen er avgiften i posteringene med mva-kode.
create function faktura.bokfor_mva_justering(_org uuid, _aar int, _anleggsmiddel uuid, _tekst text, _posteringer jsonb, _linjer jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  a faktura.anleggsmidler;
  ref uuid;
  dato date;
  gammelt uuid;
  b uuid;
begin
  perform faktura.krev(_org, 'regnskap');
  if _aar is null or _aar not between 2000 and 2100 then raise exception 'Ugyldig år' using errcode = 'FA400'; end if;
  if _anleggsmiddel is null then
    dato := make_date(_aar, 12, 31);
    if dato >= faktura.i_dag() then raise exception 'Året er ikke over' using errcode = 'FA409'; end if;
    if coalesce((select o.laast_til from faktura.regnskap_oppsett o where o.org_id = _org), '-infinity') >= dato then
      raise exception 'Året er låst; lås det opp først' using errcode = 'FA409';
    end if;
    insert into faktura.mva_justeringer (org_id, aar) values (_org, _aar) on conflict (org_id, aar) do nothing;
    select id into ref from faktura.mva_justeringer where org_id = _org and aar = _aar;
  else
    select * into a from faktura.anleggsmidler where org_id = _org and id = _anleggsmiddel for update;
    if a.id is null then raise exception 'Fant ikke anleggsmiddelet' using errcode = 'FA404'; end if;
    if a.avgang_dato is null or extract(year from a.avgang_dato)::int <> _aar then
      raise exception 'Anleggsmiddelet er ikke solgt i %', _aar using errcode = 'FA409';
    end if;
    dato := a.avgang_dato;
    ref := a.id;
  end if;
  if length(btrim(coalesce(_tekst, ''))) = 0 then raise exception 'Bilaget mangler tekst' using errcode = 'FA400'; end if;
  if jsonb_typeof(_posteringer) <> 'array' or jsonb_array_length(_posteringer) not between 2 and 400 then
    raise exception 'Bilaget må ha minst to linjer' using errcode = 'FA400';
  end if;
  if exists (select 1 from jsonb_array_elements(_posteringer) x
              where coalesce(x ->> 'konto', '') !~ '^[0-9]{4,6}$' or coalesce((x ->> 'belop')::numeric(14,2), 0) = 0) then
    raise exception 'Hver linje må ha en konto og et beløp' using errcode = 'FA400';
  end if;
  if (select sum((x ->> 'belop')::numeric(14,2)) from jsonb_array_elements(_posteringer) x) <> 0 then
    raise exception 'Bilaget går ikke i null' using errcode = 'FA400';
  end if;
  if jsonb_typeof(_linjer) <> 'array' or jsonb_array_length(_linjer) = 0 or jsonb_array_length(_linjer) > 200 then
    raise exception 'Bilaget mangler kapitalvarer' using errcode = 'FA400';
  end if;
  if exists (select 1 from jsonb_array_elements(_linjer) x
               left join faktura.anleggsmidler y on y.org_id = _org and y.id = (x ->> 'anleggsmiddel_id')::uuid
              where y.id is null or y.mva_inngaende is null or coalesce((x ->> 'belop')::numeric(14,2), 0) = 0
                 or coalesce((x ->> 'fradrag')::numeric, -1) not between 0 and 100
                 or (x ->> 'aar')::int is distinct from _aar or coalesce((x ->> 'aar_til')::int, 0) < _aar
                 or (_anleggsmiddel is null and (x ->> 'aar_til')::int <> _aar)
                 or (_anleggsmiddel is not null and y.id <> _anleggsmiddel)) then
    raise exception 'Ugyldig linje for en kapitalvare' using errcode = 'FA400';
  end if;
  if (select sum((x ->> 'belop')::numeric(14,2)) from jsonb_array_elements(_linjer) x)
     <> (select coalesce(sum((x ->> 'belop')::numeric(14,2)), 0) from jsonb_array_elements(_posteringer) x where nullif(x ->> 'mva_kode', '') is not null) then
    raise exception 'Kapitalvarene stemmer ikke med avgiften i bilaget' using errcode = 'FA400';
  end if;
  select id into gammelt from faktura.bilag
   where org_id = _org and kilde = 'mva_justering' and kilde_id = ref and reverserer is null and reversert_av is null
   for update;
  if gammelt is not null then
    perform faktura.reverser_bilag(gammelt, 'Reversert, justeringen er endret: ' || (select tekst from faktura.bilag where id = gammelt));
  end if;
  insert into faktura.bilag (org_id, serie, aar, nummer, dato, tekst, kilde, kilde_id)
  values (_org, 'V', extract(year from dato)::int, faktura.neste_bilagsnummer(_org, 'V', extract(year from dato)::int), dato,
          left(btrim(_tekst), 300), 'mva_justering', ref)
  returning id into b;
  insert into faktura.posteringer (org_id, bilag_id, rekke, konto, belop, tekst, mva_kode)
  select _org, b, y.n, y.x ->> 'konto', (y.x ->> 'belop')::numeric(14,2), left(nullif(btrim(y.x ->> 'tekst'), ''), 200), nullif(y.x ->> 'mva_kode', '')
    from jsonb_array_elements(_posteringer) with ordinality as y(x, n);
  insert into faktura.mva_justeringslinjer (org_id, bilag_id, anleggsmiddel_id, aar, aar_til, fradrag, belop)
  select _org, b, (x ->> 'anleggsmiddel_id')::uuid, (x ->> 'aar')::int, (x ->> 'aar_til')::int, (x ->> 'fradrag')::numeric(5,2), (x ->> 'belop')::numeric(14,2)
    from jsonb_array_elements(_linjer) x;
  return b;
end $$;

-- Angrer justeringen for året (når året ikke er låst) eller den samlede justeringen ved salget av
-- anleggsmiddelet (reverserer den gjeldende).
create function faktura.angre_mva_justering(_org uuid, _aar int, _anleggsmiddel uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  ref uuid;
  gammelt uuid;
begin
  perform faktura.krev(_org, 'regnskap');
  if _anleggsmiddel is null then
    if coalesce((select o.laast_til from faktura.regnskap_oppsett o where o.org_id = _org), '-infinity') >= make_date(_aar, 12, 31) then
      raise exception 'Året er låst; lås det opp først' using errcode = 'FA409';
    end if;
    select id into ref from faktura.mva_justeringer where org_id = _org and aar = _aar;
  else
    select id into ref from faktura.anleggsmidler where org_id = _org and id = _anleggsmiddel;
  end if;
  select id into gammelt from faktura.bilag
   where org_id = _org and kilde = 'mva_justering' and kilde_id = ref and reverserer is null and reversert_av is null
   for update;
  if gammelt is null then raise exception 'Justeringen er ikke bokført' using errcode = 'FA409'; end if;
  return faktura.reverser_bilag(gammelt, 'Reversert, justeringen er angret: ' || (select tekst from faktura.bilag where id = gammelt));
end $$;

revoke execute on function faktura.bokfor_mva_justering(uuid, int, uuid, text, jsonb, jsonb), faktura.angre_mva_justering(uuid, int, uuid) from public;
grant execute on function faktura.bokfor_mva_justering(uuid, int, uuid, text, jsonb, jsonb), faktura.angre_mva_justering(uuid, int, uuid) to faktura_app;

-- Som før, og: når salget reverseres, reverseres også den samlede mva-justeringen ved salget.
create or replace function faktura.reverser_anlegg(_org uuid, _bilag uuid, _tekst text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b faktura.bilag;
  ny uuid;
  h faktura.anleggshendelser;
  nr int;
  j uuid;
begin
  perform faktura.krev(_org, 'regnskap');
  select * into b from faktura.bilag where org_id = _org and id = _bilag and kilde = 'anlegg' for update;
  if b.id is null then raise exception 'Fant ikke bilaget' using errcode = 'FA404'; end if;
  if b.reverserer is not null or b.reversert_av is not null then
    raise exception 'Bilaget er reversert eller en reversering' using errcode = 'FA409';
  end if;
  for h in select * from faktura.anleggshendelser where bilag_id = _bilag and not reversert loop
    if exists (select 1 from faktura.anleggshendelser x join faktura.bilag xb on xb.id = x.bilag_id
                where x.anleggsmiddel_id = h.anleggsmiddel_id and not x.reversert and x.bilag_id <> _bilag
                  and (h.type = 'anskaffelse' or x.dato > h.dato
                       or (x.dato = h.dato and (xb.aar, xb.nummer) > (b.aar, b.nummer))
                       or (x.type = 'avskrivning' and h.type = 'avskrivning' and x.maaned > h.maaned))) then
      select nummer into nr from faktura.anleggsmidler where id = h.anleggsmiddel_id;
      raise exception 'Anleggsmiddel % har senere bokføringer. Reverser dem først.', nr using errcode = 'FA409';
    end if;
  end loop;
  ny := faktura.reverser_bilag(_bilag, coalesce(nullif(btrim(_tekst), ''), 'Reversert: ' || b.tekst));
  for j in select x.id from faktura.bilag x
            where x.org_id = _org and x.kilde = 'mva_justering' and x.reverserer is null and x.reversert_av is null
              and x.kilde_id in (select anleggsmiddel_id from faktura.anleggshendelser where bilag_id = _bilag and type = 'avgang' and not reversert) loop
    perform faktura.reverser_bilag(j, 'Reversert, salget er reversert: ' || (select tekst from faktura.bilag where id = j));
  end loop;
  update faktura.anleggsmidler a set avgang_dato = null, avgang_type = null, avgang_vederlag = null
   where a.id in (select anleggsmiddel_id from faktura.anleggshendelser where bilag_id = _bilag and type = 'avgang' and not reversert);
  update faktura.anleggshendelser set reversert = true where bilag_id = _bilag;
  return ny;
end $$;

-- ---------------------------------------------------------------------------
-- Revisjonsloggen
-- ---------------------------------------------------------------------------

drop policy revisjonslogg_les on faktura.revisjonslogg;
create policy revisjonslogg_les on faktura.revisjonslogg for select
  using (faktura.kan(org_id, 'les')
         and (coalesce(tabell, '') not in ('ansatte', 'ansatt_tillegg', 'fravaer', 'arbeidsplaner', 'ferie_overforinger', 'vaktbytter',
                                           'lonnskjoringer', 'lonn_inngaende', 'timebank_poster', 'avspasering_soknader',
                                           'ameldinger', 'bilag', 'lonnsendringer', 'nav_inntektsmeldinger', 'lonnstrekk',
                                           'naturalytelser', 'reiseregninger', 'nav_refusjoner')
              or faktura.kan(org_id, 'personal_les'))
         and (coalesce(tabell, '') not in ('anleggsmidler', 'regnskap_oppsett', 'saldo_satser', 'periodiseringer', 'utgifter', 'utgift_linjer',
                                           'bankregler', 'mva_terminer', 'aarsoppgjor', 'mva_justeringer')
              or faktura.kan(org_id, 'regnskap'))
         and (coalesce(tabell, '') not in ('fravaer', 'ferie_overforinger', 'avspasering_soknader', 'vaktbytter', 'nav_inntektsmeldinger',
                                           'nav_refusjoner')
              or faktura.kan(org_id, 'personal')));

-- ---------------------------------------------------------------------------
-- Kapitalvarene som alt er bokført fra utgifter
-- ---------------------------------------------------------------------------

-- Anleggsmidlene fra en utgift får avgiften og fradraget ved anskaffelsen fra linjene i utgiften
-- (tjenester fra utlandet: avgiften er 25 % av beløpet) når avgiften er over grensen.
alter table faktura.anleggsmidler disable trigger anleggsmidler_revisjon;
with avgift as (
  select u.org_id, u.anlegg_id,
         sum(case when u.utland then round(l.belop * 25 / 100, 2) else l.mva end) as mva,
         sum(case when u.utland then round(l.belop * 25 / 100, 2) else l.mva end * l.fradrag / 100) as fradrag
    from faktura.utgifter u join faktura.utgift_linjer l on l.utgift_id = u.id
   where u.anlegg_id is not null and u.status = 'bokfort'
   group by u.org_id, u.anlegg_id
)
update faktura.anleggsmidler a
   set mva_inngaende = x.mva,
       mva_fradrag = round(x.fradrag / x.mva * 100, 2),
       mva_felles = round(x.fradrag / x.mva * 100, 2) > 0 and round(x.fradrag / x.mva * 100, 2) < 100
  from avgift x
 where a.org_id = x.org_id and a.id = x.anlegg_id and a.mva_inngaende is null
   and a.kategori not in ('tomt', 'goodwill', 'personbil')
   and x.mva >= case when a.kategori in ('bygning', 'teknisk_installasjon') then 100000 else 50000 end;
alter table faktura.anleggsmidler enable trigger anleggsmidler_revisjon;
