-- Flere banker per organisasjon (0027_flere_banker.sql): administratorer legger til og
-- fjerner banker, alle medlemmer ser dem, bare workeren skriver økten og hentingen, og
-- andre ser ingenting.

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
select id as u from faktura.registrer_bruker('uid-banker', 'banker@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Banker AS', '923609016') \gset

-- Administratoren legger til to banker; samme bank to ganger går ikke.
insert into faktura.bankkoblinger (org_id, bank, psu_type) values (:'org', 'DNB', 'business') returning id as dnb \gset
insert into faktura.bankkoblinger (org_id, bank, psu_type, status) values (:'org', 'Storebrand Bank', 'business', 'venter') returning id as sb \gset
select set_config('test.org', :'org', false), set_config('test.dnb', :'dnb', false), set_config('test.sb', :'sb', false);
do $$ begin
  insert into faktura.bankkoblinger (org_id, bank, psu_type) values (current_setting('test.org')::uuid, 'DNB', 'business');
  raise exception 'FEIL: samme bank ble lagt til to ganger';
exception when unique_violation then null;
end $$;
-- Appen kan sette det brukeren velger, men ikke det workeren eier.
update faktura.bankkoblinger set kontoer = '[{"uid": "k1", "kontonr": "86011117947", "navn": "Drift", "valgt": true}]', auth_url = 'https://bank.test'
 where id = :'dnb';
do $$ begin
  update faktura.bankkoblinger set gyldig_til = now() + interval '1 year' where id = current_setting('test.dnb')::uuid;
  raise exception 'FEIL: API-et kunne forlenge samtykket';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  update faktura.bankkoblinger set sist_hentet = now(), hent_fra = current_date where id = current_setting('test.dnb')::uuid;
  raise exception 'FEIL: API-et kunne endre hentingen';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  update faktura.bankkoblinger set fullfort = now() where id = current_setting('test.dnb')::uuid;
  raise exception 'FEIL: API-et kunne merke BankID som fullført';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  update faktura.bankkoblinger set org_id = gen_random_uuid() where id = current_setting('test.dnb')::uuid;
  raise exception 'FEIL: koblingen kunne flyttes til en annen organisasjon';
exception when insufficient_privilege or sqlstate 'FA400' then null;
end $$;

-- Workeren fullfører koblingen og registrerer hentingen.
\c :worker
update faktura.bankkoblinger
   set status = 'aktiv', okt_id = 's-1', gyldig_til = now() + interval '180 days', fullfort = now(),
       hent_fra = current_date - 5, sist_hentet = now(), varslet_utlop = null, auth_url = null
 where id = :'dnb';
select test.er((select status || ':' || okt_id from faktura.bankkoblinger where id = :'dnb'), 'aktiv:s-1', 'workeren fullfører koblingen');

-- Et medlem med lesetilgang ser bankene, men kan ikke endre dem.
\c :api
select id as u2 from faktura.registrer_bruker('uid-banker-les', 'les-banker@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select faktura.inviter_medlem(:'org', 'les-banker@test.no', 'les') as token \gset
select set_config('app.bruker_id', :'u2', false), set_config('test.org', :'org', false);
select faktura.aksepter_invitasjon(:'token');
select test.er((select count(*)::int from faktura.bankkoblinger), 2, 'lesetilgang ser bankene');
do $$ begin
  insert into faktura.bankkoblinger (org_id, bank, psu_type) values (current_setting('test.org')::uuid, 'Nordea', 'business');
  raise exception 'FEIL: lesetilgang kunne legge til en bank';
exception when insufficient_privilege then null;
end $$;
update faktura.bankkoblinger set status = 'feil' where id = :'dnb';
delete from faktura.bankkoblinger where id = :'sb';
select test.er((select string_agg(bank || ':' || status, ',' order by bank) from faktura.bankkoblinger), 'DNB:aktiv,Storebrand Bank:venter',
               'lesetilgang endret og slettet ingenting');

-- Andre ser ingenting.
select id as u3 from faktura.registrer_bruker('uid-banker-annen', 'annen-banker@test.no') \gset
select set_config('app.bruker_id', :'u3', false);
select test.er((select count(*)::int from faktura.bankkoblinger), 0, 'andre ser ikke bankene');
delete from faktura.bankkoblinger;

-- Administratoren fjerner en bank.
select set_config('app.bruker_id', :'u', false);
delete from faktura.bankkoblinger where id = :'sb';
select test.er((select string_agg(bank, ',') from faktura.bankkoblinger), 'DNB', 'Storebrand er fjernet');

\c :migrator
drop schema test cascade;
\echo '  ok'
