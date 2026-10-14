-- Turnus (0106_turnus.sql): vakttyper med klokkeslett og timer (også over midnatt), vakter som får
-- klokkeslettene fra vakttypen, bemanningsbehovet per vakttype og ukedag (med og uten rolle), hvem
-- som går hvilke vakttyper, reglene og kjøringene av automatisk turnus, og ledige vakter for en
-- rolle, som bare de med rollen kan ta. Alle som ser planen, ser vakttypene og behovet; bare eier og
-- administrator endrer dem.

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
select id as u from faktura.registrer_bruker('uid-turnus-eier', 'eier-turnus@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Turnus AS', '917654026') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
select faktura.i_dag() + 1 as d1, faktura.i_dag() + 2 as d2, faktura.i_dag() - 30 as start \gset

insert into faktura.ansattgrupper (org_id, navn) values (:'org', 'Sykepleier') returning id as spl \gset
insert into faktura.ansattgrupper (org_id, navn) values (:'org', 'Assistent') returning id as ass \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, gruppe_id)
values (:'org', 'Ola', 'Turnus', 'ola-turnus@test.no', :'start', :'ass') returning id as ola \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, gruppe_id)
values (:'org', 'Kari', 'Turnus', 'kari-turnus@test.no', :'start', :'spl') returning id as kari \gset
select faktura.inviter_ansatt(:'org', :'ola') as t_ola \gset
select faktura.inviter_ansatt(:'org', :'kari') as t_kari \gset
select id as u_ola from faktura.registrer_bruker('uid-turnus-ola', 'ola-turnus@test.no') \gset
select id as u_kari from faktura.registrer_bruker('uid-turnus-kari', 'kari-turnus@test.no') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');
select set_config('app.bruker_id', :'u_kari', false);
select faktura.aksepter_invitasjon(:'t_kari');

-- Vakttypene: timene regnes ut, også over midnatt; koden er unik (store og små bokstaver likt).
select set_config('app.bruker_id', :'u', false);
insert into faktura.vakttyper (org_id, navn, kode, fra, til, pause_min) values (:'org', ' Dagvakt ', 'D', '07:00', '15:00', 30)
returning id as dag, timer as dag_timer, navn as dag_navn \gset
insert into faktura.vakttyper (org_id, navn, kode, fra, til, pause_min, farge) values (:'org', 'Kveldsvakt', 'K', '15:00', '23:00', 30, 1) returning id as kveld \gset
insert into faktura.vakttyper (org_id, navn, kode, fra, til, farge) values (:'org', 'Nattevakt', 'N', '23:00', '07:00', 2) returning id as natt, timer as natt_timer \gset
select test.er(:'dag_timer'::numeric, 7.50, 'dagvakt med pause');
select test.er(:'dag_navn', 'Dagvakt', 'navnet uten mellomrom');
select test.er(:'natt_timer'::numeric, 8.00, 'nattevakt over midnatt');
select test.feiler(format($$insert into faktura.vakttyper (org_id, navn, kode, fra, til) values (%L, 'Dag 2', 'd', '08:00', '16:00')$$, :'org'), 'FA409');
select test.feiler(format($$insert into faktura.vakttyper (org_id, navn, kode, fra, til, pause_min) values (%L, 'Kort', 'X', '08:00', '08:30', 30)$$, :'org'), 'FA400');
select test.feiler(format($$insert into faktura.vakttyper (org_id, navn, kode, fra, til) values (%L, 'Lang kode', 'ABCD', '08:00', '16:00')$$, :'org'), '23514');
select test.feiler(format($$insert into faktura.vakttyper (org_id, navn, kode, fra, til) values (%L, 'Lik', 'L', '08:00', '08:00')$$, :'org'), '23514');
select test.feiler(format($$update faktura.vakttyper set kode = 'n' where id = %L$$, :'kveld'), 'FA409');

-- En vakt med vakttype får klokkeslettene fra typen; en annen vakttype flytter dem, med mindre nye
-- klokkeslett er oppgitt.
insert into faktura.vakter (org_id, ansatt_id, dato, vakttype_id) values (:'org', :'ola', :'d1', :'dag')
returning id as v1, to_char(fra, 'HH24:MI') || '-' || to_char(til, 'HH24:MI') as v1_tid, pause_min as v1_pause, timer as v1_timer \gset
select test.er(:'v1_tid', '07:00-15:00', 'klokkeslettene fra dagvakten');
select test.er(:'v1_pause'::int, 30, 'pausen fra dagvakten');
select test.er(:'v1_timer'::numeric, 7.50, 'timene');
update faktura.vakter set vakttype_id = :'natt' where id = :'v1';
select test.er((select to_char(fra, 'HH24:MI') || '-' || to_char(til, 'HH24:MI') || '/' || timer from faktura.vakter where id = :'v1'), '23:00-07:00/8.00', 'nå en nattevakt');
update faktura.vakter set vakttype_id = :'kveld', fra = '16:00', til = '22:00' where id = :'v1';
select test.er((select to_char(fra, 'HH24:MI') || '-' || to_char(til, 'HH24:MI') from faktura.vakter where id = :'v1'), '16:00-22:00', 'egne klokkeslett står');
-- Uten vakttype må klokkeslettene oppgis, som før.
select test.feiler(format($$insert into faktura.vakter (org_id, ansatt_id, dato) values (%L, %L, %L)$$, :'org', :'ola', :'d1'), '23502');

-- En vakttype som ikke er i bruk lenger, kan ikke velges, men står på vaktene som har den.
update faktura.vakttyper set aktiv = false where id = :'kveld';
select test.feiler(format($$insert into faktura.vakter (org_id, ansatt_id, dato, vakttype_id) values (%L, %L, %L, %L)$$, :'org', :'kari', :'d2', :'kveld'), 'FA400');
select test.er((select vakttype_id from faktura.vakter where id = :'v1'), :'kveld'::uuid, 'vakten har fortsatt kveldsvakten');
update faktura.vakter set notat = 'Bytter med Kari' where id = :'v1';
update faktura.vakttyper set aktiv = true where id = :'kveld';

-- Bemanningsbehovet: med og uten rolle, én rad per vakttype, ukedag og rolle.
insert into faktura.vakttype_behov (org_id, vakttype_id, ukedag, rolle_id, antall) values (:'org', :'dag', 1, :'spl', 2);
insert into faktura.vakttype_behov (org_id, vakttype_id, ukedag, antall) values (:'org', :'dag', 1, 1);
insert into faktura.vakttype_behov (org_id, vakttype_id, ukedag, antall) values (:'org', :'natt', 7, 1);
select test.feiler(format($$insert into faktura.vakttype_behov (org_id, vakttype_id, ukedag, antall) values (%L, %L, 1, 3)$$, :'org', :'dag'), '23505');
select test.feiler(format($$insert into faktura.vakttype_behov (org_id, vakttype_id, ukedag, rolle_id, antall) values (%L, %L, 1, %L, 1)$$, :'org', :'dag', :'spl'), '23505');
select test.feiler(format($$insert into faktura.vakttype_behov (org_id, vakttype_id, ukedag, antall) values (%L, %L, 8, 1)$$, :'org', :'dag'), '23514');
select test.feiler(format($$insert into faktura.vakttype_behov (org_id, vakttype_id, ukedag, antall) values (%L, %L, 2, 0)$$, :'org', :'dag'), '23514');

-- Hvem som går hvilke vakttyper.
insert into faktura.ansatt_vakttyper (org_id, ansatt_id, vakttype_id) values (:'org', :'ola', :'dag'), (:'org', :'ola', :'kveld'), (:'org', :'kari', :'natt');
select test.feiler(format($$insert into faktura.ansatt_vakttyper (org_id, ansatt_id, vakttype_id) values (%L, %L, %L)$$, :'org', :'ola', :'dag'), '23505');

-- Reglene: standardverdiene, og grensene.
insert into faktura.turnus_regler (org_id) values (:'org');
select test.er((select hvile || '/' || dager_paa_rad || '/' || netter_paa_rad || '/' || helg from faktura.turnus_regler where org_id = :'org'), '11.0/5/3/3', 'standardreglene');
select test.feiler(format($$update faktura.turnus_regler set hvile = 7 where org_id = %L$$, :'org'), '23514');
update faktura.turnus_regler set helg = 2 where org_id = :'org';

-- En kjøring av automatisk turnus med en vakt og en ledig vakt for sykepleierne, som publiseres.
insert into faktura.turnus_kjoringer (org_id, fra, til, vakter, ledige) values (:'org', :'d1', :'d2', 1, 1) returning id as kj \gset
insert into faktura.vakter (org_id, ansatt_id, dato, vakttype_id, rolle_id, turnus_id) values (:'org', :'kari', :'d2', :'natt', :'spl', :'kj') returning id as v2 \gset
insert into faktura.vakter (org_id, dato, vakttype_id, rolle_id, turnus_id) values (:'org', :'d2', :'dag', :'spl', :'kj') returning id as ledig \gset
select test.feiler(format($$insert into faktura.turnus_kjoringer (org_id, fra, til) values (%L, %L, %L::date + 100)$$, :'org', :'d1', :'d1'), '23514');
select test.er((select count(*) from faktura.publiser_vakter(:'org', :'d1', :'d2')), 3::bigint, 'publisert');

-- De ansatte: ser vakttypene og behovet, sin egen rad om vakttyper og ingen kjøringer, og endrer ingenting.
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select string_agg(kode, ',' order by kode) from faktura.vakttyper), 'D,K,N', 'Ola ser vakttypene');
select test.er((select count(*) from faktura.vakttype_behov), 3::bigint, 'og behovet');
select test.er((select count(*) from faktura.ansatt_vakttyper), 2::bigint, 'bare sine egne vakttyper');
select test.er((select count(*) from faktura.turnus_kjoringer), 0::bigint, 'ingen kjøringer');
select test.er((select hvile from faktura.turnus_regler where org_id = :'org'), 11.0, 'reglene');
select test.feiler(format($$insert into faktura.vakttyper (org_id, navn, kode, fra, til) values (%L, 'Egen', 'E', '08:00', '16:00')$$, :'org'), '42501');
update faktura.vakttyper set fra = '06:00' where id = :'dag';
select test.er((select fra from faktura.vakttyper where id = :'dag'), '07:00'::time, 'Ola endrer ikke vakttypen');
delete from faktura.vakttype_behov;
select test.er((select count(*) from faktura.vakttype_behov), 3::bigint, 'og sletter ikke behovet');
select test.feiler(format($$insert into faktura.ansatt_vakttyper (org_id, ansatt_id, vakttype_id) values (%L, %L, %L)$$, :'org', :'ola', :'natt'), '42501');
update faktura.vakter set vakttype_id = :'dag' where id = :'v2';
select test.er((select vakttype_id from faktura.vakter where id = :'v2'), :'natt'::uuid, 'Ola endrer ikke vakttypen på vakten');

-- Den ledige vakten for sykepleierne: Ola (assistent) kan ikke ta den, Kari kan.
select test.feiler(format($$select faktura.ta_vakt(%L, %L)$$, :'org', :'ledig'), 'FA403');
select set_config('app.bruker_id', :'u_kari', false);
select test.er((select ansatt_id from faktura.ta_vakt(:'org', :'ledig')), :'kari'::uuid, 'Kari tok vakten');

-- Angre kjøringen: utkastene slettes av API-et; de publiserte står igjen uten kjøringen.
select set_config('app.bruker_id', :'u', false);
delete from faktura.turnus_kjoringer where id = :'kj';
select test.er((select count(*) from faktura.vakter where id in (:'v2', :'ledig') and turnus_id is null), 2::bigint, 'vaktene står uten kjøringen');

-- En annen organisasjon kan ikke bruke vakttypene eller rollene her.
select id as org2 from faktura.opprett_organisasjon('Annen AS', '917654034') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org2', true);
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra) values (:'org2', 'Per', 'Annen', :'start') returning id as per \gset
select test.feiler(format($$insert into faktura.vakter (org_id, ansatt_id, dato, vakttype_id) values (%L, %L, %L, %L)$$, :'org2', :'per', :'d1', :'dag'), 'FA404');
select test.feiler(format($$insert into faktura.vakter (org_id, ansatt_id, dato, fra, til, vakttype_id) values (%L, %L, %L, '08:00', '12:00', %L)$$, :'org2', :'per', :'d1', :'dag'), 'FA404');
select test.feiler(format($$insert into faktura.vakter (org_id, ansatt_id, dato, fra, til, rolle_id) values (%L, %L, %L, '08:00', '12:00', %L)$$, :'org2', :'per', :'d1', :'spl'), '23503');
select test.feiler(format($$insert into faktura.ansatt_vakttyper (org_id, ansatt_id, vakttype_id) values (%L, %L, %L)$$, :'org2', :'per', :'dag'), '23503');
select test.feiler(format($$insert into faktura.vakttype_behov (org_id, vakttype_id, ukedag, antall) values (%L, %L, 1, 1)$$, :'org2', :'dag'), '23503');

-- Slettes en vakttype, beholder vaktene klokkeslettene, og behovet og valgene forsvinner.
delete from faktura.vakttyper where id = :'natt';
select test.er((select vakttype_id is null and to_char(fra, 'HH24:MI') = '23:00' from faktura.vakter where id = :'v2'), true, 'vakten står uten vakttype');
select test.er((select count(*) from faktura.vakttype_behov where vakttype_id = :'natt'), 0::bigint, 'behovet er borte');
select test.er((select count(*) from faktura.ansatt_vakttyper where vakttype_id = :'natt'), 0::bigint, 'valgene er borte');

-- Endringene havner i loggen.
select test.er((select count(*) > 0 from faktura.revisjonslogg where tabell = 'vakttyper' and rad_id = :'dag'), true, 'vakttypene loggføres');
select test.er((select count(*) > 0 from faktura.revisjonslogg where tabell = 'turnus_kjoringer' and handling = 'DELETE'), true, 'kjøringene loggføres');

\c :migrator
drop schema test cascade;
\echo '  ok'
