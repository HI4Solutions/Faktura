-- Konto og avsender på påminnelser (0107_paaminnelse_konto.sql): appen kan sette dem, bare
-- organisasjonens egne kontoer, en konto som slettes, gir standardkontoen igjen, og workeren
-- får dem med påminnelsen.

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
select id as u from faktura.registrer_bruker('uid-paaminnelse-konto', 'paaminnelse-konto@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Kontopåminnelse AS', '923609016') \gset
update faktura.organisasjoner set kontonr = '86011117947', innehaver = 'Ola Nordmann' where id = :'org';
insert into faktura.kontoer (org_id, navn, kontonr) values (:'org', 'Husleiekonto', '12345678903') returning id as konto \gset
insert into faktura.kunder (org_id, navn) values (:'org', 'Kari Hansen') returning id as kari \gset

select id as org2 from faktura.opprett_organisasjon('Annen konto AS', '974760673') \gset
insert into faktura.kontoer (org_id, navn, kontonr) values (:'org2', 'Annen', '12345678903') returning id as konto2 \gset

-- Appen lagrer konto og avsender, og kan sette dem tilbake til standard.
insert into faktura.paaminnelser (org_id, tekst, kunde_id, intervall, dag, neste_dato, klokkeslett, konto_id, avsender)
values (:'org', 'Husleie til Kari', :'kari', 'maaned', 1, faktura.i_dag() - 1, '00:00', :'konto', 'innehaver') returning id as p \gset
select test.er((select konto_id from faktura.paaminnelser where id = :'p'), :'konto'::uuid, 'kontoen');
select test.er((select avsender from faktura.paaminnelser where id = :'p'), 'innehaver', 'avsenderen');
update faktura.paaminnelser set konto_id = null, avsender = null where id = :'p';
select test.er((select konto_id is null and avsender is null from faktura.paaminnelser where id = :'p'), true, 'tilbake til standard');
update faktura.paaminnelser set konto_id = :'konto', avsender = 'firma' where id = :'p';

-- Bare organisasjonens egne kontoer, og bare firma eller innehaver.
select test.feiler(format('update faktura.paaminnelser set konto_id = %L where id = %L', :'konto2', :'p'), '23503');
select test.feiler(format($$update faktura.paaminnelser set avsender = 'kari' where id = %L$$, :'p'), '23514');

-- Workeren får kontoen og avsenderen med påminnelsen.
\c :worker
create temp table tatt as select * from faktura.ta_paaminnelser();
select test.er((select konto_id from tatt where id = :'p'), :'konto'::uuid, 'workeren får kontoen');
select test.er((select avsender from tatt where id = :'p'), 'firma', 'workeren får avsenderen');

-- Kontoen slettes: påminnelsen går tilbake til standardkontoen, og avsenderen står.
\c :api
select set_config('app.bruker_id', :'u', false);
delete from faktura.kontoer where id = :'konto';
select test.er((select konto_id from faktura.paaminnelser where id = :'p'), null::uuid, 'standardkontoen når kontoen slettes');
select test.er((select avsender from faktura.paaminnelser where id = :'p'), 'firma', 'avsenderen står');

\c :migrator
drop schema test cascade;
\echo '  ok'
