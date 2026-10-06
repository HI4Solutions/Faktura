-- 0001_grunnmur.sql
-- Organisasjoner, brukere, medlemskap, regnskapsførertilgang og fakturatabellene.
-- Alt ligger i skjemaet «faktura». Tabellene eies av migreringsbrukeren; appen
-- kobler til som en rolle i faktura_app (API) eller faktura_system (worker).

create schema if not exists faktura;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'faktura_app') then
    create role faktura_app nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'faktura_system') then
    create role faktura_system nologin;
  end if;
end $$;

-- Worker-rollen arver API-rollens rettigheter og får litt mer (se 0003).
grant faktura_app to faktura_system;

revoke all on schema faktura from public;
grant usage on schema faktura to faktura_app;

-- ---------------------------------------------------------------------------
-- Rene hjelpefunksjoner
-- ---------------------------------------------------------------------------

-- Dagens dato i norsk tid, uavhengig av serverens tidssone.
create function faktura.i_dag() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'Europe/Oslo')::date
$$;

-- Innlogget bruker, satt av API-et med SET LOCAL app.bruker_id i hver transaksjon.
create function faktura.bruker_id() returns uuid
language sql stable set search_path = '' as $$
  select nullif(current_setting('app.bruker_id', true), '')::uuid
$$;

-- Organisasjonsnummer: 9 sifre, MOD11 med vekter 3,2,7,6,5,4,3,2.
create function faktura.orgnr_gyldig(_orgnr text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  vekter int[] := array[3,2,7,6,5,4,3,2];
  sum int := 0;
  rest int;
begin
  if _orgnr is null or _orgnr !~ '^\d{9}$' then return false; end if;
  for i in 1..8 loop
    sum := sum + substr(_orgnr, i, 1)::int * vekter[i];
  end loop;
  rest := 11 - (sum % 11);
  if rest = 11 then rest := 0; end if;
  if rest = 10 then return false; end if;
  return rest = substr(_orgnr, 9, 1)::int;
end $$;

-- Kontonummer: 11 sifre, MOD11 med vekter 5,4,3,2,7,6,5,4,3,2.
create function faktura.kontonr_gyldig(_kontonr text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  vekter int[] := array[5,4,3,2,7,6,5,4,3,2];
  sum int := 0;
  rest int;
begin
  if _kontonr is null or _kontonr !~ '^\d{11}$' then return false; end if;
  for i in 1..10 loop
    sum := sum + substr(_kontonr, i, 1)::int * vekter[i];
  end loop;
  rest := 11 - (sum % 11);
  if rest = 11 then rest := 0; end if;
  if rest = 10 then return false; end if;
  return rest = substr(_kontonr, 11, 1)::int;
end $$;

-- KID: kundenummer (minst 6 sifre) + fakturanummer (minst 7 sifre) + MOD10 (Luhn).
create function faktura.kid(_kundenummer bigint, _fakturanummer bigint) returns text
language plpgsql immutable set search_path = '' as $$
declare
  grunnlag text := lpad(_kundenummer::text, 6, '0') || lpad(_fakturanummer::text, 7, '0');
  sum int := 0;
  siffer int;
  dobbel boolean := true;
begin
  for i in reverse length(grunnlag)..1 loop
    siffer := substr(grunnlag, i, 1)::int;
    if dobbel then
      siffer := siffer * 2;
      if siffer > 9 then siffer := siffer - 9; end if;
    end if;
    sum := sum + siffer;
    dobbel := not dobbel;
  end loop;
  return grunnlag || ((10 - sum % 10) % 10)::text;
end $$;

-- Neste forfall: legger til et intervall og holder fast på forfallsdagen,
-- men bruker månedens siste dag når måneden er kortere (31.01 -> 28.02 -> 31.03).
create function faktura.neste_forfall(_dato date, _intervall text, _dag int) returns date
language plpgsql immutable set search_path = '' as $$
declare
  mnd int := case _intervall when 'maaned' then 1 when 'kvartal' then 3 when 'aar' then 12 end;
  start date;
  siste int;
begin
  if mnd is null then raise exception 'Ukjent intervall: %', _intervall using errcode = 'FA400'; end if;
  start := (date_trunc('month', _dato) + make_interval(months => mnd))::date;
  siste := extract(day from (start + interval '1 month - 1 day'))::int;
  return make_date(extract(year from start)::int, extract(month from start)::int, least(_dag, siste));
end $$;

-- Siste dag i en tjenesteperiode som starter _fra.
create function faktura.periode_slutt(_fra date, _intervall text) returns date
language sql immutable set search_path = '' as $$
  select (_fra + make_interval(months => case _intervall
    when 'maaned' then 1 when 'kvartal' then 3 when 'aar' then 12 end))::date - 1
$$;

-- ---------------------------------------------------------------------------
-- Brukere, organisasjoner og tilgang
-- ---------------------------------------------------------------------------

create table faktura.brukere (
  id uuid primary key default gen_random_uuid(),
  ekstern_id text not null unique,          -- uid fra Identity Platform
  epost text not null,
  navn text,
  opprettet timestamptz not null default now(),
  oppdatert timestamptz not null default now()
);
create unique index brukere_epost_idx on faktura.brukere (lower(epost));

create table faktura.organisasjoner (
  id uuid primary key default gen_random_uuid(),
  type text not null default 'foretak' check (type in ('foretak', 'regnskapsbyraa')),
  navn text not null check (btrim(navn) <> ''),
  orgnr text check (orgnr is null or faktura.orgnr_gyldig(orgnr)),
  mva_registrert boolean not null default false,
  foretaksregisteret boolean not null default false,
  adresse text,
  postnr text check (postnr ~ '^\d{4}$'),
  poststed text,
  land text not null default 'NO',
  epost text,
  telefon text,
  kontonr text check (kontonr is null or faktura.kontonr_gyldig(kontonr)),
  logo_sti text,
  farge text check (farge ~ '^#[0-9a-fA-F]{6}$'),
  standard_forfall_dager int not null default 14 check (standard_forfall_dager between 0 and 120),
  standard_gebyr numeric(12,2) not null default 0 check (standard_gebyr >= 0),
  bruk_kid boolean not null default false,
  standard_dager_foer_forfall int not null default 14 check (standard_dager_foer_forfall between 0 and 60),
  -- Verifisering og misbruksvern
  verifisering text not null default 'ny' check (verifisering in ('ny', 'verifisert', 'sperret')),
  verifisert_at timestamptz,
  verifisert_metode text,                   -- f.eks. 'epostdomene', 'enhetsregister_epost', 'brev', 'manuell'
  sperret_grunn text,
  maks_fakturaer_mnd int default 20 check (maks_fakturaer_mnd > 0),
  maks_belop_mnd numeric(14,2) default 50000 check (maks_belop_mnd > 0),
  opprettet timestamptz not null default now(),
  opprettet_av uuid references faktura.brukere(id),
  oppdatert timestamptz not null default now()
);
-- Et organisasjonsnummer kan bare være verifisert hos én organisasjon.
create unique index organisasjoner_verifisert_orgnr_idx
  on faktura.organisasjoner (orgnr) where verifisering = 'verifisert';

create table faktura.nummerserier (
  org_id uuid primary key references faktura.organisasjoner(id) on delete cascade,
  neste_fakturanummer bigint not null default 1 check (neste_fakturanummer > 0),
  neste_kundenummer bigint not null default 10001 check (neste_kundenummer > 0)
);

create table faktura.medlemmer (
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  bruker_id uuid not null references faktura.brukere(id) on delete cascade,
  rolle text not null check (rolle in ('eier', 'admin', 'fakturerer', 'regnskap', 'les')),
  opprettet timestamptz not null default now(),
  primary key (org_id, bruker_id)
);
create index medlemmer_bruker_idx on faktura.medlemmer (bruker_id);

create table faktura.invitasjoner (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  epost text not null,
  rolle text not null check (rolle in ('admin', 'fakturerer', 'regnskap', 'les')),
  token_hash bytea not null unique,         -- sha256 av lenketokenet; selve tokenet lagres aldri
  utloper timestamptz not null default now() + interval '7 days',
  invitert_av uuid not null references faktura.brukere(id),
  akseptert_av uuid references faktura.brukere(id),
  akseptert_at timestamptz,
  opprettet timestamptz not null default now()
);

-- Regnskapsbyrå <-> klient. Klienten må alltid samtykke.
--   invitert:  klienten har invitert byrået, venter på byrået
--   forespurt: byrået har bedt om tilgang, venter på klienten
create table faktura.org_tilgang (
  id uuid primary key default gen_random_uuid(),
  klient_org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  byraa_org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  rolle text not null check (rolle in ('les', 'bokfor')),
  status text not null check (status in ('invitert', 'forespurt', 'aktiv', 'avslaatt', 'trukket')),
  utloper date,
  opprettet_av uuid references faktura.brukere(id),
  besvart_av uuid references faktura.brukere(id),
  besvart_at timestamptz,
  trukket_av uuid references faktura.brukere(id),
  trukket_at timestamptz,
  opprettet timestamptz not null default now(),
  check (klient_org_id <> byraa_org_id)
);
create unique index org_tilgang_apen_idx on faktura.org_tilgang (klient_org_id, byraa_org_id)
  where status in ('invitert', 'forespurt', 'aktiv');
create index org_tilgang_byraa_idx on faktura.org_tilgang (byraa_org_id) where status = 'aktiv';

-- ---------------------------------------------------------------------------
-- Kunder, produkter og fakturaer
-- ---------------------------------------------------------------------------

create table faktura.kunder (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id),
  kundenummer bigint not null,              -- settes av trigger fra nummerserien
  type text not null default 'firma' check (type in ('person', 'firma')),
  navn text not null check (btrim(navn) <> ''),
  orgnr text check (orgnr ~ '^\d{9}$'),
  adresse text,
  postnr text,
  poststed text,
  land text not null default 'NO',
  epost text,
  telefon text,
  deres_referanse text,
  notat text,
  aktiv boolean not null default true,
  opprettet timestamptz not null default now(),
  oppdatert timestamptz not null default now(),
  unique (org_id, kundenummer),
  unique (org_id, id)
);
create index kunder_navn_idx on faktura.kunder (org_id, lower(navn));

create table faktura.produkter (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id),
  varenummer text,
  navn text not null check (btrim(navn) <> ''),
  beskrivelse text,
  enhet text not null default 'stk',
  enhetspris numeric(14,2) not null default 0,   -- eks. mva
  mva_sats numeric(5,2) not null default 25 check (mva_sats between 0 and 100),
  aktiv boolean not null default true,
  opprettet timestamptz not null default now(),
  oppdatert timestamptz not null default now(),
  unique (org_id, id)
);
create unique index produkter_varenummer_idx on faktura.produkter (org_id, varenummer) where varenummer is not null;

create table faktura.gjentakelser (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id),
  kunde_id uuid not null,
  linjer jsonb not null check (jsonb_typeof(linjer) = 'array' and jsonb_array_length(linjer) > 0),
  intervall text not null default 'maaned' check (intervall in ('maaned', 'kvartal', 'aar')),
  forfall_dag int not null check (forfall_dag between 1 and 31),
  neste_forfall date not null,
  send_dager_foer int not null default 14 check (send_dager_foer between 0 and 60),
  neste_dato date generated always as (neste_forfall - send_dager_foer) stored,
  slutt_dato date,
  aktiv boolean not null default true,
  deres_referanse text,
  siste_faktura_id uuid,
  opprettet timestamptz not null default now(),
  opprettet_av uuid references faktura.brukere(id),
  oppdatert timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, kunde_id) references faktura.kunder(org_id, id)
);
create index gjentakelser_neste_idx on faktura.gjentakelser (neste_dato) where aktiv;

create table faktura.fakturaer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id),
  fakturanummer bigint,
  kunde_id uuid not null,
  type text not null default 'faktura' check (type in ('faktura', 'kreditnota')),
  status text not null default 'utkast' check (status in ('utkast', 'utstedt', 'betalt', 'kreditert')),
  kreditnota_for uuid,
  fakturadato date,
  forfallsdato date,
  periode_fra date,
  periode_til date,
  gjentakelse_id uuid,
  kid text,
  valuta text not null default 'NOK' check (valuta = 'NOK'),
  sum_eks_mva numeric(14,2),
  mva numeric(14,2),
  sum_inkl_mva numeric(14,2),
  kreditert_belop numeric(14,2) not null default 0,  -- kreditert inkl. mva, positivt
  betalt_belop numeric(14,2) not null default 0,
  refusjon_belop numeric(14,2) not null default 0,
  selger jsonb,
  kunde jsonb,
  deres_referanse text,
  var_referanse text,
  notat text,
  planlagt_sending date,
  pdf_sti text,
  sendt_til text,
  sendt_at timestamptz,
  betalt_at timestamptz,
  utstedt_at timestamptz,
  utstedt_av uuid references faktura.brukere(id),
  opprettet timestamptz not null default now(),
  opprettet_av uuid references faktura.brukere(id),
  oppdatert timestamptz not null default now(),
  unique (org_id, fakturanummer),
  unique (org_id, id),
  foreign key (org_id, kunde_id) references faktura.kunder(org_id, id),
  foreign key (org_id, kreditnota_for) references faktura.fakturaer(org_id, id),
  foreign key (org_id, gjentakelse_id) references faktura.gjentakelser(org_id, id) on delete set null (gjentakelse_id),
  check (forfallsdato is null or fakturadato is null or forfallsdato >= fakturadato),
  check (periode_til is null or periode_fra is null or periode_til >= periode_fra),
  check ((type = 'kreditnota') = (kreditnota_for is not null)),
  check (status = 'utkast' or fakturanummer is not null)
);
create index fakturaer_status_idx on faktura.fakturaer (org_id, status);
create index fakturaer_kunde_idx on faktura.fakturaer (org_id, kunde_id);
create index fakturaer_dato_idx on faktura.fakturaer (org_id, fakturadato desc);
create index fakturaer_planlagt_idx on faktura.fakturaer (planlagt_sending) where status = 'utkast';
create index fakturaer_kreditnota_idx on faktura.fakturaer (kreditnota_for) where kreditnota_for is not null;

alter table faktura.gjentakelser
  add foreign key (org_id, siste_faktura_id) references faktura.fakturaer(org_id, id) on delete set null (siste_faktura_id);

create table faktura.faktura_linjer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  faktura_id uuid not null,
  rekke int not null default 0,
  produkt_id uuid,
  beskrivelse text not null check (btrim(beskrivelse) <> ''),
  antall numeric(14,3) not null default 1 check (antall <> 0),
  enhet text not null default 'stk',
  enhetspris numeric(14,2) not null,        -- eks. mva
  mva_sats numeric(5,2) not null default 25 check (mva_sats between 0 and 100),
  belop_eks numeric(14,2),                  -- settes ved utstedelse
  mva_belop numeric(14,2),                  -- settes ved utstedelse
  kreditert_linje_id uuid references faktura.faktura_linjer(id),
  opprettet timestamptz not null default now(),
  foreign key (org_id, faktura_id) references faktura.fakturaer(org_id, id) on delete cascade,
  foreign key (org_id, produkt_id) references faktura.produkter(org_id, id)
);
create index faktura_linjer_faktura_idx on faktura.faktura_linjer (faktura_id, rekke);
create index faktura_linjer_kreditert_idx on faktura.faktura_linjer (kreditert_linje_id) where kreditert_linje_id is not null;

create table faktura.betalinger (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  faktura_id uuid not null,
  type text not null check (type in ('betaling', 'refusjon')),
  belop numeric(14,2) not null check (belop <> 0),   -- inkl. mva; refusjon er negativ
  betalt_dato date not null,
  notat text,
  kilde text not null default 'manuell' check (kilde in ('manuell', 'bank', 'ocr', 'api')),
  ekstern_ref text,                          -- idempotensnøkkel ved import fra bank/OCR/API
  registrert_av uuid references faktura.brukere(id),
  opprettet timestamptz not null default now(),
  foreign key (org_id, faktura_id) references faktura.fakturaer(org_id, id),
  check (type = 'betaling' or belop < 0)
);
create index betalinger_faktura_idx on faktura.betalinger (faktura_id);
create unique index betalinger_ekstern_ref_idx on faktura.betalinger (org_id, kilde, ekstern_ref) where ekstern_ref is not null;

-- ---------------------------------------------------------------------------
-- Integrasjoner, utboks og revisjonslogg
-- ---------------------------------------------------------------------------

create table faktura.integrasjoner (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  type text not null check (type in ('google_drive', 'fiken', 'tripletex', 'poweroffice', 'visma', 'bank', 'peppol')),
  status text not null default 'aktiv' check (status in ('aktiv', 'feil', 'frakoblet')),
  konfig jsonb not null default '{}',
  hemmelighet_kryptert bytea,               -- kryptert med Cloud KMS før lagring
  koblet_av uuid references faktura.brukere(id),
  siste_feil text,
  opprettet timestamptz not null default now(),
  oppdatert timestamptz not null default now(),
  unique (org_id, type)
);

-- Transaksjonell utboks: skrives i samme transaksjon som endringen, publiseres
-- til Pub/Sub av workeren. Gir integrasjoner og webhooks uten tapte hendelser.
create table faktura.utboks (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  hendelse text not null,
  aggregat_id uuid not null,
  data jsonb not null default '{}',
  opprettet timestamptz not null default now(),
  publisert_at timestamptz,
  forsok int not null default 0,
  siste_feil text
);
create index utboks_upublisert_idx on faktura.utboks (id) where publisert_at is null;

create table faktura.revisjonslogg (
  id bigint generated always as identity primary key,
  org_id uuid,
  bruker_id uuid,
  handling text not null,                   -- INSERT, UPDATE, DELETE eller OPPSLAG
  tabell text,
  rad_id uuid,
  endring jsonb,
  tid timestamptz not null default now()
);
create index revisjonslogg_org_idx on faktura.revisjonslogg (org_id, tid desc);
