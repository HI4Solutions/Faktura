-- 0037_tavle_og_fravaer.sql
-- Ressursfordeling (tavla), fravær og vikarer.
--
-- Tavla deler dagen i faser (rader, f.eks. forvakt, mellomvakt og senvakt, eller før og etter
-- lunsj) og oppgaver (kolonner, f.eks. telefon, lab og resepsjon), som organisasjonen lager
-- selv. Ressursene en dag er de ansatte med vakt den dagen i vaktplanen, uten dem som er
-- borte; eier og administrator plasserer dem i oppgavene (tavle_plasseringer, én oppgave per
-- ansatt og fase).
--
-- Fravær (sykdom, sykt barn, ferie, permisjon, annet) registreres av eier og administrator,
-- og den ansatte kan selv melde sykdom. Vaktene til den som er borte, står igjen i planen (de
-- teller med for sykepenger senere), og en vikar settes inn på en egen vakt
-- (vakter.vikar_for). Fravær er helseopplysninger: bare de som ser de ansatte (personal_les),
-- og den ansatte selv, ser det, også i revisjonsloggen.

-- ---------------------------------------------------------------------------
-- Fravær
-- ---------------------------------------------------------------------------

create table faktura.fravaer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  ansatt_id uuid not null,
  type text not null check (type in ('syk', 'sykt_barn', 'ferie', 'permisjon', 'annet')),
  fra date not null,
  til date not null,
  notat text check (notat is null or length(notat) <= 500),
  opprettet_av uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null,
  opprettet timestamptz not null default now(),
  oppdatert timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete cascade,
  check (til >= fra and til - fra <= 366)
);
create index fravaer_ansatt_idx on faktura.fravaer (org_id, ansatt_id, fra);
create index fravaer_dato_idx on faktura.fravaer (org_id, til, fra);

create function faktura.fravaer_foer() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a faktura.ansatte;
begin
  if tg_op = 'UPDATE' and new.ansatt_id is distinct from old.ansatt_id then
    raise exception 'Fraværet kan ikke flyttes til en annen ansatt' using errcode = 'FA400';
  end if;
  -- Den ansatte selv: bare sykdom, fra og med i går, og deretter bare sluttdatoen.
  if not faktura.kan(new.org_id, 'personal') then
    if new.type not in ('syk', 'sykt_barn') then
      raise exception 'Du kan bare melde sykdom selv' using errcode = 'FA403';
    end if;
    if tg_op = 'INSERT' and new.fra < faktura.i_dag() - 1 then
      raise exception 'Sykdom kan meldes fra og med i går' using errcode = 'FA400';
    end if;
    if tg_op = 'UPDATE' and (new.fra <> old.fra or new.type <> old.type) then
      raise exception 'Du kan bare endre sluttdatoen' using errcode = 'FA403';
    end if;
  end if;
  if new.til < new.fra then raise exception 'Sluttdatoen er før startdatoen' using errcode = 'FA400'; end if;
  if new.til - new.fra > 366 then raise exception 'Fraværet kan være høyst ett år om gangen' using errcode = 'FA400'; end if;
  new.notat := nullif(btrim(new.notat), '');
  select * into a from faktura.ansatte where org_id = new.org_id and id = new.ansatt_id;
  if found and (new.fra < a.ansatt_fra or (a.ansatt_til is not null and new.til > a.ansatt_til)) then
    raise exception 'Fraværet er utenfor ansettelsen (%–%)', to_char(a.ansatt_fra, 'DD.MM.YYYY'),
      coalesce(to_char(a.ansatt_til, 'DD.MM.YYYY'), '') using errcode = 'FA400';
  end if;
  if exists (select 1 from faktura.fravaer f
              where f.org_id = new.org_id and f.ansatt_id = new.ansatt_id and f.id <> new.id
                and daterange(f.fra, f.til, '[]') && daterange(new.fra, new.til, '[]')) then
    raise exception 'Den ansatte har allerede fravær i perioden' using errcode = 'FA409';
  end if;
  return new;
end $$;

create trigger fravaer_foer before insert or update on faktura.fravaer
  for each row execute function faktura.fravaer_foer();
create trigger fravaer_oppdatert before update on faktura.fravaer
  for each row execute function faktura.sett_oppdatert();
create trigger fravaer_org_id before update on faktura.fravaer
  for each row execute function faktura.org_id_uendret();
create trigger fravaer_revisjon after insert or update or delete on faktura.fravaer
  for each row execute function faktura.revider();

alter table faktura.fravaer enable row level security;
create policy fravaer_les on faktura.fravaer for select
  using (faktura.kan(org_id, 'personal_les') or faktura.er_meg(org_id, ansatt_id));
create policy fravaer_ny on faktura.fravaer for insert
  with check (faktura.kan(org_id, 'personal') or faktura.er_meg(org_id, ansatt_id));
create policy fravaer_endre on faktura.fravaer for update
  using (faktura.kan(org_id, 'personal') or (faktura.er_meg(org_id, ansatt_id) and type in ('syk', 'sykt_barn')))
  with check (faktura.kan(org_id, 'personal') or faktura.er_meg(org_id, ansatt_id));
create policy fravaer_slett on faktura.fravaer for delete
  using (faktura.kan(org_id, 'personal') or (faktura.er_meg(org_id, ansatt_id) and type in ('syk', 'sykt_barn')));

grant select, delete on faktura.fravaer to faktura_app;
grant insert (org_id, ansatt_id, type, fra, til, notat), update (type, fra, til, notat)
  on faktura.fravaer to faktura_app;

-- Er den ansatte borte denne dagen? Typen, eller null.
create function faktura.fravaer_type(_org uuid, _ansatt uuid, _dato date) returns text
language sql stable security definer set search_path = '' as $$
  select f.type from faktura.fravaer f
   where f.org_id = _org and f.ansatt_id = _ansatt and _dato between f.fra and f.til
   limit 1
$$;

-- ---------------------------------------------------------------------------
-- Tavla: faser, oppgaver og plasseringer
-- ---------------------------------------------------------------------------

-- Fasene har gjerne et tidsrom: de som har vakt i (deler av) det, er ressursene i fasen.
create table faktura.tavle_faser (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  navn text not null check (length(navn) between 1 and 40),
  fra time,
  til time,                                      -- før fra: over midnatt
  rekkefolge int not null default 0,
  opprettet timestamptz not null default now(),
  unique (org_id, id),
  check ((fra is null) = (til is null)),
  check (fra is null or fra <> til)
);

-- behov: hvor mange som trengs i oppgaven i hver fase (null: ikke angitt).
create table faktura.tavle_oppgaver (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  navn text not null check (length(navn) between 1 and 40),
  behov int check (behov is null or behov between 1 and 50),
  rekkefolge int not null default 0,
  opprettet timestamptz not null default now(),
  unique (org_id, id)
);

create table faktura.tavle_plasseringer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  dato date not null,
  fase_id uuid not null,
  oppgave_id uuid not null,
  ansatt_id uuid not null,
  opprettet_av uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null,
  opprettet timestamptz not null default now(),
  unique (org_id, dato, fase_id, ansatt_id),     -- én oppgave per ansatt og fase
  foreign key (org_id, fase_id) references faktura.tavle_faser(org_id, id) on delete cascade,
  foreign key (org_id, oppgave_id) references faktura.tavle_oppgaver(org_id, id) on delete cascade,
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete cascade
);
create index tavle_plasseringer_dato_idx on faktura.tavle_plasseringer (org_id, dato);

-- Den som plasseres, er aktiv, ansatt og ikke borte den dagen.
create function faktura.tavle_plassering_foer() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a faktura.ansatte;
  borte text;
begin
  select * into a from faktura.ansatte where org_id = new.org_id and id = new.ansatt_id;
  if not found then return new; end if;
  if not a.aktiv or new.dato < a.ansatt_fra or (a.ansatt_til is not null and new.dato > a.ansatt_til) then
    raise exception '% % er ikke ansatt denne dagen', a.fornavn, a.etternavn using errcode = 'FA400';
  end if;
  borte := faktura.fravaer_type(new.org_id, new.ansatt_id, new.dato);
  if borte is not null then
    raise exception '% % er borte denne dagen (%)', a.fornavn, a.etternavn,
      case borte when 'syk' then 'syk' when 'sykt_barn' then 'sykt barn' when 'ferie' then 'ferie'
                 when 'permisjon' then 'permisjon' else 'fravær' end using errcode = 'FA409';
  end if;
  return new;
end $$;

create trigger tavle_plasseringer_foer before insert or update on faktura.tavle_plasseringer
  for each row execute function faktura.tavle_plassering_foer();
create trigger tavle_faser_org_id before update on faktura.tavle_faser
  for each row execute function faktura.org_id_uendret();
create trigger tavle_oppgaver_org_id before update on faktura.tavle_oppgaver
  for each row execute function faktura.org_id_uendret();
create trigger tavle_plasseringer_org_id before update on faktura.tavle_plasseringer
  for each row execute function faktura.org_id_uendret();

-- Fasene og oppgavene ser alle (også den ansatte, for sine egne plasser); planen styres av
-- personal, og plasseringene ser personal_les og den ansatte selv.
alter table faktura.tavle_faser enable row level security;
alter table faktura.tavle_oppgaver enable row level security;
alter table faktura.tavle_plasseringer enable row level security;
create policy tavle_faser_les on faktura.tavle_faser for select using (faktura.kan(org_id, 'medlem'));
create policy tavle_faser_ny on faktura.tavle_faser for insert with check (faktura.kan(org_id, 'personal'));
create policy tavle_faser_endre on faktura.tavle_faser for update
  using (faktura.kan(org_id, 'personal')) with check (faktura.kan(org_id, 'personal'));
create policy tavle_faser_slett on faktura.tavle_faser for delete using (faktura.kan(org_id, 'personal'));
create policy tavle_oppgaver_les on faktura.tavle_oppgaver for select using (faktura.kan(org_id, 'medlem'));
create policy tavle_oppgaver_ny on faktura.tavle_oppgaver for insert with check (faktura.kan(org_id, 'personal'));
create policy tavle_oppgaver_endre on faktura.tavle_oppgaver for update
  using (faktura.kan(org_id, 'personal')) with check (faktura.kan(org_id, 'personal'));
create policy tavle_oppgaver_slett on faktura.tavle_oppgaver for delete using (faktura.kan(org_id, 'personal'));
create policy tavle_plasseringer_les on faktura.tavle_plasseringer for select
  using (faktura.kan(org_id, 'personal_les') or faktura.er_meg(org_id, ansatt_id));
create policy tavle_plasseringer_ny on faktura.tavle_plasseringer for insert with check (faktura.kan(org_id, 'personal'));
create policy tavle_plasseringer_endre on faktura.tavle_plasseringer for update
  using (faktura.kan(org_id, 'personal')) with check (faktura.kan(org_id, 'personal'));
create policy tavle_plasseringer_slett on faktura.tavle_plasseringer for delete using (faktura.kan(org_id, 'personal'));

grant select, delete, insert (org_id, navn, fra, til, rekkefolge), update (navn, fra, til, rekkefolge)
  on faktura.tavle_faser to faktura_app;
grant select, delete, insert (org_id, navn, behov, rekkefolge), update (navn, behov, rekkefolge)
  on faktura.tavle_oppgaver to faktura_app;
grant select, delete, insert (org_id, dato, fase_id, oppgave_id, ansatt_id), update (oppgave_id)
  on faktura.tavle_plasseringer to faktura_app;

-- ---------------------------------------------------------------------------
-- Vikarer
-- ---------------------------------------------------------------------------

-- En vikarvakt dekker en annen vakt (den som er borte, beholder sin).
alter table faktura.vakter add column vikar_for uuid;
alter table faktura.vakter add constraint vakter_vikar_fk
  foreign key (org_id, vikar_for) references faktura.vakter(org_id, id) on delete set null (vikar_for);
alter table faktura.vakter add constraint vakter_vikar_ikke_seg_selv check (vikar_for is null or vikar_for <> id);
create index vakter_vikar_idx on faktura.vakter (vikar_for) where vikar_for is not null;
grant insert (vikar_for) on faktura.vakter to faktura_app;

-- Publiser én vakt (en vikarvakt i dag skal ut med en gang, uten resten av uka).
create function faktura.publiser_vakt(_org uuid, _vakt uuid) returns faktura.vakter
language plpgsql security definer set search_path = '' as $$
declare
  v faktura.vakter;
begin
  perform faktura.krev(_org, 'personal');
  update faktura.vakter set publisert_at = coalesce(publisert_at, now())
   where org_id = _org and id = _vakt
  returning * into v;
  if not found then raise exception 'Fant ikke vakten' using errcode = 'FA404'; end if;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- Revisjonsloggen
-- ---------------------------------------------------------------------------

-- Loggen for ansatte og fravær vises bare for dem som ser de ansatte.
drop policy revisjonslogg_les on faktura.revisjonslogg;
create policy revisjonslogg_les on faktura.revisjonslogg for select
  using (faktura.kan(org_id, 'les') and (coalesce(tabell, '') not in ('ansatte', 'fravaer') or faktura.kan(org_id, 'personal_les')));

-- ---------------------------------------------------------------------------
-- Funksjoner
-- ---------------------------------------------------------------------------

revoke all on function faktura.fravaer_foer(), faktura.fravaer_type(uuid, uuid, date), faktura.tavle_plassering_foer(),
  faktura.publiser_vakt(uuid, uuid) from public;
grant execute on function faktura.publiser_vakt(uuid, uuid) to faktura_app;
