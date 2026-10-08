-- Fast arbeidsplan: hvilke ukedager den ansatte jobber, med klokkeslett (fra–til og pause)
-- eller som hel dag (en femtedel av arbeidstiden i full stilling, vanligvis 7,5 timer).
-- Planen gjelder fra en dato, så en ny plan ikke endrer tidligere måneder. Den ansatte er
-- på jobb de dagene i planen (i bemanningskalenderen, på tavla og i vaktplanen), med mindre
-- en vakt i vaktplanen gjelder den dagen eller den ansatte er borte. Timer utover planen er
-- ekstratimer.

create table faktura.arbeidsplaner (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  ansatt_id uuid not null,
  gjelder_fra date not null,
  opprettet timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, ansatt_id, gjelder_fra),
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete cascade
);

create table faktura.arbeidsplan_dager (
  org_id uuid not null,
  plan_id uuid not null,
  ukedag int not null check (ukedag between 1 and 7),  -- 1 = mandag
  fra time,                                              -- uten fra og til: hel dag
  til time,                                              -- før fra: over midnatt
  pause_min int not null default 0 check (pause_min between 0 and 600),
  primary key (plan_id, ukedag),
  foreign key (org_id, plan_id) references faktura.arbeidsplaner(org_id, id) on delete cascade,
  check ((fra is null) = (til is null)),
  check (fra is null or fra <> til),
  check (fra is not null or pause_min = 0)
);

create trigger arbeidsplaner_org_id before update on faktura.arbeidsplaner
  for each row execute function faktura.org_id_uendret();
create trigger arbeidsplan_dager_org_id before update on faktura.arbeidsplan_dager
  for each row execute function faktura.org_id_uendret();
create trigger arbeidsplaner_revisjon after insert or update or delete on faktura.arbeidsplaner
  for each row execute function faktura.revider();

-- Planene ser de som ser de ansatte, og den ansatte sin egen; personal styrer dem.
alter table faktura.arbeidsplaner enable row level security;
alter table faktura.arbeidsplan_dager enable row level security;
create policy arbeidsplaner_les on faktura.arbeidsplaner for select
  using (faktura.kan(org_id, 'personal_les') or faktura.er_meg(org_id, ansatt_id));
create policy arbeidsplaner_ny on faktura.arbeidsplaner for insert with check (faktura.kan(org_id, 'personal'));
create policy arbeidsplaner_endre on faktura.arbeidsplaner for update
  using (faktura.kan(org_id, 'personal')) with check (faktura.kan(org_id, 'personal'));
create policy arbeidsplaner_slett on faktura.arbeidsplaner for delete using (faktura.kan(org_id, 'personal'));
create policy arbeidsplan_dager_les on faktura.arbeidsplan_dager for select
  using (faktura.kan(org_id, 'personal_les')
         or exists (select 1 from faktura.arbeidsplaner p where p.id = plan_id and faktura.er_meg(p.org_id, p.ansatt_id)));
create policy arbeidsplan_dager_ny on faktura.arbeidsplan_dager for insert with check (faktura.kan(org_id, 'personal'));
create policy arbeidsplan_dager_endre on faktura.arbeidsplan_dager for update
  using (faktura.kan(org_id, 'personal')) with check (faktura.kan(org_id, 'personal'));
create policy arbeidsplan_dager_slett on faktura.arbeidsplan_dager for delete using (faktura.kan(org_id, 'personal'));

grant select, delete, insert (org_id, ansatt_id, gjelder_fra), update (gjelder_fra) on faktura.arbeidsplaner to faktura_app;
grant select, delete, insert (org_id, plan_id, ukedag, fra, til, pause_min), update (fra, til, pause_min)
  on faktura.arbeidsplan_dager to faktura_app;

-- Loggen for arbeidsplanene vises, som for ansatte og fravær, bare for dem som ser de ansatte.
drop policy revisjonslogg_les on faktura.revisjonslogg;
create policy revisjonslogg_les on faktura.revisjonslogg for select
  using (faktura.kan(org_id, 'les')
         and (coalesce(tabell, '') not in ('ansatte', 'fravaer', 'arbeidsplaner') or faktura.kan(org_id, 'personal_les')));
