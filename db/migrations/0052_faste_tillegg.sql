-- 0052_faste_tillegg.sql
-- Faste tillegg på lønnen: f.eks. funksjonstillegg 1 500 kr i måneden eller fagbrevtillegg
-- 15 kr timen, per ansatt, eventuelt bare for en periode (fra og med, til og med). De hører til
-- lønnen og vises, som den, for dem som ser de ansatte og for den ansatte selv; eier og
-- administrator legger dem inn og endrer dem (også fra importen av ansatte). Lønnskjøringen
-- skal ta dem med som faste tillegg (fastTillegg i a-meldingen).

create table faktura.ansatt_tillegg (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  ansatt_id uuid not null,
  navn text not null check (length(btrim(navn)) between 1 and 100),
  belop numeric(12,2) not null check (belop > 0 and belop <= 10000000),
  per text not null default 'maaned' check (per in ('maaned', 'time')),
  fra date,
  til date,
  opprettet timestamptz not null default clock_timestamp(), -- rekkefølgen tilleggene ble lagt inn i (også i samme transaksjon)
  oppdatert timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete cascade,
  check (fra is null or til is null or til >= fra)
);
create index ansatt_tillegg_ansatt_idx on faktura.ansatt_tillegg (org_id, ansatt_id);

create trigger ansatt_tillegg_oppdatert before update on faktura.ansatt_tillegg
  for each row execute function faktura.sett_oppdatert();
create trigger ansatt_tillegg_org_id before update on faktura.ansatt_tillegg
  for each row execute function faktura.org_id_uendret();
create trigger ansatt_tillegg_revisjon after insert or update or delete on faktura.ansatt_tillegg
  for each row execute function faktura.revider();

alter table faktura.ansatt_tillegg enable row level security;
create policy ansatt_tillegg_les on faktura.ansatt_tillegg for select
  using (faktura.kan(org_id, 'personal_les') or faktura.er_meg(org_id, ansatt_id));
create policy ansatt_tillegg_ny on faktura.ansatt_tillegg for insert with check (faktura.kan(org_id, 'personal'));
create policy ansatt_tillegg_endre on faktura.ansatt_tillegg for update
  using (faktura.kan(org_id, 'personal')) with check (faktura.kan(org_id, 'personal'));
create policy ansatt_tillegg_slett on faktura.ansatt_tillegg for delete using (faktura.kan(org_id, 'personal'));

grant select, delete, insert (org_id, ansatt_id, navn, belop, per, fra, til), update (navn, belop, per, fra, til)
  on faktura.ansatt_tillegg to faktura_app;

-- Loggen for tilleggene er, som for lønnen på de ansatte, bare for dem som ser de ansatte.
drop policy revisjonslogg_les on faktura.revisjonslogg;
create policy revisjonslogg_les on faktura.revisjonslogg for select
  using (faktura.kan(org_id, 'les')
         and (coalesce(tabell, '') not in ('ansatte', 'ansatt_tillegg', 'fravaer', 'arbeidsplaner', 'ferie_overforinger') or faktura.kan(org_id, 'personal_les'))
         and (coalesce(tabell, '') not in ('fravaer', 'ferie_overforinger') or faktura.kan(org_id, 'personal')));

-- Ansatte kan også importeres (med de faste tilleggene), under funksjonen Import.
update faktura.funksjoner set beskrivelse = 'Import av kunder, produkter og ansatte fra andre systemer' where kode = 'import';
