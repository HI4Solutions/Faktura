-- Permisjon og permittering (0084_permisjon_permittering.sql): arten, prosenten og feltene for
-- permittering (bare på permisjon; permittering er aldri med lønn), lengden (en permisjon kan
-- vare i tre år), at delvis permisjon kan overlappe annet fravær men ikke en annen permisjon, at
-- delvis permisjon ikke gjør den ansatte borte (fravaer_type og planen), og at den ansatte ikke
-- registrerer permisjon selv.

\set QUIET on
\set ON_ERROR_STOP on

create schema test;
grant usage on schema test to public;
create function test.er(_faktisk anycompatible, _forventet anycompatible, _hva text) returns void language plpgsql as $$
begin
  if _faktisk is distinct from _forventet then
    raise exception 'FEIL %: fikk %, forventet %', _hva, _faktisk, _forventet;
  end if;
end $$;
create function test.feiler(_sql text, _kode text) returns void language plpgsql as $$
begin
  begin
    execute _sql;
  exception when others then
    if sqlstate = _kode then return; end if;
    raise exception 'Forventet % men fikk % (%) fra: %', _kode, sqlstate, sqlerrm, _sql;
  end;
  raise exception 'Forventet feil % fra: %', _kode, _sql;
end $$;
create function test.melding(_sql text) returns text language plpgsql as $$
begin
  execute _sql;
  return null;
exception when others then
  return sqlerrm;
end $$;
grant execute on all functions in schema test to public;

\c :api
select id as u from faktura.registrer_bruker('uid-perm-eier', 'eier-perm@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Permisjon AS', '915000290') \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, lonnstype, maanedslonn)
values (:'org', 'Ola', 'Perm', 'ola-perm@test.no', '2025-01-01', 'maaned', 40000) returning id as ola \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, lonnstype, maanedslonn)
values (:'org', 'Kari', 'Perm', '2025-01-01', 'maaned', 50000) returning id as kari \gset
select faktura.inviter_ansatt(:'org', :'ola') as t_ola \gset
select id as u_ola from faktura.registrer_bruker('uid-perm-ola', 'ola-perm@test.no') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');
select set_config('app.bruker_id', :'u', false);

-- Foreldrepermisjon over ett år (80 % dekning): lov for permisjon, ikke for annet fravær.
insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, permisjon_art)
values (:'org', :'kari', 'permisjon', '2026-03-01', '2027-04-15', 'foreldre') returning id as foreldre \gset
select test.er((select permisjon_art from faktura.fravaer where id = :'foreldre'), 'foreldre', 'arten er lagret');
select test.feiler(format($$insert into faktura.fravaer (org_id, ansatt_id, type, fra, til) values (%L, %L, 'syk', '2025-01-01', '2026-02-01')$$, :'org', :'kari'), 'FA400');
select test.feiler(format($$insert into faktura.fravaer (org_id, ansatt_id, type, fra, til) values (%L, %L, 'permisjon', '2025-01-01', '2028-02-01')$$, :'org', :'ola'), 'FA400');
-- Ukjent art avvises.
select test.feiler(format($$insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, permisjon_art) values (%L, %L, 'permisjon', '2026-01-05', '2026-01-06', 'sabbat')$$, :'org', :'ola'), '23514');

-- Feltene følger bare permisjon: ferie får dem ikke, og 100 % er det samme som ingen prosent.
insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, permisjon_art, prosent, slutt_ukjent)
values (:'org', :'ola', 'ferie', '2026-07-06', '2026-07-10', 'foreldre', 50, true) returning id as ferie \gset
select test.er((select row(permisjon_art, prosent, slutt_ukjent)::text from faktura.fravaer where id = :'ferie'), row(null::text, null::smallint, false)::text, 'ferie uten permisjonsfelt');
insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, permisjon_art, prosent)
values (:'org', :'ola', 'permisjon', '2026-01-12', '2026-01-13', 'annen', 100) returning id as kort \gset
select test.er((select prosent from faktura.fravaer where id = :'kort'), null::smallint, '100 % lagres som null');

-- Permittering: aldri med lønn (betalt og timer tas bort), varselet før starten, lønnsplikten ikke
-- før starten; varsel og lønnsplikt bare på permittering.
insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, permisjon_art, prosent, betalt, timer, varslet, lonnsplikt_til, slutt_ukjent, notat)
values (:'org', :'ola', 'permisjon', '2026-09-01', '2026-12-31', 'permittering', 50, true, 30, '2026-08-14', '2026-09-21', true, 'Ordremangel')
returning id as perm \gset
select test.er((select row(betalt, timer, prosent, varslet, lonnsplikt_til, slutt_ukjent)::text from faktura.fravaer where id = :'perm'),
               row(false, null::numeric, 50::smallint, '2026-08-14'::date, '2026-09-21'::date, true)::text, 'permitteringen');
select test.feiler(format($$update faktura.fravaer set varslet = '2026-09-02' where id = %L$$, :'perm'), '23514');
select test.feiler(format($$update faktura.fravaer set lonnsplikt_til = '2026-08-31' where id = %L$$, :'perm'), '23514');
update faktura.fravaer set permisjon_art = 'annen' where id = :'kort';
update faktura.fravaer set varslet = '2026-01-01', lonnsplikt_til = '2026-01-12' where id = :'kort';
select test.er((select row(varslet, lonnsplikt_til)::text from faktura.fravaer where id = :'kort'), row(null::date, null::date)::text, 'varsel og lønnsplikt bare på permittering');

-- Delvis permittering kan overlappe annet fravær (ferie i juli var før; nå sykdom i oktober), men
-- ikke en annen permisjon. Hel permisjon kan ikke overlappe annet fravær.
insert into faktura.fravaer (org_id, ansatt_id, type, fra, til) values (:'org', :'ola', 'syk', '2026-10-05', '2026-10-07') returning id as syk \gset
select test.er(test.melding(format($$insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, permisjon_art, prosent) values (%L, %L, 'permisjon', '2026-11-02', '2026-11-30', 'utdanning', 20)$$, :'org', :'ola')),
               'Den ansatte har allerede permisjon eller permittering i perioden', 'to permisjoner');
select test.er(test.melding(format($$insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, permisjon_art) values (%L, %L, 'permisjon', '2026-07-08', '2026-07-20', 'annen')$$, :'org', :'ola')),
               'Den ansatte har allerede fravær i perioden', 'hel permisjon over ferie');
-- Gjøres permitteringen hel, kolliderer den med sykdommen.
select test.feiler(format($$update faktura.fravaer set prosent = null where id = %L$$, :'perm'), 'FA409');

-- Planen viser ikke den delvise permitteringen (borte-sjekken under, som databasen selv).
select test.er((select count(*)::int from faktura.fravaer_plan where org_id = :'org' and id = :'perm'), 0, 'planen viser ikke den delvise');
select test.er((select count(*)::int from faktura.fravaer_plan where org_id = :'org' and id = :'foreldre'), 1, 'planen viser den hele');

-- Den ansatte registrerer ikke permisjon selv, og ser bare sin egen.
select set_config('app.bruker_id', :'u_ola', false);
select test.feiler(format($$insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, permisjon_art) values (%L, %L, 'permisjon', '2027-01-04', '2027-01-08', 'annen')$$, :'org', :'ola'), 'FA403');
select test.er((select count(*)::int from faktura.fravaer where org_id = :'org' and type = 'permisjon'), 2, 'Ola ser sine egne permisjoner');
select set_config('app.bruker_id', :'u', false);

-- Borte (fravaer_type brukes av tavla og vaktbyttene): sykdommen, ikke den delvise permitteringen.
\c :migrator
select test.er(faktura.fravaer_type(:'org', :'ola', '2026-10-06'::date), 'syk', 'syk midt i permitteringen');
select test.er(faktura.fravaer_type(:'org', :'ola', '2026-10-12'::date), null, 'delvis permittert er ikke borte');
select test.er(faktura.fravaer_type(:'org', :'kari', '2026-10-12'::date), 'permisjon', 'hel foreldrepermisjon er borte');
drop schema test cascade;
