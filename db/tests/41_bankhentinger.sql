-- Hentingene fra bankene (0066_bankhentinger.sql): bare workeren lagrer dem, alle medlemmer ser
-- organisasjonens hentinger, andre ser ingenting, og de siste 200 beholdes. Hentingene blir
-- stående når banken fjernes.

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
grant execute on all functions in schema test to public;

\c :api
select id as u from faktura.registrer_bruker('uid-hentinger', 'hentinger@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Hentinger AS', '923609016') \gset
insert into faktura.bankkoblinger (org_id, bank, psu_type) values (:'org', 'DNB', 'business') returning id as dnb \gset

-- Appen lagrer, endrer og rydder ikke hentinger.
select test.feiler(format($$insert into faktura.bankhentinger (org_id, bank, kilde) values (%L, 'DNB', 'manuell')$$, :'org'), '42501');
select test.feiler(format($$select faktura.rydd_bankhentinger(%L)$$, :'org'), '42501');

-- Workeren lagrer hentingene (bare de kjente kildene), men endrer dem ikke i ettertid.
\c :worker
insert into faktura.bankhentinger (org_id, kobling_id, bank, kilde, fra, kontoer, transaksjoner, inn, ventende, nyeste)
values (:'org', :'dnb', 'DNB', 'automatisk', '2026-10-03', 1, 4, 0, 1, '2026-10-07');
insert into faktura.bankhentinger (org_id, kobling_id, bank, kilde, fra, kontoer, transaksjoner, inn, nye, koblet, nyeste)
values (:'org', :'dnb', 'DNB', 'manuell', '2026-10-03', 1, 5, 1, 1, 1, '2026-10-08');
insert into faktura.bankhentinger (org_id, kobling_id, bank, kilde, feil)
values (:'org', :'dnb', 'DNB', 'apnet', 'Banken svarte ikke (503)');
select test.feiler(format($$insert into faktura.bankhentinger (org_id, bank, kilde) values (%L, 'DNB', 'cron')$$, :'org'), '23514');
select test.feiler(format($$update faktura.bankhentinger set nye = 9 where org_id = %L$$, :'org'), '42501');
select test.er((select string_agg(kilde || ':' || transaksjoner || ':' || inn || ':' || ventende || ':' || nye, ',' order by id)
                  from faktura.bankhentinger where org_id = :'org'),
               'automatisk:4:0:1:0,manuell:5:1:0:1,apnet:0:0:0:0', 'workeren lagret hentingene');

-- Et medlem med lesetilgang ser hentingene, men kan ikke slette dem.
\c :api
select id as u2 from faktura.registrer_bruker('uid-hentinger-les', 'les-hentinger@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select faktura.inviter_medlem(:'org', 'les-hentinger@test.no', 'les') as token \gset
select set_config('app.bruker_id', :'u2', false);
select faktura.aksepter_invitasjon(:'token');
select test.er((select count(*)::int from faktura.bankhentinger), 3, 'lesetilgang ser hentingene');
select test.feiler(format($$delete from faktura.bankhentinger where org_id = %L$$, :'org'), '42501');

-- Andre ser ingenting.
select id as u3 from faktura.registrer_bruker('uid-hentinger-annen', 'annen-hentinger@test.no') \gset
select set_config('app.bruker_id', :'u3', false);
select test.er((select count(*)::int from faktura.bankhentinger), 0, 'andre ser ikke hentingene');

-- De siste 200 beholdes.
\c :worker
insert into faktura.bankhentinger (org_id, kobling_id, bank, kilde, transaksjoner)
select :'org', :'dnb', 'DNB', 'automatisk', n from generate_series(1, 202) n;
select faktura.rydd_bankhentinger(:'org');
select test.er((select count(*)::int from faktura.bankhentinger where org_id = :'org'), 200, 'de siste 200 er igjen');
select test.er((select min(transaksjoner) from faktura.bankhentinger where org_id = :'org'), 3, 'de eldste er ryddet bort');
select faktura.rydd_bankhentinger(:'org');
select test.er((select count(*)::int from faktura.bankhentinger where org_id = :'org'), 200, 'rydder ikke mer enn nødvendig');

-- Hentingene blir stående når banken fjernes.
\c :api
select set_config('app.bruker_id', :'u', false);
delete from faktura.bankkoblinger where id = :'dnb';
select test.er((select count(*)::int from faktura.bankhentinger where kobling_id is null), 200, 'hentingene er beholdt uten banken');

\c :migrator
drop schema test cascade;
\echo '  ok'
