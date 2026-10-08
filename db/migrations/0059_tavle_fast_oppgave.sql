-- 0059_tavle_fast_oppgave.sql
-- Fast oppgave på tavla: en ansatt kan alltid ha den samme oppgaven (f.eks. laben), i stedet
-- for å rulleres. Rulleringen (server/src/rullering.ts) setter dem i oppgaven i alle fasene de
-- er på jobb og oppgaven trengs, også når behovet er dekket, og ellers ingen andre steder. Uten
-- en plass i fasen (satt for hånd eller av rulleringen) står de der på tavla, i «Mine vakter»
-- og for AI-assistenten likevel (regnes ut i API-et, lagres ikke). En plass satt for hånd en dag
-- står foran den faste oppgaven, og en vikar tar over plassen.

create table faktura.tavle_fast_oppgave (
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  ansatt_id uuid not null,
  oppgave_id uuid not null,
  opprettet timestamptz not null default now(),
  primary key (org_id, ansatt_id),
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete cascade,
  foreign key (org_id, oppgave_id) references faktura.tavle_oppgaver(org_id, id) on delete cascade
);
create index tavle_fast_oppgave_oppgave_idx on faktura.tavle_fast_oppgave (org_id, oppgave_id);

-- Som plasseringene: de som ser de ansatte, ser den faste oppgaven, og den ansatte sin egen;
-- personal styrer den.
alter table faktura.tavle_fast_oppgave enable row level security;
create policy tavle_fast_oppgave_les on faktura.tavle_fast_oppgave for select
  using (faktura.kan(org_id, 'personal_les') or faktura.er_meg(org_id, ansatt_id));
create policy tavle_fast_oppgave_ny on faktura.tavle_fast_oppgave for insert with check (faktura.kan(org_id, 'personal'));
create policy tavle_fast_oppgave_endre on faktura.tavle_fast_oppgave for update
  using (faktura.kan(org_id, 'personal')) with check (faktura.kan(org_id, 'personal'));
create policy tavle_fast_oppgave_slett on faktura.tavle_fast_oppgave for delete using (faktura.kan(org_id, 'personal'));
grant select, delete, insert (org_id, ansatt_id, oppgave_id), update (oppgave_id) on faktura.tavle_fast_oppgave to faktura_app;

-- Som før (0057), og en rolle som tas ut av tavla, eller en person som får en slik rolle, mister
-- også den faste oppgaven (de står ikke på tavla).
create or replace function faktura.rolle_ut_av_tavla() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from faktura.tavle_plasseringer p
   using faktura.ansatte a
   where p.org_id = new.org_id and a.org_id = p.org_id and a.id = p.ansatt_id and a.gruppe_id = new.id and p.dato >= faktura.i_dag();
  delete from faktura.tavle_fast_oppgave t
   using faktura.ansatte a
   where t.org_id = new.org_id and a.org_id = t.org_id and a.id = t.ansatt_id and a.gruppe_id = new.id;
  return null;
end $$;

create or replace function faktura.ansatt_ut_av_tavla() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from faktura.ansattgrupper g where g.org_id = new.org_id and g.id = new.gruppe_id and not g.tavle) then
    delete from faktura.tavle_plasseringer where org_id = new.org_id and ansatt_id = new.id and dato >= faktura.i_dag();
    delete from faktura.tavle_fast_oppgave where org_id = new.org_id and ansatt_id = new.id;
  end if;
  return null;
end $$;
