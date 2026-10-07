-- Tavle og fravær (0037_tavle_og_fravaer.sql, 0038_tavle_behov.sql): fravær registreres av
-- eier og administrator, den ansatte melder bare sykdom selv (fra og med i går, så bare
-- sluttdatoen); fravær er skjult for andre enn dem som ser de ansatte, også i loggen. Tavla
-- har faser, oppgaver og behov per fase som alle ser, men bare personal endrer; den som er
-- borte eller ikke ansatt, kan ikke plasseres. Vikarvakter dekker en annen vakt og kan
-- publiseres hver for seg.

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
select id as u from faktura.registrer_bruker('uid-tavle-eier', 'eier-tavle@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Tavle AS', '917654026') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
select faktura.i_dag() as d0, faktura.i_dag() + 1 as d1, faktura.i_dag() + 2 as d2, faktura.i_dag() + 3 as d3,
       faktura.i_dag() + 4 as d4, faktura.i_dag() - 1 as d_1, faktura.i_dag() - 3 as d_3, faktura.i_dag() - 30 as start \gset

insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra) values (:'org', 'Ola', 'Tavle', 'ola-tavle@test.no', :'start') returning id as ola \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra) values (:'org', 'Kari', 'Tavle', 'kari-tavle@test.no', :'start') returning id as kari \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, ansettelsestype, lonnstype) values (:'org', 'Vera', 'Vikar', :'start', 'tilkalling', 'time') returning id as vera \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, aktiv) values (:'org', 'Per', 'Sluttet', :'start', false) returning id as per \gset
select faktura.inviter_ansatt(:'org', :'ola') as t_ola \gset
select id as u_ola from faktura.registrer_bruker('uid-tavle-ola', 'ola-tavle@test.no') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');

-- Fravær registreres av eieren: ferie for Kari; overlapp og datoer utenfor ansettelsen avvises.
select set_config('app.bruker_id', :'u', false);
insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, notat) values (:'org', :'kari', 'ferie', :'d2', :'d4', '  Høstferie ') returning id as ferie, notat as ferie_notat \gset
select test.er(:'ferie_notat', 'Høstferie', 'notatet uten mellomrom');
select test.feiler(format($$insert into faktura.fravaer (org_id, ansatt_id, type, fra, til) values (%L, %L, 'syk', %L, %L)$$, :'org', :'kari', :'d3', :'d3'), 'FA409');
select test.feiler(format($$insert into faktura.fravaer (org_id, ansatt_id, type, fra, til) values (%L, %L, 'ferie', %L, %L)$$, :'org', :'kari', :'start'::date - 5, :'d0'), 'FA400');
select test.feiler(format($$insert into faktura.fravaer (org_id, ansatt_id, type, fra, til) values (%L, %L, 'ferie', %L, %L)$$, :'org', :'kari', :'d2', :'d1'), 'FA400');

-- Den ansatte melder sykdom selv (fra og med i går), men ikke ferie, ikke for andre og ikke langt tilbake.
select set_config('app.bruker_id', :'u_ola', false);
insert into faktura.fravaer (org_id, ansatt_id, type, fra, til) values (:'org', :'ola', 'syk', :'d0', :'d1') returning id as syk \gset
select test.feiler(format($$insert into faktura.fravaer (org_id, ansatt_id, type, fra, til) values (%L, %L, 'ferie', %L, %L)$$, :'org', :'ola', :'d3', :'d4'), 'FA403');
select test.feiler(format($$insert into faktura.fravaer (org_id, ansatt_id, type, fra, til) values (%L, %L, 'syk', %L, %L)$$, :'org', :'ola', :'d_3', :'d_3'), 'FA400');
select test.feiler(format($$insert into faktura.fravaer (org_id, ansatt_id, type, fra, til) values (%L, %L, 'syk', %L, %L)$$, :'org', :'kari', :'d0', :'d0'), '42501');
select test.er((select string_agg(type, ',') from faktura.fravaer), 'syk', 'ser bare sitt eget fravær');
-- Friskmelding: sluttdatoen kan endres, ikke starten.
update faktura.fravaer set til = :'d0' where id = :'syk';
select test.er((select til from faktura.fravaer where id = :'syk'), :'d0'::date, 'sluttdatoen endret');
select test.feiler(format($$update faktura.fravaer set fra = %L where id = %L$$, :'d_1', :'syk'), 'FA403');
update faktura.fravaer set til = :'d1' where id = :'syk';

-- Fravær vises ikke for den som bare leser fakturaer, heller ikke i loggen.
select set_config('app.bruker_id', :'u', false);
select id as u_les from faktura.registrer_bruker('uid-tavle-les', 'les-tavle@test.no') \gset
select faktura.inviter_medlem(:'org', 'les-tavle@test.no', 'les') as tl \gset
select set_config('app.bruker_id', :'u_les', false);
select faktura.aksepter_invitasjon(:'tl');
select test.er((select count(*) from faktura.fravaer), 0::bigint, 'leseren ser ikke fraværet');
select test.er((select count(*) from faktura.revisjonslogg where tabell = 'fravaer'), 0::bigint, 'og ikke loggen for fravær');
select set_config('app.bruker_id', :'u', false);
select test.er((select count(*) >= 2 from faktura.revisjonslogg where tabell = 'fravaer'), true, 'eieren ser loggen');
select test.er((select count(*) from faktura.fravaer), 2::bigint, 'eieren ser alt fravær');

-- Tavla: eieren lager faser og oppgaver; den ansatte ser dem, men endrer dem ikke.
insert into faktura.tavle_faser (org_id, navn, fra, til, rekkefolge) values (:'org', 'Forvakt', '07:00', '15:00', 1) returning id as forvakt \gset
insert into faktura.tavle_faser (org_id, navn, fra, til, rekkefolge) values (:'org', 'Senvakt', '14:00', '22:00', 2) returning id as senvakt \gset
insert into faktura.tavle_oppgaver (org_id, navn, behov, rekkefolge) values (:'org', 'Telefon', 2, 1) returning id as telefon \gset
insert into faktura.tavle_oppgaver (org_id, navn, rekkefolge) values (:'org', 'Lab', 2) returning id as lab \gset
select test.feiler(format($$insert into faktura.tavle_faser (org_id, navn, fra) values (%L, 'Halv', '08:00')$$, :'org'), '23514');
select test.feiler(format($$insert into faktura.tavle_oppgaver (org_id, navn, behov) values (%L, 'Mange', 0)$$, :'org'), '23514');
-- Behov per fase: 0 betyr at oppgaven ikke trenger noen i fasen.
insert into faktura.tavle_behov (org_id, fase_id, oppgave_id, antall) values (:'org', :'senvakt', :'telefon', 1);
insert into faktura.tavle_behov (org_id, fase_id, oppgave_id, antall) values (:'org', :'senvakt', :'lab', 0);
select test.feiler(format($$insert into faktura.tavle_behov (org_id, fase_id, oppgave_id, antall) values (%L, %L, %L, 51)$$, :'org', :'forvakt', :'lab'), '23514');
select test.feiler(format($$insert into faktura.tavle_behov (org_id, fase_id, oppgave_id, antall) values (%L, %L, %L, 2)$$, :'org', :'senvakt', :'lab'), '23505');
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select count(*) from faktura.tavle_faser), 2::bigint, 'den ansatte ser fasene');
select test.er((select count(*) from faktura.tavle_oppgaver), 2::bigint, 'og oppgavene');
select test.er((select count(*) from faktura.tavle_behov), 2::bigint, 'og behovet per fase');
select test.feiler(format($$insert into faktura.tavle_oppgaver (org_id, navn) values (%L, 'Kaffe')$$, :'org'), '42501');
select test.feiler(format($$insert into faktura.tavle_behov (org_id, fase_id, oppgave_id, antall) values (%L, %L, %L, 1)$$, :'org', :'forvakt', :'lab'), '42501');

-- Plasseringer: ikke den som er borte, har sluttet eller allerede er plassert i fasen.
select set_config('app.bruker_id', :'u', false);
insert into faktura.tavle_plasseringer (org_id, dato, fase_id, oppgave_id, ansatt_id) values (:'org', :'d1', :'forvakt', :'telefon', :'kari') returning id as p1 \gset
insert into faktura.tavle_plasseringer (org_id, dato, fase_id, oppgave_id, ansatt_id) values (:'org', :'d1', :'senvakt', :'lab', :'kari');
select test.feiler(format($$insert into faktura.tavle_plasseringer (org_id, dato, fase_id, oppgave_id, ansatt_id) values (%L, %L, %L, %L, %L)$$, :'org', :'d3', :'forvakt', :'telefon', :'kari'), 'FA409');
select test.feiler(format($$insert into faktura.tavle_plasseringer (org_id, dato, fase_id, oppgave_id, ansatt_id) values (%L, %L, %L, %L, %L)$$, :'org', :'d1', :'forvakt', :'telefon', :'ola'), 'FA409');
select test.feiler(format($$insert into faktura.tavle_plasseringer (org_id, dato, fase_id, oppgave_id, ansatt_id) values (%L, %L, %L, %L, %L)$$, :'org', :'d1', :'forvakt', :'lab', :'per'), 'FA400');
select test.feiler(format($$insert into faktura.tavle_plasseringer (org_id, dato, fase_id, oppgave_id, ansatt_id) values (%L, %L, %L, %L, %L)$$, :'org', :'d1', :'forvakt', :'lab', :'kari'), '23505');
-- Flytt til en annen oppgave i samme fase.
update faktura.tavle_plasseringer set oppgave_id = :'lab' where id = :'p1';
select test.er((select oppgave_id from faktura.tavle_plasseringer where id = :'p1'), :'lab'::uuid, 'flyttet til lab');
-- Den ansatte ser bare sine egne plasser.
insert into faktura.tavle_plasseringer (org_id, dato, fase_id, oppgave_id, ansatt_id) values (:'org', :'d2', :'forvakt', :'telefon', :'ola');
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select count(*) from faktura.tavle_plasseringer), 1::bigint, 'ser bare egne plasser');
delete from faktura.tavle_plasseringer where id = :'p1';
select set_config('app.bruker_id', :'u', false);
select test.er((select count(*) from faktura.tavle_plasseringer where id = :'p1'), 1::bigint, 'den ansatte sletter ikke plasser');
-- Slettes en oppgave, forsvinner plassene i den.
delete from faktura.tavle_oppgaver where id = :'lab';
select test.er((select count(*) from faktura.tavle_plasseringer where org_id = :'org'), 1::bigint, 'plassene i lab er borte');
select test.er((select count(*) from faktura.tavle_behov where org_id = :'org'), 1::bigint, 'og behovet for lab');

-- Vikar: en egen vakt som dekker vakten til den som er syk, og som kan publiseres alene.
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'ola', :'d1', '07:00', '15:00') returning id as v_ola \gset
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'kari', :'d1', '14:00', '22:00') returning id as v_kari \gset
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til, vikar_for) values (:'org', :'vera', :'d1', '07:00', '15:00', :'v_ola') returning id as v_vera \gset
select test.er((select publisert_at is not null from faktura.publiser_vakt(:'org', :'v_vera')), true, 'vikarvakten er publisert');
select test.er((select count(*) from faktura.vakter where org_id = :'org' and publisert_at is not null), 1::bigint, 'bare den');
select set_config('app.bruker_id', :'u_ola', false);
select test.feiler(format($$select faktura.publiser_vakt(%L, %L)$$, :'org', :'v_kari'), 'FA403');
select set_config('app.bruker_id', :'u', false);
delete from faktura.vakter where id = :'v_ola';
select test.er((select vikar_for from faktura.vakter where id = :'v_vera'), null::uuid, 'vikarvakten står igjen uten kobling');

\c :migrator
drop schema test cascade;
\echo '  ok'
