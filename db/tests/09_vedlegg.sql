-- Vedlegg på fakturaer (0023_vedlegg.sql): lastes opp uten faktura, kobles til et utkast,
-- låses når fakturaen utstedes, og filene til slettede vedlegg ryddes av workeren.

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
select id as u from faktura.registrer_bruker('uid-vedlegg', 'vedlegg@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Vedlegg AS', '923609016') \gset
update faktura.organisasjoner set kontonr = '86011117947' where id = :'org';
insert into faktura.kunder (org_id, navn, epost) values (:'org', 'Kunde', 'kunde@test.no') returning id as k \gset
insert into faktura.fakturaer (org_id, kunde_id) values (:'org', :'k') returning id as f \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, enhetspris) values (:'org', :'f', 'Arbeid', 100);

-- Opplastet fil: står uten faktura, og registrerer hvem som lastet den opp.
insert into faktura.vedlegg (org_id, filnavn, type, storrelse, sti)
values (:'org', 'Timeliste.pdf', 'application/pdf', 1200, 'org/vedlegg/1') returning id as v1 \gset
insert into faktura.vedlegg (org_id, filnavn, type, storrelse, sti)
values (:'org', 'Kvittering.jpg', 'image/jpeg', 800, 'org/vedlegg/2') returning id as v2 \gset
select test.er((select opprettet_av from faktura.vedlegg where id = :'v1'), :'u'::uuid, 'opplastet av');
select set_config('test.org', :'org', false), set_config('test.f', :'f', false), set_config('test.v1', :'v1', false);
do $$ begin
  insert into faktura.vedlegg (org_id, filnavn, type, storrelse, sti)
  values (current_setting('test.org')::uuid, 'side.html', 'text/html', 10, 'org/vedlegg/x');
  raise exception 'FEIL: HTML ble godtatt som vedlegg';
exception when check_violation then null;
end $$;
do $$ begin
  insert into faktura.vedlegg (org_id, faktura_id, filnavn, type, storrelse, sti)
  values (current_setting('test.org')::uuid, current_setting('test.f')::uuid, 'a.pdf', 'application/pdf', 10, 'org/vedlegg/y');
  raise exception 'FEIL: vedlegg ble lagt rett på en faktura';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  update faktura.vedlegg set sti = 'annen/fil' where id = current_setting('test.v1')::uuid;
  raise exception 'FEIL: filen til et vedlegg kunne byttes';
exception when insufficient_privilege then null;
end $$;

-- Kobles til utkastet; et vedlegg som fjernes fra utkastet, blir en fil som skal slettes.
update faktura.vedlegg set faktura_id = :'f', rekke = 0 where id = :'v1';
update faktura.vedlegg set faktura_id = :'f', rekke = 1 where id = :'v2';
select test.er((select count(*)::int from faktura.vedlegg where faktura_id = :'f'), 2, 'to vedlegg på utkastet');
delete from faktura.vedlegg where id = :'v2';

-- Utstedt: vedleggene kan verken fjernes, flyttes eller legges til.
select faktura.utsted(:'f');
delete from faktura.vedlegg where id = :'v1';
update faktura.vedlegg set rekke = 5 where id = :'v1';
select test.er((select rekke from faktura.vedlegg where id = :'v1'), 0, 'vedlegget på utstedt faktura er uendret');
insert into faktura.vedlegg (org_id, filnavn, type, storrelse, sti)
values (:'org', 'Sent.pdf', 'application/pdf', 10, 'org/vedlegg/3') returning id as v3 \gset
select set_config('test.v3', :'v3', false);
do $$ begin
  update faktura.vedlegg set faktura_id = current_setting('test.f')::uuid where id = current_setting('test.v3')::uuid;
  if found then raise exception 'FEIL: vedlegg ble lagt på en utstedt faktura'; end if;
exception when insufficient_privilege or sqlstate 'FA409' then null;
end $$;
do $$ begin
  perform faktura.arkiver_vedlegg(current_setting('test.v1')::uuid, 'arkiv/1');
  raise exception 'FEIL: API-et kunne sette arkivkopien';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform count(*) from faktura.slettede_filer;
  raise exception 'FEIL: API-et kunne lese filer som skal slettes';
exception when insufficient_privilege then null;
end $$;

-- Utkast som slettes, tar vedleggene med seg.
insert into faktura.fakturaer (org_id, kunde_id) values (:'org', :'k') returning id as f2 \gset
insert into faktura.vedlegg (org_id, filnavn, type, storrelse, sti)
values (:'org', 'Avtale.pdf', 'application/pdf', 10, 'org/vedlegg/4') returning id as v4 \gset
update faktura.vedlegg set faktura_id = :'f2' where id = :'v4';
delete from faktura.fakturaer where id = :'f2';

-- En annen organisasjon ser ingenting.
select id as u2 from faktura.registrer_bruker('uid-vedlegg-2', 'annen@test.no') \gset
select set_config('app.bruker_id', :'u2', false);
select test.er((select count(*)::int from faktura.vedlegg), 0, 'andre ser ikke vedleggene');
select set_config('app.bruker_id', :'u', false);

-- Låsen gjelder også tabelleieren.
\c :migrator
select set_config('test.v1', :'v1', false);
do $$ begin
  delete from faktura.vedlegg where id = current_setting('test.v1')::uuid;
  raise exception 'FEIL: vedlegg på utstedt faktura ble slettet';
exception when sqlstate 'FA409' then null;
end $$;
-- Ikke lagret på en faktura på to døgn: ryddes.
update faktura.vedlegg set opprettet = now() - interval '3 days' where id = :'v3';

\c :worker
select faktura.arkiver_vedlegg(:'v1', 'arkiv/1');
select test.er((select arkiv_sti from faktura.vedlegg where id = :'v1'), 'arkiv/1', 'arkivkopi satt av workeren');
select test.er(faktura.rydd_vedlegg(), 1, 'én gammel opplasting ryddet');
select test.er((select array_agg(sti order by sti) from faktura.slettede_filer), '{org/vedlegg/2,org/vedlegg/3,org/vedlegg/4}'::text[], 'filer som skal slettes');
delete from faktura.slettede_filer;
select test.er((select count(*)::int from faktura.vedlegg where org_id = :'org'), 1, 'vedlegget på den utstedte fakturaen står');

\c :migrator
select test.er((select count(*)::int from faktura.revisjonslogg where tabell = 'vedlegg' and rad_id = :'v1'), 3, 'opplasting, kobling og arkivkopi i revisjonsloggen');
drop schema test cascade;
\echo '  ok'
