-- Sykepenger og NAV (server/src/navSykepenger.ts, server/src/navRuter.ts, docs/nav.md).
--
-- Sykmeldingene NAV sender til arbeidsgiveren hentes med systembrukeren i Altinn (tilgangspakken
-- «Lønn med personopplysninger av særlig kategori») for hver virksomhet, fra siste løpenummer.
-- Hver sykmelding gir fravær (syk, med sykmeldingsgraden når den er gradert) for dagene som ikke
-- alt er registrert, og eier og administrator får varsel. NAVs forespørsler om inntektsmelding
-- hentes på samme måte, og inntektsmeldingen (arbeidsgiverperioden, inntekten og refusjonskravet
-- når arbeidsgiveren betaler lønn under sykdommen) sendes fra appen; workeren sender den.
--
-- Bare eier og administrator (og den ansatte selv for sine sykmeldinger) ser dette; det er
-- helseopplysninger. Bare workeren skriver (inntektsmeldingen bestilles med en funksjon).

-- Lønn under sykdom etter arbeidsgiverperioden: arbeidsgiveren betaler (forskutterer) og krever
-- refusjon fra NAV i inntektsmeldingen, eller NAV betaler sykepengene til den ansatte (da trekkes
-- fastlønnen for de dagene, og timelønn betales ikke).
alter table faktura.lonn_oppsett add column sykepenger_refusjon boolean not null default true;
grant insert (sykepenger_refusjon), update (sykepenger_refusjon) on faktura.lonn_oppsett to faktura_app;

-- Sykmeldingsgraden på fraværet (null er 100 %), og sykmeldingen fra NAV fraværet kommer fra.
alter table faktura.fravaer
  add column sykmeldingsgrad int check (sykmeldingsgrad is null or sykmeldingsgrad between 1 and 99),
  add column nav_sykmelding uuid,
  add constraint fravaer_grad_syk check (sykmeldingsgrad is null or type = 'syk');
grant insert (sykmeldingsgrad), update (sykmeldingsgrad) on faktura.fravaer to faktura_app;
grant insert (nav_sykmelding) on faktura.fravaer to faktura_system;

-- Hentingen fra NAV per virksomhet: det siste løpenummeret (sykmeldinger og forespørsler har hver
-- sin rekke), når det ble hentet, og feilen sist.
create table faktura.nav_henting (
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  type text not null check (type in ('sykmelding', 'forespoersel')),
  virksomhet_orgnr text not null check (faktura.orgnr_gyldig(virksomhet_orgnr)),
  siste_loepenr bigint not null default 0 check (siste_loepenr >= 0),
  sist_hentet timestamptz,
  siste_feil text check (siste_feil is null or length(siste_feil) <= 2000),
  primary key (org_id, type, virksomhet_orgnr)
);
alter table faktura.nav_henting enable row level security;
create policy nav_henting_les on faktura.nav_henting for select using (faktura.kan(org_id, 'personal'));
create policy nav_henting_system on faktura.nav_henting for all using (faktura.er_system()) with check (faktura.er_system());
grant select on faktura.nav_henting to faktura_app;
grant select, insert, update on faktura.nav_henting to faktura_system;

-- Sykmeldingene (uten fødselsnummer; den ansatte er koblet på når fødselsnummeret er registrert).
-- perioder: [{fom, tom, grad, type, reisetilskudd}] der type er full, gradert, avventende,
-- behandlingsdager eller reisetilskudd. fravaer: fraværet som ble registrert av sykmeldingen.
-- merknader: det lederen bør se på (dager som alt hadde annet fravær, ukjent ansatt).
create table faktura.nav_sykmeldinger (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  sykmelding_id text not null,
  loepenr bigint not null,
  virksomhet_orgnr text not null,
  ansatt_id uuid,
  navn text check (navn is null or length(navn) <= 200),
  sykefravaer_fom date,
  mottatt_av_nav timestamptz,
  sendt_til_arbeidsgiver timestamptz,
  perioder jsonb not null default '[]',
  egenmeldingsdager jsonb not null default '[]',
  melding_til_arbeidsgiver text check (melding_til_arbeidsgiver is null or length(melding_til_arbeidsgiver) <= 4000),
  tiltak_arbeidsplassen text check (tiltak_arbeidsplassen is null or length(tiltak_arbeidsplassen) <= 4000),
  behandler text check (behandler is null or length(behandler) <= 300),
  fravaer uuid[] not null default '{}',
  merknader text[] not null default '{}',
  hentet timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, sykmelding_id),
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete set null (ansatt_id)
);
create index nav_sykmeldinger_ansatt on faktura.nav_sykmeldinger (org_id, ansatt_id, sykefravaer_fom);
alter table faktura.nav_sykmeldinger enable row level security;
create policy nav_sykmeldinger_les on faktura.nav_sykmeldinger for select
  using (faktura.kan(org_id, 'personal') or faktura.er_meg(org_id, ansatt_id));
create policy nav_sykmeldinger_system on faktura.nav_sykmeldinger for all using (faktura.er_system()) with check (faktura.er_system());
grant select on faktura.nav_sykmeldinger to faktura_app;
grant select, insert, update on faktura.nav_sykmeldinger to faktura_system;

-- NAVs forespørsler om inntektsmelding (uten fødselsnummer). status: NAVs status (AKTIV venter på
-- inntektsmeldingen, BESVART er besvart og kan korrigeres, FORKASTET er trukket tilbake). data:
-- sykmeldings- og egenmeldingsperiodene, inntektsdatoen, om arbeidsgiverperioden og inntekten er
-- påkrevd, når NAV sendte den, og inntekten i a-ordningen de tre månedene før (fra NAV).
create table faktura.nav_forespoersler (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  nav_referanse_id text not null,
  loepenr bigint,
  virksomhet_orgnr text not null,
  ansatt_id uuid,
  navn text check (navn is null or length(navn) <= 200),
  status text not null check (status in ('AKTIV', 'BESVART', 'FORKASTET')),
  data jsonb not null default '{}',
  opprettet timestamptz not null default now(),
  oppdatert timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, nav_referanse_id),
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete set null (ansatt_id)
);
create trigger nav_forespoersler_oppdatert before update on faktura.nav_forespoersler
  for each row execute function faktura.sett_oppdatert();
alter table faktura.nav_forespoersler enable row level security;
create policy nav_forespoersler_les on faktura.nav_forespoersler for select using (faktura.kan(org_id, 'personal'));
create policy nav_forespoersler_system on faktura.nav_forespoersler for all using (faktura.er_system()) with check (faktura.er_system());
grant select on faktura.nav_forespoersler to faktura_app;
grant select, insert, update on faktura.nav_forespoersler to faktura_system;

-- Inntektsmeldingene som er sendt (eller sendes) fra appen. innhold: det som sendes, uten
-- fødselsnummer (arbeidsgiverperioden, inntekten, naturalytelsene og refusjonskravet).
-- status: sender (workeren sender), sendt (NAV har tatt imot og kontrollerer den), godkjent (NAV
-- har godkjent den), avvist (NAV avviste den etter kontrollen, f.eks. inntekten avviker fra
-- a-ordningen), feil (NAV tok ikke imot den). forsok_at: når workeren sist sendte (NAV kjenner igjen
-- en inntektsmelding som er sendt før, så et nytt forsøk gir ikke to).
create table faktura.nav_inntektsmeldinger (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  forespoersel_id uuid not null,
  ansatt_id uuid,
  status text not null default 'sender' check (status in ('sender', 'sendt', 'godkjent', 'avvist', 'feil')),
  aarsak text check (aarsak in ('Ny', 'Endring')),
  innhold jsonb not null,
  innsending_id text,
  feil text check (feil is null or length(feil) <= 2000),
  sendt_av uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null,
  opprettet timestamptz not null default now(),
  forsok_at timestamptz,
  sendt_at timestamptz,
  unique (org_id, id),
  foreign key (org_id, forespoersel_id) references faktura.nav_forespoersler(org_id, id) on delete cascade,
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete set null (ansatt_id)
);
create trigger nav_inntektsmeldinger_revisjon after insert or update or delete on faktura.nav_inntektsmeldinger
  for each row execute function faktura.revider();
alter table faktura.nav_inntektsmeldinger enable row level security;
create policy nav_inntektsmeldinger_les on faktura.nav_inntektsmeldinger for select using (faktura.kan(org_id, 'personal'));
create policy nav_inntektsmeldinger_system on faktura.nav_inntektsmeldinger for all using (faktura.er_system()) with check (faktura.er_system());
grant select on faktura.nav_inntektsmeldinger to faktura_app;
grant select, update (status, aarsak, innsending_id, feil, forsok_at, sendt_at) on faktura.nav_inntektsmeldinger to faktura_system;

-- Eier eller administrator sender inntektsmeldingen for en forespørsel (workeren sender den). En
-- forespørsel med en inntektsmelding som sendes nå, eller som NAV kontrollerer, får ikke en ny før
-- den er ferdig; en forespørsel NAV har trukket tilbake, får ingen.
create function faktura.bestill_inntektsmelding(_forespoersel uuid, _innhold jsonb) returns faktura.nav_inntektsmeldinger
language plpgsql security definer set search_path = '' as $$
declare
  f faktura.nav_forespoersler;
  m faktura.nav_inntektsmeldinger;
begin
  select * into f from faktura.nav_forespoersler where id = _forespoersel for update;
  if f.id is null then raise exception 'Fant ikke forespørselen' using errcode = 'FA404'; end if;
  perform faktura.krev(f.org_id, 'personal');
  if f.ansatt_id is null then
    raise exception 'Den ansatte i forespørselen er ikke registrert med fødselsnummer' using errcode = 'FA409';
  end if;
  if jsonb_typeof(_innhold) <> 'object' then raise exception 'Mangler innholdet' using errcode = 'FA400'; end if;
  if f.status = 'FORKASTET' then
    raise exception 'NAV har trukket tilbake forespørselen' using errcode = 'FA409';
  end if;
  if exists (select 1 from faktura.nav_inntektsmeldinger
              where forespoersel_id = f.id
                and ((status = 'sender' and opprettet > now() - interval '1 hour') or (status = 'sendt' and sendt_at > now() - interval '1 day'))) then
    raise exception 'Inntektsmeldingen er sendt, og NAV kontrollerer den nå. Vent til den er godkjent eller avvist.' using errcode = 'FA409';
  end if;
  insert into faktura.nav_inntektsmeldinger (org_id, forespoersel_id, ansatt_id, innhold)
  values (f.org_id, f.id, f.ansatt_id, _innhold)
  returning * into m;
  return m;
end $$;
revoke execute on function faktura.bestill_inntektsmelding(uuid, jsonb) from public;
grant execute on function faktura.bestill_inntektsmelding(uuid, jsonb) to faktura_app;
