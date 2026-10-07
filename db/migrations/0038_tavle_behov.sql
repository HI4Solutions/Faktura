-- Behov per fase på tavla: hvor mange som trengs i en oppgave i en bestemt fase (f.eks. at
-- laben trenger to om formiddagen, men ingen om kvelden). Uten en rad her gjelder behovet på
-- oppgaven (tavle_oppgaver.behov) i alle fasene; 0 betyr at oppgaven ikke trenger noen i fasen.
create table faktura.tavle_behov (
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  fase_id uuid not null,
  oppgave_id uuid not null,
  antall int not null check (antall between 0 and 50),
  primary key (org_id, fase_id, oppgave_id),
  foreign key (org_id, fase_id) references faktura.tavle_faser(org_id, id) on delete cascade,
  foreign key (org_id, oppgave_id) references faktura.tavle_oppgaver(org_id, id) on delete cascade
);
create trigger tavle_behov_org_id before update on faktura.tavle_behov
  for each row execute function faktura.org_id_uendret();

-- Som fasene og oppgavene: alle ser behovet, personal styrer det.
alter table faktura.tavle_behov enable row level security;
create policy tavle_behov_les on faktura.tavle_behov for select using (faktura.kan(org_id, 'medlem'));
create policy tavle_behov_ny on faktura.tavle_behov for insert with check (faktura.kan(org_id, 'personal'));
create policy tavle_behov_endre on faktura.tavle_behov for update
  using (faktura.kan(org_id, 'personal')) with check (faktura.kan(org_id, 'personal'));
create policy tavle_behov_slett on faktura.tavle_behov for delete using (faktura.kan(org_id, 'personal'));

grant select, delete, insert (org_id, fase_id, oppgave_id, antall), update (antall)
  on faktura.tavle_behov to faktura_app;
