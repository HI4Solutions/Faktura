-- Felles rapportmodul (server/src/rapportmodul.ts): rapportene fra Faktura, Personal, Lønn og
-- modulene som kommer, med eksport (CSV og PDF) og utsending på e-post til regnskapsføreren.
--
-- rapport_oppsett: hvem rapportene sendes til (regnskapsføreren), og hva som sendes av seg selv:
-- lønnsrapportene når en lønnskjøring godkjennes, og de valgte månedsrapportene den 1. i måneden
-- (for forrige måned). Bare eier og administrator endrer det. Nye mottakere gir en hendelse, og
-- alle eiere får e-post: den som får rapportene, får lønn og personopplysninger.
-- rapport_utsendinger: det som er sendt (manuelt eller av seg selv), og til hvem.
-- rapport_maanedsutsendinger: måneden månedsrapportene er lagt i kø for, per organisasjon, så de
-- sendes én gang (også om den daglige jobben kjøres flere ganger den 1.).

create table faktura.rapport_oppsett (
  org_id uuid primary key references faktura.organisasjoner(id) on delete cascade,
  mottakere text[] not null default '{}' check (cardinality(mottakere) <= 10 and faktura.epostliste_ok(mottakere)),
  lonn_ved_godkjenning boolean not null default false,
  maanedlig text[] not null default '{}' check (cardinality(maanedlig) <= 40),
  oppdatert timestamptz not null default now(),
  oppdatert_av uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null
);
create trigger rapport_oppsett_oppdatert before update on faktura.rapport_oppsett
  for each row execute function faktura.sett_oppdatert();
-- Hvem som endret sist (den som la inn oppsettet står fra før, som standardverdi).
create function faktura.rapport_oppsett_endret_av() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.oppdatert_av := coalesce(faktura.bruker_id(), old.oppdatert_av);
  return new;
end $$;
create trigger rapport_oppsett_endret_av before update on faktura.rapport_oppsett
  for each row execute function faktura.rapport_oppsett_endret_av();
create trigger rapport_oppsett_org_id before update on faktura.rapport_oppsett
  for each row execute function faktura.org_id_uendret();
create trigger rapport_oppsett_revisjon after insert or update or delete on faktura.rapport_oppsett
  for each row execute function faktura.revider();

alter table faktura.rapport_oppsett enable row level security;
create policy rapport_oppsett_les on faktura.rapport_oppsett for select using (faktura.kan(org_id, 'les'));
create policy rapport_oppsett_ny on faktura.rapport_oppsett for insert with check (faktura.kan(org_id, 'admin'));
create policy rapport_oppsett_endre on faktura.rapport_oppsett for update
  using (faktura.kan(org_id, 'admin')) with check (faktura.kan(org_id, 'admin'));
grant select, insert (org_id, mottakere, lonn_ved_godkjenning, maanedlig),
      update (mottakere, lonn_ved_godkjenning, maanedlig)
  on faktura.rapport_oppsett to faktura_app;

-- Nye mottakere: alle eiere får e-post (som når kopiadressen eller kontonummeret endres).
create function faktura.rapport_oppsett_etter() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  nye text[];
begin
  select coalesce(array_agg(e), '{}') into nye
    from unnest(new.mottakere) e
   where tg_op = 'INSERT' or not (lower(e) = any (select lower(x) from unnest(old.mottakere) x));
  if cardinality(nye) > 0 then
    insert into faktura.utboks (org_id, hendelse, aggregat_id, data)
    values (new.org_id, 'organisasjon.rapportmottakere_endret', new.org_id,
            jsonb_build_object('nye', to_jsonb(nye), 'alle', to_jsonb(new.mottakere), 'endret_av', faktura.bruker_id()));
  end if;
  return null;
end $$;
create trigger rapport_oppsett_etter after insert or update of mottakere on faktura.rapport_oppsett
  for each row execute function faktura.rapport_oppsett_etter();

create table faktura.rapport_utsendinger (
  id bigint generated always as identity primary key,
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  tid timestamptz not null default now(),
  til text[] not null,
  rapporter jsonb not null default '[]',   -- [{ id, navn, periode }]
  automatisk text check (automatisk in ('lonn', 'maaned')),  -- null: sendt av en bruker
  sendt_av uuid references faktura.brukere(id) on delete set null,
  feil text
);
create index rapport_utsendinger_org_idx on faktura.rapport_utsendinger (org_id, tid desc);
alter table faktura.rapport_utsendinger enable row level security;
create policy rapport_utsendinger_les on faktura.rapport_utsendinger for select using (faktura.kan(org_id, 'les'));
create policy rapport_utsendinger_system on faktura.rapport_utsendinger for all
  using (faktura.er_system()) with check (faktura.er_system());
grant select on faktura.rapport_utsendinger to faktura_app;
grant insert (org_id, til, rapporter, automatisk, sendt_av, feil) on faktura.rapport_utsendinger to faktura_system;

create table faktura.rapport_maanedsutsendinger (
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  maaned date not null check (extract(day from maaned) = 1),  -- måneden rapportene gjelder
  planlagt timestamptz not null default now(),
  primary key (org_id, maaned)
);
alter table faktura.rapport_maanedsutsendinger enable row level security;
create policy rapport_maanedsutsendinger_system on faktura.rapport_maanedsutsendinger for all
  using (faktura.er_system()) with check (faktura.er_system());
grant select, insert (org_id, maaned), delete on faktura.rapport_maanedsutsendinger to faktura_system;
