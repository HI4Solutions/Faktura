-- Innbetalinger fra banken (0026_bankavstemming.sql): bare workeren lagrer dem, appen
-- kobler dem til fakturaer, angrer og ignorerer, og andre ser dem ikke.

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
select id as u from faktura.registrer_bruker('uid-bank', 'bank@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Bank AS', '923609016') \gset
update faktura.organisasjoner set kontonr = '86011117947' where id = :'org';
insert into faktura.kunder (org_id, navn) values (:'org', 'Kari Hansen') returning id as k \gset
insert into faktura.fakturaer (org_id, kunde_id) values (:'org', :'k') returning id as f \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, enhetspris, mva_sats) values (:'org', :'f', 'Husleie', 1000, 0);
select faktura.utsted(:'f');
select set_config('test.org', :'org', false), set_config('test.f', :'f', false);
do $$ begin
  insert into faktura.banktransaksjoner (org_id, konto, ekstern_id, dato, belop)
  values (current_setting('test.org')::uuid, '86011117947', 'x1', current_date, 1000);
  raise exception 'FEIL: API-et kunne lagre en innbetaling';
exception when insufficient_privilege then null;
end $$;

\c :worker
insert into faktura.banktransaksjoner (org_id, konto, ekstern_id, dato, belop, betaler, melding)
values (:'org', '86011117947', 'e1', current_date, 1000, 'KARI HANSEN', 'Husleie') returning id as t \gset
insert into faktura.banktransaksjoner (org_id, konto, ekstern_id, dato, belop, betaler)
values (:'org', '86011117947', 'e2', current_date, 250, 'Renter') returning id as t2 \gset
select set_config('test.org', :'org', false);
do $$ begin
  insert into faktura.banktransaksjoner (org_id, konto, ekstern_id, dato, belop)
  values (current_setting('test.org')::uuid, '86011117947', 'e1', current_date, 1000);
  raise exception 'FEIL: samme innbetaling ble lagret to ganger';
exception when unique_violation then null;
end $$;

\c :api
select set_config('app.bruker_id', :'u', false), set_config('test.t', :'t', false), set_config('test.f', :'f', false);
select test.er((select count(*)::int from faktura.banktransaksjoner), 2, 'appen ser innbetalingene');
do $$ begin
  update faktura.banktransaksjoner set status = 'ignorert' where id = current_setting('test.t')::uuid;
  raise exception 'FEIL: API-et kunne endre en innbetaling direkte';
exception when insufficient_privilege then null;
end $$;

-- Koble: fakturaen blir betalt, med betalingen merket som fra banken.
select faktura.koble_banktransaksjon(:'t', :'f');
select test.er((select status from faktura.fakturaer where id = :'f'), 'betalt', 'fakturaen er betalt');
select test.er((select kilde || ':' || ekstern_ref || ':' || notat from faktura.betalinger where faktura_id = :'f'),
               'bank:' || :'t' || ':Fra KARI HANSEN: Husleie', 'betalingen er fra banken');
select test.er((select status || ':' || grunn from faktura.banktransaksjoner where id = :'t'), 'koblet:Koblet for hånd', 'koblet for hånd');
do $$ begin
  perform faktura.koble_banktransaksjon(current_setting('test.t')::uuid, current_setting('test.f')::uuid);
  raise exception 'FEIL: samme innbetaling ble registrert to ganger';
exception when sqlstate 'FA409' then null;
end $$;
do $$ begin
  perform faktura.ignorer_banktransaksjon(current_setting('test.t')::uuid);
  raise exception 'FEIL: en koblet innbetaling kunne ignoreres';
exception when sqlstate 'FA409' then null;
end $$;

-- Angre: betalingen fjernes og fakturaen er ubetalt igjen.
select faktura.angre_banktransaksjon(:'t');
select test.er((select status from faktura.fakturaer where id = :'f'), 'utstedt', 'fakturaen er ubetalt etter angre');
select test.er((select count(*)::int from faktura.betalinger where faktura_id = :'f'), 0, 'betalingen er fjernet');
select test.er((select status from faktura.banktransaksjoner where id = :'t'), 'uavklart', 'innbetalingen er uavklart igjen');
select test.er((select count(*)::int from faktura.revisjonslogg where tabell = 'betalinger' and handling = 'SLETTET'), 1, 'angre står i revisjonsloggen');

-- Ignorer og ta tilbake.
select faktura.ignorer_banktransaksjon(:'t2');
select test.er((select status from faktura.banktransaksjoner where id = :'t2'), 'ignorert', 'ignorert');
select faktura.ignorer_banktransaksjon(:'t2', false);
select test.er((select status from faktura.banktransaksjoner where id = :'t2'), 'uavklart', 'tatt tilbake');

-- Andre ser ingenting og kan ikke koble.
select id as u2 from faktura.registrer_bruker('uid-bank-2', 'annen-bank@test.no') \gset
select set_config('app.bruker_id', :'u2', false);
select test.er((select count(*)::int from faktura.banktransaksjoner), 0, 'andre ser ikke innbetalingene');
do $$ begin
  perform faktura.koble_banktransaksjon(current_setting('test.t')::uuid, current_setting('test.f')::uuid);
  raise exception 'FEIL: en annen kunne koble innbetalingen';
exception when sqlstate 'FA403' or sqlstate 'FA404' then null;
end $$;

-- Workeren kobler automatisk (uten bruker), med grunn.
\c :worker
select faktura.koble_banktransaksjon(:'t', :'f', 'Fakturanummer 1 i meldingen');
select test.er((select status || ':' || grunn || ':' || coalesce(behandlet_av::text, 'auto') from faktura.banktransaksjoner where id = :'t'),
               'koblet:Fakturanummer 1 i meldingen:auto', 'koblet automatisk');

-- Slettes fakturaen, blir innbetalingen uavklart igjen.
\c :api
select set_config('app.bruker_id', :'u', false);
select faktura.slett_faktura(:'org', :'f', 'Testfaktura');
select test.er((select status || ':' || coalesce(faktura_id::text, '-') from faktura.banktransaksjoner where id = :'t'), 'uavklart:-',
               'uavklart etter at fakturaen er slettet');

\c :migrator
drop schema test cascade;
\echo '  ok'
