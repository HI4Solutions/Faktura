-- Lønnen går av seg selv (0088_lonn_automatikk.sql): et utkast er utdatert når noe lønnen regnes ut
-- fra, endres etter at det ble regnet ut (timer, fravær, vakter, de ansatte, oppsettet,
-- trekktabellene, en annen kjøring som godkjennes), men ikke av en annen organisasjon; en godkjent
-- kjøring regnes ikke ut på nytt; regnskap ser utregningen, fakturereren ikke; ingen skriver den
-- direkte; endringene leses og ryddes bare av workeren (og det et utkast ikke har sett, beholdes);
-- bare workeren lager en kjøring som «automatisk»; valget i oppsettet; og en organisasjon kan
-- fortsatt slettes.

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
select id as u from faktura.registrer_bruker('uid-lauto-eier', 'eier-lauto@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Lønn Auto AS', '915000363') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true) on conflict (org_id) do update set aktiv = true;
select faktura.inviter_medlem(:'org', 'regn-lauto@test.no', 'regnskap') as t_regn \gset
select faktura.inviter_medlem(:'org', 'fakt-lauto@test.no', 'fakturerer') as t_fakt \gset
select id as u_regn from faktura.registrer_bruker('uid-lauto-regn', 'regn-lauto@test.no') \gset
select id as u_fakt from faktura.registrer_bruker('uid-lauto-fakt', 'fakt-lauto@test.no') \gset
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'t_regn');
select set_config('app.bruker_id', :'u_fakt', false);
select faktura.aksepter_invitasjon(:'t_fakt');
select set_config('app.bruker_id', :'u', false);

insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, lonnstype, timelonn)
values (:'org', 'Kari', 'Auto', '2026-01-01', 'time', 250) returning id as kari \gset
insert into faktura.lonnskjoringer (org_id, periode, utbetalingsdato) values (:'org', '2026-10-01', '2026-10-20') returning id as k \gset
insert into faktura.lonnskjoringer (org_id, periode, type, utbetalingsdato) values (:'org', '2026-10-01', 'ekstra', '2026-10-25') returning id as k2 \gset
select test.er((select automatisk from faktura.lonnskjoringer where id = :'k'), false, 'laget i appen');

-- Ikke regnet ut ennå: utdatert. Regnet ut: oppdatert.
select test.er(faktura.lonn_utdatert(:'k'), true, 'ikke regnet ut');
select faktura.lonn_beregnes(:'k');
select faktura.lonn_beregnes(:'k2');
select test.er(faktura.lonn_utdatert(:'k'), false, 'regnet ut');
select test.er(faktura.lonn_utdatert(:'k2'), false, 'regnet ut (ekstra kjøring)');

-- En time som føres, gjør utkastene utdatert, til hvert av dem er regnet ut på nytt.
insert into faktura.timeforinger (org_id, ansatt_id, dato, timer) values (:'org', :'kari', '2026-10-05', 3) returning id as t1 \gset
select test.er(faktura.lonn_utdatert(:'k'), true, 'ny time');
select test.er(faktura.lonn_utdatert(:'k2'), true, 'ny time (ekstra kjøring)');
select faktura.lonn_beregnes(:'k');
select test.er(faktura.lonn_utdatert(:'k'), false, 'regnet ut på nytt');
select test.er(faktura.lonn_utdatert(:'k2'), true, 'den andre venter fortsatt');
select faktura.lonn_beregnes(:'k2');
-- Endret og slettet.
update faktura.timeforinger set timer = 4 where id = :'t1';
select test.er(faktura.lonn_utdatert(:'k'), true, 'endret time');
select faktura.lonn_beregnes(:'k');
delete from faktura.timeforinger where id = :'t1';
select test.er(faktura.lonn_utdatert(:'k'), true, 'slettet time');
select faktura.lonn_beregnes(:'k');

-- Fravær, vakter, den ansatte og oppsettet.
insert into faktura.fravaer (org_id, ansatt_id, type, fra, til) values (:'org', :'kari', 'syk', '2026-10-07', '2026-10-08');
select test.er(faktura.lonn_utdatert(:'k'), true, 'fravær');
select faktura.lonn_beregnes(:'k');
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'kari', '2026-10-12', '08:00', '16:00');
select test.er(faktura.lonn_utdatert(:'k'), true, 'vakt');
select faktura.lonn_beregnes(:'k');
update faktura.ansatte set kontonr = '12345678903' where id = :'kari';
select test.er(faktura.lonn_utdatert(:'k'), true, 'den ansatte');
select faktura.lonn_beregnes(:'k');
update faktura.lonn_oppsett set otp_prosent = 3 where org_id = :'org';
select test.er(faktura.lonn_utdatert(:'k'), true, 'oppsettet');
select faktura.lonn_beregnes(:'k');

-- En annen organisasjon (samme eier) endrer ikke noe her.
select id as org2 from faktura.opprett_organisasjon('Lønn Auto To AS', '915000398') \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, lonnstype, timelonn)
values (:'org2', 'Per', 'To', '2026-01-01', 'time', 200) returning id as per \gset
insert into faktura.timeforinger (org_id, ansatt_id, dato, timer) values (:'org2', :'per', '2026-10-05', 3);
select test.er(faktura.lonn_utdatert(:'k'), false, 'en annen organisasjon');

-- En ny kjøring endrer ikke grunnlaget; en kjøring som godkjennes, gjør det. En godkjent kjøring er
-- aldri utdatert, og regnes ikke ut på nytt.
insert into faktura.lonnskjoringer (org_id, periode, utbetalingsdato) values (:'org', '2026-09-01', '2026-09-18') returning id as k9 \gset
insert into faktura.lonnsslipper (org_id, kjoring_id, ansatt_id, navn, ansattnummer, lonnstype, periode, utbetalingsdato)
values (:'org', :'k9', :'kari', 'Kari Auto', 1, 'time', '2026-09-01', '2026-09-18');
select test.er(faktura.lonn_utdatert(:'k'), false, 'en ny kjøring');
select faktura.lonn_godkjenn(:'k9');
select test.er(faktura.lonn_utdatert(:'k'), true, 'en annen kjøring er godkjent');
select test.er(faktura.lonn_utdatert(:'k9'), null::boolean, 'den godkjente');
select test.feiler(format($$select faktura.lonn_beregnes(%L)$$, :'k9'), 'FA409');
select faktura.lonn_beregnes(:'k');
select faktura.lonn_beregnes(:'k2');

-- Trekktabellene er felles: alle utkastene blir utdatert.
\c :migrator
insert into faktura.trekktabeller values (2031, 7100, 0, 0) on conflict do nothing;
\c :api
select set_config('app.bruker_id', :'u', false);
select test.er(faktura.lonn_utdatert(:'k'), true, 'trekktabellene');
select test.er(faktura.lonn_utdatert(:'k2'), true, 'trekktabellene (ekstra kjøring)');
select faktura.lonn_beregnes(:'k');
select faktura.lonn_beregnes(:'k2');

-- Regnskap ser utregningen, men regner ikke ut; fakturereren ser ingenting.
select set_config('app.bruker_id', :'u_regn', false);
select test.er((select count(*) from faktura.lonnskjoring_beregning where org_id = :'org'), 2::bigint, 'regnskap ser utregningen');
select test.er(faktura.lonn_utdatert(:'k'), false, 'regnskap ser at den er oppdatert');
select test.feiler(format($$select faktura.lonn_beregnes(%L)$$, :'k'), 'FA403');
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select count(*) from faktura.lonnskjoring_beregning), 0::bigint, 'fakturereren ser ikke utregningen');
select test.er(faktura.lonn_utdatert(:'k'), null::boolean, 'fakturereren får ikke svar');

-- Ingen i appen skriver utregningen eller leser endringene, og appen merker ikke en kjøring som
-- laget automatisk.
select set_config('app.bruker_id', :'u', false);
select test.feiler(format($$update faktura.lonnskjoring_beregning set paaminnet = now() where kjoring_id = %L$$, :'k'), '42501');
select test.feiler(format($$insert into faktura.lonnskjoring_beregning (kjoring_id, org_id, snapshot) values (%L, %L, pg_current_snapshot())$$, :'k', :'org'), '42501');
select test.feiler('select count(*) from faktura.lonn_endringer', '42501');
select test.feiler('select faktura.rydd_lonn_endringer()', '42501');
select test.feiler(format($$insert into faktura.lonnskjoringer (org_id, periode, type, utbetalingsdato, automatisk) values (%L, '2026-11-01', 'ekstra', '2026-11-20', true)$$, :'org'), '42501');

-- Valget i oppsettet: på som standard, og kan slås av.
select test.er((select auto_kjoring from faktura.lonn_oppsett where org_id = :'org'), true, 'automatisk som standard');
update faktura.lonn_oppsett set auto_kjoring = false where org_id = :'org';
select test.er((select auto_kjoring from faktura.lonn_oppsett where org_id = :'org'), false, 'slått av');
update faktura.lonn_oppsett set auto_kjoring = true where org_id = :'org';
select test.er(faktura.lonn_utdatert(:'k'), true, 'valget er også en endring');

-- Workeren lager kjøringen for måneden som automatisk, regner den ut og merker påminnelsen. Den
-- rydder bort endringene alle utkastene har sett, men ikke dem et utkast venter på.
\c :worker
insert into faktura.lonnskjoringer (org_id, periode, utbetalingsdato, automatisk) values (:'org', '2026-11-01', '2026-11-20', true) returning id as k11 \gset
select faktura.lonn_beregnes(:'k11');
update faktura.lonnskjoring_beregning set paaminnet = now() where kjoring_id = :'k11';
select faktura.rydd_lonn_endringer();
\c :migrator
select test.er((select automatisk from faktura.lonnskjoringer where id = :'k11'), true, 'laget automatisk');
select test.er((select paaminnet is not null from faktura.lonnskjoring_beregning where kjoring_id = :'k11'), true, 'påminnet');
select test.er((select count(*) from faktura.lonn_endringer where org_id = :'org'), 2::bigint, 'de to endringene utkastene ikke har sett');
select test.er((select count(*) from faktura.lonn_endringer where org_id = :'org2'), 0::bigint, 'ingen utkast venter i den andre');
\c :worker
select faktura.lonn_beregnes(:'k');
select faktura.lonn_beregnes(:'k2');
select faktura.lonn_beregnes(:'k11');
select test.er(faktura.rydd_lonn_endringer(), 2, 'ryddet');
\c :migrator
select test.er((select count(*) from faktura.lonn_endringer where org_id = :'org'), 0::bigint, 'alt er sett');
select test.er((select paaminnet is not null from faktura.lonnskjoring_beregning where kjoring_id = :'k11'), true, 'påminnelsen står etter en ny utregning');
delete from faktura.trekktabeller where aar = 2031;

-- Organisasjonen kan fortsatt slettes (med ansatte og timer).
\c :api
select set_config('app.bruker_id', :'u', false);
select test.er((select oppbevares_til from faktura.slett_organisasjon(:'org2', 'Prøvde bare')), null::date, 'ingenting å oppbevare');
\c :migrator
select test.er((select count(*) from faktura.organisasjoner where id = :'org2'), 0::bigint, 'slettet');
select test.er((select count(*) from faktura.lonn_endringer where org_id = :'org2'), 0::bigint, 'ingen endringer igjen');

drop schema test cascade;
