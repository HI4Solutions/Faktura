-- Skattekort fra Skatteetaten (server/src/skattekort.ts). Leverandøren av løsningen (Medinnova AS)
-- har én Maskinporten-klient og ett system i Altinns systemregister. Hver organisasjon gir
-- systemet tilgang («systembruker») i Altinn: appen lager forespørselen, og daglig leder eller
-- en administrator i Altinn godkjenner den. Deretter henter workeren skattekortene til de
-- ansatte som har fødselsnummer: når appen ber om det, for nye ansatte, og endringene hver dag.
--
-- skattekort_tilgang: forespørselen om systembruker per organisasjon og hvordan det går.
-- altinn_system: om systemet er registrert i Altinns systemregister (plattformen).
-- På de ansatte: hvor skattekortet kom fra, når det ble hentet, hva Skatteetaten svarte,
-- tilleggsopplysningene og hele forskuddstrekket (alle trekkodene), så skattekortet kan regnes
-- om når den ansatte er biarbeidsgiverforhold i stedet for hovedarbeidsgiver.

create table faktura.skattekort_tilgang (
  org_id uuid primary key references faktura.organisasjoner(id) on delete cascade,
  -- venter: appen har bedt om tilgang, og workeren lager forespørselen i Altinn; ny: forespørselen
  -- venter på godkjenning i Altinn; godkjent; avslatt/avvist/utlopt: ikke godkjent (be på nytt);
  -- feil: forespørselen kunne ikke lages (siste_feil)
  status text not null default 'venter' check (status in ('venter', 'ny', 'godkjent', 'avslatt', 'avvist', 'utlopt', 'feil')),
  foresporsel_id uuid,
  godkjenn_url text check (godkjenn_url is null or godkjenn_url like 'https://%'),
  bedt_av uuid references faktura.brukere(id) on delete set null,
  opprettet timestamptz not null default now(),
  oppdatert timestamptz not null default now(),
  sjekket timestamptz,                     -- sist workeren laget eller sjekket forespørselen i Altinn
  sist_hentet timestamptz,                 -- siste vellykkede henting av skattekort
  siste_feil text
);

create trigger skattekort_tilgang_oppdatert before update on faktura.skattekort_tilgang
  for each row execute function faktura.sett_oppdatert();
create trigger skattekort_tilgang_org_id before update on faktura.skattekort_tilgang
  for each row execute function faktura.org_id_uendret();

alter table faktura.skattekort_tilgang enable row level security;
create policy skattekort_tilgang_les on faktura.skattekort_tilgang for select using (faktura.kan(org_id, 'personal_les'));
create policy skattekort_tilgang_slett on faktura.skattekort_tilgang for delete using (faktura.kan(org_id, 'personal'));
-- Plattformadministratoren ser hvor mange som har bedt om og fått tilgang.
create policy skattekort_tilgang_admin on faktura.skattekort_tilgang for select using (faktura.er_betrodd());
create policy skattekort_tilgang_system on faktura.skattekort_tilgang for all
  using (faktura.er_system()) with check (faktura.er_system());
grant select, delete on faktura.skattekort_tilgang to faktura_app;
grant insert (org_id, status, foresporsel_id, godkjenn_url, bedt_av, sjekket, sist_hentet, siste_feil),
      update (status, foresporsel_id, godkjenn_url, sjekket, sist_hentet, siste_feil)
  on faktura.skattekort_tilgang to faktura_system;

-- Eier eller administrator ber om tilgang (på nytt): workeren lager forespørselen i Altinn.
create function faktura.be_om_skattekorttilgang(_org uuid) returns faktura.skattekort_tilgang
language plpgsql security definer set search_path = '' as $$
declare
  t faktura.skattekort_tilgang;
begin
  perform faktura.krev(_org, 'personal');
  if not exists (select 1 from faktura.organisasjoner where id = _org and orgnr is not null) then
    raise exception 'Organisasjonen mangler organisasjonsnummer' using errcode = 'FA400';
  end if;
  insert into faktura.skattekort_tilgang (org_id, status, bedt_av)
  values (_org, 'venter', faktura.bruker_id())
  on conflict (org_id) do update
     set status = 'venter', foresporsel_id = null, godkjenn_url = null, bedt_av = excluded.bedt_av, sjekket = null, siste_feil = null
   where faktura.skattekort_tilgang.status <> 'godkjent'
  returning * into t;
  if t.org_id is null then
    raise exception 'Tilgangen er allerede godkjent' using errcode = 'FA409';
  end if;
  return t;
end $$;
revoke all on function faktura.be_om_skattekorttilgang(uuid) from public;
grant execute on function faktura.be_om_skattekorttilgang(uuid) to faktura_app;

-- Systemet i Altinns systemregister (én rad per system-ID).
create table faktura.altinn_system (
  id text primary key,
  registrert timestamptz,
  oppdatert timestamptz not null default now(),
  siste_feil text
);
alter table faktura.altinn_system enable row level security;
create policy altinn_system_les on faktura.altinn_system for select using (faktura.er_betrodd() or faktura.er_system());
create policy altinn_system_system on faktura.altinn_system for all
  using (faktura.er_system()) with check (faktura.er_system());
grant select on faktura.altinn_system to faktura_app;
grant insert (id, registrert, oppdatert, siste_feil), update (registrert, oppdatert, siste_feil) on faktura.altinn_system to faktura_system;

-- ---------------------------------------------------------------------------
-- Skattekortet på den ansatte
-- ---------------------------------------------------------------------------

-- Frikort uten beløpsgrense (og «ikke trekkplikt»): frikort uten beløp, ingen trekk.
alter table faktura.ansatte drop constraint ansatte_skattekort;
alter table faktura.ansatte
  add constraint ansatte_skattekort check (
    skattekort is null
    or (skattekort = 'tabell' and skatt_tabell is not null and skatt_prosent is not null)
    or (skattekort = 'prosent' and skatt_prosent is not null)
    or skattekort = 'frikort'),
  add column biarbeidsgiver boolean not null default false,       -- skattekortet for biarbeidsgiver brukes
  add column skattekort_kilde text check (skattekort_kilde in ('manuell', 'skatteetaten')),
  add column skattekort_hentet timestamptz,                       -- sist hentet fra Skatteetaten
  add column skattekort_resultat text check (length(skattekort_resultat) <= 100), -- f.eks. skattekortopplysningerOK, ikkeSkattekort
  add column skattekort_utstedt date,
  add column skattekort_tillegg text[] not null default '{}',     -- tilleggsopplysninger (Svalbard, kildeskatt …)
  add column skattekort_trekk jsonb;                              -- forskuddstrekket med alle trekkodene

grant select (biarbeidsgiver, skattekort_kilde, skattekort_hentet, skattekort_resultat, skattekort_utstedt, skattekort_tillegg, skattekort_trekk),
      insert (biarbeidsgiver),
      update (biarbeidsgiver)
  on faktura.ansatte to faktura_app;
grant update (skattekort_kilde, skattekort_hentet, skattekort_resultat, skattekort_utstedt, skattekort_tillegg, skattekort_trekk)
  on faktura.ansatte to faktura_system;

-- Skattekort som registreres eller endres for hånd (ikke av workeren), er «manuell», med mindre
-- bare valget av biarbeidsgiver ble endret (da regnes skattekortet fra Skatteetaten om).
create function faktura.ansatt_skattekort_kilde() returns trigger
language plpgsql set search_path = '' as $$
begin
  if faktura.er_system() then return new; end if;
  if tg_op = 'INSERT' then
    new.skattekort_kilde := case when new.skattekort is not null then 'manuell' end;
  elsif (new.skattekort, new.skatt_tabell, new.skatt_prosent, new.skatt_frikort, new.skattekort_aar)
        is distinct from (old.skattekort, old.skatt_tabell, old.skatt_prosent, old.skatt_frikort, old.skattekort_aar)
        and new.biarbeidsgiver is not distinct from old.biarbeidsgiver then
    new.skattekort_kilde := case when new.skattekort is not null then 'manuell' end;
  end if;
  return new;
end $$;
create trigger ansatte_skattekort_kilde before insert or update on faktura.ansatte
  for each row execute function faktura.ansatt_skattekort_kilde();

-- Revisjonsloggen som før (0035), men tidspunktet skattekortet sist ble hentet, gir ingen rad: workeren
-- henter skattekortene jevnlig, og loggen viser bare når selve skattekortet endres.
create or replace function faktura.revider() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ny jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  gammel jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  rad jsonb := coalesce(ny, gammel);
  endring jsonb;
begin
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_object('fra', gammel -> n.key, 'til', n.value))
      into endring
      from jsonb_each(ny) n
     where n.value is distinct from gammel -> n.key and n.key not in ('oppdatert', 'ehf_sjekket', 'har_fnr', 'skattekort_hentet');
    if endring is null then return null; end if;
  else
    endring := rad - 'har_fnr';
  end if;
  if endring ? 'fnr_kryptert' then
    endring := (endring - 'fnr_kryptert') || case
      when tg_op = 'UPDATE' then jsonb_build_object('fodselsnummer', 'endret')
      when jsonb_typeof(endring -> 'fnr_kryptert') <> 'null' then jsonb_build_object('fodselsnummer', 'registrert')
      else '{}'::jsonb end;
  end if;
  insert into faktura.revisjonslogg (org_id, bruker_id, handling, tabell, rad_id, endring)
  values (
    case when tg_table_name = 'organisasjoner' then (rad ->> 'id')::uuid else (rad ->> 'org_id')::uuid end,
    faktura.bruker_id(),
    tg_op,
    tg_table_name,
    case when rad ? 'id' then (rad ->> 'id')::uuid end,
    -- Krypterte hemmeligheter skal aldri havne i loggen.
    endring - 'hemmelighet_kryptert'
  );
  return null;
end $$;
