-- 0051_tavle_rullering.sql
-- Rullering på tavla: de som er på jobb, fordeles på oppgavene av seg selv, så alle får gjøre
-- alt etter tur, både fra dag til dag og mellom fasene samme dag. Selve fordelingen regnes ut i
-- API-et (server/src/rullering.ts); her er det som lagres.
--
-- Plassene rulleringen setter, er merket (rullert). Kjøres rulleringen på nytt for de samme
-- dagene, byttes de ut, mens plassene som er satt for hånd, står (en plass som flyttes for
-- hånd, er ikke lenger rullert).
--
-- Ikke alle kan ta alle oppgavene (f.eks. laben). Uten noe her kan alle; en rad betyr at
-- rulleringen ikke setter den ansatte i oppgaven. Eier og administrator kan fortsatt plassere
-- hvem de vil for hånd.

alter table faktura.tavle_plasseringer add column rullert boolean not null default false;
grant insert (rullert), update (rullert) on faktura.tavle_plasseringer to faktura_app;

create table faktura.tavle_utelatt (
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  oppgave_id uuid not null,
  ansatt_id uuid not null,
  opprettet timestamptz not null default now(),
  primary key (org_id, oppgave_id, ansatt_id),
  foreign key (org_id, oppgave_id) references faktura.tavle_oppgaver(org_id, id) on delete cascade,
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete cascade
);
create index tavle_utelatt_ansatt_idx on faktura.tavle_utelatt (org_id, ansatt_id);

-- Som plasseringene: de som ser de ansatte, ser hvem som kan ta hva, og personal styrer det.
alter table faktura.tavle_utelatt enable row level security;
create policy tavle_utelatt_les on faktura.tavle_utelatt for select using (faktura.kan(org_id, 'personal_les'));
create policy tavle_utelatt_ny on faktura.tavle_utelatt for insert with check (faktura.kan(org_id, 'personal'));
create policy tavle_utelatt_slett on faktura.tavle_utelatt for delete using (faktura.kan(org_id, 'personal'));

grant select, delete, insert (org_id, oppgave_id, ansatt_id) on faktura.tavle_utelatt to faktura_app;
