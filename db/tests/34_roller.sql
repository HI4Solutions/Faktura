-- Roller (0056_roller.sql): en rolle kan være for dem som ikke er ansatt (f.eks. leger som er
-- aksjonærer). Om personen er ansatt, følger rollen: når personen får en rolle, når rollen
-- endres, og når den slettes. De som ikke er ansatt, er i ansattregisteret, men ikke i
-- feriebanken, og API-et kan ikke sette det selv.

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
select id as u from faktura.registrer_bruker('uid-rolle-db', 'eier-rolle@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Roller AS', '917654174') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
insert into faktura.ansattgrupper (org_id, navn, ikke_ansatt) values (:'org', 'Lege', true) returning id as lege \gset
insert into faktura.ansattgrupper (org_id, navn) values (:'org', 'Sekretær') returning id as sek \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, gruppe_id) values (:'org', 'Ola', 'Ansatt', '2025-01-01', :'sek') returning id as ola \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, gruppe_id) values (:'org', 'Lise', 'Lege', '2025-01-01', :'lege') returning id as lise \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra) values (:'org', 'Uten', 'Rolle', '2025-01-01') returning id as uten \gset

select test.er((select arbeidstaker from faktura.ansatte where id = :'ola'), true, 'sekretæren er ansatt');
select test.er((select arbeidstaker from faktura.ansatte where id = :'lise'), false, 'legen er ikke ansatt');
select test.er((select arbeidstaker from faktura.ansatte where id = :'uten'), true, 'uten rolle er man ansatt');
select test.feiler(format($$update faktura.ansatte set arbeidstaker = false where id = %L$$, :'ola'), '42501');
select (extract(year from faktura.i_dag())::int) as i_aar \gset
select test.er((select array_agg(navn order by navn) from faktura.feriebank(:'org', :i_aar)), array['Ola Ansatt', 'Uten Rolle'], 'feriebanken har bare de ansatte');

-- En annen rolle, rollen endres, og rollen slettes.
update faktura.ansatte set gruppe_id = :'lege' where id = :'ola';
select test.er((select arbeidstaker from faktura.ansatte where id = :'ola'), false, 'Ola som lege er ikke ansatt');
update faktura.ansattgrupper set ikke_ansatt = false where id = :'lege';
select test.er((select count(*) from faktura.ansatte where gruppe_id = :'lege' and arbeidstaker), 2::bigint, 'legene er ansatt når rollen er for ansatte');
update faktura.ansattgrupper set ikke_ansatt = true where id = :'lege';
select test.er((select count(*) from faktura.ansatte where gruppe_id = :'lege' and not arbeidstaker), 2::bigint, 'og ikke ansatt igjen');
delete from faktura.ansattgrupper where id = :'lege';
select test.er((select count(*) from faktura.ansatte where org_id = :'org' and not arbeidstaker), 0::bigint, 'uten rollen er alle ansatt');
select test.er((select count(*) from faktura.feriebank(:'org', :i_aar)), 3::bigint, 'og i feriebanken');

\c :migrator
drop schema test cascade;
\echo '  ok'
