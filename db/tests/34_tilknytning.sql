-- Tilknytning (0054_tilknytning.sql): de som ikke er ansatt (eier eller aksjonær, selvstendig,
-- innleid), er i ansattregisteret, men ikke i feriebanken. Bare de kjente verdiene godtas, og
-- standarden er ansatt.

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
select id as u from faktura.registrer_bruker('uid-tilk-db', 'eier-tilk@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Tilknytning AS', '917654174') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra) values (:'org', 'Ola', 'Ansatt', '2025-01-01') returning id as ola \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, tilknytning) values (:'org', 'Lise', 'Aksjonær', '2025-01-01', 'eier') returning id as lise \gset

select test.er((select tilknytning from faktura.ansatte where id = :'ola'), 'ansatt', 'standarden er ansatt');
select test.feiler(format($$insert into faktura.ansatte (org_id, fornavn, etternavn, tilknytning) values (%L, 'X', 'Y', 'frilanser')$$, :'org'), '23514');
select (extract(year from faktura.i_dag())::int) as i_aar \gset
select test.er((select array_agg(navn) from faktura.feriebank(:'org', :i_aar)), array['Ola Ansatt'], 'feriebanken har bare de ansatte');
update faktura.ansatte set tilknytning = 'ansatt' where id = :'lise';
select test.er((select count(*) from faktura.feriebank(:'org', :i_aar)), 2::bigint, 'som ansatt er Lise med');

\c :migrator
drop schema test cascade;
\echo '  ok'
