-- Ansatte og timer (0035_ansatte_og_timer.sql): rollen ansatt ser bare sitt eget, aldri
-- fakturadata; eier og admin styrer ansatte og godkjenner timer; regnskap ser, men endrer
-- ikke; fødselsnummeret kan bare workeren lese, og det havner aldri i loggen.

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
select id as u from faktura.registrer_bruker('uid-ansatt-eier', 'eier-ansatte@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Bemanning AS', '923609016') \gset
insert into faktura.kunder (org_id, navn) values (:'org', 'Hemmelig Kunde AS');
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);

-- Ansatte får nummer i rekkefølge; fødselsnummeret kan skrives, men ikke leses av API-et.
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, fnr_kryptert, ansatt_fra, lonnstype, timelonn)
values (:'org', '  Ola ', 'Nordmann', ' Ola@Test.no ', '\x0102'::bytea, '2026-01-01', 'time', 250)
returning id as ola, ansattnummer as ola_nr, epost as ola_epost, har_fnr as ola_fnr \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, lonnstype, maanedslonn)
values (:'org', 'Kari', 'Hansen', '2026-01-01', 'maaned', 50000) returning id as kari, ansattnummer as kari_nr \gset
select test.er(:'ola_nr'::int, 1, 'første ansattnummer');
select test.er(:'kari_nr'::int, 2, 'neste ansattnummer');
select test.er(:'ola_epost', 'ola@test.no', 'e-post med små bokstaver');
select test.er(:'ola_fnr'::boolean, true, 'har fødselsnummer');
select test.er((select fornavn from faktura.ansatte where id = :'ola'), 'Ola', 'navnet uten mellomrom');
select test.feiler('select fnr_kryptert from faktura.ansatte', '42501');
select test.feiler(format($$update faktura.ansatte set ansattnummer = 9 where id = %L$$, :'ola'), '42501');
select test.feiler(format($$update faktura.ansatte set bruker_id = %L where id = %L$$, :'u', :'ola'), '42501');

-- Loggen: aldri fødselsnummeret, bare at det er registrert.
select test.er((select endring ? 'fnr_kryptert' from faktura.revisjonslogg where tabell = 'ansatte' and rad_id = :'ola' and handling = 'INSERT'),
               false, 'fødselsnummeret er ikke i loggen');
select test.er((select endring ->> 'fodselsnummer' from faktura.revisjonslogg where tabell = 'ansatte' and rad_id = :'ola' and handling = 'INSERT'),
               'registrert', 'loggen sier at det er registrert');
update faktura.ansatte set fnr_kryptert = '\x0304'::bytea where id = :'ola';
select test.er((select endring ->> 'fodselsnummer' from faktura.revisjonslogg where tabell = 'ansatte' and rad_id = :'ola' and handling = 'UPDATE'),
               'endret', 'loggen sier at det er endret');

-- Egen innlogging: invitasjonen kobler brukeren til den ansatte, med rollen ansatt.
select faktura.inviter_ansatt(:'org', :'ola') as t \gset
select test.feiler(format($$select faktura.inviter_ansatt(%L, %L)$$, :'org', :'kari'), 'FA400');
select id as u_ola from faktura.registrer_bruker('uid-ansatt-ola', 'ola@test.no') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t');

-- Den ansatte ser organisasjonen, sitt medlemskap og seg selv, men ikke fakturadata.
select test.er((select rolle from faktura.mine_organisasjoner where id = :'org'), 'ansatt', 'rollen ansatt');
select test.er((select personal from faktura.mine_organisasjoner where id = :'org'), true, 'ansatte og timer er på');
select test.er((select ansatt_id from faktura.mine_organisasjoner where id = :'org'), :'ola'::uuid, 'egen ansattrad');
select test.er(faktura.kan(:'org', 'les'), false, 'ansatt kan ikke lese fakturadata');
select test.er(faktura.kan(:'org', 'medlem'), true, 'men er medlem');
select test.er((select count(*) from faktura.kunder), 0::bigint, 'ingen kunder');
select test.er((select count(*) from faktura.fakturaer), 0::bigint, 'ingen fakturaer');
select test.er((select count(*) from faktura.revisjonslogg), 0::bigint, 'ingen logg');
select test.er((select count(*) from faktura.medlemmer), 1::bigint, 'bare sitt eget medlemskap');
select test.er((select string_agg(fornavn, ',') from faktura.ansatte), 'Ola', 'bare seg selv');
select test.er((select bruker_id from faktura.ansatte where id = :'ola'), :'u_ola'::uuid, 'koblet til innloggingen');

-- Timer for seg selv: fra–til med pause, over midnatt, eller bare timer. Ikke for andre.
insert into faktura.timeforinger (org_id, ansatt_id, dato, fra, til, pause_min, beskrivelse)
values (:'org', :'ola', '2026-10-05', '08:00', '16:30', 30, '  Butikk  ') returning id as t1, timer as t1_timer, status as t1_status, beskrivelse as t1_besk \gset
select test.er(:'t1_timer'::numeric, 8.00, 'åtte timer med halvtime pause');
select test.er(:'t1_status', 'utkast', 'et utkast');
select test.er(:'t1_besk', 'Butikk', 'beskrivelsen uten mellomrom');
insert into faktura.timeforinger (org_id, ansatt_id, dato, fra, til) values (:'org', :'ola', '2026-10-06', '22:00', '06:30') returning id as t2, timer as t2_timer \gset
select test.er(:'t2_timer'::numeric, 8.50, 'nattskift over midnatt');
insert into faktura.timeforinger (org_id, ansatt_id, dato, timer, overtid_prosent) values (:'org', :'ola', '2026-10-07', 2.5, 50) returning id as t3 \gset
select test.feiler(format($$insert into faktura.timeforinger (org_id, ansatt_id, dato, timer) values (%L, %L, '2026-10-05', 1)$$, :'org', :'kari'), '42501');
select test.feiler(format($$insert into faktura.timeforinger (org_id, ansatt_id, dato, fra, til) values (%L, %L, '2026-10-05', '08:00', '08:00')$$, :'org', :'ola'), 'FA400');
select test.feiler(format($$insert into faktura.timeforinger (org_id, ansatt_id, dato, fra, til, pause_min) values (%L, %L, '2026-10-05', '08:00', '08:30', 30)$$, :'org', :'ola'), 'FA400');
select test.feiler(format($$insert into faktura.timeforinger (org_id, ansatt_id, dato, timer) values (%L, %L, '2025-12-31', 1)$$, :'org', :'ola'), 'FA400');
select test.feiler(format($$update faktura.timeforinger set ansatt_id = %L where id = %L$$, :'kari', :'t1'), '42501');
select test.feiler(format($$update faktura.timeforinger set status = 'godkjent' where id = %L$$, :'t1'), '42501');

-- Levert: kan ikke endres eller slettes av den ansatte, og bare personal godkjenner.
select test.er(faktura.lever_timer(:'org', :'ola', '2026-10-05', '2026-10-11'), 3, 'tre føringer levert');
update faktura.timeforinger set timer = 12 where id = :'t3';
select test.er((select timer from faktura.timeforinger where id = :'t3'), 2.50, 'levert kan ikke endres');
delete from faktura.timeforinger where id = :'t3';
select test.er((select count(*) from faktura.timeforinger where id = :'t3'), 1::bigint, 'levert kan ikke slettes');
select test.feiler(format($$select faktura.godkjenn_timer(%L, array[%L]::uuid[])$$, :'org', :'t1'), 'FA403');
select test.feiler(format($$select faktura.lever_timer(%L, %L, '2026-10-05', '2026-10-11')$$, :'org', :'kari'), 'FA403');

-- Eieren godkjenner og avviser (med grunn); den ansatte retter, og føringen blir et utkast.
select set_config('app.bruker_id', :'u', false);
select test.er(faktura.godkjenn_timer(:'org', array[:'t1', :'t2']::uuid[]), 2, 'to godkjent');
select test.er((select godkjent_av from faktura.timeforinger where id = :'t1'), :'u'::uuid, 'godkjent av eieren');
select test.feiler(format($$select faktura.avvis_timer(%L, array[%L]::uuid[], '  ')$$, :'org', :'t3'), 'FA400');
select test.er(faktura.avvis_timer(:'org', array[:'t3']::uuid[], 'Ikke avtalt overtid'), 1, 'avvist');
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select avvist_grunn from faktura.timeforinger where id = :'t3'), 'Ikke avtalt overtid', 'ser grunnen');
update faktura.timeforinger set timer = 2, overtid_prosent = null where id = :'t3';
select test.er((select status from faktura.timeforinger where id = :'t3'), 'utkast', 'rettet: et utkast igjen');
select test.er(faktura.lever_timer(:'org', :'ola', '2026-10-05', '2026-10-11'), 1, 'levert på nytt');
update faktura.timeforinger set timer = 1 where id = :'t1';
select test.er((select timer from faktura.timeforinger where id = :'t1'), 8.00, 'godkjent kan ikke endres av den ansatte');

-- En som bare kan lese fakturaer, ser ingen ansatte, timer eller logg for ansatte.
select set_config('app.bruker_id', :'u', false);
select id as u_les from faktura.registrer_bruker('uid-ansatt-les', 'les-ansatte@test.no') \gset
select faktura.inviter_medlem(:'org', 'les-ansatte@test.no', 'les') as tl \gset
select id as u_regn from faktura.registrer_bruker('uid-ansatt-regn', 'regn-ansatte@test.no') \gset
select faktura.inviter_medlem(:'org', 'regn-ansatte@test.no', 'regnskap') as tr \gset
select set_config('app.bruker_id', :'u_les', false);
select faktura.aksepter_invitasjon(:'tl');
select test.er((select count(*) from faktura.ansatte), 0::bigint, 'leseren ser ingen ansatte');
select test.er((select count(*) from faktura.timeforinger), 0::bigint, 'leseren ser ingen timer');
select test.er((select count(*) from faktura.revisjonslogg where tabell = 'ansatte'), 0::bigint, 'leseren ser ikke loggen for ansatte');
select test.er((select count(*) > 0 from faktura.revisjonslogg), true, 'men resten av loggen');
select test.er((select count(*) from faktura.kunder), 1::bigint, 'og kundene');

-- Regnskapsføreren ser ansatte og timer (til lønn), men styrer dem ikke.
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'tr');
select test.er((select count(*) from faktura.ansatte), 2::bigint, 'regnskap ser de ansatte');
select test.er((select count(*) from faktura.timeforinger), 3::bigint, 'og timene');
select test.feiler(format($$insert into faktura.ansatte (org_id, fornavn, etternavn) values (%L, 'Per', 'Pål')$$, :'org'), '42501');
select test.feiler(format($$select faktura.godkjenn_timer(%L, array[%L]::uuid[])$$, :'org', :'t3'), 'FA403');

-- Har sluttet: kan ikke føre nye timer.
select set_config('app.bruker_id', :'u', false);
update faktura.ansatte set aktiv = false where id = :'ola';
select set_config('app.bruker_id', :'u_ola', false);
select test.feiler(format($$insert into faktura.timeforinger (org_id, ansatt_id, dato, timer) values (%L, %L, '2026-10-08', 1)$$, :'org', :'ola'), 'FA403');

-- Tilgangen tas bort: medlemskapet og koblingen forsvinner, og den ansatte ser ingenting.
select set_config('app.bruker_id', :'u', false);
select faktura.fjern_ansatt_tilgang(:'org', :'ola');
select test.er((select bruker_id from faktura.ansatte where id = :'ola'), null::uuid, 'koblingen er borte');
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select count(*) from faktura.timeforinger), 0::bigint, 'ser ingen timer');
select test.er((select count(*) from faktura.mine_organisasjoner where id = :'org'), 0::bigint, 'ikke lenger med');

-- Eieren kobles til seg selv som ansatt uten invitasjon (samme e-post).
select set_config('app.bruker_id', :'u', false);
insert into faktura.ansatte (org_id, fornavn, etternavn, epost) values (:'org', 'Eier', 'Selv', 'eier-ansatte@test.no') returning id as selv \gset
select test.er(faktura.inviter_ansatt(:'org', :'selv'), null::text, 'ingen invitasjon');
select test.er((select bruker_id from faktura.ansatte where id = :'selv'), :'u'::uuid, 'koblet til eieren');
select test.er((select ansatt_id from faktura.mine_organisasjoner where id = :'org'), :'selv'::uuid, 'eierens egen ansattrad');
select test.er((select rolle from faktura.medlemmer where org_id = :'org' and bruker_id = :'u'), 'eier', 'fortsatt eier');

-- En ansatt i et regnskapsbyrå får ikke tilgang til byråets klienter (det gjør resten av byrået).
select id as byraa from faktura.opprett_organisasjon('Ansattbyrå AS', '918765409', 'regnskapsbyraa') \gset
\c :worker
select faktura.sett_verifisering(:'byraa', 'verifisert', 'manuell');
\c :api
select set_config('app.bruker_id', :'u', false);
select id as u_byraa from faktura.registrer_bruker('uid-ansatt-byraa', 'byraa-ansatt@test.no') \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost) values (:'byraa', 'Byrå', 'Ansatt', 'byraa-ansatt@test.no') returning id as ba \gset
select faktura.inviter_ansatt(:'byraa', :'ba') as tb \gset
select id as tilgang from faktura.opprett_tilgang(:'org', '918765409', 'bokfor', null) \gset
select faktura.svar_tilgang(:'tilgang', true);
select set_config('app.bruker_id', :'u_byraa', false);
select faktura.aksepter_invitasjon(:'tb');
select test.er(faktura.rolle(:'org'), null::text, 'byråets ansatt har ingen rolle hos klienten');
select test.er((select count(*) from faktura.kunder where org_id = :'org'), 0::bigint, 'og ser ingen kunder der');
select set_config('app.bruker_id', :'u', false);
select test.er(faktura.rolle(:'org'), 'eier', 'eieren er fortsatt eier');

\c :worker
select test.er(faktura.bruker_kan_lese(:'u_byraa', :'byraa'), false, 'workeren: en ansatt kan ikke lese fakturaene');
select test.er(faktura.bruker_kan_lese(:'u', :'org'), true, 'workeren: eieren kan');
select test.er((select fnr_kryptert from faktura.ansatte where id = :'ola'), '\x0304'::bytea, 'workeren leser fødselsnummeret');

\c :migrator
drop schema test cascade;
\echo '  ok'
