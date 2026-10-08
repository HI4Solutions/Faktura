-- Moduler (0044_moduler.sql): hver funksjon hører til en modul, den nye brukeren velger
-- modulene sine mens kontoen venter, forespørselen meldes først når modulene er valgt,
-- administratoren godkjenner med modulene (og kan endre dem), og organisasjonene brukeren lager
-- etterpå, får bare funksjonene i modulene (og ansatte og timer er slått på når de har Bemanning).

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
-- Modulene kan alle se, og hver funksjon hører til en.
select test.er((select array_agg(kode order by rekkefolge) from faktura.moduler), array['faktura', 'bemanning'], 'Faktura og Bemanning');
select test.er((select array_agg(kode order by rekkefolge) from faktura.funksjoner where modul = 'bemanning'), array['ansatte', 'vaktplan'], 'Bemanning har ansatte og vaktplan');
select test.er((select count(*) from faktura.funksjoner where modul is null), 0::bigint, 'alle funksjonene har en modul');

-- En ny bruker velger modulene (minst én, og bare kjente).
select id as u from faktura.registrer_bruker('uid-modul-ny', 'ny-modul@test.no', 'Mona Modul') \gset
select set_config('app.bruker_id', :'u', false);
select test.feiler($$select faktura.velg_moduler('{}')$$, 'FA400');
select test.feiler($$select faktura.velg_moduler(array['faktura', 'finnes_ikke'])$$, 'FA400');
select test.er(faktura.meld_konto(), false, 'ikke meldt uten moduler');
select test.er(faktura.velg_moduler(array['bemanning', 'faktura']), array['faktura', 'bemanning'], 'valgt, i modulenes rekkefølge');
select test.er(faktura.velg_moduler(array['bemanning']), array['bemanning'], 'endret');
select test.er((select array_agg(modul) from faktura.bruker_moduler), array['bemanning'], 'brukeren ser sine egne');
select test.er(faktura.meld_konto(), true, 'meldt når navn og moduler er på plass');
-- Endres ikke direkte.
select test.feiler($$insert into faktura.bruker_moduler (bruker_id, modul) values (faktura.bruker_id(), 'faktura')$$, '42501');

-- En annen bruker ser ikke modulene til den første.
select id as u2 from faktura.registrer_bruker('uid-modul-annen', 'annen-modul@test.no', 'Anne Annen') \gset
select set_config('app.bruker_id', :'u2', false);
select test.er((select count(*) from faktura.bruker_moduler), 0::bigint, 'ser ikke andres moduler');
select faktura.velg_moduler(array['faktura']);

-- Plattformadministratoren ser modulene i forespørselen og godkjenner med dem, eller med andre.
select set_config('app.betrodd', 'on', false);
select test.er((select moduler from faktura.admin_kontoer_venter() where id = :'u'), array['bemanning'], 'modulene står i forespørselen');
select test.er((faktura.behandle_konto(:'u', true)).status, 'godkjent', 'godkjent med modulene den ba om');
select test.er((select moduler from faktura.admin_brukere() where id = :'u'), array['bemanning'], 'og i brukerlista');
select test.feiler($$select faktura.behandle_konto('$$ || :'u2' || $$', true, null, '{}')$$, 'FA400');
select test.er((faktura.behandle_konto(:'u2', true, null, array['faktura', 'bemanning'])).status, 'godkjent', 'godkjent med en modul til');
select test.er((select moduler from faktura.admin_brukere() where id = :'u2'), array['faktura', 'bemanning'], 'med begge modulene');
select test.er((select jsonb_agg(m ->> 'kode') from jsonb_array_elements(faktura.admin_funksjoner() -> 'moduler') m), '["faktura", "bemanning"]'::jsonb, 'modulene i funksjonsoversikten');
select test.er((select f ->> 'modul' from jsonb_array_elements(faktura.admin_funksjoner() -> 'funksjoner') f where f ->> 'kode' = 'vaktplan'), 'bemanning', 'med modulen per funksjon');
select set_config('app.betrodd', '', false);

-- Etter godkjenningen endrer bare administratoren modulene.
select set_config('app.bruker_id', :'u', false);
select test.feiler($$select faktura.velg_moduler(array['faktura'])$$, 'FA403');

-- En organisasjon fra brukeren med bare Bemanning får bare funksjonene i Bemanning.
select id as org from faktura.opprett_organisasjon('Bare Bemanning AS') \gset
select test.er((select array_agg(kode order by kode) from faktura.org_funksjoner where org_id = :'org' and aktiv), array['ansatte', 'vaktplan'], 'bare Bemanning');
select test.er(faktura.har_funksjon(:'org', 'ehf'), false, 'uten EHF');
select test.er((select personal from faktura.mine_organisasjoner where id = :'org'), true, 'ansatte og timer er slått på fra start');

-- Med begge modulene: standarden, også i modulene (EHF er av som standard her).
\c :migrator
update faktura.funksjoner set standard = false where kode = 'ehf';
\c :api
select set_config('app.bruker_id', :'u2', false);
select id as org2 from faktura.opprett_organisasjon('Begge Moduler AS') \gset
select test.er(faktura.har_funksjon(:'org2', 'vaktplan'), true, 'Bemanning er med');
select test.er(faktura.har_funksjon(:'org2', 'bank'), true, 'Faktura er med');
select test.er(faktura.har_funksjon(:'org2', 'ehf'), false, 'men ikke det som er av som standard');
select test.er((select personal from faktura.mine_organisasjoner where id = :'org2'), true, 'ansatte og timer er på');

-- En bruker uten moduler (konto fra før) får standarden som før.
select id as u3 from faktura.registrer_bruker('uid-modul-gammel', 'gammel-modul@test.no', 'Gunnar Gammel') \gset
select set_config('app.bruker_id', :'u3', false);
select id as org3 from faktura.opprett_organisasjon('Uten Moduler AS') \gset
select test.er((select count(*) from faktura.org_funksjoner where org_id = :'org3' and aktiv), (select count(*) from faktura.funksjoner where standard), 'standarden');
select test.er((select personal from faktura.mine_organisasjoner where id = :'org3'), false, 'ansatte og timer slås på i innstillingene som før');

\c :migrator
update faktura.funksjoner set standard = true where kode = 'ehf';
drop schema test cascade;
\echo '  ok'
