-- Åpent i helgene (0064_helg.sql): standard åpent (også uten oppsett), eier og administrator slår
-- det av, og alle medlemmene, også de ansatte, ser det i mine_organisasjoner. De ansatte kan ikke
-- endre det.

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
select id as u from faktura.registrer_bruker('uid-helg-eier', 'eier-helg@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Helg AS', '917654328') \gset
-- Uten oppsett: åpent.
select test.er((select helg from faktura.mine_organisasjoner where id = :'org'), true, 'åpent uten oppsett');
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
select test.er((select helg from faktura.lonn_oppsett where org_id = :'org'), true, 'standard: åpent i helgene');
select test.er((select helg from faktura.mine_organisasjoner where id = :'org'), true, 'åpent i mine_organisasjoner');

-- En ansatt med innlogging.
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra) values (:'org', 'Ola', 'Helg', 'ola-helg@test.no', faktura.i_dag() - 30) returning id as ola \gset
select faktura.inviter_ansatt(:'org', :'ola') as t_ola \gset
select id as u_ola from faktura.registrer_bruker('uid-helg-ola', 'ola-helg@test.no') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');
select test.er((select helg from faktura.mine_organisasjoner where id = :'org'), true, 'den ansatte ser at det er åpent');

-- Eieren stenger i helgene; alle ser det.
select set_config('app.bruker_id', :'u', false);
update faktura.lonn_oppsett set helg = false where org_id = :'org';
select test.er((select helg from faktura.mine_organisasjoner where id = :'org'), false, 'stengt for eieren');
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select helg from faktura.mine_organisasjoner where id = :'org'), false, 'stengt for den ansatte');
-- Den ansatte kan ikke åpne igjen.
update faktura.lonn_oppsett set helg = true where org_id = :'org';
select test.er((select helg from faktura.lonn_oppsett where org_id = :'org'), false, 'den ansatte endrer ikke helgen');

-- En annen organisasjon påvirkes ikke.
select set_config('app.bruker_id', :'u', false);
select id as org2 from faktura.opprett_organisasjon('Helgeåpent AS', '917654336') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org2', true);
select test.er((select helg from faktura.mine_organisasjoner where id = :'org2'), true, 'den andre er åpen');

\c :migrator
drop schema test cascade;
\echo '  ok'
