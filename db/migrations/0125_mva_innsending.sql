-- 0125_mva_innsending.sql
-- Mva-meldingen sendt til Skatteetaten fra appen (server/src/mvaInnsending.ts,
-- docs/mva-innsending.md). Den som sender, logger inn i ID-porten (Skatteetaten tar ikke imot
-- mva-meldingen med systembruker ennå); workeren validerer meldingen hos Skatteetaten og sender den
-- gjennom Skatteetatens app i Altinn.
--
-- Én rad per forsøk. Status: innlogging (brukeren er sendt til ID-porten), sender (workeren
-- sender), sendt (levert i Altinn; tilbakemeldingen hentes), mottatt (Skatteetaten har gitt
-- tilbakemelding, med kvitteringen), feil og avbrutt (innloggingen ble avbrutt eller tok for lang
-- tid). Meldingen fryses når brukeren trykker (XML-en, linjene og summen), så det som sendes, er
-- det brukeren så. Innloggingen (state, nonce og PKCE-verifikatoren) brukes én gang og tømmes.
-- Altinn-tokenet lagres kryptert (Cloud KMS) bare til tilbakemeldingen er hentet.

create table faktura.mva_innsendinger (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  aar int not null check (aar between 2000 and 2100),
  type text not null check (type in ('tomaaneder', 'aar', 'maaned')),
  termin int not null,
  status text not null default 'innlogging' check (status in ('innlogging', 'sender', 'sendt', 'mottatt', 'feil', 'avbrutt')),
  -- Innloggingen i ID-porten.
  state text unique,
  nonce text,
  verifikator text,
  tilbake_url text,
  utloper timestamptz,
  -- Det som sendes.
  melding text not null,
  sum numeric(14,0) not null,
  linjer jsonb not null default '[]'::jsonb,
  -- Hos Skatteetaten og i Altinn: instansen («partyId/guid»), steget sendingen kom til, avvikene
  -- fra valideringen, betalingsinformasjonen, tilbakemeldingen og kvitteringen (PDF).
  instans text,
  steg text,
  avvik jsonb,
  betaling jsonb,
  tilbakemelding jsonb,
  kvittering bytea,
  altinn_token bytea,
  token_utloper timestamptz,
  feil text,
  startet_av uuid references faktura.brukere(id) on delete set null,
  opprettet timestamptz not null default now(),
  sendt_at timestamptz,
  mottatt_at timestamptz,
  oppdatert timestamptz not null default now(),
  check ((type = 'tomaaneder' and termin between 1 and 6) or (type = 'aar' and termin = 1) or (type = 'maaned' and termin between 1 and 12))
);
create index mva_innsendinger_termin on faktura.mva_innsendinger (org_id, aar, type, termin, opprettet desc);
-- Bare én sending om gangen for en termin.
create unique index mva_innsendinger_en_om_gangen on faktura.mva_innsendinger (org_id, aar, type, termin) where status = 'sender';
create index mva_innsendinger_venter on faktura.mva_innsendinger (status) where status in ('innlogging', 'sender', 'sendt');
create trigger mva_innsendinger_org_id before update on faktura.mva_innsendinger
  for each row execute function faktura.org_id_uendret();

alter table faktura.mva_innsendinger enable row level security;
create policy mva_innsendinger_les on faktura.mva_innsendinger for select using (faktura.kan(org_id, 'regnskap'));
create policy mva_innsendinger_ny on faktura.mva_innsendinger for insert with check (faktura.kan(org_id, 'regnskap'));
create policy mva_innsendinger_endre on faktura.mva_innsendinger for update
  using (faktura.kan(org_id, 'regnskap')) with check (faktura.kan(org_id, 'regnskap'));

-- API-et ser ikke verifikatoren, nonce eller Altinn-tokenet, og endrer bare statusen og innloggingen;
-- workeren (faktura_system) kan alt.
grant select (id, org_id, aar, type, termin, status, state, tilbake_url, utloper, melding, sum, linjer, instans, steg, avvik, betaling,
              tilbakemelding, kvittering, feil, startet_av, opprettet, sendt_at, mottatt_at, oppdatert)
  on faktura.mva_innsendinger to faktura_app;
grant insert (id, org_id, aar, type, termin, state, nonce, verifikator, tilbake_url, utloper, melding, sum, linjer, startet_av)
  on faktura.mva_innsendinger to faktura_app;
grant update (status, state, utloper, feil, oppdatert) on faktura.mva_innsendinger to faktura_app;
grant select, update on faktura.mva_innsendinger to faktura_system;
-- Workeren merker terminen som levert når meldingen er sendt (faktura.mva_terminer; workeren har
-- appens rettigheter der, og faktura.kan gjelder for systemet).
