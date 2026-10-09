-- Ekstratimer uten overtid (0069_ekstratimer_uten_overtid.sql): en føring kan merkes uten
-- overtid, men ikke samtidig som overtid, og valget kan ikke endres når timene er lønnet.

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
select id as u from faktura.registrer_bruker('uid-uten-overtid', 'uten-overtid@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Uten Overtid AS', '915000029') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, lonnstype, maanedslonn)
values (:'org', 'Ola', 'Ekstra', '2026-01-01', 'maaned', 50000) returning id as ola \gset

-- Uten overtid, men ikke både uten overtid og overtid.
insert into faktura.timeforinger (org_id, ansatt_id, dato, timer, uten_overtid)
values (:'org', :'ola', '2026-10-03', 4, true) returning id as t \gset
select test.er((select uten_overtid from faktura.timeforinger where id = :'t'), true, 'uten overtid');
select test.feiler(format($$update faktura.timeforinger set overtid_prosent = 50 where id = %L$$, :'t'), '23514');
update faktura.timeforinger set uten_overtid = false, overtid_prosent = 50 where id = :'t';
update faktura.timeforinger set overtid_prosent = null, uten_overtid = true where id = :'t';

-- Lønnet: valget kan ikke endres.
insert into faktura.lonnskjoringer (org_id, periode, utbetalingsdato) values (:'org', '2026-10-01', '2026-10-20') returning id as k \gset
\c :migrator
update faktura.timeforinger set lonnskjoring_id = :'k' where id = :'t';
\c :api
select set_config('app.bruker_id', :'u', false);
select test.feiler(format($$update faktura.timeforinger set uten_overtid = false where id = %L$$, :'t'), 'FA409');
select test.er((select uten_overtid from faktura.timeforinger where id = :'t'), true, 'fortsatt uten overtid');

\c :migrator
drop schema test cascade;
\echo '  ok'
