-- Rullering på tavla (0051_tavle_rullering.sql): plassene rulleringen setter, er merket
-- (rullert), og hvem som ikke kan ta en oppgave (tavle_utelatt), ser og styrer bare de som ser
-- og styrer de ansatte; den ansatte ser det ikke. Slettes oppgaven eller den ansatte, forsvinner
-- radene.

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
select id as u from faktura.registrer_bruker('uid-rull-eier', 'eier-rull@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Rullering AS', '917654034') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
select faktura.i_dag() + 1 as d1, faktura.i_dag() - 30 as start \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra) values (:'org', 'Ola', 'Rull', 'ola-rull@test.no', :'start') returning id as ola \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra) values (:'org', 'Kari', 'Rull', :'start') returning id as kari \gset
select faktura.inviter_ansatt(:'org', :'ola') as t_ola \gset
select id as u_ola from faktura.registrer_bruker('uid-rull-ola', 'ola-rull@test.no') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');

select set_config('app.bruker_id', :'u', false);
insert into faktura.tavle_faser (org_id, navn) values (:'org', 'Dagen') returning id as fase \gset
insert into faktura.tavle_oppgaver (org_id, navn, rekkefolge) values (:'org', 'Telefon', 1) returning id as telefon \gset
insert into faktura.tavle_oppgaver (org_id, navn, rekkefolge) values (:'org', 'Lab', 2) returning id as lab \gset

-- Rulleringens plasser er merket; en ny plass er satt for hånd.
insert into faktura.tavle_plasseringer (org_id, dato, fase_id, oppgave_id, ansatt_id, rullert) values (:'org', :'d1', :'fase', :'telefon', :'ola', true) returning id as p \gset
insert into faktura.tavle_plasseringer (org_id, dato, fase_id, oppgave_id, ansatt_id) values (:'org', :'d1', :'fase', :'lab', :'kari') returning id as p2 \gset
select test.er((select rullert from faktura.tavle_plasseringer where id = :'p2'), false, 'satt for hånd');
update faktura.tavle_plasseringer set oppgave_id = :'lab', rullert = false where id = :'p';
select test.er((select rullert from faktura.tavle_plasseringer where id = :'p'), false, 'flyttet for hånd');

-- Hvem som ikke kan ta en oppgave: eieren styrer det.
insert into faktura.tavle_utelatt (org_id, oppgave_id, ansatt_id) values (:'org', :'lab', :'kari');
select test.feiler(format($$insert into faktura.tavle_utelatt (org_id, oppgave_id, ansatt_id) values (%L, %L, %L)$$, :'org', :'lab', :'kari'), '23505');
select test.feiler(format($$update faktura.tavle_utelatt set ansatt_id = %L$$, :'ola'), '42501');

-- Den ansatte ser det ikke og endrer det ikke.
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select count(*) from faktura.tavle_utelatt), 0::bigint, 'den ansatte ser ikke hvem som er utelatt');
select test.feiler(format($$insert into faktura.tavle_utelatt (org_id, oppgave_id, ansatt_id) values (%L, %L, %L)$$, :'org', :'telefon', :'ola'), '42501');
delete from faktura.tavle_utelatt;
select set_config('app.bruker_id', :'u', false);
select test.er((select count(*) from faktura.tavle_utelatt), 1::bigint, 'den ansatte sletter ikke');

-- En annen organisasjon ser ingenting.
select id as u2 from faktura.registrer_bruker('uid-rull-annen', 'annen-rull@test.no') \gset
select set_config('app.bruker_id', :'u2', false);
select faktura.opprett_organisasjon('Annen AS', '917654042');
select test.er((select count(*) from faktura.tavle_utelatt), 0::bigint, 'en annen organisasjon ser ingenting');
select test.feiler(format($$insert into faktura.tavle_utelatt (org_id, oppgave_id, ansatt_id) values (%L, %L, %L)$$, :'org', :'telefon', :'ola'), '42501');

-- Slettes oppgaven, forsvinner radene.
select set_config('app.bruker_id', :'u', false);
delete from faktura.tavle_oppgaver where id = :'lab';
select test.er((select count(*) from faktura.tavle_utelatt where org_id = :'org'), 0::bigint, 'radene for laben er borte');

\c :migrator
drop schema test cascade;
\echo '  ok'
