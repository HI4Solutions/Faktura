-- Kontogodkjenning (0043_kontogodkjenning.sql): nye brukere venter til plattformadministratoren
-- godkjenner dem, forespørselen meldes én gang (når navnet er skrevet inn), bare betrodde kall
-- godkjenner eller avviser, og den som tar imot en invitasjon til e-postadressen sin, godkjennes.

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
-- En ny bruker venter.
select id as u from faktura.registrer_bruker('uid-godkj-ny', 'ny-godkj@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select test.er((select status from faktura.brukere where id = :'u'), 'venter', 'ny bruker venter');
-- Uten navn meldes den ikke; med navn én gang.
select test.er(faktura.meld_konto(), false, 'ikke meldt uten navn');
update faktura.brukere set navn = 'Nina Ny' where id = :'u';
select test.er(faktura.meld_konto(), true, 'meldt når navnet er skrevet inn');
select test.er(faktura.meld_konto(), false, 'bare én gang');
-- Den kan ikke godkjenne seg selv.
select test.feiler($$update faktura.brukere set status = 'godkjent' where id = faktura.bruker_id()$$, '42501');
select test.feiler($$select faktura.behandle_konto(faktura.bruker_id(), true)$$, 'FA403');
select test.feiler($$select * from faktura.admin_kontoer_venter()$$, 'FA403');

-- Plattformadministratoren ser den og godkjenner.
select set_config('app.betrodd', 'on', false);
select test.er((select count(*) from faktura.admin_kontoer_venter() where id = :'u'), 1::bigint, 'står blant dem som venter');
select test.er((select status from faktura.admin_brukere() where id = :'u'), 'venter', 'med status i brukerlista');
select test.er((faktura.behandle_konto(:'u', true)).status, 'godkjent', 'godkjent');
select test.er((select count(*) from faktura.admin_kontoer_venter() where id = :'u'), 0::bigint, 'venter ikke lenger');
select test.er((select behandlet_at is not null from faktura.brukere where id = :'u'), true, 'med tidspunkt');
-- En annen avvises med grunn.
select id as u2 from faktura.registrer_bruker('uid-godkj-avvist', 'avvist-godkj@test.no') \gset
select test.er((faktura.behandle_konto(:'u2', false, '  Ukjent person  ')).avvist_grunn, 'Ukjent person', 'avvist med grunn');
select test.feiler($$select faktura.behandle_konto(gen_random_uuid(), true)$$, 'FA404');
select set_config('app.betrodd', '', false);

-- Den som tar imot en invitasjon til e-postadressen sin, godkjennes.
select id as eier from faktura.registrer_bruker('uid-godkj-eier', 'eier-godkj@test.no') \gset
select set_config('app.bruker_id', :'eier', false);
select id as org from faktura.opprett_organisasjon('Godkjenning AS', '917654123') \gset
select faktura.inviter_medlem(:'org', 'invitert-godkj@test.no', 'fakturerer') as token \gset
select faktura.inviter_medlem(:'org', 'avvist-godkj@test.no', 'les') as token2 \gset
select id as u3 from faktura.registrer_bruker('uid-godkj-invitert', 'invitert-godkj@test.no') \gset
select set_config('app.bruker_id', :'u3', false);
select test.er((select status from faktura.brukere where id = :'u3'), 'venter', 'den inviterte venter først');
select faktura.aksepter_invitasjon(:'token');
select test.er((select status from faktura.brukere where id = :'u3'), 'godkjent', 'godkjent av invitasjonen');
-- En avvist konto blir ikke godkjent av en invitasjon.
select set_config('app.bruker_id', :'u2', false);
select test.feiler($$select faktura.aksepter_invitasjon('$$ || :'token2' || $$')$$, 'FA403');
select test.er((select status from faktura.brukere where id = :'u2'), 'avvist', 'den avviste er fortsatt avvist');

\c :migrator
drop schema test cascade;
\echo '  ok'
