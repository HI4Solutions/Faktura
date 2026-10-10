-- Månedsavslutningen (0092_maanedsavslutning.sql): automatikken er på som standard og kan slås av av
-- den som fører regnskapet, men måneden den gjelder fra (maaned_fra, den første i en måned) setter
-- bare workeren; avslutningene lagres bare av workeren (én per organisasjon og måned, med
-- sjekklisten som en liste), den som fører regnskapet ser dem, og fakturerer verken ser dem eller
-- endrer oppsettet.

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
select id as u from faktura.registrer_bruker('uid-ma-eier', 'eier-ma@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Månedsavslutning AS', '915000428') \gset
select id as org2 from faktura.opprett_organisasjon('Annen AS', null) \gset
select faktura.inviter_medlem(:'org', 'fakt-ma@test.no', 'fakturerer') as t_fakt \gset
select id as u_fakt from faktura.registrer_bruker('uid-ma-fakt', 'fakt-ma@test.no') \gset
select set_config('app.bruker_id', :'u_fakt', false);
select faktura.aksepter_invitasjon(:'t_fakt');
select set_config('app.bruker_id', :'u', false);

-- Automatikken er på som standard, og den som fører regnskapet kan slå den av og på.
insert into faktura.regnskap_oppsett (org_id) values (:'org');
select test.er((select row(maaned_auto, maaned_fra)::text from faktura.regnskap_oppsett where org_id = :'org'), row(true, null::date)::text, 'standarden');
update faktura.regnskap_oppsett set maaned_auto = false where org_id = :'org';
select test.er((select maaned_auto from faktura.regnskap_oppsett where org_id = :'org'), false, 'slått av');
update faktura.regnskap_oppsett set maaned_auto = true where org_id = :'org';
-- API-et setter ikke måneden automatikken gjelder fra, og lagrer ikke avslutninger.
select test.feiler(format($$update faktura.regnskap_oppsett set maaned_fra = '2026-09-01' where org_id = %L$$, :'org'), '42501');
select test.feiler(format($$insert into faktura.maanedsavslutninger (org_id, maaned) values (%L, '2026-09-01')$$, :'org'), '42501');

\c :worker
update faktura.regnskap_oppsett set maaned_fra = '2026-09-01' where org_id = :'org';
select test.er((select maaned_fra from faktura.regnskap_oppsett where org_id = :'org'), '2026-09-01'::date, 'workeren setter måneden');
select test.feiler(format($$update faktura.regnskap_oppsett set maaned_fra = '2026-09-02' where org_id = %L$$, :'org'), '23514');
-- Workeren lager oppsettet når det ikke finnes (månedsavslutningen setter måneden første gang).
insert into faktura.regnskap_oppsett (org_id, maaned_fra) values (:'org2', '2026-09-01');
select test.er((select row(maaned_auto, maaned_fra)::text from faktura.regnskap_oppsett where org_id = :'org2'), row(true, '2026-09-01'::date)::text, 'oppsettet laget av workeren');

insert into faktura.maanedsavslutninger (org_id, maaned, punkter, varslet)
values (:'org', '2026-09-01', '[{"nokkel": "bank", "navn": "Bankpostene", "ok": true, "tekst": "Alle bankpostene er ført.", "lenke": "/regnskap?fane=bank"}]', true);
-- Én per organisasjon og måned, den første i måneden, og sjekklisten er en liste.
select test.feiler(format($$insert into faktura.maanedsavslutninger (org_id, maaned) values (%L, '2026-09-01')$$, :'org'), '23505');
select test.feiler(format($$insert into faktura.maanedsavslutninger (org_id, maaned) values (%L, '2026-08-15')$$, :'org'), '23514');
select test.feiler(format($$insert into faktura.maanedsavslutninger (org_id, maaned, punkter) values (%L, '2026-08-01', '{}')$$, :'org'), '23514');
select test.feiler(format($$update faktura.maanedsavslutninger set org_id = %L where org_id = %L$$, :'org2', :'org'), '42501');
update faktura.maanedsavslutninger set sperret = 'Noe fra før mangler', varslet = false where org_id = :'org' and maaned = '2026-09-01';

\c :api
select set_config('app.bruker_id', :'u', false);
select test.er((select row(sperret, varslet, jsonb_array_length(punkter))::text from faktura.maanedsavslutninger where org_id = :'org'),
               row('Noe fra før mangler', false, 1)::text, 'eieren ser avslutningen');
select test.feiler(format($$update faktura.maanedsavslutninger set varslet = true where org_id = %L$$, :'org'), '42501');
select test.feiler(format($$delete from faktura.maanedsavslutninger where org_id = %L$$, :'org'), '42501');

-- Fakturerer ser ikke avslutningene og endrer ikke oppsettet.
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select count(*)::int from faktura.maanedsavslutninger where org_id = :'org'), 0, 'fakturerer ser ikke avslutningene');
update faktura.regnskap_oppsett set maaned_auto = false where org_id = :'org';
select set_config('app.bruker_id', :'u', false);
select test.er((select maaned_auto from faktura.regnskap_oppsett where org_id = :'org'), true, 'fakturerer endret ikke oppsettet');

\c :migrator
drop schema test cascade;
