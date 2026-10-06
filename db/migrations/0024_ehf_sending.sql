-- 0024_ehf_sending.sql
-- Sending av EHF gjennom organisasjonens egen konto hos et aksesspunkt (Recommand).
-- Koblingen ligger i faktura.integrasjoner (type 'peppol'): selskapet og nøkkel-ID-en i
-- konfig, hemmeligheten kryptert med Cloud KMS. API-et kan bare kryptere; workeren
-- dekrypterer og sender.
--
-- Hver EHF-sending logges her. oppgave_id er utsendingsoppgaven: kjøres den på nytt
-- (Cloud Tasks prøver igjen ved feil), sendes ikke EHF-en en gang til.

create table faktura.ehf_sendinger (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  faktura_id uuid not null,
  oppgave_id text not null unique,
  mottaker text not null,                -- Peppol-adressen, f.eks. 0192:974760673
  -- sender: forespørselen er startet (svaret kom aldri, så utfallet er ukjent)
  -- venter: sendt, mottakerens aksesspunkt har ikke kvittert ennå
  -- levert: mottakerens aksesspunkt har tatt imot fakturaen
  -- feilet: kom ikke fram (se feil_kategori og detaljer)
  status text not null default 'sender' check (status in ('sender', 'venter', 'levert', 'feilet')),
  dokument_id text,                      -- aksesspunktets id for dokumentet
  feil_kategori text,
  detaljer text,
  sjekket int not null default 0,        -- antall statuskontroller mens den venter
  opprettet timestamptz not null default now(),
  oppdatert timestamptz not null default now(),
  foreign key (org_id, faktura_id) references faktura.fakturaer(org_id, id) on delete cascade
);
create index ehf_sendinger_faktura_idx on faktura.ehf_sendinger (faktura_id, opprettet);

alter table faktura.ehf_sendinger enable row level security;
create policy ehf_sendinger_les on faktura.ehf_sendinger for select using (faktura.kan(org_id, 'les'));
create policy ehf_sendinger_system on faktura.ehf_sendinger for all using (faktura.er_system()) with check (faktura.er_system());
grant select on faktura.ehf_sendinger to faktura_app;
grant insert (org_id, faktura_id, oppgave_id, mottaker, status),
      update (status, dokument_id, feil_kategori, detaljer, sjekket, oppdatert)
  on faktura.ehf_sendinger to faktura_system;

create trigger ehf_sendinger_org_id before update on faktura.ehf_sendinger
  for each row execute function faktura.org_id_uendret();
