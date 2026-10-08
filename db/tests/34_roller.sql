-- Roller (0056_roller.sql): en rolle kan være for dem som ikke er ansatt (f.eks. leger som er
-- aksjonærer). Om personen er ansatt, følger rollen: når personen får en rolle, når rollen
-- endres, og når den slettes. De som ikke er ansatt, er i ansattregisteret, men ikke i
-- feriebanken, og API-et kan ikke sette det selv. Kunder kan hentes inn som rollehavere (0058).

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

-- Med på tavla (0057_rolle_tavle.sql): plasser for dem med en rolle utenfor tavla lages ikke, og
-- plassene deres fra i dag av forsvinner når de får en slik rolle, eller rollen tas ut.
insert into faktura.ansattgrupper (org_id, navn, tavle) values (:'org', 'Overlege', false) returning id as overlege \gset
insert into faktura.tavle_faser (org_id, navn) values (:'org', 'Dag') returning id as fase \gset
insert into faktura.tavle_oppgaver (org_id, navn) values (:'org', 'Resepsjon') returning id as opp \gset
select (faktura.i_dag() + 7) as neste \gset
insert into faktura.tavle_plasseringer (org_id, dato, fase_id, oppgave_id, ansatt_id) values (:'org', :'neste', :'fase', :'opp', :'ola');
select test.er((select count(*) from faktura.tavle_plasseringer where ansatt_id = :'ola'), 1::bigint, 'Ola er plassert');
update faktura.ansatte set gruppe_id = :'overlege' where id = :'ola';
select test.er((select count(*) from faktura.tavle_plasseringer where ansatt_id = :'ola'), 0::bigint, 'med en rolle utenfor tavla forsvinner plassen');
insert into faktura.tavle_plasseringer (org_id, dato, fase_id, oppgave_id, ansatt_id) values (:'org', :'neste', :'fase', :'opp', :'ola');
select test.er((select count(*) from faktura.tavle_plasseringer where ansatt_id = :'ola'), 0::bigint, 'og en ny plass lages ikke');
update faktura.ansattgrupper set tavle = true where id = :'overlege';
insert into faktura.tavle_plasseringer (org_id, dato, fase_id, oppgave_id, ansatt_id) values (:'org', :'neste', :'fase', :'opp', :'ola');
select test.er((select count(*) from faktura.tavle_plasseringer where ansatt_id = :'ola'), 1::bigint, 'med rollen på tavla igjen kan han plasseres');
update faktura.ansattgrupper set tavle = false where id = :'overlege';
select test.er((select count(*) from faktura.tavle_plasseringer where ansatt_id = :'ola'), 0::bigint, 'rollen tas ut av tavla');
-- Den faste oppgaven (0059_tavle_fast_oppgave.sql) forsvinner også når rollen tas ut av tavla, og
-- når personen får en rolle som ikke er med.
update faktura.ansattgrupper set tavle = true where id = :'overlege';
insert into faktura.tavle_fast_oppgave (org_id, ansatt_id, oppgave_id) values (:'org', :'ola', :'opp');
update faktura.ansattgrupper set tavle = false where id = :'overlege';
select test.er((select count(*) from faktura.tavle_fast_oppgave where ansatt_id = :'ola'), 0::bigint, 'uten tavla, ingen fast oppgave');
update faktura.ansatte set gruppe_id = null where id = :'ola';
insert into faktura.tavle_fast_oppgave (org_id, ansatt_id, oppgave_id) values (:'org', :'ola', :'opp');
update faktura.ansatte set gruppe_id = :'overlege' where id = :'ola';
select test.er((select count(*) from faktura.tavle_fast_oppgave where ansatt_id = :'ola'), 0::bigint, 'en rolle utenfor tavla tar den faste oppgaven');

-- Kunder som rollehavere (0058_kunder_som_rollehavere.sql): personen kobles til en kunde i samme
-- organisasjon, og slettes kunden, står personen uten kobling.
insert into faktura.kunder (org_id, navn) values (:'org', 'Lise Lege') returning id as kunde \gset
update faktura.ansatte set kunde_id = :'kunde' where id = :'lise';
select test.er((select kunde_id from faktura.ansatte where id = :'lise'), :'kunde'::uuid, 'Lise er koblet til kunden');
select id as org2 from faktura.opprett_organisasjon('Andre Roller AS', '923609016') \gset
insert into faktura.kunder (org_id, navn) values (:'org2', 'Kunde hos andre') returning id as kunde2 \gset
select test.feiler(format($$update faktura.ansatte set kunde_id = %L where id = %L$$, :'kunde2', :'lise'), '23503');
delete from faktura.kunder where id = :'kunde';
select test.er((select kunde_id from faktura.ansatte where id = :'lise'), null::uuid, 'uten kunden er Lise uten kobling');

\c :migrator
drop schema test cascade;
\echo '  ok'
