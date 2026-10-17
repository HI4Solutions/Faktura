-- 0120_aarsregnskap.sql
-- Årsregnskapet til Regnskapsregisteret i Brønnøysund (server/src/aarsregnskap.ts).
--
-- Tallene (resultatregnskapet og balansen etter oppstillingen for små foretak, med fjoråret)
-- hentes fra regnskapet når årsregnskapet vises; her ligger det brukeren selv fyller ut:
-- fastsettelsen (dato og hvem som bekrefter), revisjonen, notene og eventuelle fjorårstall som er
-- lagt inn for hånd (opplysninger), og innsendingen i Altinn: instansen i Brønnøysunds app,
-- om den er låst for signering, og når den er levert (signert og sendt inn).
--
-- Status: utkast (ikke sendt), sender (workeren lager instansen i Altinn), til_signering (ligger
-- i Altinn og venter på signeringen; låst, eller åpen så revisjonsberetningen kan legges ved),
-- levert (signert og sendt inn) og feil. Skjemaene som ble sendt, lagres sammen med raden.

create table faktura.aarsregnskap (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  aar int not null check (aar between 2000 and 2100),
  opplysninger jsonb not null default '{}'::jsonb,
  status text not null default 'utkast' check (status in ('utkast', 'sender', 'til_signering', 'levert', 'feil')),
  instans text,
  instans_url text,
  laast boolean not null default false,
  hovedskjema text,
  underskjema text,
  sendt_at timestamptz,
  sendt_av uuid references faktura.brukere(id) on delete set null,
  levert_at timestamptz,
  sjekket_at timestamptz,
  feil text,
  valideringsfeil jsonb,
  opprettet timestamptz not null default now(),
  oppdatert timestamptz not null default now(),
  unique (org_id, aar)
);
create index aarsregnskap_venter on faktura.aarsregnskap (status) where status in ('sender', 'til_signering');

alter table faktura.aarsregnskap enable row level security;
create policy aarsregnskap_les on faktura.aarsregnskap for select using (faktura.kan(org_id, 'regnskap'));
create policy aarsregnskap_ny on faktura.aarsregnskap for insert with check (faktura.kan(org_id, 'regnskap'));
create policy aarsregnskap_endre on faktura.aarsregnskap for update
  using (faktura.kan(org_id, 'regnskap')) with check (faktura.kan(org_id, 'regnskap'));
create policy aarsregnskap_system on faktura.aarsregnskap for all using (faktura.er_system()) with check (faktura.er_system());

grant select on faktura.aarsregnskap to faktura_app;
grant insert (org_id, aar, opplysninger) on faktura.aarsregnskap to faktura_app;
grant update (opplysninger, status, instans, instans_url, laast, hovedskjema, underskjema, sendt_at, sendt_av, levert_at, sjekket_at,
              feil, valideringsfeil, oppdatert) on faktura.aarsregnskap to faktura_app;
grant select, update on faktura.aarsregnskap to faktura_system;

-- Antall årsverk i året (forslaget i noten om årsverk): stillingsprosenten til arbeidstakerne
-- (ikke rollene for dem som ikke er ansatt, og ikke frilansere og oppdragstakere), vektet med den
-- delen av året de var ansatt. Regnskapet kan se tallet uten å ha tilgang til personaldataene.
create function faktura.aarsverk(_org uuid, _aar int) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare
  fra date := make_date(_aar, 1, 1);
  til date := make_date(_aar, 12, 31);
  svar numeric;
begin
  perform faktura.krev(_org, 'regnskap');
  select coalesce(round(sum(a.stillingsprosent / 100.0
                            * greatest(0, least(coalesce(a.ansatt_til, til), til) - greatest(a.ansatt_fra, fra) + 1)
                            / (til - fra + 1)), 1), 0)
    into svar
    from faktura.ansatte a
   where a.org_id = _org and a.arbeidstaker and a.arbeidsforhold_type <> 'frilanserOppdragstakerHonorarPersonerMm'
     and (a.aktiv or a.ansatt_til is not null);
  return svar;
end $$;
revoke all on function faktura.aarsverk(uuid, int) from public;
grant execute on function faktura.aarsverk(uuid, int) to faktura_app;

-- Tilgangen i Altinn (systembrukeren, skattekort_tilgang) gjelder også årsregnskapet: Regnskap kan
-- se den, be om den og utvide den med tilgangspakken for årsregnskapet, også uten Personal og Lønn
-- (rutene under /regnskap/altinn). Skattekortsidene bruker fortsatt be_om_skattekorttilgang og
-- be_om_utvidet_tilgang, som krever Personal.
create policy skattekort_tilgang_regnskap on faktura.skattekort_tilgang for select using (faktura.kan(org_id, 'regnskap'));

create function faktura.be_om_altinntilgang_regnskap(_org uuid) returns faktura.skattekort_tilgang
language plpgsql security definer set search_path = '' as $$
declare
  t faktura.skattekort_tilgang;
begin
  perform faktura.krev(_org, 'regnskap');
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
revoke all on function faktura.be_om_altinntilgang_regnskap(uuid) from public;
grant execute on function faktura.be_om_altinntilgang_regnskap(uuid) to faktura_app;

create function faktura.be_om_utvidet_tilgang_regnskap(_org uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform faktura.krev(_org, 'regnskap');
  update faktura.skattekort_tilgang
     set endring_status = 'venter', endring_id = null, endring_url = null, endring_pakker = null, endring_feil = null
   where org_id = _org and status = 'godkjent';
  if not found then
    raise exception 'Gi tilgang i Altinn først' using errcode = 'FA409';
  end if;
end $$;
revoke all on function faktura.be_om_utvidet_tilgang_regnskap(uuid) from public;
grant execute on function faktura.be_om_utvidet_tilgang_regnskap(uuid) to faktura_app;
