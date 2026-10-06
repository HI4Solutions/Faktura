-- E-postsporing (0009_epostsporing.sql).

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

\c :api
select id as u from faktura.registrer_bruker('uid-ep', 'ep@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Epost AS') \gset

\c :worker
select faktura.logg_epost(:'org', null, null, 'resend-1', 'kunde@x.no', 'Faktura 1');

\c :api
select test.er(faktura.oppdater_epoststatus('resend-1', 'levert'), true, 'kjent id');
select test.er(faktura.oppdater_epoststatus('ukjent', 'levert'), false, 'ukjent id');
select faktura.oppdater_epoststatus('resend-1', 'forsinket');
select set_config('app.bruker_id', :'u', false);
select test.er((select status from faktura.eposter where ekstern_id = 'resend-1'), 'levert', 'forsinket overstyrer ikke levert');
select faktura.oppdater_epoststatus('resend-1', 'sprett', 'Mailbox does not exist');
select faktura.oppdater_epoststatus('resend-1', 'levert');
select test.er((select status from faktura.eposter where ekstern_id = 'resend-1'), 'sprett', 'retur vinner');

\c :worker
select test.er((select count(*) from faktura.utboks where hendelse = 'epost.sprett' and org_id = :'org'), 1::bigint, 'hendelse ved retur');

\c :migrator
drop schema test cascade;
\echo '  ok'
