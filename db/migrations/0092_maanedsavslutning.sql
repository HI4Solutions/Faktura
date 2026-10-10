-- 0092_maanedsavslutning.sql
-- Månedsavslutningen går av seg selv (server/src/maanedsavslutning.ts): når en måned er over,
-- bokfører workeren avskrivningene og periodiseringene for den (et bilag per måned i serie A og P,
-- som når brukeren bokfører dem under Regnskap → Bilag), lagrer det som ble gjort og sjekklisten for
-- måneden (bankpostene, utgiftene, lønnen, avskrivningene og periodiseringene), og eier,
-- administrator og regnskapsføreren får et varsel med det som gjenstår.

-- maaned_auto: månedsavslutningen går av seg selv (ellers bokfører brukeren den).
-- maaned_fra: den første måneden som bokføres av seg selv; workeren setter den til måneden som er
--   over, første gang den går for organisasjonen. Avskrivninger eller periodiseringer fra før den
--   som ikke er bokført, bokføres ikke av seg selv (brukeren bokfører dem), og til de er bokført,
--   venter automatikken.
alter table faktura.regnskap_oppsett
  add column maaned_auto boolean not null default true,
  add column maaned_fra date check (maaned_fra is null or extract(day from maaned_fra) = 1);
grant insert (maaned_auto), update (maaned_auto) on faktura.regnskap_oppsett to faktura_app;
grant insert (org_id, maaned_fra), update (maaned_fra) on faktura.regnskap_oppsett to faktura_system;

-- Månedsavslutningene som har gått av seg selv, én per organisasjon og måned: når, bilagene som ble
-- bokført, sjekklisten (punktene med status og tekst), hvorfor avskrivningene og periodiseringene
-- ikke ble bokført (sperret), og om varselet er sendt.
create table faktura.maanedsavslutninger (
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  maaned date not null check (extract(day from maaned) = 1),
  tid timestamptz not null default now(),
  bilag uuid[] not null default '{}',
  punkter jsonb not null default '[]' check (jsonb_typeof(punkter) = 'array'),
  sperret text check (sperret is null or length(sperret) <= 500),
  varslet boolean not null default false,
  primary key (org_id, maaned)
);
alter table faktura.maanedsavslutninger enable row level security;
create policy maanedsavslutninger_les on faktura.maanedsavslutninger for select using (faktura.kan(org_id, 'regnskap'));
create policy maanedsavslutninger_system on faktura.maanedsavslutninger for all using (faktura.er_system()) with check (faktura.er_system());
grant select on faktura.maanedsavslutninger to faktura_app;
grant insert (org_id, maaned, tid, bilag, punkter, sperret, varslet), update (tid, bilag, punkter, sperret, varslet)
  on faktura.maanedsavslutninger to faktura_system;
create trigger maanedsavslutninger_org_id before update on faktura.maanedsavslutninger
  for each row execute function faktura.org_id_uendret();
