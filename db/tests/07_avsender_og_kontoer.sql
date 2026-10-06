-- Avsender for ENK, privatperson og flere kontonumre (0016_avsender_og_kontoer.sql).

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
select id as u from faktura.registrer_bruker('uid-enk', 'enk@test.no') \gset
select set_config('app.bruker_id', :'u', false);

-- ENK: firmanavn som standard, innehaver per faktura.
select id as org from faktura.opprett_organisasjon('Nordmann Snekkerservice', '923609016') \gset
update faktura.organisasjoner set kontonr = '86011117947', innehaver = 'Ola Nordmann' where id = :'org';
insert into faktura.kontoer (org_id, navn, kontonr) values (:'org', 'Husleiekonto', '12345678903') returning id as konto \gset
insert into faktura.kunder (org_id, navn) values (:'org', 'Kunde') returning id as k \gset

insert into faktura.fakturaer (org_id, kunde_id) values (:'org', :'k') returning id as f1 \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, enhetspris) values (:'org', :'f1', 'Arbeid', 100);
select faktura.utsted(:'f1');
select test.er((select selger ->> 'navn' from faktura.fakturaer where id = :'f1'), 'Nordmann Snekkerservice', 'firmanavn som standard');
select test.er((select selger ->> 'kontonr' from faktura.fakturaer where id = :'f1'), '86011117947', 'standardkonto');

insert into faktura.fakturaer (org_id, kunde_id, avsender, konto_id) values (:'org', :'k', 'innehaver', :'konto') returning id as f2 \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, enhetspris) values (:'org', :'f2', 'Husleie', 100);
select faktura.utsted(:'f2');
select test.er((select selger ->> 'navn' from faktura.fakturaer where id = :'f2'), 'Ola Nordmann', 'innehaver som avsender');
select test.er((select selger ->> 'orgnr' from faktura.fakturaer where id = :'f2'), '923609016', 'org.nr. står fortsatt');
select test.er((select selger ->> 'kontonr' from faktura.fakturaer where id = :'f2'), '12345678903', 'valgt konto');

-- Kreditnota arver avsender og konto.
select id as kn from faktura.krediter(:'f2') \gset
select test.er((select selger ->> 'navn' from faktura.fakturaer where id = :'kn'), 'Ola Nordmann', 'kreditnota arver avsender');
select test.er((select selger ->> 'kontonr' from faktura.fakturaer where id = :'kn'), '12345678903', 'kreditnota arver konto');

-- Gjentakelse med egen konto gir fakturaer til den kontoen.
insert into faktura.gjentakelser (org_id, kunde_id, linjer, forfall_dag, neste_forfall, konto_id)
values (:'org', :'k', '[{"beskrivelse": "Leie", "enhetspris": 100}]', 1, faktura.i_dag(), :'konto') returning id as g \gset
select faktura.lag_fra_gjentakelse(:'g') as f3 \gset
select faktura.utsted(:'f3');
select test.er((select selger ->> 'kontonr' from faktura.fakturaer where id = :'f3'), '12345678903', 'gjentakelsens konto');

-- Privatperson: ingen org.nr. eller mva, selv om det forsøkes satt.
select id as priv from faktura.opprett_organisasjon('Kari Privat', null, 'privatperson') \gset
update faktura.organisasjoner set kontonr = '86011117947', orgnr = '923609016', mva_registrert = true where id = :'priv';
select test.er((select orgnr is null and not mva_registrert from faktura.organisasjoner where id = :'priv'), true, 'privatperson uten org.nr. og mva');

-- En annen organisasjons konto kan ikke brukes.
select id as annen from faktura.opprett_organisasjon('Annen AS') \gset
insert into faktura.kunder (org_id, navn) values (:'annen', 'Kunde') returning id as k2 \gset
select set_config('test.annen', :'annen', false), set_config('test.k2', :'k2', false), set_config('test.konto', :'konto', false);
do $$ begin
  insert into faktura.fakturaer (org_id, kunde_id, konto_id) values (current_setting('test.annen')::uuid, current_setting('test.k2')::uuid, current_setting('test.konto')::uuid);
  raise exception 'FEIL: fremmed konto ble godtatt';
exception when foreign_key_violation then null;
end $$;

\c :migrator
drop schema test cascade;
\echo '  ok'
