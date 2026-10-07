-- AI-assistenten (0031_ai_assistent.sql): alle med tilgang til organisasjonen kan spørre,
-- forespørslene telles i samme tak som de andre AI-funksjonene, og plattformadministratorene
-- ser bruken per funksjon.

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
select id as u from faktura.registrer_bruker('uid-assistent', 'assistent@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Assistent AS', '923609016') \gset

-- Et medlem som bare kan lese, kan spørre assistenten, men ikke lage fakturautkast.
select id as u2 from faktura.registrer_bruker('uid-assistent-les', 'les-assistent@test.no') \gset
select faktura.inviter_medlem(:'org', 'les-assistent@test.no', 'les') as t \gset
select set_config('app.bruker_id', :'u2', false);
select faktura.aksepter_invitasjon(:'t');
select test.er(faktura.ai_reserver(:'org', 'assistent', 3), true, 'lesetilgang kan spørre assistenten');
select test.feiler(format($$select faktura.ai_reserver(%L, 'faktura', 3)$$, :'org'), 'FA403');
select faktura.ai_tokens(:'org', 'assistent', 900, 60);

-- Samme tak som resten.
select set_config('app.bruker_id', :'u', false);
select test.er(faktura.ai_reserver(:'org', 'faktura', 3), true, 'fakturautkast');
select test.er(faktura.ai_reserver(:'org', 'assistent', 3), true, 'assistenten igjen');
select test.er(faktura.ai_reserver(:'org', 'assistent', 3), false, 'taket gjelder alle funksjonene');
select test.er((select antall from faktura.ai_bruk where org_id = :'org' and funksjon = 'assistent'), 2, 'to til assistenten');
select test.er((select tokens_inn from faktura.ai_bruk where org_id = :'org' and funksjon = 'assistent'), 900::bigint, 'tokens');

-- Uten tilgang til organisasjonen: ingenting.
select id as u3 from faktura.registrer_bruker('uid-assistent-annen', 'annen-assistent@test.no') \gset
select set_config('app.bruker_id', :'u3', false);
select test.feiler(format($$select faktura.ai_reserver(%L, 'assistent', 100)$$, :'org'), 'FA403');

-- Plattformadministratorene ser assistenten som egen kolonne.
select set_config('app.bruker_id', :'u', false);
select set_config('app.betrodd', 'on', false);
select test.er((select (x ->> 'assistent')::int from jsonb_array_elements(faktura.admin_ai() -> 'organisasjoner') x where x ->> 'org_id' = :'org'), 2,
               'assistenten i adminoversikten');

\c :migrator
drop schema test cascade;
\echo '  ok'
