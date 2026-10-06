-- Fakturering uten mva (0005_uten_mva.sql).

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

\c :api
select id as u from faktura.registrer_bruker('uid-mva', 'mva@test.no') \gset
select set_config('app.bruker_id', :'u', false);

-- Uten mva fra start.
select id as org from faktura.opprett_organisasjon('Uten Mva AS') \gset
update faktura.organisasjoner set kontonr = '86011117947', mva_registrert = false where id = :'org';
insert into faktura.produkter (org_id, navn, enhetspris, mva_sats) values (:'org', 'Tjeneste', 1000, 25) returning id as p, mva_sats as p_mva \gset
select test.er(:p_mva::numeric, 0::numeric, 'produkt får 0 % mva');
insert into faktura.kunder (org_id, navn) values (:'org', 'Kunde') returning id as k \gset
insert into faktura.fakturaer (org_id, kunde_id) values (:'org', :'k') returning id as f \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, antall, enhetspris, mva_sats) values (:'org', :'f', 'Tjeneste', 2, 1000, 25);
select test.er((select mva from faktura.utsted(:'f')), 0::numeric, 'faktura uten mva');
select test.er((select sum_inkl_mva from faktura.fakturaer where id = :'f'), 2000::numeric, 'sum uten mva');

-- Fra mva-registrert til uten mva: produkter, utkast og gjentakelser oppdateres; utstedte rører vi ikke.
select id as org2 from faktura.opprett_organisasjon('Bytter AS') \gset
update faktura.organisasjoner set kontonr = '86011117947', mva_registrert = true where id = :'org2';
insert into faktura.produkter (org_id, navn, enhetspris, mva_sats) values (:'org2', 'Vare', 100, 25) returning id as p2 \gset
insert into faktura.kunder (org_id, navn) values (:'org2', 'Kunde') returning id as k2 \gset
insert into faktura.fakturaer (org_id, kunde_id) values (:'org2', :'k2') returning id as utstedt \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, enhetspris, mva_sats) values (:'org2', :'utstedt', 'Vare', 100, 25);
select faktura.utsted(:'utstedt');
insert into faktura.fakturaer (org_id, kunde_id) values (:'org2', :'k2') returning id as utkast \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, enhetspris, mva_sats) values (:'org2', :'utkast', 'Vare', 100, 25);
insert into faktura.gjentakelser (org_id, kunde_id, linjer, forfall_dag, neste_forfall)
values (:'org2', :'k2', '[{"beskrivelse": "Abo", "enhetspris": 100, "mva_sats": 25}]', 1, '2030-01-01') returning id as g \gset

update faktura.organisasjoner set mva_registrert = false where id = :'org2';
select test.er((select mva_sats from faktura.produkter where id = :'p2'), 0::numeric, 'produkt endres');
select test.er((select mva_sats from faktura.faktura_linjer where faktura_id = :'utkast'), 0::numeric, 'utkast endres');
select test.er((select (linjer -> 0 ->> 'mva_sats')::numeric from faktura.gjentakelser where id = :'g'), 0::numeric, 'gjentakelse endres');
select test.er((select mva from faktura.fakturaer where id = :'utstedt'), 25::numeric, 'utstedt faktura er uendret');

-- Kreditnota for en faktura sendt med mva beholder mva.
select test.er((select mva from faktura.krediter(:'utstedt')), -25::numeric, 'kreditnota beholder mva');

\c :migrator
drop schema test cascade;
\echo '  ok'
