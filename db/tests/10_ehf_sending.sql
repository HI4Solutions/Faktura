-- EHF-sendinger (0024_ehf_sending.sql): appen kan lese loggen, bare workeren kan skrive.

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
grant execute on all functions in schema test to public;

\c :api
select id as u from faktura.registrer_bruker('uid-ehfsend', 'ehfsend@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('EHF AS', '923609016') \gset
update faktura.organisasjoner set kontonr = '86011117947' where id = :'org';
insert into faktura.kunder (org_id, navn, orgnr) values (:'org', 'Kunde AS', '974760673') returning id as k \gset
insert into faktura.fakturaer (org_id, kunde_id) values (:'org', :'k') returning id as f \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, enhetspris) values (:'org', :'f', 'Arbeid', 100);
select faktura.utsted(:'f');
select set_config('test.org', :'org', false), set_config('test.f', :'f', false);
do $$ begin
  insert into faktura.ehf_sendinger (org_id, faktura_id, oppgave_id, mottaker)
  values (current_setting('test.org')::uuid, current_setting('test.f')::uuid, 'o1', '0192:974760673');
  raise exception 'FEIL: API-et kunne skrive i EHF-loggen';
exception when insufficient_privilege then null;
end $$;

\c :worker
select set_config('test.org', :'org', false), set_config('test.f', :'f', false);
insert into faktura.ehf_sendinger (org_id, faktura_id, oppgave_id, mottaker)
values (:'org', :'f', 'o1', '0192:974760673') returning id as s \gset
update faktura.ehf_sendinger set status = 'levert', dokument_id = 'doc_1' where id = :'s';
do $$ begin
  insert into faktura.ehf_sendinger (org_id, faktura_id, oppgave_id, mottaker)
  values (current_setting('test.org')::uuid, current_setting('test.f')::uuid, 'o1', '0192:974760673');
  raise exception 'FEIL: samme oppgave ble logget to ganger';
exception when unique_violation then null;
end $$;

\c :api
select set_config('app.bruker_id', :'u', false), set_config('test.f', :'f', false);
select test.er((select status from faktura.ehf_sendinger where faktura_id = :'f'), 'levert', 'appen leser EHF-loggen');
do $$ begin
  update faktura.ehf_sendinger set status = 'feilet' where faktura_id = current_setting('test.f')::uuid;
  raise exception 'FEIL: API-et kunne endre EHF-loggen';
exception when insufficient_privilege then null;
end $$;
select test.er((select status from faktura.ehf_sendinger where faktura_id = :'f'), 'levert', 'appen kan ikke endre EHF-loggen');
-- Andre ser ingenting.
select id as u2 from faktura.registrer_bruker('uid-ehfsend-2', 'annen-ehf@test.no') \gset
select set_config('app.bruker_id', :'u2', false);
select test.er((select count(*)::int from faktura.ehf_sendinger), 0, 'andre ser ikke EHF-loggen');

\c :migrator
drop schema test cascade;
\echo '  ok'
