-- De ansatte ser hele planen (0063_ansatte_ser_planen.sql): de publiserte vaktene, de faste
-- dagene, tavla og rollene, også kollegaenes, men ikke utkast. Fraværet ser de bare som fravær
-- (fravaer_plan, uten typen og notatet), og ansattregisteret bare som planen viser det
-- (ansatte_plan, uten stilling og stillingsprosent); tabellene er låst som før. En som har sluttet,
-- en som bare fakturerer, og andre organisasjoner ser ikke planen.

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
select id as u from faktura.registrer_bruker('uid-planen-eier', 'eier-planen@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Planen AS', '917654301') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
select faktura.i_dag() - 30 as start, faktura.i_dag() + 1 as d1, faktura.i_dag() + 2 as d2, faktura.i_dag() + 3 as d3 \gset

insert into faktura.ansattgrupper (org_id, navn) values (:'org', 'Sekretær') returning id as sek \gset
insert into faktura.ansattgrupper (org_id, navn, ikke_ansatt) values (:'org', 'Lege', true) returning id as lege \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, gruppe_id, stilling, stillingsprosent)
values (:'org', 'Ola', 'Plan', 'ola-planen@test.no', :'start', :'sek', 'Helsesekretær', 80) returning id as ola \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, gruppe_id, stilling, stillingsprosent, ansettelsestype)
values (:'org', 'Kari', 'Plan', 'kari-planen@test.no', :'start', :'sek', 'Sekretær', 60, 'midlertidig') returning id as kari \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, gruppe_id) values (:'org', 'Lise', 'Lege', 'lise-planen@test.no', :'start', :'lege') returning id as lise \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, gruppe_id) values (:'org', 'Siri', 'Slutter', 'siri-planen@test.no', :'start', :'sek') returning id as siri \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, gruppe_id) values (:'org', 'Per', 'Uten', :'start', :'sek') returning id as per \gset

select faktura.inviter_ansatt(:'org', :'ola') as t_ola \gset
select faktura.inviter_ansatt(:'org', :'kari') as t_kari \gset
select faktura.inviter_ansatt(:'org', :'lise') as t_lise \gset
select faktura.inviter_ansatt(:'org', :'siri') as t_siri \gset
select faktura.inviter_medlem(:'org', 'regn-planen@test.no', 'regnskap') as t_regn \gset
select faktura.inviter_medlem(:'org', 'fakt-planen@test.no', 'fakturerer') as t_fakt \gset
select id as u_ola from faktura.registrer_bruker('uid-planen-ola', 'ola-planen@test.no') \gset
select id as u_kari from faktura.registrer_bruker('uid-planen-kari', 'kari-planen@test.no') \gset
select id as u_lise from faktura.registrer_bruker('uid-planen-lise', 'lise-planen@test.no') \gset
select id as u_siri from faktura.registrer_bruker('uid-planen-siri', 'siri-planen@test.no') \gset
select id as u_regn from faktura.registrer_bruker('uid-planen-regn', 'regn-planen@test.no') \gset
select id as u_fakt from faktura.registrer_bruker('uid-planen-fakt', 'fakt-planen@test.no') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');
select set_config('app.bruker_id', :'u_kari', false);
select faktura.aksepter_invitasjon(:'t_kari');
select set_config('app.bruker_id', :'u_lise', false);
select faktura.aksepter_invitasjon(:'t_lise');
select set_config('app.bruker_id', :'u_siri', false);
select faktura.aksepter_invitasjon(:'t_siri');
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'t_regn');
select set_config('app.bruker_id', :'u_fakt', false);
select faktura.aksepter_invitasjon(:'t_fakt');

-- Planen: publiserte vakter (Karis med et notat), en ledig, et utkast, Karis faste dager, Kari
-- syk d3, og Kari på tavla med fast oppgave.
select set_config('app.bruker_id', :'u', false);
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'ola', :'d1', '08:00', '16:00');
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til, notat) values (:'org', :'kari', :'d1', '08:00', '16:00', 'Legetime kl. 14');
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'siri', :'d1', '12:00', '18:00');
insert into faktura.vakter (org_id, dato, fra, til, oppgave) values (:'org', :'d2', '10:00', '14:00', 'Lab');
select count(*) from faktura.publiser_vakter(:'org', :'d1', :'d2');
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til, oppgave) values (:'org', :'kari', :'d2', '08:00', '12:00', 'Utkast');
insert into faktura.arbeidsplaner (org_id, ansatt_id, gjelder_fra) values (:'org', :'kari', :'start') returning id as plan \gset
insert into faktura.arbeidsplan_dager (org_id, plan_id, ukedag) values (:'org', :'plan', 1), (:'org', :'plan', 3);
insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, notat) values (:'org', :'kari', 'syk', :'d3', :'d3', 'Influensa');
insert into faktura.tavle_faser (org_id, navn, fra, til, rekkefolge) values (:'org', 'Formiddag', '08:00', '12:00', 1) returning id as fase \gset
insert into faktura.tavle_oppgaver (org_id, navn, rekkefolge) values (:'org', 'Resepsjon', 1) returning id as resepsjon \gset
insert into faktura.tavle_plasseringer (org_id, dato, fase_id, oppgave_id, ansatt_id) values (:'org', :'d1', :'fase', :'resepsjon', :'kari');
insert into faktura.tavle_fast_oppgave (org_id, ansatt_id, oppgave_id) values (:'org', :'kari', :'resepsjon');
select test.er(faktura.fravaer_type(:'org', :'kari', 'syk'), 'syk', 'eieren ser typen');
select test.er((select type || '/' || notat from faktura.fravaer_plan where ansatt_id = :'kari'), 'syk/Influensa', 'eieren ser typen og notatet i planen');
select test.er((select stillingsprosent from faktura.ansatte_plan where id = :'kari'), 60.00::numeric, 'eieren ser stillingsprosenten');

-- Ola (sekretær) ser planen: alle de publiserte vaktene, ikke utkastet.
select set_config('app.bruker_id', :'u_ola', false);
select test.er(faktura.kan(:'org', 'plan'), true, 'en aktiv ansatt ser planen');
select test.er(faktura.kan(:'org', 'personal_les'), false, 'men ikke de ansatte');
select test.er((select count(*) from faktura.vakter), 4::bigint, 'de fire publiserte vaktene');
select test.er((select count(*) from faktura.vakter where oppgave = 'Utkast'), 0::bigint, 'ikke utkastet');
select test.er((select count(*) from faktura.arbeidsplaner where ansatt_id = :'kari'), 1::bigint, 'Karis faste dager');
select test.er((select count(*) from faktura.arbeidsplan_dager where plan_id = :'plan'), 2::bigint, 'og dagene');
select test.er((select count(*) from faktura.tavle_plasseringer where ansatt_id = :'kari'), 1::bigint, 'Karis plass på tavla');
select test.er((select count(*) from faktura.tavle_fast_oppgave where ansatt_id = :'kari'), 1::bigint, 'og den faste oppgaven');
select test.er((select count(*) from faktura.ansattgrupper), 2::bigint, 'rollene');
select test.er((select count(*) from faktura.tavle_utelatt), 0::bigint, 'ikke rulleringsoppsettet');
-- Fraværet bare som fravær, og registeret bare som planen viser det.
select test.er((select count(*) from faktura.fravaer), 0::bigint, 'fraværstabellen er låst');
select test.er((select type from faktura.fravaer_plan where ansatt_id = :'kari'), 'fravaer', 'Kari er borte, men ikke hvorfor');
select test.er((select notat from faktura.fravaer_plan where ansatt_id = :'kari'), null::text, 'og uten notatet');
select test.er((select count(*) from faktura.ansatte), 1::bigint, 'ansattregisteret: bare seg selv');
select test.er((select count(*) from faktura.ansatte_plan where org_id = :'org'), 5::bigint, 'alle i planen');
select test.er((select fornavn || ' ' || coalesce(stilling, '-') || ' ' || coalesce(stillingsprosent::text, '-') || ' ' || coalesce(ansettelsestype, '-')
                  from faktura.ansatte_plan where id = :'kari'), 'Kari - - -', 'uten Karis stilling, stillingsprosent og ansettelsestype');
select test.er((select stilling || ' ' || stillingsprosent from faktura.ansatte_plan where id = :'ola'), 'Helsesekretær 80.00', 'men sin egen');
select test.er((select array_agg(fornavn) from faktura.ansatte_plan where meg), array['Ola'], 'meg');
-- Endrer ingenting.
select test.feiler(format($$insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (%L, %L, %L, '08:00', '12:00')$$, :'org', :'ola', :'d3'), '42501');
select test.feiler(format($$insert into faktura.tavle_plasseringer (org_id, dato, fase_id, oppgave_id, ansatt_id) values (%L, %L, %L, %L, %L)$$, :'org', :'d1', :'fase', :'resepsjon', :'ola'), '42501');
select test.feiler(format($$insert into faktura.arbeidsplan_dager (org_id, plan_id, ukedag) values (%L, %L, 5)$$, :'org', :'plan'), '42501');
update faktura.vakter set fra = '09:00' where ansatt_id = :'kari';
delete from faktura.tavle_plasseringer;
select set_config('app.bruker_id', :'u', false);
select test.er((select count(*) from faktura.vakter where ansatt_id = :'kari' and fra = '08:00'), 2::bigint, 'Karis vakter er uendret');
select test.er((select count(*) from faktura.tavle_plasseringer), 1::bigint, 'plassen står');

-- Kari ser sitt eget fravær med typen og notatet.
select set_config('app.bruker_id', :'u_kari', false);
select test.er((select type || '/' || notat from faktura.fravaer_plan where ansatt_id = :'kari'), 'syk/Influensa', 'sitt eget fravær');
-- Legen (ikke ansatt, men med innlogging) ser også planen.
select set_config('app.bruker_id', :'u_lise', false);
select test.er((select count(*) from faktura.vakter), 4::bigint, 'legen ser planen');
-- Regnskap ser som før også utkastet, men ikke typen fravær.
select set_config('app.bruker_id', :'u_regn', false);
select test.er((select count(*) from faktura.vakter), 5::bigint, 'regnskap ser utkastet');
select test.er((select type from faktura.fravaer_plan where ansatt_id = :'kari'), 'fravaer', 'regnskap ser ikke typen');
select test.er((select stillingsprosent from faktura.ansatte_plan where id = :'kari'), 60.00::numeric, 'regnskap ser stillingsprosenten');
-- Fakturereren (ikke ansatt) ser ikke planen.
select set_config('app.bruker_id', :'u_fakt', false);
select test.er(faktura.kan(:'org', 'plan'), false, 'fakturereren ser ikke planen');
select test.er((select count(*) from faktura.vakter), 0::bigint, 'ingen vakter');
select test.er((select count(*) from faktura.ansatte_plan), 0::bigint, 'ingen i planen');
select test.er((select count(*) from faktura.fravaer_plan), 0::bigint, 'intet fravær');
select test.er((select count(*) from faktura.ansattgrupper), 0::bigint, 'ingen roller');

-- Siri slutter: hun ser bare sin egen vakt, ikke planen.
select set_config('app.bruker_id', :'u', false);
update faktura.ansatte set aktiv = false where id = :'siri';
select set_config('app.bruker_id', :'u_siri', false);
select test.er(faktura.kan(:'org', 'plan'), false, 'en som har sluttet, ser ikke planen');
select test.er((select count(*) from faktura.vakter), 1::bigint, 'bare sin egen vakt');
select test.er((select array_agg(fornavn) from faktura.ansatte_plan), array['Siri'], 'bare seg selv');
select test.er((select count(*) from faktura.arbeidsplaner), 0::bigint, 'ingen faste dager');
select test.er((select count(*) from faktura.tavle_plasseringer), 0::bigint, 'ingen plasser');

-- En annen organisasjon ser ingenting.
select id as u2 from faktura.registrer_bruker('uid-planen-andre', 'andre-planen@test.no') \gset
select set_config('app.bruker_id', :'u2', false);
select test.er(faktura.kan(:'org', 'plan'), false, 'utenforstående ser ikke planen');
select test.er((select count(*) from faktura.ansatte_plan), 0::bigint, 'ingen i planen');
select test.er((select count(*) from faktura.fravaer_plan), 0::bigint, 'intet fravær');

\c :migrator
drop schema test cascade;
\echo '  ok'
