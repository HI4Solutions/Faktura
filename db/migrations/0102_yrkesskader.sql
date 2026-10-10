-- Yrkesskader (Lønn K8; yrkesskader.ts, Yrkesskader.tsx). Alle arbeidsgivere skal ha
-- yrkesskadeforsikring for de ansatte (selskapet og polisenummeret i lønnsoppsettet). Arbeidsgiveren
-- skal registrere personskadene under arbeidet (arbeidsmiljøloven § 5-1; registeret skal være
-- tilgjengelig for verneombud, arbeidsmiljøutvalg, bedriftshelsetjeneste og Arbeidstilsynet), sende
-- skademelding til NAV så snart som mulig, også når det er tvil, og melde skaden til
-- forsikringsselskapet, og varsle Arbeidstilsynet og politiet straks ved dødsfall eller alvorlig
-- personskade (§ 5-2). Registeret har helseopplysninger: bare eier og administrator (som fraværet).
alter table faktura.lonn_oppsett
  add column yrkesskade_selskap text check (length(yrkesskade_selskap) <= 200),
  add column yrkesskade_polise text check (length(yrkesskade_polise) <= 100);
grant insert (yrkesskade_selskap, yrkesskade_polise), update (yrkesskade_selskap, yrkesskade_polise) on faktura.lonn_oppsett to faktura_app;

create table faktura.yrkesskader (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  ansatt_id uuid not null,
  dato date not null,
  klokkeslett time,
  type text not null default 'ulykke' check (type in ('ulykke', 'sykdom')), -- arbeidsulykke eller yrkessykdom
  sted text check (length(sted) <= 300),
  beskrivelse text not null check (length(btrim(beskrivelse)) between 1 and 4000), -- hva som skjedde
  skade text check (length(skade) <= 1000),                                         -- skaden (kroppsdel, art)
  alvorlig boolean not null default false,                                          -- dødsfall eller alvorlig personskade
  fravaer boolean not null default false,                                           -- førte til sykefravær
  tiltak text check (length(tiltak) <= 2000),                                       -- for å hindre at det skjer igjen
  meldt_nav date,
  meldt_forsikring date,
  meldt_arbeidstilsynet date,
  meldt_politi date,
  opprettet_av uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null,
  opprettet timestamptz not null default now(),
  oppdatert timestamptz not null default now(),
  unique (org_id, id),
  constraint yrkesskader_ansatt foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id)
);
create index yrkesskader_dato on faktura.yrkesskader (org_id, dato);
create trigger yrkesskader_oppdatert before update on faktura.yrkesskader
  for each row execute function faktura.sett_oppdatert();
create trigger yrkesskader_org_id before update on faktura.yrkesskader
  for each row execute function faktura.org_id_uendret();
create trigger yrkesskader_revisjon after insert or update or delete on faktura.yrkesskader
  for each row execute function faktura.revider();

alter table faktura.yrkesskader enable row level security;
create policy yrkesskader_les on faktura.yrkesskader for select using (faktura.kan(org_id, 'personal'));
create policy yrkesskader_ny on faktura.yrkesskader for insert with check (faktura.kan(org_id, 'personal'));
create policy yrkesskader_endre on faktura.yrkesskader for update using (faktura.kan(org_id, 'personal')) with check (faktura.kan(org_id, 'personal'));
create policy yrkesskader_slett on faktura.yrkesskader for delete using (faktura.kan(org_id, 'personal'));
grant select, insert, update, delete on faktura.yrkesskader to faktura_app;

-- Revisjonsloggen for registeret er, som for fraværet, bare for eier og administrator.
drop policy revisjonslogg_les on faktura.revisjonslogg;
create policy revisjonslogg_les on faktura.revisjonslogg for select
  using (faktura.kan(org_id, 'les')
         and (coalesce(tabell, '') not in ('ansatte', 'ansatt_tillegg', 'fravaer', 'arbeidsplaner', 'ferie_overforinger', 'vaktbytter',
                                           'lonnskjoringer', 'lonn_inngaende', 'timebank_poster', 'avspasering_soknader',
                                           'ameldinger', 'bilag', 'lonnsendringer', 'nav_inntektsmeldinger', 'lonnstrekk',
                                           'naturalytelser', 'reiseregninger', 'nav_refusjoner', 'afp_premier', 'virksomheter', 'yrkesskader')
              or faktura.kan(org_id, 'personal_les'))
         and (coalesce(tabell, '') not in ('anleggsmidler', 'regnskap_oppsett', 'saldo_satser', 'periodiseringer', 'utgifter', 'utgift_linjer',
                                           'bankregler', 'mva_terminer', 'aarsoppgjor', 'mva_justeringer')
              or faktura.kan(org_id, 'regnskap'))
         and (coalesce(tabell, '') not in ('fravaer', 'ferie_overforinger', 'avspasering_soknader', 'vaktbytter', 'nav_inntektsmeldinger',
                                           'nav_refusjoner', 'yrkesskader')
              or faktura.kan(org_id, 'personal')));
