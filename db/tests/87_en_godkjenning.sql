-- Én godkjenning (0128_en_godkjenning.sql): når plattformadministratoren godkjenner en konto som er
-- registrert som organisasjon, er organisasjonen brukeren lager med det organisasjonsnummeret,
-- verifisert med en gang. Ikke når administratoren lar være, for personer, for kontoer godkjent
-- ved en invitasjon, eller når nummeret alt er verifisert hos en annen organisasjon.

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
-- En ny konto, registrert som organisasjon. Plattformadministratoren (et annet medlem) godkjenner.
select id as admin from faktura.registrer_bruker('uid-en-admin', 'admin-en@test.no', 'Ada Admin') \gset
select id as a from faktura.registrer_bruker('uid-en-a', 'a-en@test.no', 'Anne Ny') \gset
select set_config('app.bruker_id', :'a', false);
select faktura.velg_registrering('organisasjon', '316200001', 'Første Godkjenning AS');
-- Brukeren kan ikke sette det godkjente nummeret selv, eller verifisere med funksjonen.
select test.feiler($$update faktura.brukere set godkjent_orgnr = '316200001' where id = faktura.bruker_id()$$, '42501');
select test.feiler($$select faktura.verifiser_godkjent_orgnr(faktura.bruker_id())$$, '42501');

select set_config('app.bruker_id', :'admin', false);
select set_config('app.betrodd', 'on', false);
select test.er((faktura.behandle_konto(:'a', true)).godkjent_orgnr, '316200001', 'godkjent med organisasjonen');
select set_config('app.betrodd', '', false);

-- Organisasjonen brukeren lager med nummeret, er verifisert med en gang, uten grenser.
select set_config('app.bruker_id', :'a', false);
select id as orga from faktura.opprett_organisasjon('Første Godkjenning AS', '316200001') \gset
select test.er((select verifisering || '|' || verifisert_metode || '|' || (verifisert_at is not null) || '|'
                       || coalesce(maks_fakturaer_mnd::text, '-') || '|' || coalesce(maks_belop_mnd::text, '-')
                  from faktura.organisasjoner where id = :'orga'),
               'verifisert|kontogodkjenning|true|-|-', 'verifisert ved opprettingen');
-- Svaret fra opprettingen er den verifiserte organisasjonen.
select test.er((select (faktura.opprett_organisasjon('Annet nummer AS', '316200028')).verifisering), 'ny', 'et annet nummer er ikke verifisert');
-- Nummeret kan bare være verifisert én gang: en til med samme nummer venter, uten feil.
select id as orga2 from faktura.opprett_organisasjon('Duplikat AS', '316200001') \gset
select test.er((select verifisering from faktura.organisasjoner where id = :'orga2'), 'ny', 'duplikatet venter');
-- Det betrodde kallet er slått av igjen etter verifiseringen.
select test.er(faktura.er_betrodd(), false, 'ikke betrodd etterpå');

-- Administratoren lar være: den vanlige verifiseringen gjelder.
select id as b from faktura.registrer_bruker('uid-en-b', 'b-en@test.no', 'Bjørn Ny') \gset
select set_config('app.bruker_id', :'b', false);
select faktura.velg_registrering('organisasjon', '316200036', 'Uten Verifisering AS');
select set_config('app.bruker_id', :'admin', false);
select set_config('app.betrodd', 'on', false);
select test.er((faktura.behandle_konto(:'b', true, null, null, false)).godkjent_orgnr, null::text, 'godkjent uten organisasjonen');
select set_config('app.betrodd', '', false);
select set_config('app.bruker_id', :'b', false);
select id as orgb from faktura.opprett_organisasjon('Uten Verifisering AS', '316200036') \gset
select test.er((select verifisering from faktura.organisasjoner where id = :'orgb'), 'ny', 'ikke verifisert');
-- Brukeren ber om manuell godkjenning. Godkjennes kontoen likevel med organisasjonen senere,
-- verifiseres den som alt finnes, og forespørselen er behandlet.
select faktura.be_om_manuell_verifisering(:'orgb', 'Daglig leder');
select set_config('app.bruker_id', :'admin', false);
select set_config('app.betrodd', 'on', false);
select test.er((faktura.behandle_konto(:'b', true)).godkjent_orgnr, '316200036', 'godkjent med organisasjonen nå');
select set_config('app.betrodd', '', false);
select set_config('app.bruker_id', :'b', false);
select test.er((select verifisering || '|' || verifisert_metode from faktura.organisasjoner where id = :'orgb'),
               'verifisert|kontogodkjenning', 'den som fantes, er verifisert');
select test.er((select status from faktura.verifiseringer where org_id = :'orgb' and metode = 'manuell'), 'godkjent', 'forespørselen er behandlet');

-- En person (uten organisasjonsnummer) får ikke noe godkjent nummer.
select id as c from faktura.registrer_bruker('uid-en-c', 'c-en@test.no', 'Cecilie Ny') \gset
select set_config('app.bruker_id', :'c', false);
select faktura.velg_registrering('person');
select set_config('app.bruker_id', :'admin', false);
select set_config('app.betrodd', 'on', false);
select test.er((faktura.behandle_konto(:'c', true)).godkjent_orgnr, null::text, 'personen har ikke noe nummer');
select set_config('app.betrodd', '', false);

-- Avvist: heller ikke.
select id as d from faktura.registrer_bruker('uid-en-d', 'd-en@test.no', 'Dag Ny') \gset
select set_config('app.bruker_id', :'d', false);
select faktura.velg_registrering('organisasjon', '316200044', 'Avvist AS');
select set_config('app.bruker_id', :'admin', false);
select set_config('app.betrodd', 'on', false);
select test.er((faktura.behandle_konto(:'d', false, 'Ukjent')).godkjent_orgnr, null::text, 'avvist uten nummer');
select set_config('app.betrodd', '', false);

-- Godkjent ved en invitasjon (ikke hos plattformadministratoren): den vanlige verifiseringen.
select id as e from faktura.registrer_bruker('uid-en-e', 'e-en@test.no', 'Eva Ny') \gset
select set_config('app.bruker_id', :'e', false);
select faktura.velg_registrering('organisasjon', '316200052', 'Invitert AS');
select set_config('app.bruker_id', :'a', false);
select faktura.inviter_medlem(:'orga', 'e-en@test.no', 'les') as token \gset
select set_config('app.bruker_id', :'e', false);
select faktura.aksepter_invitasjon(:'token');
select test.er((select status || '|' || coalesce(godkjent_orgnr, '-') from faktura.brukere where id = :'e'), 'godkjent|-', 'godkjent av invitasjonen, uten nummer');
select id as orge from faktura.opprett_organisasjon('Invitert AS', '316200052') \gset
select test.er((select verifisering from faktura.organisasjoner where id = :'orge'), 'ny', 'ikke verifisert');

-- Er nummeret alt verifisert hos en annen organisasjon, venter den nye (uten feil).
select id as f from faktura.registrer_bruker('uid-en-f', 'f-en@test.no', 'Frida Ny') \gset
select set_config('app.bruker_id', :'f', false);
select faktura.velg_registrering('organisasjon', '316200001', 'Første Godkjenning AS');
select set_config('app.bruker_id', :'admin', false);
select set_config('app.betrodd', 'on', false);
select test.er((faktura.behandle_konto(:'f', true)).godkjent_orgnr, '316200001', 'godkjent med et nummer som alt er verifisert');
select set_config('app.betrodd', '', false);
select set_config('app.bruker_id', :'f', false);
select id as orgf from faktura.opprett_organisasjon('Første Godkjenning AS', '316200001') \gset
select test.er((select verifisering from faktura.organisasjoner where id = :'orgf'), 'ny', 'venter, nummeret er verifisert hos en annen');

-- Nummeret lagt inn senere (organisasjonen ble laget uten): verifisert da.
select id as g from faktura.registrer_bruker('uid-en-g', 'g-en@test.no', 'Geir Ny') \gset
select set_config('app.bruker_id', :'g', false);
select faktura.velg_registrering('organisasjon', '316200060', 'Senere AS');
select set_config('app.bruker_id', :'admin', false);
select set_config('app.betrodd', 'on', false);
select faktura.behandle_konto(:'g', true);
select set_config('app.betrodd', '', false);
select set_config('app.bruker_id', :'g', false);
select id as orgg from faktura.opprett_organisasjon('Geir Ny', null, 'privatperson') \gset
select test.er((select verifisering from faktura.organisasjoner where id = :'orgg'), 'ny', 'uten nummer venter');
select test.er((faktura.legg_inn_orgnr(:'orgg', '316200060')).verifisering, 'verifisert', 'verifisert når nummeret legges inn');
-- Et annet nummer lagt inn senere gir ingenting.
select id as orgg2 from faktura.opprett_organisasjon('Geir Ny 2', null, 'privatperson') \gset
select test.er((faktura.legg_inn_orgnr(:'orgg2', '316200079')).verifisering, 'ny', 'et annet nummer venter');

\c :migrator
drop schema test cascade;
\echo '  ok'
