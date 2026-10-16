-- Sjekklister (0114_sjekklister.sql): administrator lager sjekklistene (de andre kan ikke), de med
-- rollen (eller alle) fyller dem ut med «ok» eller «avvik» med kommentar, de faste har én utfylling
-- per periode, en fullført kan ikke endres, og administrator lukker avvikene med et tiltak. Den som
-- ikke har rollen, ser verken sjekklisten som å gjøre eller utfyllingene; Personal ser alt.

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
select id as u from faktura.registrer_bruker('uid-sjekk-eier', 'eier-sjekk@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Sjekk AS', '915000363') \gset
select test.er(faktura.har_funksjon(:'org', 'sjekklister'), true, 'sjekklistene er på for nye organisasjoner med ansatte og timer');
insert into faktura.ansattgrupper (org_id, navn) values (:'org', 'Butikk') returning id as butikk \gset
insert into faktura.ansattgrupper (org_id, navn) values (:'org', 'Lager') returning id as lager \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, gruppe_id) values (:'org', 'Ola', 'Sjekk', 'ola-sjekk@test.no', '2026-01-01', :'butikk') returning id as ola \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, gruppe_id) values (:'org', 'Kari', 'Sjekk', 'kari-sjekk@test.no', '2026-01-01', :'lager') returning id as kari \gset
select faktura.inviter_ansatt(:'org', :'ola') as t_ola \gset
select faktura.inviter_ansatt(:'org', :'kari') as t_kari \gset
select faktura.inviter_medlem(:'org', 'regn-sjekk@test.no', 'regnskap') as t_regn \gset
select id as u_ola from faktura.registrer_bruker('uid-sjekk-ola', 'ola-sjekk@test.no') \gset
select id as u_kari from faktura.registrer_bruker('uid-sjekk-kari', 'kari-sjekk@test.no') \gset
select id as u_regn from faktura.registrer_bruker('uid-sjekk-regn', 'regn-sjekk@test.no') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');
select set_config('app.bruker_id', :'u_kari', false);
select faktura.aksepter_invitasjon(:'t_kari');
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'t_regn');

-- Periodene: dagen, mandagen i uka og den første i måneden.
select test.er(faktura.sjekkliste_periode('daglig', '2026-10-15'), '2026-10-15'::date, 'daglig');
select test.er(faktura.sjekkliste_periode('ukentlig', '2026-10-15'), '2026-10-12'::date, 'ukentlig fra mandag');
select test.er(faktura.sjekkliste_periode('ukentlig', '2026-10-18'), '2026-10-12'::date, 'søndag er i samme uke');
select test.er(faktura.sjekkliste_periode('maanedlig', '2026-10-15'), '2026-10-01'::date, 'månedlig');
select test.er(faktura.sjekkliste_periode('ved_behov', '2026-10-15'), '2026-10-15'::date, 'ved behov');
select test.er(faktura.sjekkliste_forrige('daglig', '2026-10-19', true), '2026-10-18'::date, 'dagen før');
select test.er(faktura.sjekkliste_forrige('daglig', '2026-10-19', false), '2026-10-16'::date, 'stengt i helgene: fredag før mandag');
select test.er(faktura.sjekkliste_forrige('daglig', '2026-10-18', false), '2026-10-16'::date, 'stengt i helgene: fredag før søndag');
select test.er(faktura.sjekkliste_forrige('daglig', '2026-10-17', false), '2026-10-16'::date, 'stengt i helgene: fredag før lørdag');
select test.er(faktura.sjekkliste_forrige('daglig', '2026-10-15', false), '2026-10-14'::date, 'stengt i helgene: dagen før på en hverdag');
select test.er(faktura.sjekkliste_forrige('ukentlig', '2026-10-15', false), '2026-10-05'::date, 'uka før');
select test.er(faktura.sjekkliste_forrige('maanedlig', '2026-10-15', true), '2026-09-01'::date, 'måneden før');
select test.er(faktura.sjekkliste_forrige('ved_behov', '2026-10-15', true), null::date, 'ved behov har ingen');

-- Administrator lager sjekklistene; navnet, punktene og rollene sjekkes.
select set_config('app.bruker_id', :'u', false);
select faktura.lagre_sjekkliste(:'org', null, 'Åpning', 'Hver morgen', 'daglig', '{}',
  '[{"tekst": "Lys og varme på"}, {"tekst": "Kassen telt", "hjelp": "Skriv avviket om det ikke stemmer"}, {"tekst": "Alarmen av"}]') as aapning \gset
select faktura.lagre_sjekkliste(:'org', null, 'Varemottak', null, 'ved_behov', array[:'lager']::uuid[],
  '[{"tekst": "Antall kolli stemmer"}, {"tekst": "Ingen skader"}]') as vare \gset
select test.feiler(format($$select faktura.lagre_sjekkliste(%L, null, 'åpning', null, 'daglig', '{}', '[{"tekst": "X"}]')$$, :'org'), 'FA409');
select test.feiler(format($$select faktura.lagre_sjekkliste(%L, null, 'Tom', null, 'daglig', '{}', '[]')$$, :'org'), 'FA400');
select test.feiler(format($$select faktura.lagre_sjekkliste(%L, null, 'Tom', null, 'daglig', '{}', '[{"tekst": "  "}]')$$, :'org'), 'FA400');
select test.feiler(format($$select faktura.lagre_sjekkliste(%L, null, 'X', null, 'daglig', '{}', '[{"tekst": "A"}]')$$, :'org'), 'FA400');
select test.feiler(format($$select faktura.lagre_sjekkliste(%L, null, 'Ukjent', null, 'hver time', '{}', '[{"tekst": "A"}]')$$, :'org'), 'FA400');
select test.feiler(format($$select faktura.lagre_sjekkliste(%L, null, 'Rolle', null, 'daglig', array[gen_random_uuid()], '[{"tekst": "A"}]')$$, :'org'), 'FA404');
select test.er((select count(*)::int from faktura.sjekkliste_punkter where sjekkliste_id = :'aapning'), 3, 'tre punkter');
select test.er((select string_agg(tekst, '|' order by rekkefolge) from faktura.sjekkliste_punkter where sjekkliste_id = :'aapning'), 'Lys og varme på|Kassen telt|Alarmen av', 'i rekkefølge');

-- De andre lager og endrer ikke sjekklister.
select set_config('app.bruker_id', :'u_ola', false);
select test.feiler(format($$select faktura.lagre_sjekkliste(%L, null, 'Egen', null, 'daglig', '{}', '[{"tekst": "A"}]')$$, :'org'), 'FA403');
select test.feiler(format($$select faktura.slett_sjekkliste(%L, %L)$$, :'org', :'aapning'), 'FA403');
select test.feiler(format($$select faktura.sett_sjekkliste_aktiv(%L, %L, false)$$, :'org', :'aapning'), 'FA403');
select test.feiler(format($$insert into faktura.sjekklister (org_id, navn) values (%L, 'Rett inn')$$, :'org'), '42501');
select test.er((select count(*)::int from faktura.sjekklister where org_id = :'org'), 2, 'alle i organisasjonen ser sjekklistene');

-- Ola (Butikk) gjør Åpning (til alle), men ikke Varemottak (Lager).
select test.feiler(format($$select faktura.start_sjekkliste(%L, %L, null)$$, :'org', :'vare'), 'FA404');
select test.feiler(format($$select faktura.start_sjekkliste(%L, %L, faktura.i_dag() + 1)$$, :'org', :'aapning'), 'FA400');
select test.feiler(format($$select faktura.start_sjekkliste(%L, %L, faktura.i_dag() - 90)$$, :'org', :'aapning'), 'FA400');
select faktura.start_sjekkliste(:'org', :'aapning', null) as u1 \gset
select test.er(faktura.start_sjekkliste(:'org', :'aapning', null), :'u1'::uuid, 'samme utfylling samme dag');
select test.er((select periode from faktura.sjekkliste_utfyllinger where id = :'u1'), (select faktura.i_dag()), 'perioden er i dag');
select test.er((select startet_navn from faktura.sjekkliste_utfyllinger where id = :'u1'), 'Ola Sjekk', 'navnet fra ansattregisteret');
select id as p1 from faktura.sjekkliste_punkter where sjekkliste_id = :'aapning' and rekkefolge = 1 \gset
select id as p2 from faktura.sjekkliste_punkter where sjekkliste_id = :'aapning' and rekkefolge = 2 \gset
select id as p3 from faktura.sjekkliste_punkter where sjekkliste_id = :'aapning' and rekkefolge = 3 \gset
select faktura.svar_sjekkliste(:'org', :'u1', :'p1', 'ok', null);
select test.feiler(format($$select faktura.svar_sjekkliste(%L, %L, %L, 'avvik', ' ')$$, :'org', :'u1', :'p2'), 'FA400');
select test.feiler(format($$select faktura.svar_sjekkliste(%L, %L, %L, 'kanskje', null)$$, :'org', :'u1', :'p2'), 'FA400');
select test.feiler(format($$select faktura.svar_sjekkliste(%L, %L, gen_random_uuid(), 'ok', null)$$, :'org', :'u1'), 'FA404');
select faktura.svar_sjekkliste(:'org', :'u1', :'p2', 'avvik', 'Mangler 200 kr');
select test.feiler(format($$select faktura.fullfor_sjekkliste(%L, %L, null)$$, :'org', :'u1'), 'FA400');
select test.er(faktura.sjekkliste_alt_normalt(:'org', :'u1'), 1, 'ett punkt igjen');
select test.er((select string_agg(svar, ',' order by punkt_tekst) from faktura.sjekkliste_svar where utfylling_id = :'u1'), 'ok,avvik,ok', 'svarene');
select test.er(faktura.fullfor_sjekkliste(:'org', :'u1', 'Fin morgen'), 1, 'ett avvik');
select test.er((select status || '|' || fullfort_navn || '|' || kommentar from faktura.sjekkliste_utfyllinger where id = :'u1'), 'fullfort|Ola Sjekk|Fin morgen', 'fullført');
-- En fullført sjekkliste endres ikke, og samme dag gir den samme.
select test.feiler(format($$select faktura.svar_sjekkliste(%L, %L, %L, 'ok', null)$$, :'org', :'u1', :'p2'), 'FA409');
select test.feiler(format($$select faktura.fullfor_sjekkliste(%L, %L, null)$$, :'org', :'u1'), 'FA409');
select test.er(faktura.start_sjekkliste(:'org', :'aapning', null), :'u1'::uuid, 'dagens er allerede gjort');
-- I går er en egen periode.
select faktura.start_sjekkliste(:'org', :'aapning', faktura.i_dag() - 1) as u0 \gset
select test.er(:'u0' <> :'u1', true, 'en ny for i går');
-- Ola ser utfyllingene av Åpning, men ikke lukker avviket.
select test.er((select count(*)::int from faktura.sjekkliste_utfyllinger where org_id = :'org'), 2, 'Ola ser sine');
select test.feiler(format($$select faktura.lukk_sjekkliste_avvik(%L, %L, %L, 'Telt på nytt')$$, :'org', :'u1', :'p2'), 'FA403');

-- Kari (Lager) gjør Varemottak; ved behov fortsetter hun sin egen som ikke er fullført.
select set_config('app.bruker_id', :'u_kari', false);
select faktura.start_sjekkliste(:'org', :'vare', null) as v1 \gset
select test.er(faktura.start_sjekkliste(:'org', :'vare', null), :'v1'::uuid, 'fortsetter sin egen');
select test.er(faktura.sjekkliste_alt_normalt(:'org', :'v1'), 2, 'alt normalt');
select test.er(faktura.fullfor_sjekkliste(:'org', :'v1', null), 0, 'ingen avvik');
select faktura.start_sjekkliste(:'org', :'vare', null) as v2 \gset
select test.er(:'v2' <> :'v1', true, 'neste varemottak er en ny');
-- Kari ser Åpning (til alle) og sine egne varemottak.
select test.er((select count(*)::int from faktura.sjekkliste_utfyllinger where org_id = :'org'), 4, 'Kari ser alle fire');
select test.er((select count(*)::int from faktura.sjekkliste_svar where utfylling_id = :'u1'), 3, 'og svarene på Åpning');

-- Ola ser ikke varemottakene (Lager).
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select count(*)::int from faktura.sjekkliste_utfyllinger where sjekkliste_id = :'vare'), 0, 'Ola ser ikke varemottakene');
select test.er((select count(*)::int from faktura.sjekkliste_svar where utfylling_id = :'v1'), 0, 'eller svarene');
select test.feiler(format($$select faktura.svar_sjekkliste(%L, %L, (select id from faktura.sjekkliste_punkter where sjekkliste_id = %L limit 1), 'ok', null)$$, :'org', :'v2', :'vare'), 'FA404');

-- Regnskap (ser personalet) ser alt, men lukker ikke avvik.
select set_config('app.bruker_id', :'u_regn', false);
select test.er((select count(*)::int from faktura.sjekkliste_utfyllinger where org_id = :'org'), 4, 'regnskap ser alle');
select test.feiler(format($$select faktura.lukk_sjekkliste_avvik(%L, %L, %L, 'Telt på nytt')$$, :'org', :'u1', :'p2'), 'FA403');

-- Administrator lukker avviket med tiltaket (og får hvem som meldte det).
select set_config('app.bruker_id', :'u', false);
select test.feiler(format($$select faktura.lukk_sjekkliste_avvik(%L, %L, %L, ' ')$$, :'org', :'u1', :'p2'), 'FA400');
select test.feiler(format($$select faktura.lukk_sjekkliste_avvik(%L, %L, %L, 'Ok')$$, :'org', :'u1', :'p1'), 'FA404');
select test.er(faktura.lukk_sjekkliste_avvik(:'org', :'u1', :'p2', 'Kassen telt på nytt, stemmer'), :'u_ola'::uuid, 'meldt av Ola');
select test.er((select tiltak || '|' || avvik_lukket_navn from faktura.sjekkliste_svar where utfylling_id = :'u1' and punkt_id = :'p2'), 'Kassen telt på nytt, stemmer|eier-sjekk@test.no', 'lukket');
select test.feiler(format($$select faktura.lukk_sjekkliste_avvik(%L, %L, %L, 'Igjen')$$, :'org', :'u1', :'p2'), 'FA404');
select test.feiler(format($$update faktura.sjekkliste_svar set tiltak = 'Rett inn' where utfylling_id = %L$$, :'u1'), '42501');

-- Endringer: et besvart punkt tas ut av lista (svaret står), et nytt kommer til.
select faktura.lagre_sjekkliste(:'org', :'aapning', 'Åpning', 'Hver morgen', 'daglig', '{}',
  format('[{"id": %s, "tekst": "Lys og varme på"}, {"tekst": "Dørene låst opp"}]', to_jsonb(:'p1'::text))::jsonb);
select test.er((select count(*)::int from faktura.sjekkliste_punkter where sjekkliste_id = :'aapning' and aktiv), 2, 'to i lista');
select test.er((select aktiv from faktura.sjekkliste_punkter where id = :'p2'), false, 'det besvarte punktet er tatt ut');
select test.er((select punkt_tekst from faktura.sjekkliste_svar where utfylling_id = :'u1' and punkt_id = :'p2'), 'Kassen telt', 'teksten står i svaret');
-- I går (påbegynt) kan svare på de nye punktene, ikke de som er tatt ut.
select test.feiler(format($$select faktura.svar_sjekkliste(%L, %L, %L, 'ok', null)$$, :'org', :'u0', :'p2'), 'FA404');
select test.er(faktura.sjekkliste_alt_normalt(:'org', :'u0'), 2, 'de to i lista');

-- En som er brukt, arkiveres; en som ikke er brukt, slettes. En arkivert kan ikke startes.
select faktura.lagre_sjekkliste(:'org', null, 'Måned', null, 'maanedlig', '{}', '[{"tekst": "Brannslukker sjekket"}]') as mnd \gset
select test.er(faktura.slett_sjekkliste(:'org', :'mnd'), 'slettet', 'ubrukt slettes');
select test.er(faktura.slett_sjekkliste(:'org', :'vare'), 'arkivert', 'brukt arkiveres');
select test.feiler(format($$select faktura.start_sjekkliste(%L, %L, null)$$, :'org', :'vare'), 'FA409');
select faktura.lagre_sjekkliste(:'org', null, 'Varemottak', null, 'daglig', '{}', '[{"tekst": "Ny"}]') as vare2 \gset
select test.feiler(format($$select faktura.sett_sjekkliste_aktiv(%L, %L, true)$$, :'org', :'vare'), 'FA409');
select faktura.slett_sjekkliste(:'org', :'vare2');
select faktura.sett_sjekkliste_aktiv(:'org', :'vare', true);
select test.er((select aktiv from faktura.sjekklister where id = :'vare'), true, 'hentet fram igjen');

-- Uten funksjonen eller medlemskap: ingenting.
select id as u_fremmed from faktura.registrer_bruker('uid-sjekk-fremmed', 'fremmed-sjekk@test.no') \gset
select set_config('app.bruker_id', :'u_fremmed', false);
select test.er((select count(*)::int from faktura.sjekklister where org_id = :'org'), 0, 'en fremmed ser ingenting');
select test.feiler(format($$select faktura.start_sjekkliste(%L, %L, null)$$, :'org', :'aapning'), 'FA404');

\c :migrator
drop schema test cascade;
\echo '  ok'
