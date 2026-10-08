-- Lønnskjøring (0065_lonn.sql): oppsettet og skattekortet, kjøringer med slipper og linjer som
-- bare eier og administrator lager og endrer, og som låses når de godkjennes (timene merkes som
-- lønnet og kan ikke endres). De ansatte ser bare sine egne slipper, og først når kjøringen er
-- godkjent; regnskap ser alle, den som fakturerer ingen. Trekktabellene lastes opp betrodd, og
-- godkjente kjøringer er regnskapsmateriale når organisasjonen slettes.

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
select id as u from faktura.registrer_bruker('uid-lonn-eier', 'eier-lonn@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Lønn AS', '917654344') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
select test.er(faktura.har_funksjon(:'org', 'lonn'), true, 'lønn er slått på for nye');
select test.er((select row(aga_sone, otp_prosent, feriepenger_prosent, lonnsdag, halv_skatt)::text from faktura.lonn_oppsett where org_id = :'org'),
               '(1,2.00,12.00,20,desember)', 'standardoppsettet');

insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, lonnstype, maanedslonn, kontonr)
values (:'org', 'Ola', 'Lønn', 'ola-lonn@test.no', '2026-01-01', 'maaned', 50000, '12345678903') returning id as ola \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, lonnstype, timelonn)
values (:'org', 'Kari', 'Lønn', 'kari-lonn@test.no', '2026-01-01', 'time', 250) returning id as kari \gset

-- Skattekortet må være fullstendig.
select test.feiler(format($$update faktura.ansatte set skattekort = 'tabell' where id = %L$$, :'ola'), '23514');
update faktura.ansatte set skattekort = 'tabell', skatt_tabell = 7100, skatt_prosent = 34, skattekort_aar = 2026 where id = :'ola';
update faktura.ansatte set skattekort = 'frikort', skatt_frikort = 100000, skattekort_aar = 2026 where id = :'kari';

-- Innlogging for Ola og Kari, og regnskap og fakturerer.
select faktura.inviter_ansatt(:'org', :'ola') as t_ola \gset
select faktura.inviter_ansatt(:'org', :'kari') as t_kari \gset
select faktura.inviter_medlem(:'org', 'regn-lonn@test.no', 'regnskap') as t_regn \gset
select faktura.inviter_medlem(:'org', 'fakt-lonn@test.no', 'fakturerer') as t_fakt \gset
select id as u_ola from faktura.registrer_bruker('uid-lonn-ola', 'ola-lonn@test.no') \gset
select id as u_kari from faktura.registrer_bruker('uid-lonn-kari', 'kari-lonn@test.no') \gset
select id as u_regn from faktura.registrer_bruker('uid-lonn-regn', 'regn-lonn@test.no') \gset
select id as u_fakt from faktura.registrer_bruker('uid-lonn-fakt', 'fakt-lonn@test.no') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');
select set_config('app.bruker_id', :'u_kari', false);
select faktura.aksepter_invitasjon(:'t_kari');
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'t_regn');
select set_config('app.bruker_id', :'u_fakt', false);
select faktura.aksepter_invitasjon(:'t_fakt');

-- Kari fører og leverer timer; eieren godkjenner dem.
select set_config('app.bruker_id', :'u_kari', false);
insert into faktura.timeforinger (org_id, ansatt_id, dato, timer) values (:'org', :'kari', '2026-10-05', 7.5) returning id as t1 \gset
insert into faktura.timeforinger (org_id, ansatt_id, dato, timer) values (:'org', :'kari', '2026-10-06', 7.5) returning id as t2 \gset
select test.er(faktura.lever_timer(:'org', :'kari', '2026-10-05', '2026-10-11'), 2, 'levert');
select set_config('app.bruker_id', :'u', false);
select test.er(faktura.godkjenn_timer(:'org', array[:'t1', :'t2']::uuid[]), 2, 'godkjent');

-- Den ansatte lager ikke lønnskjøringer.
select set_config('app.bruker_id', :'u_ola', false);
select test.feiler(format($$insert into faktura.lonnskjoringer (org_id, periode, utbetalingsdato) values (%L, '2026-10-01', '2026-10-20')$$, :'org'), '42501');

-- Eieren lager kjøringen for oktober, med en slipp for hver.
select set_config('app.bruker_id', :'u', false);
insert into faktura.lonnskjoringer (org_id, periode, utbetalingsdato) values (:'org', '2026-10-01', '2026-10-20') returning id as k \gset
select test.feiler(format($$insert into faktura.lonnskjoringer (org_id, periode, utbetalingsdato) values (%L, '2026-10-01', '2026-10-20')$$, :'org'), '23505');
select test.feiler(format($$insert into faktura.lonnskjoringer (org_id, periode, utbetalingsdato) values (%L, '2026-10-15', '2026-10-20')$$, :'org'), '23514');
insert into faktura.lonnsslipper (org_id, kjoring_id, ansatt_id, navn, ansattnummer, lonnstype, periode, utbetalingsdato, trekkmetode, brutto, skattetrekk, netto)
values (:'org', :'k', :'ola', 'Ola Lønn', 1, 'maaned', '2026-10-01', '2026-10-20', 'Tabell 7100', 50000, 11000, 39000) returning id as s_ola \gset
insert into faktura.lonnsslipper (org_id, kjoring_id, ansatt_id, navn, ansattnummer, lonnstype, periode, utbetalingsdato, trekkmetode, brutto, netto, timeforinger)
values (:'org', :'k', :'kari', 'Kari Lønn', 2, 'time', '2026-10-01', '2026-10-20', 'Frikort', 3750, 3750, array[:'t1', :'t2']::uuid[]) returning id as s_kari \gset
insert into faktura.lonnslinjer (org_id, slipp_id, lonnsart, tekst, belop, kilde, nokkel) values (:'org', :'s_ola', 'fastlonn', 'Fastlønn', 50000, 'auto', 'fastlonn');
insert into faktura.lonnslinjer (org_id, slipp_id, lonnsart, tekst, antall, sats, belop, kilde) values (:'org', :'s_kari', 'timelonn', 'Timelønn', 15, 250, 3750, 'auto');

-- Før godkjenning: regnskap ser slippene, de ansatte og fakturereren ikke.
select set_config('app.bruker_id', :'u_regn', false);
select test.er((select count(*) from faktura.lonnsslipper where kjoring_id = :'k'), 2::bigint, 'regnskap ser slippene');
select test.er((select count(*) from faktura.lonnskjoringer), 1::bigint, 'regnskap ser kjøringen');
with u as (update faktura.lonnsslipper set netto = 1 where id = :'s_ola' returning 1)
select test.er((select count(*) from u), 0::bigint, 'regnskap endrer ikke slippene');
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select count(*) from faktura.lonnsslipper), 0::bigint, 'Ola ser ikke utkastet');
select test.er((select count(*) from faktura.lonnskjoringer), 0::bigint, 'Ola ser ikke kjøringene');
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select count(*) from faktura.lonnsslipper), 0::bigint, 'fakturereren ser ikke lønn');

-- En kjøring med timer som ikke er godkjent (lenger), godkjennes ikke.
select set_config('app.bruker_id', :'u', false);
select test.er(faktura.avvis_timer(:'org', array[:'t2']::uuid[], 'Feil dag'), 1, 'avvist før lønn');
select test.feiler(format($$select faktura.lonn_godkjenn(%L)$$, :'k'), 'FA409');
update faktura.timeforinger set dato = '2026-10-07' where id = :'t2';
select set_config('app.bruker_id', :'u_kari', false);
select test.er(faktura.lever_timer(:'org', :'kari', '2026-10-05', '2026-10-11'), 1, 'levert på nytt');
select set_config('app.bruker_id', :'u', false);
select test.er(faktura.godkjenn_timer(:'org', array[:'t2']::uuid[]), 1, 'godkjent på nytt');

-- Den ansatte og regnskap godkjenner ikke.
select set_config('app.bruker_id', :'u_regn', false);
select test.feiler(format($$select faktura.lonn_godkjenn(%L)$$, :'k'), 'FA403');

-- Eieren godkjenner: kontonummeret lagres, timene er lønnet, og kjøringen er låst.
select set_config('app.bruker_id', :'u', false);
select faktura.lonn_godkjenn(:'k');
select test.er((select status from faktura.lonnskjoringer where id = :'k'), 'godkjent', 'godkjent');
select test.er((select kontonr from faktura.lonnsslipper where id = :'s_ola'), '12345678903', 'kontonummeret er lagret');
select test.er((select count(*) from faktura.timeforinger where lonnskjoring_id = :'k'), 2::bigint, 'timene er lønnet');
select test.feiler(format($$select faktura.lonn_godkjenn(%L)$$, :'k'), 'FA409');
with u as (update faktura.lonnsslipper set netto = 1 where id = :'s_ola' returning 1)
select test.er((select count(*) from u), 0::bigint, 'slippen endres ikke');
select test.feiler(format($$insert into faktura.lonnslinjer (org_id, slipp_id, lonnsart, tekst, belop) values (%L, %L, 'bonus', 'Bonus', 100)$$, :'org', :'s_ola'), 'FA409');
with u as (delete from faktura.lonnskjoringer where id = :'k' returning 1)
select test.er((select count(*) from u), 0::bigint, 'den godkjente kjøringen slettes ikke');
-- Lønnede timer endres, avvises og slettes ikke.
select test.feiler(format($$select faktura.avvis_timer(%L, array[%L]::uuid[], 'Feil')$$, :'org', :'t1'), 'FA409');
select test.feiler(format($$update faktura.timeforinger set timer = 8 where id = %L$$, :'t1'), 'FA409');
select test.feiler(format($$delete from faktura.timeforinger where id = %L$$, :'t1'), 'FA409');
-- En ansatt med lønnsslipper slettes ikke.
select test.feiler(format($$delete from faktura.ansatte where id = %L$$, :'ola'), '23503');

-- De ansatte ser sine egne slipper og linjer (ikke de andres); regnskap ser alle.
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select array_agg(navn) from faktura.lonnsslipper), array['Ola Lønn'], 'Ola ser sin egen slipp');
select test.er((select array_agg(lonnsart) from faktura.lonnslinjer), array['fastlonn'], 'og linjene på den');
select test.er((select count(*) from faktura.lonnskjoringer), 0::bigint, 'men ikke kjøringene');
select set_config('app.bruker_id', :'u_kari', false);
select test.er((select array_agg(navn) from faktura.lonnsslipper), array['Kari Lønn'], 'Kari ser sin egen');
select set_config('app.bruker_id', :'u_regn', false);
select test.er((select count(*) from faktura.lonnslinjer), 2::bigint, 'regnskap ser alle linjene');

-- Åpnes igjen: timene er ikke lønnet, og de ansatte ser ikke slippen.
select set_config('app.bruker_id', :'u', false);
select faktura.lonn_gjenapne(:'k');
select test.er((select status from faktura.lonnskjoringer where id = :'k'), 'utkast', 'utkast igjen');
select test.er((select count(*) from faktura.timeforinger where lonnskjoring_id is not null), 0::bigint, 'timene er ikke lønnet');
select test.feiler(format($$select faktura.lonn_gjenapne(%L)$$, :'k'), 'FA409');
update faktura.lonnsslipper set netto = 39100 where id = :'s_ola';
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select count(*) from faktura.lonnsslipper), 0::bigint, 'Ola ser ikke utkastet igjen');

-- Tall fra et tidligere lønnssystem: eieren registrerer, Ola ser sine egne.
select set_config('app.bruker_id', :'u', false);
insert into faktura.lonn_inngaende (org_id, ansatt_id, aar, feriepengegrunnlag, trekkpliktig) values (:'org', :'ola', 2026, 450000, 450000);
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select feriepengegrunnlag from faktura.lonn_inngaende where ansatt_id = :'ola'), 450000.00::numeric, 'Ola ser sine tall');
select test.feiler(format($$insert into faktura.lonn_inngaende (org_id, ansatt_id, aar) values (%L, %L, 2025)$$, :'org', :'ola'), '42501');
select set_config('app.bruker_id', :'u_kari', false);
select test.er((select count(*) from faktura.lonn_inngaende), 0::bigint, 'Kari ser ikke Olas tall');

-- Trekktabellene: alle leser, bare betrodd (plattformadministratoren) laster opp.
select test.feiler($$insert into faktura.trekktabeller values (2026, 7100, 0, 0)$$, '42501');
select test.feiler($$select faktura.trekktabell_last(2026, true, array[7100], array[0], array[0])$$, 'FA403');
select set_config('app.betrodd', 'on', false);
select test.er(faktura.trekktabell_last(2026, true, array[7100, 7100, 7100], array[0, 40000, 40100], array[0, 9000, 9030]), 3, 'tre rader');
select test.er(faktura.trekktabell_last(2026, false, array[7101], array[40000], array[8800]), 1, 'en til');
select test.feiler($$select faktura.trekktabell_last(2026, false, array[7100], array[0, 1], array[0])$$, 'FA400');
select set_config('app.betrodd', '', false);
select test.er((select trekk from faktura.trekktabeller where aar = 2026 and tabell = 7100 and grunnlag <= 40050 order by grunnlag desc limit 1), 9000, 'oppslag');
select test.er((select count(*) from faktura.trekktabeller where aar = 2026), 4::bigint, 'fire rader');

-- Organisasjonen slettes: med en godkjent kjøring stenges den i stedet (regnskapsmateriale), og
-- utkastene til kjøringer slettes.
select set_config('app.bruker_id', :'u', false);
select faktura.lonn_godkjenn(:'k');
insert into faktura.lonnskjoringer (org_id, periode, type, utbetalingsdato) values (:'org', '2026-10-01', 'ekstra', '2026-10-25') returning id as k2 \gset
select test.er((select oppbevares_til from faktura.slett_organisasjon(:'org', 'Legger ned')), '2031-12-31'::date, 'oppbevares i fem år');
\c :migrator
select test.er((select slettet_at is not null from faktura.organisasjoner where id = :'org'), true, 'stengt');
select test.er((select count(*) from faktura.lonnskjoringer where org_id = :'org'), 1::bigint, 'den godkjente er der, utkastet er slettet');
select test.er((select count(*) from faktura.timeforinger where org_id = :'org' and lonnskjoring_id is not null), 2::bigint, 'timene er fortsatt lønnet');

-- Uten fakturaer og godkjente kjøringer slettes alt, også lønnede timer i en gjenåpnet kjøring.
\c :api
select set_config('app.bruker_id', :'u', false);
select id as org2 from faktura.opprett_organisasjon('Lønn To AS', '917654352') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org2', true);
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, lonnstype, maanedslonn) values (:'org2', 'Per', 'To', '2026-01-01', 'maaned', 40000) returning id as per \gset
insert into faktura.lonnskjoringer (org_id, periode, utbetalingsdato) values (:'org2', '2026-10-01', '2026-10-20') returning id as k3 \gset
insert into faktura.lonnsslipper (org_id, kjoring_id, ansatt_id, navn, ansattnummer, lonnstype, periode, utbetalingsdato) values (:'org2', :'k3', :'per', 'Per To', 1, 'maaned', '2026-10-01', '2026-10-20');
select test.er((select oppbevares_til from faktura.slett_organisasjon(:'org2', 'Prøvde bare')), null::date, 'ingenting å oppbevare');
\c :migrator
select test.er((select count(*) from faktura.organisasjoner where id = :'org2'), 0::bigint, 'slettet');
select test.er((select count(*) from faktura.lonnskjoringer where org_id = :'org2'), 0::bigint, 'kjøringen er borte');

drop schema test cascade;
\echo '  ok'
