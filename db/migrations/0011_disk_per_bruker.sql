-- 0011_disk_per_bruker.sql
-- Google Disk kobles per bruker (privat eller bedriftskonto). Brukeren velger hvilke
-- organisasjoner som skal kopieres; fakturaene havner i «HI4 Faktura/<org>/<år>/».

create table faktura.disk_koblinger (
  bruker_id uuid primary key references faktura.brukere(id) on delete cascade,
  google_epost text,
  status text not null default 'aktiv' check (status in ('aktiv', 'feil')),
  rotmappe text not null,
  hemmelighet_kryptert bytea not null,          -- refresh token, kryptert med Cloud KMS
  siste_feil text,
  opprettet timestamptz not null default now(),
  oppdatert timestamptz not null default now()
);

create table faktura.disk_organisasjoner (
  bruker_id uuid not null references faktura.disk_koblinger(bruker_id) on delete cascade,
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  aktiv boolean not null default true,
  mappe text,                                   -- mappen for organisasjonen
  aarsmapper jsonb not null default '{}',       -- {"2026": "<mappe-id>"}
  sist_kopiert timestamptz,
  primary key (bruker_id, org_id)
);
create index disk_organisasjoner_org_idx on faktura.disk_organisasjoner (org_id) where aktiv;

create trigger disk_koblinger_oppdatert before update on faktura.disk_koblinger
  for each row execute function faktura.sett_oppdatert();

alter table faktura.disk_koblinger enable row level security;
alter table faktura.disk_organisasjoner enable row level security;

create policy disk_koblinger_egne on faktura.disk_koblinger for all
  using (bruker_id = faktura.bruker_id() or faktura.er_system())
  with check (bruker_id = faktura.bruker_id() or faktura.er_system());

-- Bare organisasjoner brukeren har tilgang til, kan velges.
create policy disk_organisasjoner_egne on faktura.disk_organisasjoner for all
  using (bruker_id = faktura.bruker_id() or faktura.er_system())
  with check ((bruker_id = faktura.bruker_id() and faktura.kan(org_id, 'les')) or faktura.er_system());

grant select (bruker_id, google_epost, status, rotmappe, siste_feil, opprettet, oppdatert),
      insert, delete,
      update (google_epost, status, rotmappe, hemmelighet_kryptert, siste_feil)
  on faktura.disk_koblinger to faktura_app;
grant select (hemmelighet_kryptert) on faktura.disk_koblinger to faktura_system;
grant select, insert, delete, update (aktiv, mappe, aarsmapper, sist_kopiert) on faktura.disk_organisasjoner to faktura_app;

-- Har brukeren fortsatt lesetilgang til organisasjonen? Brukes av workeren, som
-- ikke kjører som brukeren.
create function faktura.bruker_kan_lese(_bruker uuid, _org uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if not faktura.er_system() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  return exists (
    select 1 from faktura.medlemmer m where m.org_id = _org and m.bruker_id = _bruker
    union all
    select 1 from faktura.org_tilgang t join faktura.medlemmer bm on bm.org_id = t.byraa_org_id and bm.bruker_id = _bruker
     where t.klient_org_id = _org and t.status = 'aktiv' and (t.utloper is null or t.utloper >= faktura.i_dag())
  );
end $$;

grant execute on function faktura.bruker_kan_lese(uuid, uuid) to faktura_system;

-- Den gamle koblingen per organisasjon erstattes.
delete from faktura.integrasjoner where type = 'google_drive';
