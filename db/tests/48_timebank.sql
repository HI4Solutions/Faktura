-- Timebank (0073_timebank.sql): overtid og ekstratimer settes i banken når de er godkjent, lederen
-- justerer for hånd, den ansatte søker om avspasering (hele dager blir fravær, noen timer en post)
-- og lederen godkjenner eller avslår, og timer betales ut i lønnskjøringen. Ingenting går i banken
-- når den er slått av, og lønnede utbetalinger kan ikke endres. Datoene regnes fra i dag.

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
create function test.melding(_sql text) returns text language plpgsql as $$
begin
  execute _sql;
  return null;
exception when others then
  return sqlerrm;
end $$;
grant execute on all functions in schema test to public;

\c :api
select id as u from faktura.registrer_bruker('uid-timebank-eier', 'eier-timebank@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Timebank AS', '915000088') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
select faktura.i_dag() - 60 as start, faktura.i_dag() - 10 as p1, faktura.i_dag() - 9 as p2, faktura.i_dag() - 8 as p3,
       faktura.i_dag() + 10 as f1, faktura.i_dag() + 12 as f2, faktura.i_dag() + 14 as f3,
       date_trunc('week', faktura.i_dag() + 21)::date as man \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, lonnstype, maanedslonn)
values (:'org', 'Kari', 'Bank', 'kari-timebank@test.no', :'start', 'maaned', 50000) returning id as kari \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, lonnstype, timelonn)
values (:'org', 'Ola', 'Bank', :'start', 'time', 250) returning id as ola \gset
select faktura.inviter_ansatt(:'org', :'kari') as t_kari \gset
select id as u_kari from faktura.registrer_bruker('uid-timebank-kari', 'kari-timebank@test.no') \gset
select set_config('app.bruker_id', :'u_kari', false);
select faktura.aksepter_invitasjon(:'t_kari');

-- Av: ingenting går i banken.
select test.feiler(format($$insert into faktura.timeforinger (org_id, ansatt_id, dato, timer, uten_overtid, timebank) values (%L, %L, %L, 2, true, true)$$,
                          :'org', :'kari', :'p1'), 'FA400');
select set_config('app.bruker_id', :'u', false);
select test.feiler(format($$insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, timer) values (%L, %L, 'avspasering', %L, %L, 7.5)$$,
                          :'org', :'kari', :'f1', :'f1'), 'FA400');
select test.feiler(format($$insert into faktura.timebank_poster (org_id, ansatt_id, dato, type, timer, tekst) values (%L, %L, %L, 'justering', 5, 'Fra før')$$,
                          :'org', :'kari', :'p1'), 'FA400');
select test.er((select timebank from faktura.mine_organisasjoner where id = :'org'), false, 'av i appen');

update faktura.lonn_oppsett set timebank = true where org_id = :'org';
select test.er((select timebank from faktura.mine_organisasjoner where id = :'org'), true, 'på i appen');

-- Kari fører ekstratimer og overtid til banken (og en vanlig time), og leverer. Vanlige timer kan
-- ikke settes i banken.
select set_config('app.bruker_id', :'u_kari', false);
select test.er(test.melding(format($$insert into faktura.timeforinger (org_id, ansatt_id, dato, timer, timebank) values (%L, %L, %L, 1, true)$$, :'org', :'kari', :'p1')),
               'Bare overtid og ekstratimer (uten overtid) kan settes i timebanken', 'ikke vanlige timer');
insert into faktura.timeforinger (org_id, ansatt_id, dato, timer, uten_overtid, timebank) values (:'org', :'kari', :'p1', 2, true, true) returning id as t1 \gset
insert into faktura.timeforinger (org_id, ansatt_id, dato, timer, overtid_prosent, timebank) values (:'org', :'kari', :'p2', 3, 50, true) returning id as t2 \gset
insert into faktura.timeforinger (org_id, ansatt_id, dato, timer) values (:'org', :'kari', :'p3', 1) returning id as t3 \gset
select faktura.lever_timer(:'org', :'kari', :'p1', :'p3');
select test.er((select array[inn, venter_inn, saldo] from faktura.timebank(:'org')), array[0, 5, 0]::numeric[], 'levert, ikke godkjent');
select test.er((select count(*) from faktura.timebank(:'org')), 1::bigint, 'Kari ser bare seg selv');
select test.er((select sats from faktura.timebank(:'org')), null::numeric, 'Kari ser ikke satsen');

-- Lederen godkjenner: 5 t inn. En vanlig arbeidsdag er 7,5 t.
select set_config('app.bruker_id', :'u', false);
select faktura.godkjenn_timer(:'org', array[:'t1', :'t2', :'t3']::uuid[]);
select test.er((select array[inn, venter_inn, saldo, dag_timer] from faktura.timebank(:'org') where ansatt_id = :'kari'), array[5, 0, 5, 7.5]::numeric[], 'godkjent: 5 t');
select test.er((select count(*) from faktura.timebank(:'org')), 2::bigint, 'lederen ser begge');
select test.er((select sats from faktura.timebank(:'org') where ansatt_id = :'ola'), 250::numeric, 'timelønnen');
select test.er((select round(sats, 2) from faktura.timebank(:'org') where ansatt_id = :'kari'), 307.69::numeric, 'timesatsen');

-- Justering: bare lederen, og med en grunn.
select test.er(test.melding(format($$insert into faktura.timebank_poster (org_id, ansatt_id, dato, type, timer) values (%L, %L, %L, 'justering', 7.5)$$, :'org', :'kari', :'p1')),
               'Skriv hvorfor timebanken justeres', 'grunn');
insert into faktura.timebank_poster (org_id, ansatt_id, dato, type, timer, tekst) values (:'org', :'kari', :'p1', 'justering', 7.5, 'Jobbet 1. mai') returning id as j1 \gset
select set_config('app.bruker_id', :'u_kari', false);
select test.feiler(format($$insert into faktura.timebank_poster (org_id, ansatt_id, dato, type, timer, tekst) values (%L, %L, %L, 'justering', 10, 'Selv')$$,
                          :'org', :'kari', :'p1'), '42501');
select test.er((select count(*) from faktura.timebank_poster), 1::bigint, 'Kari ser posten sin');
select test.er((select saldo from faktura.timebank(:'org')), 12.5::numeric, 'saldo 12,5');

-- Søknader: hele dager og noen timer, ikke mer enn det som er igjen.
select (faktura.sok_avspasering(:'org', :'f1', :'f1', 7.5, true, 'Tannlege')).id as s1 \gset
select test.er(test.melding(format($$select faktura.sok_avspasering(%L, %L, %L, 6, false, null)$$, :'org', :'f2', :'f2')),
               'Du har 5 t i timebanken (utenom 7,5 t du har søkt om fra før)', 'ikke mer enn det som er igjen');
select test.feiler(format($$select faktura.sok_avspasering(%L, %L, %L, 1, true, null)$$, :'org', :'f1', :'f1'), 'FA409');
select test.feiler(format($$select faktura.sok_avspasering(%L, %L, %L, 1, false, null)$$, :'org', :'f2', :'f3'), 'FA400');
select test.feiler(format($$select faktura.sok_avspasering(%L, %L, %L, 1, true, null)$$, :'org', faktura.i_dag() - 8, faktura.i_dag() - 8), 'FA400');
select (faktura.sok_avspasering(:'org', :'f2', :'f2', 4, false, 'Går tidlig')).id as s2 \gset
select test.er((select array[saldo, sokt] from faktura.timebank(:'org')), array[12.5, 11.5]::numeric[], 'søkt om 11,5 t');
select test.feiler(format($$select faktura.behandle_avspasering(%L, %L, true, null, null)$$, :'org', :'s1'), 'FA403');
select test.er((select count(*) from faktura.avspasering_soknader), 2::bigint, 'Kari ser søknadene sine');

-- Lederen godkjenner hele dagen med 7 t (blir fravær) og avslår den andre.
select set_config('app.bruker_id', :'u', false);
select test.er((select status || ':' || timer || ':' || svar from faktura.behandle_avspasering(:'org', :'s1', true, 'God bedring', 7)), 'godkjent:7.00:God bedring', 'godkjent');
select test.er((select type || ':' || timer || ':' || notat from faktura.fravaer where org_id = :'org' and ansatt_id = :'kari'), 'avspasering:7.00:Tannlege', 'fraværet');
select test.er((select type from faktura.fravaer where org_id = :'org' and ansatt_id = :'kari' and :'f1'::date between fra and til), 'avspasering', 'borte den dagen');
select test.er((select fravaer_id is not null from faktura.avspasering_soknader where id = :'s1'), true, 'søknaden peker på fraværet');
select test.er((select array[saldo, sokt, avspasert] from faktura.timebank(:'org') where ansatt_id = :'kari'), array[5.5, 4, 7]::numeric[], 'etter godkjenning');
select test.er((select status || ':' || svar from faktura.behandle_avspasering(:'org', :'s2', false, 'Travelt den dagen', null)), 'avslatt:Travelt den dagen', 'avslått');
select test.feiler(format($$select faktura.behandle_avspasering(%L, %L, true, null, null)$$, :'org', :'s2'), 'FA409');
select test.er((select sokt from faktura.timebank(:'org') where ansatt_id = :'kari'), 0::numeric, 'ingenting søkt');

-- Noen timer blir en post (uten fravær); en søknad kan trekkes mens den venter.
select set_config('app.bruker_id', :'u_kari', false);
select (faktura.sok_avspasering(:'org', :'f3', :'f3', 2, false, null)).id as s3 \gset
select (faktura.sok_avspasering(:'org', :'f2', :'f2', 1, false, null)).id as s4 \gset
select test.er((select status from faktura.trekk_avspasering(:'org', :'s4')), 'trukket', 'trukket');
select test.feiler(format($$select faktura.trekk_avspasering(%L, %L)$$, :'org', :'s4'), 'FA409');
select set_config('app.bruker_id', :'u', false);
select faktura.behandle_avspasering(:'org', :'s3', true, null, null);
select test.er((select type || ':' || timer || ':' || tekst from faktura.timebank_poster where id = (select post_id from faktura.avspasering_soknader where id = :'s3')),
               'avspasering:-2.00:Avspasering', 'posten');
select test.er((select type from faktura.fravaer where org_id = :'org' and ansatt_id = :'kari' and :'f3'::date between fra and til), null::text, 'ikke borte for noen timer');
select test.er((select saldo from faktura.timebank(:'org') where ansatt_id = :'kari'), 3.5::numeric, 'saldo 3,5');

-- Avspasering endret til ferie: timene kommer tilbake; tilbake til avspasering krever timer.
select id as fa from faktura.fravaer where org_id = :'org' and ansatt_id = :'kari' and type = 'avspasering' \gset
update faktura.fravaer set type = 'ferie' where id = :'fa';
select test.er((select timer from faktura.fravaer where id = :'fa'), null::numeric, 'ferie uten timer');
select test.er((select saldo from faktura.timebank(:'org') where ansatt_id = :'kari'), 10.5::numeric, 'timene tilbake');
select test.er(test.melding(format($$update faktura.fravaer set type = 'avspasering' where id = %L$$, :'fa')),
               'Skriv hvor mange timer avspaseringen tar fra timebanken', 'avspasering krever timer');
update faktura.fravaer set type = 'avspasering', timer = 7 where id = :'fa';
select test.er((select saldo from faktura.timebank(:'org') where ansatt_id = :'kari'), 3.5::numeric, 'avspasert igjen');

-- Utbetaling: lagres negativt, merkes som lønnet når kjøringen godkjennes, og kan da ikke endres.
insert into faktura.timebank_poster (org_id, ansatt_id, dato, type, timer) values (:'org', :'kari', faktura.i_dag(), 'utbetaling', 2) returning id as u1 \gset
select test.er((select timer from faktura.timebank_poster where id = :'u1'), -2::numeric, 'uttak er negativt');
select test.er((select array[saldo, utbetalt] from faktura.timebank(:'org') where ansatt_id = :'kari'), array[1.5, 2]::numeric[], 'utbetalt 2 t');
select date_trunc('month', faktura.i_dag())::date as periode \gset
insert into faktura.lonnskjoringer (org_id, periode, utbetalingsdato) values (:'org', :'periode', :'periode'::date + 19) returning id as k \gset
insert into faktura.lonnsslipper (org_id, kjoring_id, ansatt_id, navn, ansattnummer, lonnstype, periode, utbetalingsdato, trekkmetode, brutto, netto, timebank_poster)
select :'org', :'k', a.id, 'Kari Bank', a.ansattnummer, 'maaned', :'periode', :'periode'::date + 19, '', 0, 0, array[:'u1']::uuid[]
  from faktura.ansatte a where a.id = :'kari';
select faktura.lonn_godkjenn(:'k');
select test.er((select lonnskjoring_id from faktura.timebank_poster where id = :'u1'), :'k'::uuid, 'lønnet');
select test.feiler(format($$delete from faktura.timebank_poster where id = %L$$, :'u1'), 'FA409');
select test.feiler(format($$update faktura.timebank_poster set timer = -3 where id = %L$$, :'u1'), 'FA409');
select faktura.lonn_gjenapne(:'k');
select test.er((select lonnskjoring_id from faktura.timebank_poster where id = :'u1'), null::uuid, 'ikke lønnet etter at kjøringen er åpnet');
delete from faktura.timebank_poster where id = :'u1';

-- Lønnede timer: valget om timebanken kan ikke endres.
\c :migrator
update faktura.timeforinger set lonnskjoring_id = :'k' where id = :'t2';
\c :api
select set_config('app.bruker_id', :'u', false);
select test.feiler(format($$update faktura.timeforinger set timebank = false where id = %L$$, :'t2'), 'FA409');
\c :migrator
update faktura.timeforinger set lonnskjoring_id = null where id = :'t2';
\c :api

-- Forslag til timene: vaktene den dagen, ellers en vanlig arbeidsdag per arbeidsdag.
\c :migrator
select count(*) * 7.5 as uke_timer from generate_series(:'man'::date, :'man'::date + 6, interval '1 day') d
 where faktura.arbeidsdag(:'org', :'kari', d::date) \gset
\c :api
select set_config('app.bruker_id', :'u', false);
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til, pause_min) values (:'org', :'ola', :'f2', '08:00', '14:00', 0);
select test.er(faktura.avspasering_forslag(:'org', :'ola', :'f2', :'f2'), 6::numeric, 'vakten');
select set_config('app.bruker_id', :'u_kari', false);
select test.er(faktura.avspasering_forslag(:'org', :'kari', :'man', :'man'::date + 6), :'uke_timer'::numeric, 'en uke med vanlige arbeidsdager');
select test.feiler(format($$select faktura.avspasering_forslag(%L, %L, %L, %L)$$, :'org', :'ola', :'f2', :'f2'), 'FA403');

-- Slått av etterpå: det som er i banken, står, men nye timer settes ikke inn.
select set_config('app.bruker_id', :'u', false);
update faktura.lonn_oppsett set timebank = false where org_id = :'org';
update faktura.timeforinger set beskrivelse = 'Kveldsvakt' where id = :'t1';
select test.feiler(format($$insert into faktura.timeforinger (org_id, ansatt_id, dato, timer, uten_overtid, timebank) values (%L, %L, %L, 2, true, true)$$,
                          :'org', :'ola', :'p1'), 'FA400');
select test.er((select saldo from faktura.timebank(:'org') where ansatt_id = :'kari'), 3.5::numeric, 'saldoen står');

\c :migrator
drop schema test cascade;
\echo '  ok'
