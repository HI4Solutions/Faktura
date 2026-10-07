-- Plattformadministrasjon (0029_admin.sql): oversikt, detaljer om én organisasjon og
-- driftsstatus, bare for betrodde kall.

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
select id as u from faktura.registrer_bruker('uid-adminside', 'adminside@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Adminside AS', '923609016') \gset
update faktura.organisasjoner set kontonr = '86011117947' where id = :'org';
update faktura.organisasjoner set kontonr = '95300000003' where id = :'org';
insert into faktura.kunder (org_id, navn) values (:'org', 'Kari Hansen') returning id as k \gset
insert into faktura.fakturaer (org_id, kunde_id) values (:'org', :'k') returning id as f \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, enhetspris, mva_sats) values (:'org', :'f', 'Husleie', 1000, 0);
select faktura.utsted(:'f');
select set_config('test.org', :'org', false);

-- Uten betrodd kall: ingen tilgang, heller ikke for eieren.
do $$ begin
  perform faktura.admin_oversikt();
  raise exception 'FEIL: oversikten var åpen';
exception when sqlstate 'FA403' then null;
end $$;
do $$ begin
  perform faktura.admin_organisasjon(current_setting('test.org')::uuid);
  raise exception 'FEIL: detaljene var åpne';
exception when sqlstate 'FA403' then null;
end $$;
do $$ begin
  perform faktura.admin_drift();
  raise exception 'FEIL: driftsstatusen var åpen';
exception when sqlstate 'FA403' then null;
end $$;

-- Betrodd (API-et for en plattformadministrator).
select set_config('app.betrodd', 'on', false);
select faktura.admin_organisasjon(:'org') as d \gset
select set_config('test.d', :'d', false);
select test.er((current_setting('test.d')::jsonb -> 'antall' ->> 'fakturaer')::int, 1, 'antall fakturaer');
select test.er((current_setting('test.d')::jsonb ->> 'fakturert')::numeric, 1000::numeric, 'fakturert');
select test.er((current_setting('test.d')::jsonb ->> 'utestaende')::numeric, 1000::numeric, 'utestående');
select test.er(current_setting('test.d')::jsonb -> 'medlemmer' -> 0 ->> 'epost', 'adminside@test.no', 'eieren er medlem');
select test.er(current_setting('test.d')::jsonb -> 'medlemmer' -> 0 ->> 'rolle', 'eier', 'som eier');
select test.er(current_setting('test.d')::jsonb -> 'kontonr_endringer' -> 0 ->> 'fra', '86011117947', 'siste kontonummerendring fra');
select test.er(current_setting('test.d')::jsonb -> 'kontonr_endringer' -> 0 ->> 'til', '95300000003', 'siste kontonummerendring til');
select test.er(current_setting('test.d')::jsonb -> 'kontonr_endringer' -> 0 ->> 'av', 'adminside@test.no', 'endret av');
select test.er((select count(*)::int from jsonb_array_elements(current_setting('test.d')::jsonb -> 'aktivitet') a where a ->> 'tabell' = 'faktura_linjer'), 0,
               'fakturalinjene er ikke med i aktiviteten');
select test.er((select count(*)::int from jsonb_array_elements(current_setting('test.d')::jsonb -> 'aktivitet') a
                 where a ->> 'tabell' = 'fakturaer' and a ->> 'status' = 'utstedt'), 1, 'utstedelsen er med i aktiviteten');
select test.er(faktura.admin_organisasjon(gen_random_uuid()), null, 'ukjent organisasjon');
select test.er((faktura.admin_oversikt() -> 'organisasjoner' ->> 'totalt')::int >= 1, true, 'oversikten teller organisasjoner');
select test.er((faktura.admin_oversikt() -> 'fakturaer' ->> 'antall_30')::int >= 1, true, 'fakturaer siste 30 dager');
select test.er((faktura.admin_oversikt() -> 'brukere' ->> 'aktive_30')::int >= 1, true, 'aktive brukere');
select test.er(faktura.admin_oversikt() -> 'problemer' ? 'banker', true, 'problemer per område');
select test.er(faktura.admin_drift() ?& array['utboks', 'epost', 'ehf', 'integrasjoner', 'banker'], true, 'driftsstatus');
select test.er((select sist_aktiv is not null and antall_medlemmer = 1 from faktura.admin_organisasjoner() where id = :'org'), true,
               'organisasjonen sist aktiv');
select test.er((select sist_aktiv is not null from faktura.admin_brukere() where id = :'u'), true, 'brukeren sist aktiv');

\c :migrator
drop schema test cascade;
\echo '  ok'
