-- Vaktplan (0036_vaktplan.sql): eier og administrator planlegger og publiserer; den ansatte ser
-- den publiserte planen (også kollegaenes vakter, 0063, men ikke utkast), og kan ta en ledig vakt (én får den, uten
-- overlapp, ikke passerte); timer kan føres fra egne vakter. Datoene regnes fra i dag, så
-- testene ikke avhenger av når de kjøres.

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
select id as u from faktura.registrer_bruker('uid-vakt-eier', 'eier-vakt@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Vaktplan AS', '917654018') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
select faktura.i_dag() as d0, faktura.i_dag() + 1 as d1, faktura.i_dag() + 2 as d2, faktura.i_dag() + 3 as d3,
       faktura.i_dag() - 1 as d_1, faktura.i_dag() - 30 as start, faktura.i_dag() + 10 as senere \gset

insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra) values (:'org', 'Ola', 'Vakt', 'ola-vakt@test.no', :'start') returning id as ola \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra) values (:'org', 'Kari', 'Vakt', 'kari-vakt@test.no', :'start') returning id as kari \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, aktiv) values (:'org', 'Per', 'Sluttet', :'start', false) returning id as per \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra) values (:'org', 'Nina', 'Senere', :'senere') returning id as nina \gset

-- Ola og Kari logger inn som ansatte.
select faktura.inviter_ansatt(:'org', :'ola') as t_ola \gset
select faktura.inviter_ansatt(:'org', :'kari') as t_kari \gset
select id as u_ola from faktura.registrer_bruker('uid-vakt-ola', 'ola-vakt@test.no') \gset
select id as u_kari from faktura.registrer_bruker('uid-vakt-kari', 'kari-vakt@test.no') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');
select test.er(faktura.min_ansatt(:'org'), :'ola'::uuid, 'Olas egen ansattrad');
select set_config('app.bruker_id', :'u_kari', false);
select faktura.aksepter_invitasjon(:'t_kari');

-- Eieren planlegger: timene regnes ut (også over midnatt), og en vakt uten ansatt er ledig.
select set_config('app.bruker_id', :'u', false);
select test.er(faktura.min_ansatt(:'org'), null::uuid, 'eieren er ikke ansatt');
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til, pause_min, oppgave)
values (:'org', :'ola', :'d1', '08:00', '16:00', 30, ' Kasse ') returning id as v1, timer as v1_timer, oppgave as v1_oppgave, publisert_at is null as v1_utkast \gset
select test.er(:'v1_timer'::numeric, 7.50, 'sju og en halv time');
select test.er(:'v1_oppgave', 'Kasse', 'oppgaven uten mellomrom');
select test.er(:'v1_utkast'::boolean, true, 'et utkast');
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'ola', :'d2', '22:00', '06:00') returning id as v2, timer as v2_timer \gset
select test.er(:'v2_timer'::numeric, 8.00, 'nattevakt over midnatt');
insert into faktura.vakter (org_id, dato, fra, til, oppgave) values (:'org', :'d3', '10:00', '14:00', 'Lager') returning id as v3 \gset
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'kari', :'d1', '12:00', '20:00') returning id as v4 \gset

-- Like tider, for lang pause, en som ikke er aktiv, og en dag utenfor ansettelsen.
select test.feiler(format($$insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (%L, %L, %L, '08:00', '08:00')$$, :'org', :'ola', :'d1'), 'FA400');
select test.feiler(format($$insert into faktura.vakter (org_id, ansatt_id, dato, fra, til, pause_min) values (%L, %L, %L, '08:00', '08:30', 30)$$, :'org', :'ola', :'d1'), 'FA400');
select test.feiler(format($$insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (%L, %L, %L, '08:00', '12:00')$$, :'org', :'per', :'d1'), 'FA400');
select test.feiler(format($$insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (%L, %L, %L, '08:00', '12:00')$$, :'org', :'nina', :'d1'), 'FA400');
select test.feiler(format($$update faktura.vakter set ansatt_id = %L where id = %L$$, :'per', :'v3'), 'FA400');
-- Publiseringen skjer bare gjennom publiser_vakter.
select test.feiler(format($$update faktura.vakter set publisert_at = now() where id = %L$$, :'v1'), '42501');

-- Utkast: den ansatte ser ingenting, og kan ikke planlegge eller publisere.
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select count(*) from faktura.vakter), 0::bigint, 'utkast vises ikke for den ansatte');
select test.feiler(format($$insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (%L, %L, %L, '08:00', '12:00')$$, :'org', :'ola', :'d1'), '42501');
select test.feiler(format($$select faktura.publiser_vakter(%L, %L, %L)$$, :'org', :'d0', :'d3'), 'FA403');

-- Publisert: Ola ser hele den publiserte planen (sine egne, Karis og den ledige; 0063), og endrer ingenting.
select set_config('app.bruker_id', :'u', false);
select test.er((select count(*) from faktura.publiser_vakter(:'org', :'d0', :'d3')), 4::bigint, 'fire vakter publisert');
select test.er((select count(*) from faktura.publiser_vakter(:'org', :'d0', :'d3')), 0::bigint, 'ingen nye å publisere');
select test.feiler(format($$select faktura.publiser_vakter(%L, %L, %L)$$, :'org', :'d3', :'d0'), 'FA400');
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select string_agg(coalesce(oppgave, '-'), ',' order by dato, fra) from faktura.vakter), 'Kasse,-,-,Lager', 'hele den publiserte planen');
update faktura.vakter set fra = '09:00' where id = :'v1';
select test.er((select fra from faktura.vakter where id = :'v1'), '08:00'::time, 'den ansatte endrer ikke vakten');
delete from faktura.vakter where id = :'v1';
select test.er((select count(*) from faktura.vakter where id = :'v1'), 1::bigint, 'og sletter den ikke');

-- Den ledige vakten: den første som tar den, får den.
select test.er((select ansatt_id from faktura.ta_vakt(:'org', :'v3')), :'ola'::uuid, 'Ola tok vakten');
select set_config('app.bruker_id', :'u_kari', false);
select test.feiler(format($$select faktura.ta_vakt(%L, %L)$$, :'org', :'v3'), 'FA409');
select test.er((select ansatt_id from faktura.vakter where id = :'v3'), :'ola'::uuid, 'Kari ser at Ola har den nå');

-- Vakter som overlapper egne vakter eller er passert, kan ikke tas; utkast finnes ikke for
-- den ansatte, og den som ikke er ansatt, kan ikke ta vakter.
select set_config('app.bruker_id', :'u', false);
insert into faktura.vakter (org_id, dato, fra, til) values (:'org', :'d1', '15:00', '18:00') returning id as v5 \gset
insert into faktura.vakter (org_id, dato, fra, til) values (:'org', :'d_1', '08:00', '12:00') returning id as v6 \gset
insert into faktura.vakter (org_id, dato, fra, til) values (:'org', :'d3', '18:00', '20:00') returning id as v7 \gset
select test.er((select count(*) from faktura.publiser_vakter(:'org', :'d_1', :'d1')), 2::bigint, 'to nye publisert');
select test.feiler(format($$select faktura.ta_vakt(%L, %L)$$, :'org', :'v5'), 'FA403');
select set_config('app.bruker_id', :'u_ola', false);
select test.feiler(format($$select faktura.ta_vakt(%L, %L)$$, :'org', :'v5'), 'FA409');
select test.feiler(format($$select faktura.ta_vakt(%L, %L)$$, :'org', :'v6'), 'FA409');
select test.feiler(format($$select faktura.ta_vakt(%L, %L)$$, :'org', :'v7'), 'FA404');
-- Nattevakten 22–06 overlapper ikke en vakt som starter kl. 06 neste morgen.
select set_config('app.bruker_id', :'u', false);
insert into faktura.vakter (org_id, dato, fra, til) values (:'org', :'d3', '06:00', '09:00') returning id as v9 \gset
select test.er((select count(*) from faktura.publiser_vakter(:'org', :'d3', :'d3')), 2::bigint, 'publisert');
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select ansatt_id from faktura.ta_vakt(:'org', :'v9')), :'ola'::uuid, 'rett etter nattevakten');

-- Timer fra vakten: bare fra egne vakter. Slettes vakten, står føringen uendret uten kobling.
insert into faktura.timeforinger (org_id, ansatt_id, dato, fra, til, pause_min, vakt_id)
values (:'org', :'ola', :'d1', '08:00', '16:00', 30, :'v1') returning id as t1, vakt_id as t1_vakt \gset
select test.er(:'t1_vakt'::uuid, :'v1'::uuid, 'koblet til vakten');
select test.feiler(format($$insert into faktura.timeforinger (org_id, ansatt_id, dato, timer, vakt_id) values (%L, %L, %L, 2, %L)$$, :'org', :'ola', :'d1', :'v4'), 'FA400');
select test.feiler(format($$update faktura.timeforinger set vakt_id = %L where id = %L$$, :'v2', :'t1'), '42501');
select test.er(faktura.lever_timer(:'org', :'ola', :'d0', :'d3'), 1, 'levert');
select set_config('app.bruker_id', :'u', false);
select test.er(faktura.avvis_timer(:'org', array[:'t1']::uuid[], 'Feil dag'), 1, 'avvist');
delete from faktura.vakter where id = :'v1';
select test.er((select vakt_id from faktura.timeforinger where id = :'t1'), null::uuid, 'koblingen er borte');
select test.er((select status from faktura.timeforinger where id = :'t1'), 'avvist', 'føringen er ellers uendret');

-- Slettes en ansatt (uten timer), blir vaktene ledige.
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra) values (:'org', 'Vikar', 'Kort', :'start') returning id as vikar \gset
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'vikar', :'d2', '08:00', '12:00') returning id as v8 \gset
delete from faktura.ansatte where id = :'vikar';
select test.er((select ansatt_id from faktura.vakter where id = :'v8'), null::uuid, 'vakten er ledig');

-- Endringer i planen havner i loggen.
select test.er((select count(*) > 0 from faktura.revisjonslogg where tabell = 'vakter' and rad_id = :'v3' and handling = 'UPDATE'), true, 'loggført');

-- En som bare kan lese fakturaer, ser ikke vaktplanen; regnskap ser den, men endrer ikke.
select id as u_les from faktura.registrer_bruker('uid-vakt-les', 'les-vakt@test.no') \gset
select faktura.inviter_medlem(:'org', 'les-vakt@test.no', 'les') as tl \gset
select id as u_regn from faktura.registrer_bruker('uid-vakt-regn', 'regn-vakt@test.no') \gset
select faktura.inviter_medlem(:'org', 'regn-vakt@test.no', 'regnskap') as tr \gset
select set_config('app.bruker_id', :'u_les', false);
select faktura.aksepter_invitasjon(:'tl');
select test.er((select count(*) from faktura.vakter), 0::bigint, 'leseren ser ingen vakter');
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'tr');
select test.er((select count(*) from faktura.vakter), 8::bigint, 'regnskap ser hele planen');
select test.feiler(format($$insert into faktura.vakter (org_id, dato, fra, til) values (%L, %L, '08:00', '12:00')$$, :'org', :'d1'), '42501');

\c :migrator
drop schema test cascade;
\echo '  ok'
