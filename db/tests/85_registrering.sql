-- Person eller organisasjon ved «Opprett konto» (0126_registrering.sql): den nye brukeren velger
-- mens kontoen venter, organisasjonsnummeret må være gyldig, valget står i lista over kontoer som
-- venter, endres ikke etter godkjenningen og fjernes når kontoen slettes.

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
-- Uten innlogging går det ikke.
select test.feiler($$select faktura.velg_registrering('person')$$, 'FA403');

select id as u from faktura.registrer_bruker('uid-reg-ny', 'ny-reg@test.no', 'Nora Ny') \gset
select set_config('app.bruker_id', :'u', false);
select test.er((select registrert_som from faktura.brukere where id = :'u'), null::text, 'ingen valg fra start');

-- Som person: uten organisasjonsnummer (et nummer som følger med, lagres ikke).
select faktura.velg_registrering('person', '315000300', 'Noe AS');
select test.er((select registrert_som || '|' || coalesce(oppgitt_orgnr, '-') || '|' || coalesce(oppgitt_orgnavn, '-') from faktura.brukere where id = :'u'),
               'person|-|-', 'person uten organisasjonsnummer');

-- Som organisasjon: med gyldig organisasjonsnummer, og navnet fra Enhetsregisteret.
select faktura.velg_registrering('organisasjon', '315000300', '  Registrering AS  ');
select test.er((select registrert_som || '|' || oppgitt_orgnr || '|' || oppgitt_orgnavn from faktura.brukere where id = :'u'),
               'organisasjon|315000300|Registrering AS', 'organisasjon med nummer og navn');
-- Uten navn (Enhetsregisteret svarte ikke) går det også.
select faktura.velg_registrering('organisasjon', '315000319');
select test.er((select oppgitt_orgnr || '|' || coalesce(oppgitt_orgnavn, '-') from faktura.brukere where id = :'u'), '315000319|-', 'uten navn');
select test.feiler($$select faktura.velg_registrering('organisasjon', '315000301')$$, 'FA400');
select test.feiler($$select faktura.velg_registrering('organisasjon', null)$$, 'FA400');
select test.feiler($$select faktura.velg_registrering('organisasjon', '31500030')$$, 'FA400');
select test.feiler($$select faktura.velg_registrering('firma', '315000300')$$, 'FA400');
select test.feiler($$select faktura.velg_registrering(null)$$, 'FA400');
select test.er((select oppgitt_orgnr from faktura.brukere where id = :'u'), '315000319', 'feilene endret ingenting');
-- Feltene kan ikke endres direkte.
select test.feiler($$update faktura.brukere set registrert_som = 'person' where id = faktura.bruker_id()$$, '42501');
select test.feiler($$update faktura.brukere set oppgitt_orgnr = '315000300' where id = faktura.bruker_id()$$, '42501');

-- Plattformadministratoren ser valget blant kontoene som venter.
select set_config('app.betrodd', 'on', false);
select test.er((select registrert_som || '|' || oppgitt_orgnr || '|' || coalesce(oppgitt_orgnavn, '-') from faktura.admin_kontoer_venter() where id = :'u'),
               'organisasjon|315000319|-', 'i lista over kontoer som venter');
select faktura.behandle_konto(:'u', true);
select set_config('app.betrodd', '', false);

-- Etter godkjenningen endres det ikke.
select test.feiler($$select faktura.velg_registrering('person')$$, 'FA403');
select test.er((select registrert_som from faktura.brukere where id = :'u'), 'organisasjon', 'uendret etter godkjenningen');

-- Når kontoen slettes, fjernes også valget og organisasjonsnummeret.
select faktura.slett_min_konto();
\c :migrator
select test.er((select status || '|' || coalesce(registrert_som, '-') || '|' || coalesce(oppgitt_orgnr, '-') || '|' || coalesce(oppgitt_orgnavn, '-')
                  from faktura.brukere where id = :'u'),
               'slettet|-|-|-', 'fjernet med kontoen');
-- Organisasjonsnummer bare for organisasjon.
select test.feiler($$update faktura.brukere set registrert_som = 'person', oppgitt_orgnr = '315000300' where id = '$$ || :'u' || $$'$$, '23514');
select test.feiler($$update faktura.brukere set registrert_som = 'organisasjon' where id = '$$ || :'u' || $$'$$, '23514');

drop schema test cascade;
\echo '  ok'
