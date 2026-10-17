-- Brukeren sletter sin egen konto (0123_slett_konto.sql): eneste eier må gi fra seg eierrollen
-- først; kontoen anonymiseres, medlemskapene og det som bare hørte til kontoen slettes, og
-- ansattkortet blir stående uten innloggingen. En ny innlogging med samme adresse blir en ny konto.

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
select id as u_e from faktura.registrer_bruker('uid-slett-eier', 'slett-eier@test.no', 'Eva Eier') \gset
select set_config('app.bruker_id', :'u_e', false);
select id as org from faktura.opprett_organisasjon('Slett Konto AS', '315000106') \gset
select id as org2 from faktura.opprett_organisasjon('Slett Konto To AS', '315000114') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra) values (:'org', 'Ola', 'Nordmann', 'slett-ola@test.no', '2026-01-01')
returning id as ola \gset

-- Ola får innlogging som ansatt, og en invitasjon til den andre organisasjonen som ikke er tatt imot.
select faktura.inviter_ansatt(:'org', :'ola') as t \gset
select faktura.inviter_medlem(:'org2', 'slett-ola@test.no', 'fakturerer') as t2 \gset
select id as u_ola from faktura.registrer_bruker('uid-slett-ola', 'slett-ola@test.no', 'Ola Nordmann') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t');
select test.er((select bruker_id from faktura.ansatte where id = :'ola'), :'u_ola'::uuid, 'koblet til innloggingen');

-- Eva er eneste eier av begge organisasjonene og kan ikke slette kontoen.
select set_config('app.bruker_id', :'u_e', false);
do $$
begin
  perform faktura.slett_min_konto();
  raise exception 'Forventet FA409';
exception when sqlstate 'FA409' then
  if sqlerrm not like '%Slett Konto AS, Slett Konto To AS%' then raise exception 'Feil melding: %', sqlerrm; end if;
end $$;

-- Ola sletter kontoen sin.
select set_config('app.bruker_id', :'u_ola', false);
select faktura.slett_min_konto();
select test.feiler('select faktura.slett_min_konto()', 'FA403');

select set_config('app.bruker_id', :'u_e', false);
select test.er((select count(*)::int from faktura.medlemmer where bruker_id = :'u_ola'), 0, 'medlemskapet er borte');
select test.er((select bruker_id from faktura.ansatte where id = :'ola'), null::uuid, 'ansattkortet uten innloggingen');
select test.er((select fornavn from faktura.ansatte where id = :'ola'), 'Ola', 'ansattkortet blir stående');
select test.er((select count(*)::int from faktura.invitasjoner where org_id = :'org2'), 0, 'invitasjonen som ikke er tatt imot, er slettet');

\c :migrator
select test.er((select status || '|' || navn || '|' || (epost = 'slettet-' || id || '@slettet.invalid') || '|' || (ekstern_id = 'slettet:' || id)
                       || '|' || (slettet_at is not null) || '|' || epost_bekreftet
                  from faktura.brukere where id = :'u_ola'),
               'slettet|Slettet bruker|true|true|true|false', 'kontoen er anonymisert');
select test.er((select count(*)::int from faktura.brukere where lower(epost) = 'slett-ola@test.no'), 0, 'adressen er borte');
select test.er((select count(*)::int from faktura.admin_brukere() where id = :'u_ola'), 0, 'ikke i brukerlista i administrasjonen')
  from (select set_config('app.betrodd', 'on', false)) x;
select set_config('app.betrodd', '', false);

-- En ny innlogging med samme adresse blir en ny konto uten noe av det gamle.
\c :api
select id as u_ny from faktura.registrer_bruker('uid-slett-ola', 'slett-ola@test.no', 'Ola Nordmann') \gset
select test.er(:'u_ny'::uuid <> :'u_ola'::uuid, true, 'en ny bruker');
select set_config('app.bruker_id', :'u_ny', false);
select test.er((select count(*)::int from faktura.mine_organisasjoner), 0, 'ingen organisasjoner');

-- Med en eier til kan Eva slette kontoen; den andre er fortsatt eier.
select set_config('app.bruker_id', :'u_e', false);
select faktura.inviter_medlem(:'org', 'slett-kari@test.no', 'admin') as t3 \gset
select faktura.inviter_medlem(:'org2', 'slett-kari@test.no', 'admin') as t4 \gset
select id as u_k from faktura.registrer_bruker('uid-slett-kari', 'slett-kari@test.no', 'Kari') \gset
select set_config('app.bruker_id', :'u_k', false);
select faktura.aksepter_invitasjon(:'t3');
select faktura.aksepter_invitasjon(:'t4');
select set_config('app.bruker_id', :'u_e', false);
select faktura.endre_rolle(:'org', :'u_k', 'eier');
-- Fortsatt eneste eier av den andre.
select test.feiler('select faktura.slett_min_konto()', 'FA409');
select faktura.endre_rolle(:'org2', :'u_k', 'eier');
select faktura.slett_min_konto();
select set_config('app.bruker_id', :'u_k', false);
select test.er((select string_agg(rolle, ',') from faktura.mine_organisasjoner), 'eier,eier', 'Kari er eier av begge');
select test.er((select count(*)::int from faktura.medlemmer where org_id = :'org'), 1, 'Eva er ikke lenger medlem');

\c :migrator
drop schema test cascade;
\echo '  ok'
