-- AI (0030_ai.sql): taket per organisasjon og måned, tilgangen (skriv for fakturautkast,
-- bokfør for innbetalinger), av og på per organisasjon, bruken føres bare gjennom
-- funksjonene, og forslag på innbetalinger som må bekreftes.

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
select id as u from faktura.registrer_bruker('uid-ai', 'ai@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('AI Test AS', '923609016') \gset
select test.er((select ai_aktiv from faktura.organisasjoner where id = :'org'), true, 'AI er slått på som standard');

-- Taket gjelder alle forespørslene til organisasjonen i måneden.
select test.er(faktura.ai_reserver(:'org', 'faktura', 3), true, 'første');
select test.er(faktura.ai_reserver(:'org', 'innbetaling', 3), true, 'andre (innbetaling)');
select test.er(faktura.ai_reserver(:'org', 'faktura', 3), true, 'tredje');
select test.er(faktura.ai_reserver(:'org', 'faktura', 3), false, 'taket er nådd');
select faktura.ai_tokens(:'org', 'faktura', 1200, 300);
select faktura.ai_tokens(:'org', 'faktura', 800, 100);
select test.er((select antall from faktura.ai_bruk where org_id = :'org' and funksjon = 'faktura'), 2, 'to fakturautkast');
select test.er((select tokens_inn from faktura.ai_bruk where org_id = :'org' and funksjon = 'faktura'), 2000::bigint, 'tokens inn');
select test.er((select tokens_ut from faktura.ai_bruk where org_id = :'org' and funksjon = 'faktura'), 400::bigint, 'tokens ut');
select test.er((select maaned from faktura.ai_bruk where org_id = :'org' and funksjon = 'innbetaling'), date_trunc('month', faktura.i_dag())::date, 'denne måneden');
select test.feiler(format($$select faktura.ai_reserver(%L, 'oversett', 100)$$, :'org'), '23514');

-- Bruken føres bare gjennom funksjonene.
select test.feiler(format($$insert into faktura.ai_bruk (org_id, maaned, funksjon) values (%L, '2026-01-01', 'faktura')$$, :'org'), '42501');
select test.feiler(format($$update faktura.ai_bruk set antall = 0 where org_id = %L$$, :'org'), '42501');
select test.feiler($$select faktura.admin_ai()$$, 'FA403');

-- Slått av for organisasjonen: ingen forespørsler.
update faktura.organisasjoner set ai_aktiv = false where id = :'org';
select test.feiler(format($$select faktura.ai_reserver(%L, 'faktura', 100)$$, :'org'), 'FA409');
update faktura.organisasjoner set ai_aktiv = true where id = :'org';

-- Lesetilgang: ingenting. Regnskapsfører (bokfør): forslag på innbetalinger, ikke fakturautkast.
select id as u2 from faktura.registrer_bruker('uid-ai-les', 'les-ai@test.no') \gset
select id as u3 from faktura.registrer_bruker('uid-ai-regnskap', 'regnskap-ai@test.no') \gset
select faktura.inviter_medlem(:'org', 'les-ai@test.no', 'les') as t2 \gset
select faktura.inviter_medlem(:'org', 'regnskap-ai@test.no', 'regnskap') as t3 \gset
select set_config('app.bruker_id', :'u2', false);
select faktura.aksepter_invitasjon(:'t2');
select test.feiler(format($$select faktura.ai_reserver(%L, 'faktura', 100)$$, :'org'), 'FA403');
select test.feiler(format($$select faktura.ai_reserver(%L, 'innbetaling', 100)$$, :'org'), 'FA403');
select test.feiler(format($$select faktura.ai_tokens(%L, 'faktura', 1, 1)$$, :'org'), 'FA403');
select test.er((select count(*)::int from faktura.ai_bruk where org_id = :'org'), 2, 'medlemmer ser bruken');
update faktura.organisasjoner set ai_aktiv = false where id = :'org';
select test.er((select ai_aktiv from faktura.organisasjoner where id = :'org'), true, 'bare administratorer slår AI av');
select set_config('app.bruker_id', :'u3', false);
select faktura.aksepter_invitasjon(:'t3');
select test.er(faktura.ai_reserver(:'org', 'innbetaling', 100), true, 'regnskapsføreren ber om forslag på en innbetaling');
select test.feiler(format($$select faktura.ai_reserver(%L, 'faktura', 100)$$, :'org'), 'FA403');

-- Andre organisasjoner ser ikke bruken.
select id as u4 from faktura.registrer_bruker('uid-ai-annen', 'annen-ai@test.no') \gset
select set_config('app.bruker_id', :'u4', false);
select test.er((select count(*)::int from faktura.ai_bruk), 0, 'en annen ser ingenting');
select test.feiler(format($$select faktura.ai_reserver(%L, 'faktura', 100)$$, :'org'), 'FA403');

-- Forslag på en innbetaling: bare uavklarte, bare utstedte fakturaer i samme organisasjon,
-- og det registreres ikke før noen bekrefter.
select set_config('app.bruker_id', :'u', false);
update faktura.organisasjoner set kontonr = '86011117947' where id = :'org';
insert into faktura.kunder (org_id, navn) values (:'org', 'Kari Hansen') returning id as k \gset
insert into faktura.fakturaer (org_id, kunde_id) values (:'org', :'k') returning id as f1 \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, enhetspris, mva_sats) values (:'org', :'f1', 'Husleie', 8000, 0);
select faktura.utsted(:'f1');
insert into faktura.fakturaer (org_id, kunde_id) values (:'org', :'k') returning id as utkast \gset
select id as annen from faktura.opprett_organisasjon('Annen AS', '974760673') \gset
update faktura.organisasjoner set kontonr = '86011117947' where id = :'annen';
insert into faktura.kunder (org_id, navn) values (:'annen', 'Per') returning id as k2 \gset
insert into faktura.fakturaer (org_id, kunde_id) values (:'annen', :'k2') returning id as fremmed \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, enhetspris, mva_sats) values (:'annen', :'fremmed', 'Noe', 100, 0);
select faktura.utsted(:'fremmed');

\c :worker
insert into faktura.banktransaksjoner (org_id, konto, ekstern_id, dato, belop, betaler, melding)
values (:'org', '86011117947', 'a1', faktura.i_dag(), 8000, 'HANSEN OLA', 'husleie okt') returning id as t1 \gset
select test.er(faktura.ai_reserver(:'org', 'innbetaling', 100), true, 'workeren kan be om forslag');

\c :api
select set_config('app.bruker_id', :'u', false);
select test.feiler(format($$select faktura.foresla_banktransaksjon(%L, %L, 'AI: test')$$, :'t1', :'utkast'), 'FA404');
select test.feiler(format($$select faktura.foresla_banktransaksjon(%L, %L, 'AI: test')$$, :'t1', :'fremmed'), 'FA404');
select test.er((select status from faktura.foresla_banktransaksjon(:'t1', :'f1', 'AI: Husleie for oktober fra en i familien')), 'forslag', 'forslaget');
select test.er((select grunn from faktura.banktransaksjoner where id = :'t1'), 'AI: Husleie for oktober fra en i familien', 'med grunnen');
select test.er((select status from faktura.fakturaer where id = :'f1'), 'utstedt', 'ikke registrert før det er bekreftet');
select test.feiler(format($$select faktura.foresla_banktransaksjon(%L, %L, 'AI: igjen')$$, :'t1', :'f1'), 'FA409');
select test.er((select status from faktura.koble_banktransaksjon(:'t1', :'f1')), 'koblet', 'bekreftet');
select test.er((select status from faktura.fakturaer where id = :'f1'), 'betalt', 'fakturaen er betalt');
select set_config('app.bruker_id', :'u2', false);
select test.feiler(format($$select faktura.foresla_banktransaksjon(%L, %L, 'AI: test')$$, :'t1', :'f1'), 'FA403');

\c :migrator
drop schema test cascade;
\echo '  ok'
