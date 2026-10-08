-- Beskjeder (0062_beskjeder.sql): en beskjed til roller ses av de aktive med rollene, av den som
-- skrev den og av eier og administrator; en beskjed til alle ses av alle. Den som skrev den, og eier og
-- administrator, kan slette den. Navnet til den som skrev den, kommer fra ansattregisteret.

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
select id as u from faktura.registrer_bruker('uid-beskjed-eier', 'eier-beskjed@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Beskjeder AS', '917654301') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
insert into faktura.ansattgrupper (org_id, navn) values (:'org', 'Sekretær') returning id as sek \gset
insert into faktura.ansattgrupper (org_id, navn, ikke_ansatt) values (:'org', 'Lege', true) returning id as lege \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, gruppe_id) values (:'org', 'Ola', 'Sekretær', 'ola-beskjed@test.no', '2025-01-01', :'sek') returning id as ola \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, gruppe_id) values (:'org', 'Lise', 'Lege', 'lise-beskjed@test.no', '2025-01-01', :'lege') returning id as lise \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, gruppe_id) values (:'org', 'Per', 'Lege', 'per-beskjed@test.no', '2025-01-01', :'lege') returning id as per \gset
select faktura.inviter_ansatt(:'org', :'ola') as t_ola \gset
select faktura.inviter_ansatt(:'org', :'lise') as t_lise \gset
select faktura.inviter_ansatt(:'org', :'per') as t_per \gset
select id as u_ola from faktura.registrer_bruker('uid-beskjed-ola', 'ola-beskjed@test.no') \gset
select id as u_lise from faktura.registrer_bruker('uid-beskjed-lise', 'lise-beskjed@test.no') \gset
select id as u_per from faktura.registrer_bruker('uid-beskjed-per', 'per-beskjed@test.no') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');
select set_config('app.bruker_id', :'u_lise', false);
select faktura.aksepter_invitasjon(:'t_lise');
select set_config('app.bruker_id', :'u_per', false);
select faktura.aksepter_invitasjon(:'t_per');

-- Ola (sekretær) skriver til legene; navnet kommer fra ansattregisteret.
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select count(*) from faktura.beskjed_roller(:'org')), 2::bigint, 'den ansatte ser rollene å skrive til');
insert into faktura.beskjeder (org_id, tekst, roller, push) values (:'org', '  Husk møtet kl. 12  ', array[:'lege'::uuid, :'lege'::uuid], true)
  returning id as b1, tekst as b1_tekst, forfatter_navn as b1_navn, cardinality(roller) as b1_roller \gset
select test.er(:'b1_tekst', 'Husk møtet kl. 12', 'uten mellomrom i endene');
select test.er(:'b1_navn', 'Ola Sekretær', 'navnet fra ansattregisteret');
select test.er(:'b1_roller'::int, 1, 'hver rolle én gang');
select test.feiler(format($$insert into faktura.beskjeder (org_id, tekst) values (%L, '   ')$$, :'org'), 'FA400');
select test.feiler(format($$insert into faktura.beskjeder (org_id, tekst, roller) values (%L, 'Hei', array[gen_random_uuid()])$$, :'org'), 'FA404');
select test.feiler(format($$update faktura.beskjeder set tekst = 'Endret' where id = %L$$, :'b1'), '42501');

-- Legene ser den; en annen sekretær ville ikke (Per er lege, og ser den).
select set_config('app.bruker_id', :'u_lise', false);
select test.er((select count(*) from faktura.beskjeder where id = :'b1'), 1::bigint, 'legen ser beskjeden til legene');
delete from faktura.beskjeder where id = :'b1';
select test.er((select count(*) from faktura.beskjeder where id = :'b1'), 1::bigint, 'legen kan ikke slette Olas beskjed');
-- Lise skriver til sekretærene: Ola ser den, Per (lege) ikke.
insert into faktura.beskjeder (org_id, tekst, roller) values (:'org', 'Ring pasienten i rom 2', array[:'sek'::uuid]) returning id as b2 \gset
select set_config('app.bruker_id', :'u_per', false);
select test.er((select count(*) from faktura.beskjeder where id = :'b2'), 0::bigint, 'en lege ser ikke beskjeden til sekretærene');
select test.er((select count(*) from faktura.beskjeder where id = :'b1'), 1::bigint, 'men den til legene');
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select count(*) from faktura.beskjeder where id = :'b2'), 1::bigint, 'sekretæren ser den');
-- Til alle: alle ser den.
insert into faktura.beskjeder (org_id, tekst) values (:'org', 'Kaffemaskinen er fikset') returning id as b3 \gset
select set_config('app.bruker_id', :'u_per', false);
select test.er((select count(*) from faktura.beskjeder where id = :'b3'), 1::bigint, 'til alle ser alle');

-- En som ikke er aktiv, ser ikke beskjedene til rollen lenger.
select set_config('app.bruker_id', :'u', false);
update faktura.ansatte set aktiv = false where id = :'per';
select set_config('app.bruker_id', :'u_per', false);
select test.er((select count(*) from faktura.beskjeder where id = :'b1'), 0::bigint, 'ikke aktiv: ikke rollens beskjeder');

-- Eieren ser alle og kan slette alle; den som skrev den, kan slette sin.
select set_config('app.bruker_id', :'u', false);
select test.er((select count(*) from faktura.beskjeder where org_id = :'org'), 3::bigint, 'eieren ser alle');
select set_config('app.bruker_id', :'u_ola', false);
delete from faktura.beskjeder where id = :'b1';
select test.er((select count(*) from faktura.beskjeder where id = :'b1'), 0::bigint, 'Ola slettet sin');
select set_config('app.bruker_id', :'u', false);
delete from faktura.beskjeder where id = :'b2';
select test.er((select count(*) from faktura.beskjeder where org_id = :'org'), 1::bigint, 'eieren slettet Lises');

-- Sist lest: bare sin egen.
select set_config('app.bruker_id', :'u_ola', false);
insert into faktura.beskjed_lest (org_id, bruker_id) values (:'org', :'u_ola');
update faktura.beskjed_lest set lest = now() where org_id = :'org' and bruker_id = :'u_ola';
select test.feiler(format($$insert into faktura.beskjed_lest (org_id, bruker_id) values (%L, %L)$$, :'org', :'u_lise'), '42501');
select set_config('app.bruker_id', :'u_lise', false);
select test.er((select count(*) from faktura.beskjed_lest where org_id = :'org'), 0::bigint, 'ser ikke andres');

-- En annen organisasjon ser ingenting.
select id as u2 from faktura.registrer_bruker('uid-beskjed-andre', 'andre-beskjed@test.no') \gset
select set_config('app.bruker_id', :'u2', false);
select test.er((select count(*) from faktura.beskjeder where org_id = :'org'), 0::bigint, 'utenforstående ser ingenting');
select test.er((select count(*) from faktura.beskjed_roller(:'org')), 0::bigint, 'heller ikke rollene');
select test.feiler(format($$insert into faktura.beskjeder (org_id, tekst) values (%L, 'Hei')$$, :'org'), '42501');

\c :migrator
drop schema test cascade;
\echo '  ok'
