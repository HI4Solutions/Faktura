-- Skattekort fra Skatteetaten (0068_skattekort_fra_skatteetaten.sql): eier og administrator ber om
-- tilgang, bare workeren skriver forespørselen og skattekortene fra Skatteetaten, og skattekort som
-- endres for hånd blir «manuell» (men ikke når bare valget av biarbeidsgiver endres).

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
select id as u from faktura.registrer_bruker('uid-skattekort', 'skattekort@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Skattekort AS', '923609016') \gset
select faktura.inviter_medlem(:'org', 'regn-skattekort@test.no', 'regnskap') as t_regn \gset
select faktura.inviter_medlem(:'org', 'les-skattekort@test.no', 'les') as t_les \gset
select id as u_regn from faktura.registrer_bruker('uid-skattekort-regn', 'regn-skattekort@test.no') \gset
select id as u_les from faktura.registrer_bruker('uid-skattekort-les', 'les-skattekort@test.no') \gset
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'t_regn');
select set_config('app.bruker_id', :'u_les', false);
select faktura.aksepter_invitasjon(:'t_les');

-- Eieren ber om tilgang; regnskap ser den, men kan ikke be om den; lesetilgang ser ingenting.
select set_config('app.bruker_id', :'u', false);
select test.er((select status from faktura.be_om_skattekorttilgang(:'org')), 'venter', 'eieren ber om tilgang');
select test.feiler(format($$update faktura.skattekort_tilgang set status = 'godkjent' where org_id = %L$$, :'org'), '42501');
select set_config('app.bruker_id', :'u_regn', false);
select test.er((select status from faktura.skattekort_tilgang where org_id = :'org'), 'venter', 'regnskap ser tilgangen');
select test.feiler(format($$select faktura.be_om_skattekorttilgang(%L)$$, :'org'), 'FA403');
select set_config('app.bruker_id', :'u_les', false);
select test.er((select count(*)::int from faktura.skattekort_tilgang), 0, 'lesetilgang ser ikke tilgangen');

-- Workeren lager forespørselen i Altinn, og kunden godkjenner den.
\c :worker
update faktura.skattekort_tilgang
   set status = 'ny', foresporsel_id = gen_random_uuid(), godkjenn_url = 'https://am.ui.tt02.altinn.no/accessmanagement/ui/systemuser/request?id=1'
 where org_id = :'org';
select test.feiler(format($$update faktura.skattekort_tilgang set godkjenn_url = 'http://usikker.no' where org_id = %L$$, :'org'), '23514');
update faktura.skattekort_tilgang set status = 'godkjent' where org_id = :'org';

-- Godkjent: kan ikke bes om på nytt (men kan kobles fra og bes om igjen).
\c :api
select set_config('app.bruker_id', :'u', false);
select test.feiler(format($$select faktura.be_om_skattekorttilgang(%L)$$, :'org'), 'FA409');

-- Skattekort registrert for hånd er «manuell».
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, skattekort, skatt_prosent, skattekort_aar)
values (:'org', 'Ola', 'Skatt', '2026-01-01', 'prosent', 30, 2026) returning id as ola \gset
select test.er((select skattekort_kilde from faktura.ansatte where id = :'ola'), 'manuell', 'registrert for hånd');
select test.feiler(format($$update faktura.ansatte set skattekort_kilde = 'skatteetaten' where id = %L$$, :'ola'), '42501');
select test.feiler(format($$update faktura.ansatte set skattekort_trekk = '[]' where id = %L$$, :'ola'), '42501');

-- Workeren lagrer skattekortet fra Skatteetaten (tabellkort for hovedarbeidsgiver).
\c :worker
update faktura.ansatte
   set skattekort = 'tabell', skatt_tabell = 8010, skatt_prosent = 41, skatt_frikort = null, skattekort_aar = 2026,
       skattekort_kilde = 'skatteetaten', skattekort_hentet = now(), skattekort_resultat = 'skattekortopplysningerOK',
       skattekort_utstedt = '2025-12-05', skattekort_tillegg = '{oppholdPaaSvalbard}',
       skattekort_trekk = '[{"trekkode": "LOENN_FRA_HOVEDARBEIDSGIVER", "tabell": 8010, "prosent": 41}, {"trekkode": "LOENN_FRA_BIARBEIDSGIVER", "prosent": 34}]'
 where id = :'ola';
select test.er((select skattekort_kilde || ':' || skatt_tabell from faktura.ansatte where id = :'ola'), 'skatteetaten:8010', 'fra Skatteetaten');

-- Biarbeidsgiver: appen regner om fra forskuddstrekket, og kilden blir den samme.
\c :api
select set_config('app.bruker_id', :'u', false);
update faktura.ansatte set biarbeidsgiver = true, skattekort = 'prosent', skatt_tabell = null, skatt_prosent = 34 where id = :'ola';
select test.er((select skattekort_kilde || ':' || skattekort || ':' || skatt_prosent from faktura.ansatte where id = :'ola'),
               'skatteetaten:prosent:34.00', 'biarbeidsgiver regnet om');
-- Endres skattekortet for hånd, er det «manuell».
update faktura.ansatte set skatt_prosent = 40 where id = :'ola';
select test.er((select skattekort_kilde from faktura.ansatte where id = :'ola'), 'manuell', 'endret for hånd');
-- Frikort uten beløpsgrense.
update faktura.ansatte set skattekort = 'frikort', skatt_prosent = null, skatt_frikort = null where id = :'ola';
select test.er((select skattekort || ':' || coalesce(skatt_frikort::text, 'uten grense') from faktura.ansatte where id = :'ola'), 'frikort:uten grense', 'frikort uten beløp');
select test.feiler(format($$update faktura.ansatte set skattekort = 'tabell', skatt_tabell = null where id = %L$$, :'ola'), '23514');

-- Systemet i Altinns systemregister: bare workeren skriver, og vanlige brukere ser det ikke.
\c :worker
insert into faktura.altinn_system (id, registrert) values ('936564046_test', now());
\c :api
select set_config('app.bruker_id', :'u', false);
select test.er((select count(*)::int from faktura.altinn_system), 0, 'vanlige brukere ser ikke systemet');
select test.feiler($$insert into faktura.altinn_system (id) values ('x')$$, '42501');

-- Koble fra: eieren sletter tilgangen, og kan be om den på nytt.
delete from faktura.skattekort_tilgang where org_id = :'org';
select test.er((select status from faktura.be_om_skattekorttilgang(:'org')), 'venter', 'bedt om på nytt');

\c :migrator
drop schema test cascade;
\echo '  ok'
