-- Fast arbeidsplan (0040_arbeidsplan.sql): ukedager med klokkeslett eller hel dag, gjeldende
-- fra en dato. Eier og administrator lager planene; de ansatte ser dem (de faste dagene er en del
-- av vaktplanen, 0063), men endrer ingen. Loggen for planene vises bare for dem som ser de ansatte.

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
select id as u from faktura.registrer_bruker('uid-plan-eier', 'eier-plan@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Arbeidsplan AS', '917654085') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
select faktura.i_dag() - 30 as start \gset

insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, stillingsprosent) values (:'org', 'Linda', 'Plan', 'linda-plan@test.no', :'start', 40) returning id as linda \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra) values (:'org', 'Ola', 'Plan', 'ola-plan@test.no', :'start') returning id as ola \gset

-- Linda: mandag hel dag, onsdag 08–15.30, fredag 08–16 med en halvtime pause.
insert into faktura.arbeidsplaner (org_id, ansatt_id, gjelder_fra) values (:'org', :'linda', :'start') returning id as plan \gset
insert into faktura.arbeidsplan_dager (org_id, plan_id, ukedag) values (:'org', :'plan', 1);
insert into faktura.arbeidsplan_dager (org_id, plan_id, ukedag, fra, til) values (:'org', :'plan', 3, '08:00', '15:30');
insert into faktura.arbeidsplan_dager (org_id, plan_id, ukedag, fra, til, pause_min) values (:'org', :'plan', 5, '08:00', '16:00', 30);
select test.er((select count(*) from faktura.arbeidsplan_dager where plan_id = :'plan'), 3::bigint, 'tre dager i planen');
select test.feiler(format($$insert into faktura.arbeidsplan_dager (org_id, plan_id, ukedag, fra) values (%L, %L, 2, '08:00')$$, :'org', :'plan'), '23514');
select test.feiler(format($$insert into faktura.arbeidsplan_dager (org_id, plan_id, ukedag, pause_min) values (%L, %L, 2, 30)$$, :'org', :'plan'), '23514');
select test.feiler(format($$insert into faktura.arbeidsplan_dager (org_id, plan_id, ukedag) values (%L, %L, 8)$$, :'org', :'plan'), '23514');
select test.feiler(format($$insert into faktura.arbeidsplan_dager (org_id, plan_id, ukedag) values (%L, %L, 1)$$, :'org', :'plan'), '23505');
select test.feiler(format($$insert into faktura.arbeidsplaner (org_id, ansatt_id, gjelder_fra) values (%L, %L, %L)$$, :'org', :'linda', :'start'), '23505');
-- En ny plan fra i dag (den gamle gjelder fortsatt bakover).
insert into faktura.arbeidsplaner (org_id, ansatt_id, gjelder_fra) values (:'org', :'linda', faktura.i_dag()) returning id as plan2 \gset
insert into faktura.arbeidsplan_dager (org_id, plan_id, ukedag) values (:'org', :'plan2', 2);

-- Den ansatte ser planene (sin egen og kollegaenes, 0063), og endrer ingen.
select faktura.inviter_ansatt(:'org', :'linda') as t_linda \gset
select faktura.inviter_ansatt(:'org', :'ola') as t_ola \gset
select id as u_linda from faktura.registrer_bruker('uid-plan-linda', 'linda-plan@test.no') \gset
select id as u_ola from faktura.registrer_bruker('uid-plan-ola', 'ola-plan@test.no') \gset
select set_config('app.bruker_id', :'u_linda', false);
select faktura.aksepter_invitasjon(:'t_linda');
select test.er((select count(*) from faktura.arbeidsplaner), 2::bigint, 'Linda ser planene sine');
select test.er((select count(*) from faktura.arbeidsplan_dager), 4::bigint, 'og dagene i dem');
select test.feiler(format($$insert into faktura.arbeidsplan_dager (org_id, plan_id, ukedag) values (%L, %L, 4)$$, :'org', :'plan2'), '42501');
delete from faktura.arbeidsplan_dager where plan_id = :'plan';
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');
select test.er((select count(*) from faktura.arbeidsplaner), 2::bigint, 'Ola ser Lindas planer');
select test.er((select count(*) from faktura.arbeidsplan_dager), 4::bigint, 'og dagene');
select test.feiler(format($$insert into faktura.arbeidsplan_dager (org_id, plan_id, ukedag) values (%L, %L, 5)$$, :'org', :'plan2'), '42501');

-- Loggen for planene ser eieren, ikke den som bare leser fakturaer.
select set_config('app.bruker_id', :'u', false);
select test.er((select count(*) from faktura.arbeidsplan_dager where plan_id = :'plan'), 3::bigint, 'Linda slettet ingen dager');
select test.er((select count(*) >= 2 from faktura.revisjonslogg where tabell = 'arbeidsplaner'), true, 'eieren ser loggen');
select id as u_les from faktura.registrer_bruker('uid-plan-les', 'les-plan@test.no') \gset
select faktura.inviter_medlem(:'org', 'les-plan@test.no', 'les') as tl \gset
select set_config('app.bruker_id', :'u_les', false);
select faktura.aksepter_invitasjon(:'tl');
select test.er((select count(*) from faktura.revisjonslogg where tabell = 'arbeidsplaner'), 0::bigint, 'leseren ser ikke loggen for planene');
select test.er((select count(*) from faktura.arbeidsplaner), 0::bigint, 'eller planene');

-- Slettes den ansatte, forsvinner planene.
select set_config('app.bruker_id', :'u', false);
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra) values (:'org', 'Per', 'Plan', :'start') returning id as per \gset
insert into faktura.arbeidsplaner (org_id, ansatt_id, gjelder_fra) values (:'org', :'per', :'start') returning id as plan3 \gset
insert into faktura.arbeidsplan_dager (org_id, plan_id, ukedag) values (:'org', :'plan3', 4);
delete from faktura.ansatte where id = :'per';
select test.er((select count(*) from faktura.arbeidsplaner where ansatt_id = :'per'), 0::bigint, 'planen er borte med den ansatte');
select test.er((select count(*) from faktura.arbeidsplan_dager where plan_id = :'plan3'), 0::bigint, 'og dagene');

\c :migrator
drop schema test cascade;
\echo '  ok'
