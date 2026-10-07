-- 0036_vaktplan.sql
-- Vaktplan (andre steg av bemanning og lønn).
--
-- Eier og administrator (personal) planlegger vakter per dag og ansatt. Vaktene er utkast til
-- de publiseres (publiser_vakter); da ser den ansatte sine egne, og får varsel. En vakt uten
-- ansatt er ledig: aktive ansatte ser publiserte ledige vakter og kan ta en (ta_vakt), så
-- lenge den ikke er passert og ikke overlapper en annen vakt de har. Regnskap ser planen.
-- Timene kan føres fra vakten (timeforinger.vakt_id), så planlagt og ført kan sammenlignes.
--
-- Arbeidsmiljølovens regler (hviletid, overtid) sjekkes som advarsler i API-et
-- (server/src/vaktregler.ts): planen kan ha grunner til å avvike, som en avtale om kortere
-- hvile.

-- Den innloggedes egen aktive ansattrad i organisasjonen (koblet og fortsatt medlem), eller null.
create function faktura.min_ansatt(_org uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select a.id
    from faktura.ansatte a
    join faktura.medlemmer m on m.org_id = a.org_id and m.bruker_id = a.bruker_id
   where a.org_id = _org and a.bruker_id = faktura.bruker_id() and a.aktiv
$$;

-- Tiden vakten dekker (over midnatt når til er før fra), til å finne overlapp.
create function faktura.vakt_tid(_dato date, _fra time, _til time) returns tsrange
language sql immutable set search_path = '' as $$
  select tsrange(_dato + _fra, _dato + _til + case when _til <= _fra then interval '1 day' else interval '0' end)
$$;

-- ---------------------------------------------------------------------------
-- Vakter
-- ---------------------------------------------------------------------------

create table faktura.vakter (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  ansatt_id uuid,                                -- null: ledig vakt
  dato date not null,                            -- dagen vakten starter
  fra time not null,
  til time not null,                             -- før fra: over midnatt
  pause_min int not null default 0 check (pause_min between 0 and 600),
  timer numeric(5,2) not null check (timer > 0 and timer <= 24),
  oppgave text check (oppgave is null or length(oppgave) <= 60),   -- f.eks. «Kasse» eller «Lager»
  notat text check (notat is null or length(notat) <= 500),
  publisert_at timestamptz,                      -- null: utkast, som bare de som planlegger ser
  opprettet_av uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null,
  opprettet timestamptz not null default now(),
  oppdatert timestamptz not null default now(),
  unique (org_id, id),
  -- Slettes den ansatte, blir vaktene ledige.
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete set null (ansatt_id)
);
create index vakter_dato_idx on faktura.vakter (org_id, dato);
create index vakter_ansatt_idx on faktura.vakter (org_id, ansatt_id, dato);

create function faktura.vakt_foer() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a faktura.ansatte;
  minutter int;
begin
  if new.fra = new.til then raise exception 'Fra og til kan ikke være like' using errcode = 'FA400'; end if;
  minutter := (extract(epoch from (new.til - new.fra)) / 60)::int;
  if minutter < 0 then minutter := minutter + 24 * 60; end if;
  minutter := minutter - new.pause_min;
  if minutter <= 0 then raise exception 'Pausen er like lang som vakten' using errcode = 'FA400'; end if;
  new.timer := round(minutter / 60.0, 2);
  new.oppgave := nullif(btrim(new.oppgave), '');
  new.notat := nullif(btrim(new.notat), '');
  -- En ansatt settes på vakten (eller vakten flyttes): aktiv, og ansatt den dagen.
  if new.ansatt_id is not null and (tg_op = 'INSERT' or new.ansatt_id is distinct from old.ansatt_id or new.dato <> old.dato) then
    select * into a from faktura.ansatte where org_id = new.org_id and id = new.ansatt_id;
    if found then
      if not a.aktiv then
        raise exception '% % er ikke aktiv', a.fornavn, a.etternavn using errcode = 'FA400';
      end if;
      if new.dato < a.ansatt_fra or (a.ansatt_til is not null and new.dato > a.ansatt_til) then
        raise exception 'Datoen er utenfor ansettelsen til % % (%–%)', a.fornavn, a.etternavn,
          to_char(a.ansatt_fra, 'DD.MM.YYYY'), coalesce(to_char(a.ansatt_til, 'DD.MM.YYYY'), '') using errcode = 'FA400';
      end if;
    end if;
  end if;
  return new;
end $$;

create trigger vakter_foer before insert or update on faktura.vakter
  for each row execute function faktura.vakt_foer();
create trigger vakter_oppdatert before update on faktura.vakter
  for each row execute function faktura.sett_oppdatert();
create trigger vakter_org_id before update on faktura.vakter
  for each row execute function faktura.org_id_uendret();
create trigger vakter_revisjon after insert or update or delete on faktura.vakter
  for each row execute function faktura.revider();

-- Planen: personal endrer, personal_les (også regnskap) ser alt. Den ansatte ser sine egne
-- publiserte vakter og de publiserte ledige.
alter table faktura.vakter enable row level security;
create policy vakter_les on faktura.vakter for select
  using (
    faktura.kan(org_id, 'personal_les')
    or (publisert_at is not null
        and (faktura.er_meg(org_id, ansatt_id) or (ansatt_id is null and faktura.min_ansatt(org_id) is not null)))
  );
create policy vakter_ny on faktura.vakter for insert with check (faktura.kan(org_id, 'personal'));
create policy vakter_endre on faktura.vakter for update
  using (faktura.kan(org_id, 'personal')) with check (faktura.kan(org_id, 'personal'));
create policy vakter_slett on faktura.vakter for delete using (faktura.kan(org_id, 'personal'));

-- Timene regnes ut av triggeren, og publiseringen skjer bare gjennom publiser_vakter.
grant select, delete on faktura.vakter to faktura_app;
grant insert (org_id, ansatt_id, dato, fra, til, pause_min, oppgave, notat),
      update (ansatt_id, dato, fra, til, pause_min, oppgave, notat)
  on faktura.vakter to faktura_app;

-- Publiser utkastene i perioden. Gir vaktene som ble publisert (til varslene).
create function faktura.publiser_vakter(_org uuid, _fra date, _til date) returns setof faktura.vakter
language plpgsql security definer set search_path = '' as $$
begin
  perform faktura.krev(_org, 'personal');
  if _til < _fra or _til - _fra > 62 then raise exception 'Ugyldig periode' using errcode = 'FA400'; end if;
  return query
    with publisert as (
      update faktura.vakter set publisert_at = now()
       where org_id = _org and dato between _fra and _til and publisert_at is null
      returning *
    )
    select * from publisert;
end $$;

-- Ta en ledig vakt: publisert, ikke passert, og uten overlapp med egne vakter. Raden låses,
-- så bare den første som tar vakten, får den.
create function faktura.ta_vakt(_org uuid, _vakt uuid) returns faktura.vakter
language plpgsql security definer set search_path = '' as $$
declare
  meg uuid := faktura.min_ansatt(_org);
  v faktura.vakter;
begin
  if meg is null then raise exception 'Du er ikke registrert som aktiv ansatt her' using errcode = 'FA403'; end if;
  select * into v from faktura.vakter where org_id = _org and id = _vakt for update;
  if not found or v.publisert_at is null then raise exception 'Fant ikke vakten' using errcode = 'FA404'; end if;
  if v.ansatt_id is not null then raise exception 'Vakten er ikke ledig lenger' using errcode = 'FA409'; end if;
  if v.dato < faktura.i_dag() then raise exception 'Vakten er passert' using errcode = 'FA409'; end if;
  if exists (select 1 from faktura.vakter o
              where o.org_id = _org and o.ansatt_id = meg and o.id <> v.id
                and faktura.vakt_tid(o.dato, o.fra, o.til) && faktura.vakt_tid(v.dato, v.fra, v.til)) then
    raise exception 'Du har allerede en vakt som overlapper' using errcode = 'FA409';
  end if;
  update faktura.vakter set ansatt_id = meg where id = v.id returning * into v;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- Timer fra vakten
-- ---------------------------------------------------------------------------

alter table faktura.timeforinger add column vakt_id uuid;
alter table faktura.timeforinger add constraint timeforinger_vakt_fk
  foreign key (org_id, vakt_id) references faktura.vakter(org_id, id) on delete set null (vakt_id);
create index timeforinger_vakt_idx on faktura.timeforinger (vakt_id) where vakt_id is not null;
-- Koblingen settes når føringen lages, og endres ikke.
grant insert (vakt_id) on faktura.timeforinger to faktura_app;

-- Som i 0035, og: vakten må være den ansattes egen (og publisert, for andre enn personal).
create or replace function faktura.timer_foer() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a faktura.ansatte;
  minutter int;
begin
  -- Vakten ble slettet: fremmednøkkelen fjerner koblingen, og ingenting annet endres.
  if tg_op = 'UPDATE' and old.vakt_id is not null and new.vakt_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.ansatt_id is distinct from old.ansatt_id then
    raise exception 'Timene kan ikke flyttes til en annen ansatt' using errcode = 'FA400';
  end if;
  -- Fra–til gir timene, over midnatt om til er før fra.
  if new.fra is not null and new.til is not null then
    if new.fra = new.til then raise exception 'Fra og til kan ikke være like' using errcode = 'FA400'; end if;
    minutter := (extract(epoch from (new.til - new.fra)) / 60)::int;
    if minutter < 0 then minutter := minutter + 24 * 60; end if;
    minutter := minutter - new.pause_min;
    if minutter <= 0 then raise exception 'Pausen er like lang som arbeidstiden' using errcode = 'FA400'; end if;
    new.timer := round(minutter / 60.0, 2);
  end if;
  new.beskrivelse := nullif(btrim(new.beskrivelse), '');
  select * into a from faktura.ansatte where org_id = new.org_id and id = new.ansatt_id;
  if new.dato < a.ansatt_fra or (a.ansatt_til is not null and new.dato > a.ansatt_til) then
    raise exception 'Datoen er utenfor ansettelsen (%–%)', to_char(a.ansatt_fra, 'DD.MM.YYYY'),
      coalesce(to_char(a.ansatt_til, 'DD.MM.YYYY'), '') using errcode = 'FA400';
  end if;
  if not a.aktiv and not faktura.kan(new.org_id, 'personal') then
    raise exception 'Du er ikke lenger registrert som ansatt' using errcode = 'FA403';
  end if;
  if new.vakt_id is not null and (tg_op = 'INSERT' or new.vakt_id is distinct from old.vakt_id) then
    if not exists (select 1 from faktura.vakter v
                    where v.org_id = new.org_id and v.id = new.vakt_id and v.ansatt_id = new.ansatt_id
                      and (v.publisert_at is not null or faktura.kan(new.org_id, 'personal'))) then
      raise exception 'Vakten hører ikke til den ansatte' using errcode = 'FA400';
    end if;
  end if;
  -- Endret etter at timene ble avvist: et nytt utkast som leveres på nytt.
  if tg_op = 'UPDATE' and old.status = 'avvist' and new.status = 'avvist' then
    new.status := 'utkast';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Funksjoner
-- ---------------------------------------------------------------------------

revoke all on function faktura.min_ansatt(uuid), faktura.vakt_foer(), faktura.publiser_vakter(uuid, date, date),
  faktura.ta_vakt(uuid, uuid) from public;
grant execute on function faktura.min_ansatt(uuid), faktura.publiser_vakter(uuid, date, date),
  faktura.ta_vakt(uuid, uuid) to faktura_app;
