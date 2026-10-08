-- Bemanningskalenderen (0039_bemanning.sql): de ansatte deles i grupper (f.eks. sekretærer
-- og leger) med hvor mange som trengs på jobb per dag. Gruppene ser de som ser de ansatte
-- (også regnskap), og bare eier og administrator endrer dem; en ansatt kan bare være i en
-- gruppe i samme organisasjon, og slettes gruppen, står den ansatte uten. Kurs er en
-- fraværstype som eier og administrator registrerer.

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
select id as u from faktura.registrer_bruker('uid-bem-eier', 'eier-bem@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Bemanning AS', '917654042') \gset
select id as org2 from faktura.opprett_organisasjon('Annen bemanning AS', '917654050') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
select faktura.i_dag() as d0, faktura.i_dag() - 30 as start \gset

-- Gruppene: navn, forkortelse og behov per dag.
insert into faktura.ansattgrupper (org_id, navn, kort, behov, rekkefolge) values (:'org', 'Sekretærer', 'Sek.', 4, 1) returning id as sek \gset
insert into faktura.ansattgrupper (org_id, navn, behov, rekkefolge) values (:'org', 'Leger', 7, 2) returning id as leg \gset
insert into faktura.ansattgrupper (org_id, navn) values (:'org2', 'Andre') returning id as annen \gset
select test.feiler(format($$insert into faktura.ansattgrupper (org_id, navn, behov) values (%L, 'For mange', 501)$$, :'org'), '23514');
select test.feiler(format($$insert into faktura.ansattgrupper (org_id, navn, kort) values (%L, 'Lang', 'Altforlang')$$, :'org'), '23514');

insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, gruppe_id) values (:'org', 'Aase', 'Sekretær', 'aase-bem@test.no', :'start', :'sek') returning id as aase \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra) values (:'org', 'Fahim', 'Lege', :'start') returning id as fahim \gset
update faktura.ansatte set gruppe_id = :'leg' where id = :'fahim';
select test.er((select gruppe_id from faktura.ansatte where id = :'fahim'), :'leg'::uuid, 'legen er i gruppen');
select test.feiler(format($$update faktura.ansatte set gruppe_id = %L where id = %L$$, :'annen', :'fahim'), '23503');

-- Kurs er fravær (registrert av eieren).
insert into faktura.fravaer (org_id, ansatt_id, type, fra, til) values (:'org', :'fahim', 'kurs', :'d0', :'d0');
select test.er((select type from faktura.fravaer where ansatt_id = :'fahim'), 'kurs', 'kurs er registrert');

-- Den ansatte ser ikke gruppene, endrer dem ikke og melder ikke kurs selv.
select faktura.inviter_ansatt(:'org', :'aase') as t_aase \gset
select id as u_aase from faktura.registrer_bruker('uid-bem-aase', 'aase-bem@test.no') \gset
select set_config('app.bruker_id', :'u_aase', false);
select faktura.aksepter_invitasjon(:'t_aase');
select test.er((select count(*) from faktura.ansattgrupper), 0::bigint, 'den ansatte ser ikke gruppene');
select test.feiler(format($$insert into faktura.ansattgrupper (org_id, navn) values (%L, 'Egen')$$, :'org'), '42501');
select test.feiler(format($$insert into faktura.fravaer (org_id, ansatt_id, type, fra, til) values (%L, %L, 'kurs', %L, %L)$$, :'org', :'aase', :'d0', :'d0'), 'FA403');

-- Regnskap ser gruppene, men endrer dem ikke.
select set_config('app.bruker_id', :'u', false);
select id as u_regn from faktura.registrer_bruker('uid-bem-regn', 'regn-bem@test.no') \gset
select faktura.inviter_medlem(:'org', 'regn-bem@test.no', 'regnskap') as tr \gset
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'tr');
select test.er((select count(*) from faktura.ansattgrupper), 2::bigint, 'regnskap ser gruppene');
update faktura.ansattgrupper set behov = 1 where id = :'leg';
select set_config('app.bruker_id', :'u', false);
select test.er((select behov from faktura.ansattgrupper where id = :'leg'), 7, 'men endrer dem ikke');

-- Slettes gruppen, står den ansatte uten gruppe.
delete from faktura.ansattgrupper where id = :'leg';
select test.er((select gruppe_id from faktura.ansatte where id = :'fahim'), null::uuid, 'legen står uten gruppe');

\c :migrator
drop schema test cascade;
\echo '  ok'
