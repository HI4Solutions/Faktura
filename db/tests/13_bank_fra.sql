-- Startdato for innbetalinger fra banken (0028_bank_fra.sql): standard er dagen
-- organisasjonen ble opprettet. Eldre innbetalinger ryddes bort, også de som ble registrert
-- på en faktura av seg selv (betalingen tas bort), men ikke de en person har registrert.

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
grant execute on all functions in schema test to public;

\c :api
select id as u from faktura.registrer_bruker('uid-bankfra', 'bankfra@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Bankfra AS', '923609016') \gset
update faktura.organisasjoner set kontonr = '86011117947' where id = :'org';
insert into faktura.kunder (org_id, navn) values (:'org', 'Kari Hansen') returning id as k \gset
insert into faktura.fakturaer (org_id, kunde_id) values (:'org', :'k') returning id as f1 \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, enhetspris, mva_sats) values (:'org', :'f1', 'Husleie', 1000, 0);
select faktura.utsted(:'f1');
insert into faktura.fakturaer (org_id, kunde_id) values (:'org', :'k') returning id as f2 \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, enhetspris, mva_sats) values (:'org', :'f2', 'Husleie', 2000, 0);
select faktura.utsted(:'f2');
-- Standard: dagen organisasjonen ble opprettet.
select test.er(faktura.bank_fra(:'org'), faktura.i_dag(), 'standard startdato');

-- Innbetalinger fra før startdatoen (hentet før regelen kom): én registrert av seg selv,
-- én som en person registrerer, én uavklart, og én fra i dag.
\c :worker
insert into faktura.banktransaksjoner (org_id, konto, ekstern_id, dato, belop, betaler, melding)
values (:'org', '86011117947', 'g1', faktura.i_dag() - 20, 1000, 'KARI HANSEN', 'Faktura 1') returning id as g1 \gset
insert into faktura.banktransaksjoner (org_id, konto, ekstern_id, dato, belop, betaler)
values (:'org', '86011117947', 'g2', faktura.i_dag() - 19, 500, 'KARI HANSEN') returning id as g2 \gset
insert into faktura.banktransaksjoner (org_id, konto, ekstern_id, dato, belop, betaler)
values (:'org', '86011117947', 'g3', faktura.i_dag() - 18, 77, 'Ukjent') returning id as g3 \gset
insert into faktura.banktransaksjoner (org_id, konto, ekstern_id, dato, belop, betaler)
values (:'org', '86011117947', 'n1', faktura.i_dag(), 300, 'Ukjent') returning id as n1 \gset
select faktura.koble_banktransaksjon(:'g1', :'f1', 'Fakturanummer 1 i meldingen');

\c :api
select set_config('app.bruker_id', :'u', false), set_config('test.org', :'org', false);
select faktura.koble_banktransaksjon(:'g2', :'f2');
select test.er((select status from faktura.fakturaer where id = :'f1'), 'betalt', 'faktura 1 betalt av den gamle innbetalingen');

-- Bare workeren rydder av seg selv, og startdatoen endres bare gjennom funksjonen.
do $$ begin
  perform faktura.rydd_banktransaksjoner(current_setting('test.org')::uuid);
  raise exception 'FEIL: API-et kunne kalle ryddingen direkte';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  update faktura.organisasjoner set bank_fra = '2020-01-01' where id = current_setting('test.org')::uuid;
  raise exception 'FEIL: API-et kunne endre startdatoen direkte';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform faktura.sett_bank_fra(current_setting('test.org')::uuid, faktura.i_dag() + 1);
  raise exception 'FEIL: startdatoen kunne være fram i tid';
exception when sqlstate 'FA400' then null;
end $$;

-- Rydding: den gamle som ble registrert av seg selv, angres og fjernes sammen med den
-- uavklarte. Den en person registrerte, og den fra i dag, blir stående.
select test.er(faktura.sett_bank_fra(:'org', null), 2, 'to gamle innbetalinger fjernet');
select test.er((select string_agg(ekstern_id, ',' order by ekstern_id) from faktura.banktransaksjoner where org_id = :'org'), 'g2,n1', 'igjen etter rydding');
select test.er((select status from faktura.fakturaer where id = :'f1'), 'utstedt', 'faktura 1 er ubetalt igjen');
select test.er((select count(*)::int from faktura.betalinger where faktura_id = :'f1'), 0, 'betalingen fra den gamle er fjernet');
select test.er((select count(*)::int from faktura.betalinger where faktura_id = :'f2'), 1, 'betalingen en person registrerte, står');
select test.er((select count(*)::int from faktura.revisjonslogg where org_id = :'org' and tabell = 'betalinger' and handling = 'SLETTET'), 1,
               'fjerningen står i revisjonsloggen');

-- En bank som er hentet fra før: flyttes startdatoen bakover, hentes kontoene på nytt.
insert into faktura.bankkoblinger (org_id, bank, psu_type) values (:'org', 'DNB', 'business') returning id as dnb \gset
update faktura.bankkoblinger set kontoer = '[{"uid": "k1", "kontonr": "86011117947", "navn": "Drift", "hent_fra": "2026-10-01"}]' where id = :'dnb';
select test.er(faktura.sett_bank_fra(:'org', faktura.i_dag() - 30), 0, 'ingenting å fjerne');
select test.er(faktura.bank_fra(:'org'), faktura.i_dag() - 30, 'valgt startdato');
select test.er((select kontoer -> 0 ->> 'hent_fra' from faktura.bankkoblinger where id = :'dnb'), null, 'hentes på nytt fra startdatoen');
select test.er((select kontoer -> 0 ->> 'kontonr' from faktura.bankkoblinger where id = :'dnb'), '86011117947', 'kontoen står');

-- Et medlem med lesetilgang kan ikke endre startdatoen.
select id as u2 from faktura.registrer_bruker('uid-bankfra-les', 'les-bankfra@test.no') \gset
select faktura.inviter_medlem(:'org', 'les-bankfra@test.no', 'les') as token \gset
select set_config('app.bruker_id', :'u2', false);
select faktura.aksepter_invitasjon(:'token');
do $$ begin
  perform faktura.sett_bank_fra(current_setting('test.org')::uuid, null);
  raise exception 'FEIL: lesetilgang kunne endre startdatoen';
exception when sqlstate 'FA403' then null;
end $$;

-- Workeren rydder ved hver henting.
\c :worker
select test.er(faktura.rydd_banktransaksjoner(:'org'), 0, 'workeren rydder (ingenting igjen)');

\c :migrator
drop schema test cascade;
\echo '  ok'
