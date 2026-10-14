-- 0106_turnus.sql
-- Turnus i vaktplanen: vakttyper (f.eks. dagvakt, kveldsvakt og nattevakt) med klokkeslett, hvor
-- mange som trengs på hver vakttype hver ukedag (eventuelt per rolle), og hvilke vakttyper hver
-- ansatt kan gå. Vaktene er de vanlige vaktene i vaktplanen (0036) med vakttypen på, så
-- timeføringen, lønnen, tavla, vaktbyttene og varslene virker som før.
--
-- Automatisk turnus (server/src/turnusplan.ts) fordeler de ansatte på vaktene i en periode etter
-- behovet og reglene her (hviletid, dager og netter på rad, hver n-te helg) og den avtalte
-- arbeidstiden, uansett hvilke ukedager de pleier å jobbe. Vaktene lages som utkast, og kjøringen
-- huskes (turnus_kjoringer), så et nytt forslag kan erstatte det forrige og en kjøring kan angres.
-- Det som ikke kan fylles, kan bli ledige vakter for rollen: bare de med rollen kan ta dem.

-- ---------------------------------------------------------------------------
-- Vakttyper
-- ---------------------------------------------------------------------------

create table faktura.vakttyper (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  navn text not null check (length(navn) between 1 and 40),     -- «Dagvakt»
  kode text not null check (kode ~ '^[A-Za-z0-9ÆØÅæøå]{1,3}$'), -- «D» i turnusen
  fra time not null,
  til time not null,                                              -- før fra: over midnatt
  pause_min int not null default 0 check (pause_min between 0 and 600),
  timer numeric(5,2) not null check (timer > 0 and timer <= 24),  -- regnes ut av triggeren
  farge int not null default 0 check (farge between 0 and 7),
  aktiv boolean not null default true,                            -- false: står på gamle vakter, men velges ikke
  rekkefolge int not null default 0,
  opprettet timestamptz not null default now(),
  oppdatert timestamptz not null default now(),
  unique (org_id, id),
  check (fra <> til)
);
create unique index vakttyper_kode_idx on faktura.vakttyper (org_id, upper(kode));

create function faktura.vakttype_foer() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  minutter int;
begin
  new.navn := btrim(new.navn);
  new.kode := btrim(new.kode);
  minutter := (extract(epoch from (new.til - new.fra)) / 60)::int;
  if minutter <= 0 then minutter := minutter + 24 * 60; end if;
  minutter := minutter - new.pause_min;
  if minutter <= 0 then raise exception 'Pausen er like lang som vakten' using errcode = 'FA400'; end if;
  new.timer := round(minutter / 60.0, 2);
  if exists (select 1 from faktura.vakttyper t
              where t.org_id = new.org_id and t.id <> new.id and upper(t.kode) = upper(new.kode)) then
    raise exception 'Koden % er allerede i bruk', new.kode using errcode = 'FA409';
  end if;
  return new;
end $$;

create trigger vakttyper_foer before insert or update on faktura.vakttyper
  for each row execute function faktura.vakttype_foer();
create trigger vakttyper_oppdatert before update on faktura.vakttyper
  for each row execute function faktura.sett_oppdatert();
create trigger vakttyper_org_id before update on faktura.vakttyper
  for each row execute function faktura.org_id_uendret();
create trigger vakttyper_revisjon after insert or update or delete on faktura.vakttyper
  for each row execute function faktura.revider();

-- Alle som ser planen, ser vakttypene (kodene står på vaktene); personal styrer dem.
alter table faktura.vakttyper enable row level security;
create policy vakttyper_les on faktura.vakttyper for select using (faktura.kan(org_id, 'plan'));
create policy vakttyper_ny on faktura.vakttyper for insert with check (faktura.kan(org_id, 'personal'));
create policy vakttyper_endre on faktura.vakttyper for update
  using (faktura.kan(org_id, 'personal')) with check (faktura.kan(org_id, 'personal'));
create policy vakttyper_slett on faktura.vakttyper for delete using (faktura.kan(org_id, 'personal'));

grant select, delete on faktura.vakttyper to faktura_app;
grant insert (org_id, navn, kode, fra, til, pause_min, farge, aktiv, rekkefolge),
      update (navn, kode, fra, til, pause_min, farge, aktiv, rekkefolge)
  on faktura.vakttyper to faktura_app;

-- ---------------------------------------------------------------------------
-- Bemanningsbehovet: hvor mange på hver vakttype hver ukedag
-- ---------------------------------------------------------------------------

-- Med rolle: så mange med rollen. Uten rolle: så mange til, med hvilken som helst rolle. Behovet
-- legges sammen («2 sykepleiere og 1 til»). Helligdagene bemannes som søndager.
create table faktura.vakttype_behov (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  vakttype_id uuid not null,
  ukedag int not null check (ukedag between 1 and 7),            -- 1 = mandag
  rolle_id uuid,                                                  -- null: hvilken som helst rolle
  antall int not null check (antall between 1 and 50),
  foreign key (org_id, vakttype_id) references faktura.vakttyper(org_id, id) on delete cascade,
  foreign key (org_id, rolle_id) references faktura.ansattgrupper(org_id, id) on delete cascade
);
create unique index vakttype_behov_idx
  on faktura.vakttype_behov (org_id, vakttype_id, ukedag, coalesce(rolle_id, '00000000-0000-0000-0000-000000000000'::uuid));

create trigger vakttype_behov_org_id before update on faktura.vakttype_behov
  for each row execute function faktura.org_id_uendret();
create trigger vakttype_behov_revisjon after insert or update or delete on faktura.vakttype_behov
  for each row execute function faktura.revider();

alter table faktura.vakttype_behov enable row level security;
create policy vakttype_behov_les on faktura.vakttype_behov for select using (faktura.kan(org_id, 'plan'));
create policy vakttype_behov_ny on faktura.vakttype_behov for insert with check (faktura.kan(org_id, 'personal'));
create policy vakttype_behov_endre on faktura.vakttype_behov for update
  using (faktura.kan(org_id, 'personal')) with check (faktura.kan(org_id, 'personal'));
create policy vakttype_behov_slett on faktura.vakttype_behov for delete using (faktura.kan(org_id, 'personal'));

grant select, delete, insert (org_id, vakttype_id, ukedag, rolle_id, antall), update (antall)
  on faktura.vakttype_behov to faktura_app;

-- ---------------------------------------------------------------------------
-- Hvilke vakttyper den ansatte kan gå
-- ---------------------------------------------------------------------------

-- Den ansatte er med i den automatiske turnusen når de har minst én vakttype her (f.eks. bare
-- dagvakter, eller dag og kveld, men ikke natt).
create table faktura.ansatt_vakttyper (
  org_id uuid not null,
  ansatt_id uuid not null,
  vakttype_id uuid not null,
  primary key (ansatt_id, vakttype_id),
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete cascade,
  foreign key (org_id, vakttype_id) references faktura.vakttyper(org_id, id) on delete cascade
);
create index ansatt_vakttyper_org_idx on faktura.ansatt_vakttyper (org_id);

alter table faktura.ansatt_vakttyper enable row level security;
create policy ansatt_vakttyper_les on faktura.ansatt_vakttyper for select
  using (faktura.kan(org_id, 'personal_les') or faktura.er_meg(org_id, ansatt_id));
create policy ansatt_vakttyper_ny on faktura.ansatt_vakttyper for insert with check (faktura.kan(org_id, 'personal'));
create policy ansatt_vakttyper_slett on faktura.ansatt_vakttyper for delete using (faktura.kan(org_id, 'personal'));

grant select, delete, insert (org_id, ansatt_id, vakttype_id) on faktura.ansatt_vakttyper to faktura_app;

-- ---------------------------------------------------------------------------
-- Reglene for automatisk turnus
-- ---------------------------------------------------------------------------

-- hvile: minst så mange timer mellom to vakter (11 etter arbeidsmiljøloven § 10-8; ned mot 8 med
-- avtale). dager_paa_rad og netter_paa_rad: høyst så mange vakter (nattevakter) på rad. helg: den
-- ansatte jobber høyst hver n-te helg (1: alle helger). Uten rad gjelder standardverdiene.
create table faktura.turnus_regler (
  org_id uuid primary key references faktura.organisasjoner(id) on delete cascade,
  hvile numeric(3,1) not null default 11 check (hvile between 8 and 24),
  dager_paa_rad int not null default 5 check (dager_paa_rad between 1 and 14),
  netter_paa_rad int not null default 3 check (netter_paa_rad between 1 and 14),
  helg int not null default 3 check (helg between 1 and 6),
  oppdatert timestamptz not null default now()
);
create trigger turnus_regler_oppdatert before update on faktura.turnus_regler
  for each row execute function faktura.sett_oppdatert();
create trigger turnus_regler_revisjon after insert or update or delete on faktura.turnus_regler
  for each row execute function faktura.revider();

alter table faktura.turnus_regler enable row level security;
create policy turnus_regler_les on faktura.turnus_regler for select using (faktura.kan(org_id, 'plan'));
create policy turnus_regler_ny on faktura.turnus_regler for insert with check (faktura.kan(org_id, 'personal'));
create policy turnus_regler_endre on faktura.turnus_regler for update
  using (faktura.kan(org_id, 'personal')) with check (faktura.kan(org_id, 'personal'));

grant select, insert (org_id, hvile, dager_paa_rad, netter_paa_rad, helg), update (hvile, dager_paa_rad, netter_paa_rad, helg)
  on faktura.turnus_regler to faktura_app;

-- ---------------------------------------------------------------------------
-- Kjøringene av automatisk turnus
-- ---------------------------------------------------------------------------

create table faktura.turnus_kjoringer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  fra date not null,
  til date not null,
  vakter int not null default 0 check (vakter >= 0),   -- vakter med en ansatt på
  ledige int not null default 0 check (ledige >= 0),   -- ledige vakter for det som ikke ble fylt
  hull int not null default 0 check (hull >= 0),       -- behov som verken fikk en ansatt eller en ledig vakt
  opprettet_av uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null,
  opprettet timestamptz not null default now(),
  unique (org_id, id),
  check (til >= fra and til - fra <= 92)
);
create index turnus_kjoringer_org_idx on faktura.turnus_kjoringer (org_id, opprettet desc);
create trigger turnus_kjoringer_revisjon after insert or update or delete on faktura.turnus_kjoringer
  for each row execute function faktura.revider();

alter table faktura.turnus_kjoringer enable row level security;
create policy turnus_kjoringer_les on faktura.turnus_kjoringer for select using (faktura.kan(org_id, 'personal_les'));
create policy turnus_kjoringer_ny on faktura.turnus_kjoringer for insert with check (faktura.kan(org_id, 'personal'));
create policy turnus_kjoringer_slett on faktura.turnus_kjoringer for delete using (faktura.kan(org_id, 'personal'));

grant select, delete, insert (org_id, fra, til, vakter, ledige, hull) on faktura.turnus_kjoringer to faktura_app;

-- ---------------------------------------------------------------------------
-- Vaktene: vakttypen, rollen og kjøringen
-- ---------------------------------------------------------------------------

-- vakttype_id: vakttypen (slettes typen, beholder vakten klokkeslettene). rolle_id: rollen vakten
-- dekker i turnusen; en ledig vakt med rolle kan bare tas av dem med rollen. turnus_id: kjøringen
-- av automatisk turnus som laget vakten (null når den er laget eller endret for hånd).
alter table faktura.vakter
  add column vakttype_id uuid,
  add column rolle_id uuid,
  add column turnus_id uuid;
alter table faktura.vakter
  add constraint vakter_vakttype_fk foreign key (org_id, vakttype_id)
    references faktura.vakttyper(org_id, id) on delete set null (vakttype_id),
  add constraint vakter_rolle_fk foreign key (org_id, rolle_id)
    references faktura.ansattgrupper(org_id, id) on delete set null (rolle_id),
  add constraint vakter_turnus_fk foreign key (org_id, turnus_id)
    references faktura.turnus_kjoringer(org_id, id) on delete set null (turnus_id);
create index vakter_turnus_idx on faktura.vakter (turnus_id) where turnus_id is not null;
create index vakter_vakttype_idx on faktura.vakter (vakttype_id) where vakttype_id is not null;

grant insert (vakttype_id, rolle_id, turnus_id), update (vakttype_id, rolle_id, turnus_id) on faktura.vakter to faktura_app;

-- En vakt med vakttype får klokkeslettene og pausen fra typen når de ikke er oppgitt (en ny vakt
-- uten fra og til, eller en annen vakttype på en vakt uten nye klokkeslett), og en vakttype som
-- ikke er i bruk lenger, kan ikke velges. (Navnet gjør at triggeren går før vakter_foer, som
-- regner ut timene.)
create function faktura.vakt_vakttype() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  t faktura.vakttyper;
begin
  if new.vakttype_id is null or (tg_op = 'UPDATE' and new.vakttype_id is not distinct from old.vakttype_id) then
    return new;
  end if;
  select * into t from faktura.vakttyper where org_id = new.org_id and id = new.vakttype_id;
  if not found then raise exception 'Fant ikke vakttypen' using errcode = 'FA404'; end if;
  if not t.aktiv then raise exception 'Vakttypen % er ikke i bruk lenger', t.navn using errcode = 'FA400'; end if;
  if (tg_op = 'INSERT' and (new.fra is null or new.til is null))
     or (tg_op = 'UPDATE' and new.fra = old.fra and new.til = old.til and new.pause_min = old.pause_min) then
    new.fra := t.fra;
    new.til := t.til;
    new.pause_min := t.pause_min;
  end if;
  return new;
end $$;
create trigger vakter_av_vakttype before insert or update on faktura.vakter
  for each row execute function faktura.vakt_vakttype();

-- Som i 0036, og en ledig vakt for en rolle kan bare tas av dem med rollen.
create or replace function faktura.ta_vakt(_org uuid, _vakt uuid) returns faktura.vakter
language plpgsql security definer set search_path = '' as $$
declare
  meg uuid := faktura.min_ansatt(_org);
  v faktura.vakter;
  rolle text;
begin
  if meg is null then raise exception 'Du er ikke registrert som aktiv ansatt her' using errcode = 'FA403'; end if;
  select * into v from faktura.vakter where org_id = _org and id = _vakt for update;
  if not found or v.publisert_at is null then raise exception 'Fant ikke vakten' using errcode = 'FA404'; end if;
  if v.ansatt_id is not null then raise exception 'Vakten er ikke ledig lenger' using errcode = 'FA409'; end if;
  if v.dato < faktura.i_dag() then raise exception 'Vakten er passert' using errcode = 'FA409'; end if;
  if v.rolle_id is not null
     and not exists (select 1 from faktura.ansatte a where a.org_id = _org and a.id = meg and a.gruppe_id = v.rolle_id) then
    select g.navn into rolle from faktura.ansattgrupper g where g.org_id = _org and g.id = v.rolle_id;
    raise exception 'Vakten er for rollen %', coalesce(rolle, '') using errcode = 'FA403';
  end if;
  if exists (select 1 from faktura.vakter o
              where o.org_id = _org and o.ansatt_id = meg and o.id <> v.id
                and faktura.vakt_tid(o.dato, o.fra, o.til) && faktura.vakt_tid(v.dato, v.fra, v.til)) then
    raise exception 'Du har allerede en vakt som overlapper' using errcode = 'FA409';
  end if;
  update faktura.vakter set ansatt_id = meg where id = v.id returning * into v;
  return v;
end $$;

revoke all on function faktura.vakttype_foer(), faktura.vakt_vakttype() from public;
