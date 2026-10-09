-- Lønns- og stillingsendringer med virkningsdato (server/src/lonnsendringer.ts, server/src/lonn.ts,
-- web/src/sider/Lonnsendringer.tsx).
--
-- Lønnen og stillingen til en ansatt har en historikk. Hver endring gjelder fra en dato og har bare
-- feltene som endres (lønnstypen, månedslønnen, timelønnen og stillingsprosenten; tomt felt er
-- uendret). Det som gjelder en dag, er det siste som er satt for hvert felt; før den første raden
-- gjelder den første raden. Endringer slettes ikke, men merkes som slettet, så lønnskjøringen ser
-- hva som var kjent da en kjøring ble godkjent (etterbetaling eller trekk når en endring gjelder
-- tilbake i tid).
--
-- Feltene på den ansatte er det som gjelder i dag. Endres de på den ansatte (skjemaet, importen,
-- AI-assistenten), blir det en endring fra i dag, eller fra datoen API-et setter
-- (faktura.lonn_gjelder_fra); en endring fram i tid endrer ikke feltene før dagen kommer (workeren
-- hver morgen). Datoene for siste lønns- og stillingsendring (a-meldingen) følger historikken.

create table faktura.lonnsendringer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  ansatt_id uuid not null,
  gjelder_fra date not null,
  lonnstype text check (lonnstype is null or lonnstype in ('maaned', 'time')),
  maanedslonn numeric(12,2) check (maanedslonn is null or maanedslonn >= 0),
  timelonn numeric(10,2) check (timelonn is null or timelonn >= 0),
  stillingsprosent numeric(5,2) check (stillingsprosent is null or (stillingsprosent > 0 and stillingsprosent <= 100)),
  grunn text check (grunn is null or length(grunn) <= 300),
  opprettet timestamptz not null default clock_timestamp(),
  opprettet_av uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null,
  slettet timestamptz,
  slettet_av uuid references faktura.brukere(id) on delete set null,
  check (lonnstype is not null or maanedslonn is not null or timelonn is not null or stillingsprosent is not null),
  unique (org_id, id),
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete cascade
);
create unique index lonnsendringer_dato on faktura.lonnsendringer (org_id, ansatt_id, gjelder_fra) where slettet is null;
create index lonnsendringer_ansatt on faktura.lonnsendringer (org_id, ansatt_id, gjelder_fra);
create trigger lonnsendringer_revisjon after insert or update on faktura.lonnsendringer
  for each row execute function faktura.revider();

-- Historikken ser de som ser lønnen, og den ansatte sin egen. Bare funksjonene skriver.
alter table faktura.lonnsendringer enable row level security;
create policy lonnsendringer_les on faktura.lonnsendringer for select
  using (faktura.kan(org_id, 'personal_les') or faktura.er_meg(org_id, ansatt_id));
grant select on faktura.lonnsendringer to faktura_app, faktura_system;

-- Det som gjelder for den ansatte en dag (felt for felt, fra de gjeldende endringene). Med
-- tilgangen til den som kaller (radene den kan se).
create function faktura.lonn_gjeldende(_org uuid, _ansatt uuid, _dato date)
returns table (lonnstype text, maanedslonn numeric, timelonn numeric, stillingsprosent numeric)
language sql stable set search_path = '' as $$
  with r as (
    select * from faktura.lonnsendringer
     where org_id = _org and ansatt_id = _ansatt and slettet is null
       and (gjelder_fra <= _dato or gjelder_fra = (select min(gjelder_fra) from faktura.lonnsendringer
                                                    where org_id = _org and ansatt_id = _ansatt and slettet is null))
  )
  select (select r.lonnstype from r where r.lonnstype is not null order by r.gjelder_fra desc limit 1),
         (select r.maanedslonn from r where r.maanedslonn is not null order by r.gjelder_fra desc limit 1),
         (select r.timelonn from r where r.timelonn is not null order by r.gjelder_fra desc limit 1),
         (select r.stillingsprosent from r where r.stillingsprosent is not null order by r.gjelder_fra desc limit 1)
$$;

-- Lagrer en endring fra en dato: en endring som alt gjelder fra datoen, merkes som slettet og
-- slås sammen med den nye (de nye feltene vinner). Før den første raden (startdatoen er flyttet
-- tidligere) får den nye raden feltene den mangler fra den første, så den første alltid er hel.
create function faktura.lagre_lonnsendring(_org uuid, _ansatt uuid, _fra date, _lonnstype text, _maanedslonn numeric,
                                           _timelonn numeric, _stillingsprosent numeric, _grunn text)
returns faktura.lonnsendringer
language plpgsql security definer set search_path = '' as $$
declare
  g faktura.lonnsendringer;
  n faktura.lonnsendringer;
begin
  if _lonnstype is null and _maanedslonn is null and _timelonn is null and _stillingsprosent is null then
    raise exception 'Endringen har ingen felt' using errcode = 'FA400';
  end if;
  update faktura.lonnsendringer set slettet = clock_timestamp(), slettet_av = faktura.bruker_id()
   where org_id = _org and ansatt_id = _ansatt and gjelder_fra = _fra and slettet is null
   returning * into g;
  if g.id is null then
    select * into g from faktura.lonnsendringer
     where org_id = _org and ansatt_id = _ansatt and slettet is null and gjelder_fra > _fra
       and gjelder_fra = (select min(gjelder_fra) from faktura.lonnsendringer where org_id = _org and ansatt_id = _ansatt and slettet is null);
    g.grunn := null;
  end if;
  insert into faktura.lonnsendringer (org_id, ansatt_id, gjelder_fra, lonnstype, maanedslonn, timelonn, stillingsprosent, grunn)
  values (_org, _ansatt, _fra, coalesce(_lonnstype, g.lonnstype), coalesce(_maanedslonn, g.maanedslonn), coalesce(_timelonn, g.timelonn),
          coalesce(_stillingsprosent, g.stillingsprosent), coalesce(nullif(btrim(_grunn), ''), g.grunn))
  returning * into n;
  return n;
end $$;

-- Datoene for siste lønns- og stillingsendring (etter den første raden) en dag, eller null.
create function faktura.lonn_endringsdatoer(_org uuid, _ansatt uuid, _dato date, out lonn date, out stilling date)
language sql stable set search_path = '' as $$
  with r as (
    select * from faktura.lonnsendringer
     where org_id = _org and ansatt_id = _ansatt and slettet is null and gjelder_fra <= _dato
       and gjelder_fra > (select min(gjelder_fra) from faktura.lonnsendringer where org_id = _org and ansatt_id = _ansatt and slettet is null)
  )
  select (select max(gjelder_fra) from r where lonnstype is not null or maanedslonn is not null or timelonn is not null),
         (select max(gjelder_fra) from r where stillingsprosent is not null)
$$;

-- Feltene på den ansatte settes til det som gjelder i dag (uten å lage en ny endring).
create function faktura.oppdater_gjeldende_lonn(_org uuid, _ansatt uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  g record;
  d record;
begin
  select * into g from faktura.lonn_gjeldende(_org, _ansatt, faktura.i_dag());
  select * into d from faktura.lonn_endringsdatoer(_org, _ansatt, faktura.i_dag());
  perform set_config('faktura.lonn_synk', 'på', true);
  update faktura.ansatte a
     set lonnstype = coalesce(g.lonnstype, a.lonnstype),
         maanedslonn = coalesce(g.maanedslonn, a.maanedslonn),
         timelonn = coalesce(g.timelonn, a.timelonn),
         stillingsprosent = coalesce(g.stillingsprosent, a.stillingsprosent),
         siste_lonnsendring = coalesce(d.lonn, a.siste_lonnsendring),
         siste_stillingsendring = coalesce(d.stilling, a.siste_stillingsendring)
   where a.org_id = _org and a.id = _ansatt
     and (a.lonnstype, a.maanedslonn, a.timelonn, a.stillingsprosent, a.siste_lonnsendring, a.siste_stillingsendring)
         is distinct from (coalesce(g.lonnstype, a.lonnstype), coalesce(g.maanedslonn, a.maanedslonn), coalesce(g.timelonn, a.timelonn),
                           coalesce(g.stillingsprosent, a.stillingsprosent), coalesce(d.lonn, a.siste_lonnsendring),
                           coalesce(d.stilling, a.siste_stillingsendring));
  perform set_config('faktura.lonn_synk', '', true);
end $$;

-- Endres lønnen eller stillingsprosenten på den ansatte, blir det en endring fra i dag (eller
-- datoen i faktura.lonn_gjelder_fra, med grunnen i faktura.lonn_grunn). Fram i tid: feltene
-- beholdes til dagen kommer. Tilbake i tid: en senere endring av samme felt gjelder fortsatt.
-- Før den første raden (den ansatte har ikke begynt ennå): lønnen den ansatte begynner med, rettes.
create or replace function faktura.ansatt_endringsdatoer() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  d date;
  f date;
  forste boolean := false;
  i_dag date := faktura.i_dag();
  e record;
begin
  if coalesce(current_setting('faktura.lonn_synk', true), '') = 'på' then return new; end if;
  -- Ingen endring, eller bare felt som er tømt (et tomt felt er uendret i historikken).
  if (case when new.lonnstype is distinct from old.lonnstype then new.lonnstype end) is null
     and (case when new.maanedslonn is distinct from old.maanedslonn then new.maanedslonn end) is null
     and (case when new.timelonn is distinct from old.timelonn then new.timelonn end) is null
     and (case when new.stillingsprosent is distinct from old.stillingsprosent then new.stillingsprosent end) is null then
    return new;
  end if;
  d := nullif(current_setting('faktura.lonn_gjelder_fra', true), '')::date;
  if d < new.ansatt_fra then
    raise exception 'Endringen kan ikke gjelde fra før den ansatte begynte (%)', to_char(new.ansatt_fra, 'DD.MM.YYYY') using errcode = 'FA400';
  end if;
  if d > new.ansatt_til then
    raise exception 'Endringen kan ikke gjelde fra etter at den ansatte sluttet (%)', to_char(new.ansatt_til, 'DD.MM.YYYY') using errcode = 'FA400';
  end if;
  d := coalesce(d, i_dag);
  select min(gjelder_fra) into f from faktura.lonnsendringer where org_id = new.org_id and ansatt_id = new.id and slettet is null;
  if d < f then
    d := f;
    forste := true;
  end if;
  perform faktura.lagre_lonnsendring(new.org_id, new.id, d,
    case when new.lonnstype is distinct from old.lonnstype then new.lonnstype end,
    case when new.maanedslonn is distinct from old.maanedslonn then new.maanedslonn end,
    case when new.timelonn is distinct from old.timelonn then new.timelonn end,
    case when new.stillingsprosent is distinct from old.stillingsprosent then new.stillingsprosent end,
    nullif(current_setting('faktura.lonn_grunn', true), ''));
  if d > i_dag and not forste then
    new.lonnstype := old.lonnstype;
    new.maanedslonn := old.maanedslonn;
    new.timelonn := old.timelonn;
    new.stillingsprosent := old.stillingsprosent;
    return new;
  end if;
  select * into e from faktura.lonn_gjeldende(new.org_id, new.id, i_dag);
  -- Et felt som er endret senere enn datoen (og før i dag), beholder den senere verdien.
  if exists (select 1 from faktura.lonnsendringer r where r.org_id = new.org_id and r.ansatt_id = new.id and r.slettet is null
              and r.gjelder_fra > d and r.gjelder_fra <= i_dag and r.lonnstype is not null) then new.lonnstype := e.lonnstype; end if;
  if exists (select 1 from faktura.lonnsendringer r where r.org_id = new.org_id and r.ansatt_id = new.id and r.slettet is null
              and r.gjelder_fra > d and r.gjelder_fra <= i_dag and r.maanedslonn is not null) then new.maanedslonn := e.maanedslonn; end if;
  if exists (select 1 from faktura.lonnsendringer r where r.org_id = new.org_id and r.ansatt_id = new.id and r.slettet is null
              and r.gjelder_fra > d and r.gjelder_fra <= i_dag and r.timelonn is not null) then new.timelonn := e.timelonn; end if;
  if exists (select 1 from faktura.lonnsendringer r where r.org_id = new.org_id and r.ansatt_id = new.id and r.slettet is null
              and r.gjelder_fra > d and r.gjelder_fra <= i_dag and r.stillingsprosent is not null) then new.stillingsprosent := e.stillingsprosent; end if;
  if forste then return new; end if;
  select * into e from faktura.lonn_endringsdatoer(new.org_id, new.id, i_dag);
  if new.siste_lonnsendring is not distinct from old.siste_lonnsendring then
    new.siste_lonnsendring := coalesce(e.lonn, case when (new.lonnstype, new.maanedslonn, new.timelonn) is distinct from (old.lonnstype, old.maanedslonn, old.timelonn) then d end, old.siste_lonnsendring);
  end if;
  if new.siste_stillingsendring is not distinct from old.siste_stillingsendring then
    new.siste_stillingsendring := coalesce(e.stilling, case when new.stillingsprosent is distinct from old.stillingsprosent then d end, old.siste_stillingsendring);
  end if;
  return new;
end $$;

-- Den første raden (fra ansettelsen) når den ansatte legges inn.
create function faktura.ansatt_forste_lonn() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into faktura.lonnsendringer (org_id, ansatt_id, gjelder_fra, lonnstype, maanedslonn, timelonn, stillingsprosent, grunn)
  values (new.org_id, new.id, new.ansatt_fra, new.lonnstype, new.maanedslonn, new.timelonn, new.stillingsprosent, 'Ansatt');
  return new;
end $$;
create trigger ansatte_forste_lonn after insert on faktura.ansatte
  for each row execute function faktura.ansatt_forste_lonn();

-- De ansatte som finnes: den første raden fra ansettelsen med det som gjelder nå. Den ble kjent nå
-- (lønnskjøringer godkjent før dette får ikke etterbetaling av seg selv).
insert into faktura.lonnsendringer (org_id, ansatt_id, gjelder_fra, lonnstype, maanedslonn, timelonn, stillingsprosent, grunn, opprettet_av)
select org_id, id, ansatt_fra, lonnstype, maanedslonn, timelonn, stillingsprosent, 'Fra før lønnshistorikken', null from faktura.ansatte;

-- Eier og administrator legger inn en endring fra en dato (også fram i tid eller tilbake i tid).
create function faktura.ny_lonnsendring(_ansatt uuid, _fra date, _lonnstype text, _maanedslonn numeric, _timelonn numeric,
                                        _stillingsprosent numeric, _grunn text)
returns faktura.lonnsendringer
language plpgsql security definer set search_path = '' as $$
declare
  a faktura.ansatte;
  n faktura.lonnsendringer;
begin
  select * into a from faktura.ansatte where id = _ansatt;
  if a.id is null then raise exception 'Fant ikke den ansatte' using errcode = 'FA404'; end if;
  perform faktura.krev(a.org_id, 'personal');
  if _fra is null then raise exception 'Velg datoen endringen gjelder fra' using errcode = 'FA400'; end if;
  if _fra < a.ansatt_fra then
    raise exception 'Endringen kan ikke gjelde fra før den ansatte begynte (%)', to_char(a.ansatt_fra, 'DD.MM.YYYY') using errcode = 'FA400';
  end if;
  if a.ansatt_til is not null and _fra > a.ansatt_til then
    raise exception 'Endringen kan ikke gjelde fra etter at den ansatte sluttet (%)', to_char(a.ansatt_til, 'DD.MM.YYYY') using errcode = 'FA400';
  end if;
  if _lonnstype = 'maaned' and _maanedslonn is null and (select maanedslonn from faktura.lonn_gjeldende(a.org_id, a.id, _fra)) is null then
    raise exception 'Skriv månedslønnen' using errcode = 'FA400';
  end if;
  if _lonnstype = 'time' and _timelonn is null and (select timelonn from faktura.lonn_gjeldende(a.org_id, a.id, _fra)) is null then
    raise exception 'Skriv timelønnen' using errcode = 'FA400';
  end if;
  n := faktura.lagre_lonnsendring(a.org_id, a.id, _fra, _lonnstype, _maanedslonn, _timelonn, _stillingsprosent, _grunn);
  perform faktura.oppdater_gjeldende_lonn(a.org_id, a.id);
  return n;
end $$;

-- Eier og administrator sletter en endring (ikke den første raden). Den merkes som slettet.
create function faktura.slett_lonnsendring(_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r faktura.lonnsendringer;
begin
  select * into r from faktura.lonnsendringer where id = _id and slettet is null;
  if r.id is null then raise exception 'Fant ikke endringen' using errcode = 'FA404'; end if;
  perform faktura.krev(r.org_id, 'personal');
  if r.gjelder_fra = (select min(gjelder_fra) from faktura.lonnsendringer where org_id = r.org_id and ansatt_id = r.ansatt_id and slettet is null) then
    raise exception 'Den første lønnen kan ikke slettes; legg inn en endring i stedet' using errcode = 'FA409';
  end if;
  update faktura.lonnsendringer set slettet = clock_timestamp(), slettet_av = faktura.bruker_id() where id = r.id;
  perform faktura.oppdater_gjeldende_lonn(r.org_id, r.ansatt_id);
end $$;

-- Hver morgen (workeren): endringer som gjelder fra i dag, tas i bruk på de ansatte.
create function faktura.aktiver_lonnsendringer() returns int
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  n int := 0;
begin
  if not faktura.er_system() then raise exception 'Bare workeren' using errcode = 'FA403'; end if;
  for r in
    select distinct org_id, ansatt_id from faktura.lonnsendringer
     where slettet is null and gjelder_fra > faktura.i_dag() - 7 and gjelder_fra <= faktura.i_dag()
  loop
    perform faktura.oppdater_gjeldende_lonn(r.org_id, r.ansatt_id);
    n := n + 1;
  end loop;
  return n;
end $$;

revoke execute on function faktura.lonn_gjeldende(uuid, uuid, date), faktura.lagre_lonnsendring(uuid, uuid, date, text, numeric, numeric, numeric, text),
  faktura.lonn_endringsdatoer(uuid, uuid, date), faktura.oppdater_gjeldende_lonn(uuid, uuid), faktura.ny_lonnsendring(uuid, date, text, numeric, numeric, numeric, text),
  faktura.slett_lonnsendring(uuid), faktura.aktiver_lonnsendringer() from public;
grant execute on function faktura.ny_lonnsendring(uuid, date, text, numeric, numeric, numeric, text), faktura.slett_lonnsendring(uuid) to faktura_app;
grant execute on function faktura.lonn_gjeldende(uuid, uuid, date), faktura.lonn_endringsdatoer(uuid, uuid, date) to faktura_app, faktura_system;
grant execute on function faktura.aktiver_lonnsendringer() to faktura_system;

-- Lønnslinjene: perioden en linje gjelder når den ikke er kjøringens (etterbetaling og trekk for
-- tidligere måneder, i a-meldingen som opptjeningsperioden).
alter table faktura.lonnslinjer
  add column opptjent_fra date,
  add column opptjent_til date,
  add constraint lonnslinjer_opptjent check ((opptjent_fra is null) = (opptjent_til is null) and (opptjent_fra is null or opptjent_fra <= opptjent_til));
grant insert (opptjent_fra, opptjent_til), update (opptjent_fra, opptjent_til) on faktura.lonnslinjer to faktura_app;
