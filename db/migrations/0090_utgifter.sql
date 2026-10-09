-- 0090_utgifter.sql
-- Utgiftene: leverandørfakturaer og kvitteringer (server/src/utgifter.ts). Fila lastes opp (eller tas
-- bilde av), AI leser den (aiUtgift.ts), og reglene vurderer hvordan den skal føres
-- (utgiftVurdering.ts): som kostnad, som anleggsmiddel (aktiveres og avskrives) eller periodisert
-- (forskuddsbetalt kostnad fordelt på månedene), med kontoen og fradraget for inngående mva. Den
-- bokføres når den godkjennes, eller av seg selv fra en kjent leverandør når alt stemmer: en
-- kostnad i bilagserie U, et anleggsmiddel med anskaffelsen i serie A og en periodisering med
-- starten i serie P. Det som ikke er betalt, står som leverandørgjeld til betalingen bokføres
-- (serie U). Posteringene regnes i API-et, og databasen kontrollerer dem.

alter table faktura.bilag drop constraint bilag_kilde_check;
alter table faktura.bilag add constraint bilag_kilde_check
  check (kilde in ('lonn', 'nav_refusjon', 'anlegg', 'periodisering', 'manuell', 'faktura', 'innbetaling', 'utgift', 'utgift_betaling'));
drop policy bilag_les on faktura.bilag;
create policy bilag_les on faktura.bilag for select
  using ((kilde in ('lonn', 'nav_refusjon') and faktura.kan(org_id, 'personal_les'))
         or (kilde in ('anlegg', 'periodisering', 'manuell', 'faktura', 'innbetaling', 'utgift', 'utgift_betaling') and faktura.kan(org_id, 'regnskap')));

-- mva_fradrag: prosenten av den inngående avgiften som trekkes fra (100: fullt; 0: ingen, f.eks. når
--   salget er utenfor merverdiavgiftsloven; imellom: forholdsmessig fradrag for fellesanskaffelser).
--   null: 100 for den som er mva-registrert, ellers 0.
-- periodiser_fra: en utgift som gjelder flere måneder, periodiseres når den er på minst så mye (uten
--   mva); mindre kostnadsføres med en gang.
-- utgifter_auto: en utgift fra en leverandør som er bokført før, bokføres av seg selv når alt stemmer.
alter table faktura.regnskap_oppsett
  add column mva_fradrag numeric(5,2) check (mva_fradrag is null or mva_fradrag between 0 and 100),
  add column periodiser_fra numeric(14,2) not null default 5000 check (periodiser_fra >= 0 and periodiser_fra < 1000000000),
  add column utgifter_auto boolean not null default true;
grant insert (mva_fradrag, periodiser_fra, utgifter_auto), update (mva_fradrag, periodiser_fra, utgifter_auto)
  on faktura.regnskap_oppsett to faktura_app;

-- ---------------------------------------------------------------------------
-- Utgiftene
-- ---------------------------------------------------------------------------

-- status: kladd (kan endres og slettes) eller bokfort (rettes ved å angre bokføringen).
-- type: faktura (leverandørfaktura) eller kvittering.
-- belop: det som skal betales (med mva). valuta: beløpene er i kroner; valutaen fakturaen var i.
-- betaling: ubetalt (leverandørgjeld til den betales), bank (betalt med kort eller fra banken),
--   kontant, eller ansatt (lagt ut av en ansatt: gjeld til den ansatte).
-- behandling: kostnad, anlegg (anleggsmiddel med kategori og levetid) eller periodisering
--   (forskuddsbetalt kostnad fra periode_fra over antall_maaneder).
-- vurdering: hvorfor den føres slik (reglene i utgiftVurdering.ts).
-- utland: tjenester kjøpt fra utlandet uten norsk mva (mottakeren beregner avgiften, snudd avregning).
-- fil_*: fila (filer-bøtta mens den er kladd); arkiv_sti: kopien i fakturabøtta (oppbevares) fra den
--   bokføres. ai: det AI leste. auto: bokført av seg selv.
create table faktura.utgifter (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  status text not null default 'kladd' check (status in ('kladd', 'bokfort')),
  type text not null default 'faktura' check (type in ('faktura', 'kvittering')),
  leverandor text check (leverandor is null or length(leverandor) <= 200),
  orgnr text check (orgnr is null or orgnr ~ '^[0-9]{9}$'),
  fakturanummer text check (fakturanummer is null or length(fakturanummer) <= 60),
  dato date,
  forfallsdato date,
  kid text check (kid is null or kid ~ '^[0-9]{2,25}$'),
  kontonr text check (kontonr is null or kontonr ~ '^[0-9]{11}$'),
  belop numeric(14,2) check (belop is null or (belop > 0 and belop < 1000000000000)),
  valuta text not null default 'NOK' check (valuta ~ '^[A-Z]{3}$'),
  beskrivelse text check (beskrivelse is null or length(beskrivelse) <= 500),
  betaling text not null default 'ubetalt' check (betaling in ('ubetalt', 'bank', 'kontant', 'ansatt')),
  betalt_dato date,
  behandling text not null default 'kostnad' check (behandling in ('kostnad', 'anlegg', 'periodisering')),
  anlegg_kategori text,
  levetid_mnd int check (levetid_mnd is null or levetid_mnd between 1 and 1200),
  periode_fra date check (periode_fra is null or periode_fra = date_trunc('month', periode_fra)::date),
  antall_maaneder int check (antall_maaneder is null or antall_maaneder between 1 and 120),
  vurdering text check (vurdering is null or length(vurdering) <= 1000),
  utland boolean not null default false,
  fil_sti text,
  fil_type text,
  fil_navn text check (fil_navn is null or length(fil_navn) <= 200),
  fil_storrelse int,
  arkiv_sti text,
  ai jsonb,
  auto boolean not null default false,
  bilag_id uuid,
  betaling_bilag_id uuid,
  anlegg_id uuid references faktura.anleggsmidler(id) on delete set null,
  periodisering_id uuid references faktura.periodiseringer(id) on delete set null,
  opprettet timestamptz not null default now(),
  opprettet_av uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null,
  bokfort_at timestamptz,
  bokfort_av uuid references faktura.brukere(id) on delete set null,
  unique (org_id, id),
  foreign key (org_id, bilag_id) references faktura.bilag(org_id, id),
  foreign key (org_id, betaling_bilag_id) references faktura.bilag(org_id, id),
  check (status = 'kladd' or (bilag_id is not null and dato is not null and belop is not null))
);
create index utgifter_org on faktura.utgifter (org_id, status, dato);
create index utgifter_orgnr on faktura.utgifter (org_id, orgnr) where orgnr is not null;
create trigger utgifter_revisjon after insert or update or delete on faktura.utgifter
  for each row execute function faktura.revider();

-- Linjene: konto, beløpet uten mva, satsen, avgiften og hvor mye av den som trekkes fra (prosent).
-- kategori: det AI mente det var (til kontoen leverandøren fikk sist for samme slags kjøp).
create table faktura.utgift_linjer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  utgift_id uuid not null,
  rekke int not null check (rekke between 1 and 100),
  beskrivelse text check (beskrivelse is null or length(beskrivelse) <= 200),
  kategori text check (kategori is null or kategori ~ '^[a-z_]{2,40}$'),
  konto text not null check (konto ~ '^[0-9]{4,6}$'),
  belop numeric(14,2) not null check (belop <> 0 and abs(belop) < 1000000000000),
  mva_sats numeric(5,2) not null default 0 check (mva_sats between 0 and 100),
  mva numeric(14,2) not null default 0 check (abs(mva) < 1000000000000),
  fradrag numeric(5,2) not null default 100 check (fradrag between 0 and 100),
  foreign key (org_id, utgift_id) references faktura.utgifter(org_id, id) on delete cascade,
  unique (utgift_id, rekke)
);
create trigger utgift_linjer_revisjon after insert or update or delete on faktura.utgift_linjer
  for each row execute function faktura.revider();

alter table faktura.utgifter enable row level security;
alter table faktura.utgift_linjer enable row level security;
create policy utgifter_les on faktura.utgifter for select using (faktura.kan(org_id, 'regnskap') or faktura.er_system());
create policy utgifter_ny on faktura.utgifter for insert with check (faktura.kan(org_id, 'regnskap'));
create policy utgifter_endre on faktura.utgifter for update using (faktura.kan(org_id, 'regnskap')) with check (faktura.kan(org_id, 'regnskap'));
create policy utgifter_slett on faktura.utgifter for delete using (faktura.kan(org_id, 'regnskap'));
create policy utgift_linjer_les on faktura.utgift_linjer for select using (faktura.kan(org_id, 'regnskap') or faktura.er_system());
create policy utgift_linjer_ny on faktura.utgift_linjer for insert with check (faktura.kan(org_id, 'regnskap'));
create policy utgift_linjer_endre on faktura.utgift_linjer for update using (faktura.kan(org_id, 'regnskap')) with check (faktura.kan(org_id, 'regnskap'));
create policy utgift_linjer_slett on faktura.utgift_linjer for delete using (faktura.kan(org_id, 'regnskap'));
grant select on faktura.utgifter, faktura.utgift_linjer to faktura_app, faktura_system;
-- Statusen, bilagene, arkivet og koblingene settes bare av funksjonene under.
grant insert (id, org_id, type, leverandor, orgnr, fakturanummer, dato, forfallsdato, kid, kontonr, belop, valuta, beskrivelse, betaling,
              behandling, anlegg_kategori, levetid_mnd, periode_fra, antall_maaneder, vurdering, utland,
              fil_sti, fil_type, fil_navn, fil_storrelse, ai),
      update (type, leverandor, orgnr, fakturanummer, dato, forfallsdato, kid, kontonr, belop, valuta, beskrivelse, betaling,
              behandling, anlegg_kategori, levetid_mnd, periode_fra, antall_maaneder, vurdering, utland, ai),
      delete
  on faktura.utgifter to faktura_app;
grant insert (org_id, utgift_id, rekke, beskrivelse, kategori, konto, belop, mva_sats, mva, fradrag),
      update (rekke, beskrivelse, kategori, konto, belop, mva_sats, mva, fradrag),
      delete
  on faktura.utgift_linjer to faktura_app;

-- En bokført utgift endres og slettes ikke (bokføringen angres først); funksjonene under endrer
-- statusen, bilagene og betalingen.
create function faktura.utgifter_foer() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'bokfort' then
      raise exception 'Utgiften er bokført. Angre bokføringen først.' using errcode = 'FA409';
    end if;
    return old;
  end if;
  if old.status = 'bokfort' and new.status = 'bokfort' and coalesce(current_setting('faktura.utgift_funksjon', true), '') <> 'on'
     and (new.type, new.leverandor, new.orgnr, new.fakturanummer, new.dato, new.forfallsdato, new.kid, new.kontonr, new.belop,
          new.valuta, new.beskrivelse, new.betaling, new.betalt_dato, new.behandling, new.anlegg_kategori, new.levetid_mnd,
          new.periode_fra, new.antall_maaneder, new.vurdering, new.utland, new.ai)
         is distinct from
         (old.type, old.leverandor, old.orgnr, old.fakturanummer, old.dato, old.forfallsdato, old.kid, old.kontonr, old.belop,
          old.valuta, old.beskrivelse, old.betaling, old.betalt_dato, old.behandling, old.anlegg_kategori, old.levetid_mnd,
          old.periode_fra, old.antall_maaneder, old.vurdering, old.utland, old.ai) then
    raise exception 'Utgiften er bokført. Angre bokføringen for å endre den.' using errcode = 'FA409';
  end if;
  return new;
end $$;
create trigger utgifter_foer before update or delete on faktura.utgifter
  for each row execute function faktura.utgifter_foer();

-- Linjene på en bokført utgift endres ikke (heller ikke ved å slette utgiften: den slettes ikke).
create function faktura.utgift_linjer_foer() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from faktura.utgifter where id = coalesce(new.utgift_id, old.utgift_id) and status = 'bokfort') then
    raise exception 'Utgiften er bokført. Angre bokføringen for å endre den.' using errcode = 'FA409';
  end if;
  return coalesce(new, old);
end $$;
create trigger utgift_linjer_foer before insert or update or delete on faktura.utgift_linjer
  for each row execute function faktura.utgift_linjer_foer();

-- Kontrollen av posteringene for et bilag fra en utgift: minst to linjer, ingen på 0, går i null,
-- og belop på én linje (leverandørgjelden, banken eller den ansatte i kredit, eller i debet for
-- betalingen).
create function faktura.utgift_posteringer_ok(_posteringer jsonb, _belop numeric) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(_posteringer) <> 'array' or jsonb_array_length(_posteringer) < 2 or jsonb_array_length(_posteringer) > 200 then
    raise exception 'Bilaget må ha minst to linjer' using errcode = 'FA400';
  end if;
  if exists (select 1 from jsonb_array_elements(_posteringer) x where coalesce((x->>'belop')::numeric(14,2), 0) = 0) then
    raise exception 'En linje i bilaget er på 0 kr' using errcode = 'FA400';
  end if;
  if (select sum((x->>'belop')::numeric(14,2)) from jsonb_array_elements(_posteringer) x) <> 0 then
    raise exception 'Bilaget går ikke i null' using errcode = 'FA400';
  end if;
  if not exists (select 1 from jsonb_array_elements(_posteringer) x where abs((x->>'belop')::numeric(14,2)) = _belop) then
    raise exception 'Bilaget har ingen linje på % kr', _belop using errcode = 'FA400';
  end if;
end $$;

-- Bokfører en utgift som kostnad (serie U, kilde utgift, på utgiftens dato).
create function faktura.bokfor_utgift(_org uuid, _utgift uuid, _tekst text, _posteringer jsonb, _auto boolean default false) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  u faktura.utgifter;
  b uuid;
begin
  perform faktura.krev(_org, 'regnskap');
  select * into u from faktura.utgifter where org_id = _org and id = _utgift for update;
  if u.id is null then raise exception 'Fant ikke utgiften' using errcode = 'FA404'; end if;
  if u.status <> 'kladd' then raise exception 'Utgiften er alt bokført' using errcode = 'FA409'; end if;
  if u.behandling <> 'kostnad' then raise exception 'Utgiften skal ikke føres som kostnad' using errcode = 'FA409'; end if;
  if u.dato is null or u.belop is null then raise exception 'Utgiften mangler dato eller beløp' using errcode = 'FA400'; end if;
  if u.dato > faktura.i_dag() then raise exception 'Datoen kan ikke være fram i tid' using errcode = 'FA400'; end if;
  if length(btrim(coalesce(_tekst, ''))) = 0 then raise exception 'Bilaget mangler tekst' using errcode = 'FA400'; end if;
  perform faktura.utgift_posteringer_ok(_posteringer, u.belop);
  insert into faktura.bilag (org_id, serie, aar, nummer, dato, tekst, kilde, kilde_id)
  values (_org, 'U', extract(year from u.dato)::int, faktura.neste_bilagsnummer(_org, 'U', extract(year from u.dato)::int), u.dato,
          left(btrim(_tekst), 300), 'utgift', u.id)
  returning id into b;
  insert into faktura.posteringer (org_id, bilag_id, rekke, konto, belop, tekst, mva_kode)
  select _org, b, y.n, y.x->>'konto', (y.x->>'belop')::numeric(14,2), left(nullif(btrim(y.x->>'tekst'), ''), 200), nullif(y.x->>'mva_kode', '')
    from jsonb_array_elements(_posteringer) with ordinality as y(x, n);
  perform pg_catalog.set_config('faktura.utgift_funksjon', 'on', true);
  update faktura.utgifter
     set status = 'bokfort', bilag_id = b, auto = coalesce(_auto, false), bokfort_at = now(), bokfort_av = faktura.bruker_id(),
         betalt_dato = case when betaling <> 'ubetalt' then dato end
   where id = u.id;
  perform pg_catalog.set_config('faktura.utgift_funksjon', 'off', true);
  return b;
end $$;

-- En utgift ført som anleggsmiddel eller periodisering: bilaget er alt ført (serie A eller P, i
-- samme transaksjon), og utgiften kobles til det.
create function faktura.koble_utgift(_org uuid, _utgift uuid, _bilag uuid, _anlegg uuid, _periodisering uuid, _auto boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare
  u faktura.utgifter;
  b faktura.bilag;
begin
  perform faktura.krev(_org, 'regnskap');
  select * into u from faktura.utgifter where org_id = _org and id = _utgift for update;
  if u.id is null then raise exception 'Fant ikke utgiften' using errcode = 'FA404'; end if;
  if u.status <> 'kladd' then raise exception 'Utgiften er alt bokført' using errcode = 'FA409'; end if;
  if u.dato is null or u.belop is null then raise exception 'Utgiften mangler dato eller beløp' using errcode = 'FA400'; end if;
  select * into b from faktura.bilag where org_id = _org and id = _bilag;
  if b.id is null or b.reverserer is not null or b.reversert_av is not null then
    raise exception 'Fant ikke bilaget' using errcode = 'FA404';
  end if;
  if u.behandling = 'anlegg' and not (b.kilde = 'anlegg' and _anlegg is not null and exists (
       select 1 from faktura.anleggshendelser h where h.bilag_id = b.id and h.anleggsmiddel_id = _anlegg and h.type = 'anskaffelse' and not h.reversert)) then
    raise exception 'Bilaget er ikke anskaffelsen av anleggsmiddelet' using errcode = 'FA400';
  end if;
  if u.behandling = 'periodisering' and not (b.kilde = 'periodisering' and _periodisering is not null and exists (
       select 1 from faktura.periodiseringsposter p where p.bilag_id = b.id and p.periodisering_id = _periodisering and p.type = 'start' and not p.reversert)) then
    raise exception 'Bilaget er ikke starten på periodiseringen' using errcode = 'FA400';
  end if;
  if u.behandling = 'kostnad' then raise exception 'Utgiften føres som kostnad' using errcode = 'FA409'; end if;
  if not exists (select 1 from faktura.posteringer p where p.bilag_id = b.id and abs(p.belop) = u.belop) then
    raise exception 'Bilaget har ingen linje på % kr', u.belop using errcode = 'FA400';
  end if;
  perform pg_catalog.set_config('faktura.utgift_funksjon', 'on', true);
  update faktura.utgifter
     set status = 'bokfort', bilag_id = b.id, anlegg_id = _anlegg, periodisering_id = _periodisering, auto = coalesce(_auto, false),
         bokfort_at = now(), bokfort_av = faktura.bruker_id(), betalt_dato = case when betaling <> 'ubetalt' then dato end
   where id = u.id;
  perform pg_catalog.set_config('faktura.utgift_funksjon', 'off', true);
end $$;

-- Betalingen av en bokført, ubetalt utgift (serie U, kilde utgift_betaling): leverandørgjelden mot
-- banken. betaling: bank eller kontant.
create function faktura.betal_utgift(_org uuid, _utgift uuid, _dato date, _betaling text, _tekst text, _posteringer jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  u faktura.utgifter;
  b uuid;
begin
  perform faktura.krev(_org, 'regnskap');
  select * into u from faktura.utgifter where org_id = _org and id = _utgift for update;
  if u.id is null then raise exception 'Fant ikke utgiften' using errcode = 'FA404'; end if;
  if u.status <> 'bokfort' then raise exception 'Utgiften er ikke bokført' using errcode = 'FA409'; end if;
  if u.betaling <> 'ubetalt' or u.betaling_bilag_id is not null then raise exception 'Utgiften er alt betalt' using errcode = 'FA409'; end if;
  if _betaling not in ('bank', 'kontant') then raise exception 'Ukjent betaling' using errcode = 'FA400'; end if;
  if _dato is null or _dato > faktura.i_dag() then raise exception 'Betalingsdatoen kan ikke være fram i tid' using errcode = 'FA400'; end if;
  if _dato < u.dato then raise exception 'Betalingsdatoen kan ikke være før utgiftens dato' using errcode = 'FA400'; end if;
  if length(btrim(coalesce(_tekst, ''))) = 0 then raise exception 'Bilaget mangler tekst' using errcode = 'FA400'; end if;
  perform faktura.utgift_posteringer_ok(_posteringer, u.belop);
  insert into faktura.bilag (org_id, serie, aar, nummer, dato, tekst, kilde, kilde_id)
  values (_org, 'U', extract(year from _dato)::int, faktura.neste_bilagsnummer(_org, 'U', extract(year from _dato)::int), _dato,
          left(btrim(_tekst), 300), 'utgift_betaling', u.id)
  returning id into b;
  insert into faktura.posteringer (org_id, bilag_id, rekke, konto, belop, tekst)
  select _org, b, y.n, y.x->>'konto', (y.x->>'belop')::numeric(14,2), left(nullif(btrim(y.x->>'tekst'), ''), 200)
    from jsonb_array_elements(_posteringer) with ordinality as y(x, n);
  perform pg_catalog.set_config('faktura.utgift_funksjon', 'on', true);
  update faktura.utgifter set betaling = _betaling, betalt_dato = _dato, betaling_bilag_id = b where id = u.id;
  perform pg_catalog.set_config('faktura.utgift_funksjon', 'off', true);
  return b;
end $$;

-- Angrer bokføringen: betalingen og kostnaden reverseres (anskaffelsen eller starten på
-- periodiseringen med de funksjonene, og anleggsmiddelet eller periodiseringen slettes), og
-- utgiften blir en kladd igjen.
create function faktura.angre_utgift(_org uuid, _utgift uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  u faktura.utgifter;
  betalt boolean;
begin
  perform faktura.krev(_org, 'regnskap');
  select * into u from faktura.utgifter where org_id = _org and id = _utgift for update;
  if u.id is null then raise exception 'Fant ikke utgiften' using errcode = 'FA404'; end if;
  if u.status <> 'bokfort' then raise exception 'Utgiften er ikke bokført' using errcode = 'FA409'; end if;
  betalt := u.betaling_bilag_id is not null;
  if betalt and exists (select 1 from faktura.bilag where id = u.betaling_bilag_id and reverserer is null and reversert_av is null) then
    perform faktura.reverser_bilag(u.betaling_bilag_id, 'Reversert, utgiften er angret: ' || (select tekst from faktura.bilag where id = u.betaling_bilag_id));
  end if;
  if u.behandling = 'anlegg' and u.anlegg_id is not null then
    perform faktura.reverser_anlegg(_org, u.bilag_id, 'Reversert, utgiften er angret: ' || (select tekst from faktura.bilag where id = u.bilag_id));
    delete from faktura.anleggsmidler where id = u.anlegg_id;
  elsif u.behandling = 'periodisering' and u.periodisering_id is not null then
    perform faktura.reverser_periodisering(_org, u.bilag_id, 'Reversert, utgiften er angret: ' || (select tekst from faktura.bilag where id = u.bilag_id));
    delete from faktura.periodiseringer where id = u.periodisering_id;
  elsif exists (select 1 from faktura.bilag where id = u.bilag_id and reverserer is null and reversert_av is null) then
    perform faktura.reverser_bilag(u.bilag_id, 'Reversert, utgiften er angret: ' || (select tekst from faktura.bilag where id = u.bilag_id));
  end if;
  perform pg_catalog.set_config('faktura.utgift_funksjon', 'on', true);
  update faktura.utgifter
     set status = 'kladd', bilag_id = null, betaling_bilag_id = null, anlegg_id = null, periodisering_id = null, auto = false,
         bokfort_at = null, bokfort_av = null, betaling = case when betalt then 'ubetalt' else betaling end,
         betalt_dato = null
   where id = u.id;
  perform pg_catalog.set_config('faktura.utgift_funksjon', 'off', true);
end $$;

-- Kopien av fila i fakturabøtta (oppbevares), når utgiften bokføres.
create function faktura.arkiver_utgift(_org uuid, _utgift uuid, _sti text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform faktura.krev(_org, 'regnskap');
  perform pg_catalog.set_config('faktura.utgift_funksjon', 'on', true);
  update faktura.utgifter set arkiv_sti = _sti where org_id = _org and id = _utgift and arkiv_sti is null;
  perform pg_catalog.set_config('faktura.utgift_funksjon', 'off', true);
end $$;

revoke execute on function faktura.utgift_posteringer_ok(jsonb, numeric), faktura.bokfor_utgift(uuid, uuid, text, jsonb, boolean),
  faktura.koble_utgift(uuid, uuid, uuid, uuid, uuid, boolean), faktura.betal_utgift(uuid, uuid, date, text, text, jsonb),
  faktura.angre_utgift(uuid, uuid), faktura.arkiver_utgift(uuid, uuid, text) from public;
grant execute on function faktura.bokfor_utgift(uuid, uuid, text, jsonb, boolean), faktura.koble_utgift(uuid, uuid, uuid, uuid, uuid, boolean),
  faktura.betal_utgift(uuid, uuid, date, text, text, jsonb), faktura.angre_utgift(uuid, uuid), faktura.arkiver_utgift(uuid, uuid, text)
  to faktura_app;

-- AI-lesingen av utgiftene telles i samme tak som de andre AI-funksjonene, for dem som fører regnskapet.
alter table faktura.ai_bruk drop constraint ai_bruk_funksjon_check;
alter table faktura.ai_bruk add constraint ai_bruk_funksjon_check check (funksjon in ('faktura', 'innbetaling', 'assistent', 'lonnsslipp', 'utgift'));
create or replace function faktura.ai_krev(_org uuid, _funksjon text) returns void
language plpgsql stable set search_path = '' as $$
begin
  perform faktura.krev(_org, case _funksjon when 'faktura' then 'skriv' when 'assistent' then 'medlem' when 'lonnsslipp' then 'personal'
                                            when 'utgift' then 'regnskap' else 'bokfor' end);
end $$;


-- Anleggsmidlene, periodiseringene og de manuelle bilagene tar med mva-koden på posteringene (fra
-- utgiftene og de manuelle bilagene), ellers som før (0086 og 0087).
create or replace function faktura.bokfor_anlegg(_org uuid, _dato date, _tekst text, _posteringer jsonb, _hendelser jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b uuid;
  h jsonb;
  a faktura.anleggsmidler;
  m date;
  rest numeric;
begin
  perform faktura.krev(_org, 'regnskap');
  if _dato is null or length(btrim(coalesce(_tekst, ''))) = 0 then
    raise exception 'Bilaget mangler dato eller tekst' using errcode = 'FA400';
  end if;
  if jsonb_typeof(_hendelser) <> 'array' or jsonb_array_length(_hendelser) = 0 or jsonb_typeof(_posteringer) <> 'array' then
    raise exception 'Bilaget mangler hendelser' using errcode = 'FA400';
  end if;
  if (select coalesce(sum((x->>'belop')::numeric(14,2)), 0) from jsonb_array_elements(_posteringer) x) <> 0 then
    raise exception 'Bilaget går ikke i null' using errcode = 'FA400';
  end if;
  insert into faktura.bilag (org_id, serie, aar, nummer, dato, tekst, kilde)
  values (_org, 'A', extract(year from _dato)::int, faktura.neste_bilagsnummer(_org, 'A', extract(year from _dato)::int), _dato, left(btrim(_tekst), 300), 'anlegg')
  returning id into b;
  insert into faktura.posteringer (org_id, bilag_id, rekke, konto, belop, tekst, mva_kode)
  select _org, b, p.n, p.x->>'konto', (p.x->>'belop')::numeric(14,2), left(nullif(btrim(p.x->>'tekst'), ''), 200), nullif(p.x->>'mva_kode', '')
    from jsonb_array_elements(_posteringer) with ordinality as p(x, n);

  for h in select * from jsonb_array_elements(_hendelser) loop
    select * into a from faktura.anleggsmidler where org_id = _org and id = (h->>'anleggsmiddel_id')::uuid for update;
    if a.id is null then raise exception 'Fant ikke anleggsmiddelet' using errcode = 'FA404'; end if;
    if a.avgang_dato is not null then
      raise exception 'Anleggsmiddel % er solgt eller utrangert', a.nummer using errcode = 'FA409';
    end if;
    m := (h->>'maaned')::date;
    case h->>'type'
      when 'avskrivning' then
        if a.levetid_mnd is null then raise exception 'Anleggsmiddel % avskrives ikke', a.nummer using errcode = 'FA409'; end if;
        if m is null or m < a.avskrives_fra or (a.tidligere_til is not null and m <= a.tidligere_til) then
          raise exception 'Anleggsmiddel % avskrives ikke for den måneden', a.nummer using errcode = 'FA409';
        end if;
        if exists (select 1 from faktura.anleggshendelser x where x.anleggsmiddel_id = a.id and not x.reversert
                     and x.type = 'avskrivning' and x.maaned >= m) then
          raise exception 'Avskrivningen for anleggsmiddel % er alt bokført for måneden (eller en senere)', a.nummer using errcode = 'FA409';
        end if;
      when 'nedskrivning' then null;
      when 'reversering' then
        if a.kategori = 'goodwill' then
          raise exception 'Nedskrivning av goodwill kan ikke reverseres' using errcode = 'FA409';
        end if;
        if (h->>'belop')::numeric > coalesce((select sum(case x.type when 'nedskrivning' then x.belop else -x.belop end)
                                                from faktura.anleggshendelser x
                                               where x.anleggsmiddel_id = a.id and not x.reversert and x.type in ('nedskrivning', 'reversering')), 0) then
          raise exception 'Reverseringen er større enn nedskrivningene' using errcode = 'FA409';
        end if;
      when 'anskaffelse' then
        if a.tidligere_til is not null then
          raise exception 'Anskaffelsen av anleggsmiddel % er ført i et annet system', a.nummer using errcode = 'FA409';
        end if;
        if (h->>'belop')::numeric <> a.kostpris then
          raise exception 'Anskaffelsen må være kostprisen' using errcode = 'FA400';
        end if;
      when 'avgang' then
        -- Den bokførte verdien går ut (etter avskrivningene som er bokført).
        rest := a.kostpris - a.tidligere_avskrevet
                - coalesce((select sum(case x.type when 'reversering' then -x.belop else x.belop end) from faktura.anleggshendelser x
                             where x.anleggsmiddel_id = a.id and not x.reversert and x.type in ('avskrivning', 'nedskrivning', 'reversering')), 0);
        if abs((h->>'belop')::numeric - rest) >= 0.005 then
          raise exception 'Den bokførte verdien av anleggsmiddel % er % kr', a.nummer, rest using errcode = 'FA409';
        end if;
        update faktura.anleggsmidler
           set avgang_dato = _dato, avgang_type = coalesce(h->>'avgang_type', 'salg'), avgang_vederlag = coalesce((h->>'vederlag')::numeric, 0)
         where id = a.id;
      else
        raise exception 'Ukjent hendelse' using errcode = 'FA400';
    end case;
    insert into faktura.anleggshendelser (org_id, anleggsmiddel_id, type, dato, maaned, belop, vederlag, tekst, bilag_id)
    values (_org, a.id, h->>'type',
            case when m is null or _dato between m and (m + interval '1 month - 1 day')::date then _dato
                 else (m + interval '1 month - 1 day')::date end, m,
            (h->>'belop')::numeric(14,2), case when h->>'type' = 'avgang' then coalesce((h->>'vederlag')::numeric(14,2), 0) end,
            left(nullif(btrim(h->>'tekst'), ''), 300), b);
  end loop;

  -- Verdien etter det som er bokført, blir ikke negativ.
  for a in select x.* from faktura.anleggsmidler x
            where x.org_id = _org and x.id in (select (y->>'anleggsmiddel_id')::uuid from jsonb_array_elements(_hendelser) y) loop
    rest := a.kostpris - a.tidligere_avskrevet
            - coalesce((select sum(case x.type when 'reversering' then -x.belop else x.belop end) from faktura.anleggshendelser x
                         where x.anleggsmiddel_id = a.id and not x.reversert and x.type in ('avskrivning', 'nedskrivning', 'reversering')), 0);
    if rest < 0 then
      raise exception 'Verdien av anleggsmiddel % blir negativ', a.nummer using errcode = 'FA409';
    end if;
  end loop;
  return b;
end $$;

create or replace function faktura.bokfor_periodisering(_org uuid, _dato date, _tekst text, _posteringer jsonb, _poster jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b uuid;
  x jsonb;
  p faktura.periodiseringer;
  m date;
begin
  perform faktura.krev(_org, 'regnskap');
  if _dato is null or length(btrim(coalesce(_tekst, ''))) = 0 then
    raise exception 'Bilaget mangler dato eller tekst' using errcode = 'FA400';
  end if;
  if jsonb_typeof(_poster) <> 'array' or jsonb_array_length(_poster) = 0 or jsonb_typeof(_posteringer) <> 'array' or jsonb_array_length(_posteringer) < 2 then
    raise exception 'Bilaget mangler posteringer' using errcode = 'FA400';
  end if;
  if (select sum((y->>'belop')::numeric(14,2)) from jsonb_array_elements(_posteringer) y) <> 0 then
    raise exception 'Bilaget går ikke i null' using errcode = 'FA400';
  end if;
  insert into faktura.bilag (org_id, serie, aar, nummer, dato, tekst, kilde)
  values (_org, 'P', extract(year from _dato)::int, faktura.neste_bilagsnummer(_org, 'P', extract(year from _dato)::int), _dato, left(btrim(_tekst), 300), 'periodisering')
  returning id into b;
  insert into faktura.posteringer (org_id, bilag_id, rekke, konto, belop, tekst, mva_kode)
  select _org, b, y.n, y.x->>'konto', (y.x->>'belop')::numeric(14,2), left(nullif(btrim(y.x->>'tekst'), ''), 200), nullif(y.x->>'mva_kode', '')
    from jsonb_array_elements(_posteringer) with ordinality as y(x, n);

  for x in select * from jsonb_array_elements(_poster) loop
    select * into p from faktura.periodiseringer where org_id = _org and id = (x->>'periodisering_id')::uuid for update;
    if p.id is null then raise exception 'Fant ikke periodiseringen' using errcode = 'FA404'; end if;
    m := (x->>'maaned')::date;
    if x->>'type' = 'start' then
      if p.start = 'ingen' then raise exception 'Periodisering % har ingen start å bokføre', p.nummer using errcode = 'FA409'; end if;
      if (x->>'belop')::numeric <> p.belop then raise exception 'Starten må være hele beløpet' using errcode = 'FA400'; end if;
      if exists (select 1 from faktura.periodiseringsposter y where y.periodisering_id = p.id and not y.reversert and y.type = 'start') then
        raise exception 'Starten for periodisering % er alt bokført', p.nummer using errcode = 'FA409';
      end if;
    elsif x->>'type' = 'maaned' then
      if m is null or m < p.fra or m > (p.fra + make_interval(months => p.antall_maaneder - 1))::date then
        raise exception 'Måneden er utenfor periodisering %', p.nummer using errcode = 'FA409';
      end if;
      -- Et forskudd med start fordeles først når beløpet er på balansekontoen.
      if p.start <> 'ingen' and not exists (select 1 from faktura.periodiseringsposter y where y.periodisering_id = p.id and not y.reversert and y.type = 'start') then
        raise exception 'Bokfør starten for periodisering % først', p.nummer using errcode = 'FA409';
      end if;
      if exists (select 1 from faktura.periodiseringsposter y where y.periodisering_id = p.id and not y.reversert and y.type = 'maaned' and y.maaned >= m) then
        raise exception 'Periodisering % er alt bokført for måneden (eller en senere)', p.nummer using errcode = 'FA409';
      end if;
    else
      raise exception 'Ukjent post' using errcode = 'FA400';
    end if;
    insert into faktura.periodiseringsposter (org_id, periodisering_id, type, maaned, belop, bilag_id)
    values (_org, p.id, x->>'type', m, (x->>'belop')::numeric(14,2), b);
    if (select coalesce(sum(belop), 0) from faktura.periodiseringsposter where periodisering_id = p.id and type = 'maaned' and not reversert) > p.belop then
      raise exception 'Det som er fordelt for periodisering %, blir mer enn beløpet', p.nummer using errcode = 'FA409';
    end if;
  end loop;
  return b;
end $$;

create or replace function faktura.bokfor_manuelt(_org uuid, _dato date, _tekst text, _posteringer jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b uuid;
begin
  perform faktura.krev(_org, 'regnskap');
  if _dato is null or length(btrim(coalesce(_tekst, ''))) = 0 then
    raise exception 'Skriv dato og tekst for bilaget' using errcode = 'FA400';
  end if;
  if jsonb_typeof(_posteringer) <> 'array' or jsonb_array_length(_posteringer) < 2 or jsonb_array_length(_posteringer) > 200 then
    raise exception 'Bilaget må ha minst to linjer' using errcode = 'FA400';
  end if;
  if (select sum((y->>'belop')::numeric(14,2)) from jsonb_array_elements(_posteringer) y) <> 0 then
    raise exception 'Bilaget går ikke i null: debet og kredit må være like' using errcode = 'FA400';
  end if;
  insert into faktura.bilag (org_id, serie, aar, nummer, dato, tekst, kilde)
  values (_org, 'M', extract(year from _dato)::int, faktura.neste_bilagsnummer(_org, 'M', extract(year from _dato)::int), _dato, left(btrim(_tekst), 300), 'manuell')
  returning id into b;
  insert into faktura.posteringer (org_id, bilag_id, rekke, konto, belop, tekst, mva_kode)
  select _org, b, y.n, y.x->>'konto', (y.x->>'belop')::numeric(14,2), left(nullif(btrim(y.x->>'tekst'), ''), 200), nullif(y.x->>'mva_kode', '')
    from jsonb_array_elements(_posteringer) with ordinality as y(x, n);
  return b;
end $$;
