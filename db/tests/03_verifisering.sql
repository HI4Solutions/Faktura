-- Verifisering (0007_verifisering.sql).

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

\c :api
select id as eier from faktura.registrer_bruker('uid-ver', 'eier@ver.test') \gset
select id as fremmed from faktura.registrer_bruker('uid-ver2', 'fremmed@ver.test') \gset
select set_config('app.bruker_id', :'eier', false);
select id as org from faktura.opprett_organisasjon('Verifiser AS', '889640782') \gset

-- Kode til e-post i Enhetsregisteret.
select faktura.start_verifiseringskode(:'org', 'post@verifiser.no', '123456');
select test.er(faktura.sjekk_verifiseringskode(:'org', '000000'), false, 'feil kode');
select test.feiler($$select kode_hash from faktura.verifiseringer$$, '42501');
select test.er(faktura.sjekk_verifiseringskode(:'org', ' 123456 '), true, 'riktig kode');
select test.er((select verifisering from faktura.organisasjoner where id = :'org'), 'verifisert', 'verifisert med kode');
select test.er((select maks_fakturaer_mnd from faktura.organisasjoner where id = :'org'), null::int, 'grensene fjernes');
select test.feiler(format($$select faktura.sjekk_verifiseringskode(%L, '123456')$$, :'org'), 'FA409');

-- Fem feil gjør koden ugyldig.
select id as org2 from faktura.opprett_organisasjon('Feiler AS', '910000004') \gset
select faktura.start_verifiseringskode(:'org2', 'post@feiler.no', '654321');
select faktura.sjekk_verifiseringskode(:'org2', '1') from generate_series(1, 5);
select test.feiler(format($$select faktura.sjekk_verifiseringskode(%L, '654321')$$, :'org2'), 'FA409');

-- Andre kan ikke starte eller sjekke koder.
select set_config('app.bruker_id', :'fremmed', false);
select test.feiler(format($$select faktura.start_verifiseringskode(%L, 'x@y.no', '111111')$$, :'org2'), 'FA403');
select test.feiler(format($$select faktura.be_om_manuell_verifisering(%L)$$, :'org2'), 'FA403');

-- Manuell forespørsel og plattformadministrasjon.
select set_config('app.bruker_id', :'eier', false);
select test.er(faktura.be_om_manuell_verifisering(:'org2', 'Ingen e-post i registeret'), faktura.be_om_manuell_verifisering(:'org2'), 'samme forespørsel gjenbrukes');
select test.feiler($$select * from faktura.admin_organisasjoner()$$, 'FA403');
select test.feiler(format($$select faktura.sett_verifisering(%L, 'verifisert', 'manuell')$$, :'org2'), 'FA403');

begin;
select set_config('app.betrodd', 'on', true);
select test.er((select venter_manuell from faktura.admin_organisasjoner() where id = :'org2'), true, 'admin ser ventende');
select faktura.sett_verifisering(:'org2', 'verifisert', 'manuell');
commit;
select test.er((select status from faktura.verifiseringer where org_id = :'org2' and metode = 'manuell'), 'godkjent', 'forespørselen lukkes');

-- Et orgnr kan bare være verifisert hos én organisasjon.
select id as org3 from faktura.opprett_organisasjon('Kopi AS', '889640782') \gset
begin;
select set_config('app.betrodd', 'on', true);
select test.feiler(format($$select faktura.sett_verifisering(%L, 'verifisert', 'manuell')$$, :'org3'), 'FA409');
commit;

\c :migrator
drop schema test cascade;
\echo '  ok'
