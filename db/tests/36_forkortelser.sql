-- Forkortelser (0061_forkortelser.sql): lages av initialene, med en ledig variant når de er i bruk
-- (tre bokstaver, så tall), kan settes selv og er unike i organisasjonen (store og små bokstaver
-- likt), og tømmes feltet, lages den på nytt. En annen organisasjon kan bruke de samme.

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
create function test.melding(_sql text) returns text language plpgsql as $$
begin
  execute _sql;
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
grant execute on all functions in schema test to public;

\c :api
select id as u from faktura.registrer_bruker('uid-fork-eier', 'eier-fork@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Forkortelser AS', '917654301') \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra) values (:'org', 'Anne', 'Berg', '2025-01-01') returning id as anne, forkortelse as f_anne \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra) values (:'org', 'Anna', 'Berg', '2025-01-01') returning id as anna, forkortelse as f_anna \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra) values (:'org', 'Arne', 'Bakke', '2025-01-01') returning forkortelse as f_arne \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra) values (:'org', 'Ane', 'Berg', '2025-01-01') returning forkortelse as f_ane \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra) values (:'org', 'Annie', 'Bergh', '2025-01-01') returning forkortelse as f_annie \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra) values (:'org', 'Kari', 'Nordmann Hansen', '2025-01-01') returning id as kari, forkortelse as f_kari \gset
select test.er(:'f_anne', 'AB', 'initialene');
select test.er(:'f_anna', 'ABE', 'tre bokstaver når AB er i bruk');
select test.er(:'f_arne', 'ABA', 'fra etternavnet');
select test.er(:'f_ane', 'ANB', 'fra fornavnet');
select test.er(:'f_annie', 'AB2', 'med tall til slutt');
select test.er(:'f_kari', 'KN', 'første ord i etternavnet');

-- Satt selv: unik uten hensyn til store og små bokstaver, og feilmeldingen sier hvem som har den.
update faktura.ansatte set forkortelse = ' kh ' where id = :'kari';
select test.er((select forkortelse from faktura.ansatte where id = :'kari'), 'kh', 'satt selv (uten mellomrom)');
select test.er(test.melding(format($$update faktura.ansatte set forkortelse = 'KH' where id = %L$$, :'anne')), 'FA409: Forkortelsen «KH» er i bruk av Kari Nordmann Hansen', 'i bruk');
select test.er(test.melding(format($$insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, forkortelse) values (%L, 'Per', 'Ny', '2025-01-01', 'ab')$$, :'org')),
               'FA409: Forkortelsen «ab» er i bruk av Anne Berg', 'også for en ny person');
select test.er(left(test.melding(format($$update faktura.ansatte set forkortelse = 'ABCDEFG' where id = %L$$, :'anne')), 5), '23514', 'høyst seks tegn');
-- Tømt: lages på nytt (KN er ledig igjen).
update faktura.ansatte set forkortelse = '' where id = :'kari';
select test.er((select forkortelse from faktura.ansatte where id = :'kari'), 'KN', 'tømt: initialene igjen');
-- Andre endringer rører den ikke.
update faktura.ansatte set stilling = 'Sekretær' where id = :'anna';
select test.er((select forkortelse from faktura.ansatte where id = :'anna'), 'ABE', 'uendret');

-- En annen organisasjon kan bruke de samme.
select id as org2 from faktura.opprett_organisasjon('Andre Forkortelser AS', '923609016') \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra) values (:'org2', 'Anne', 'Berg', '2025-01-01') returning forkortelse as f_andre \gset
select test.er(:'f_andre', 'AB', 'egne forkortelser i hver organisasjon');

\c :migrator
select test.er((select count(*) from faktura.ansatte where forkortelse is null), 0::bigint, 'alle har en forkortelse');
drop schema test cascade;
\echo '  ok'
