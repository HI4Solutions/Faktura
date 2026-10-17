-- Sletting når oppbevaringstiden er ute (0124_slett_utlopt.sql): en stengt organisasjon slettes helt
-- av workeren når oppbevares_til er passert – fakturaene, bilagene, lønnen og alt annet, også
-- revisjonsloggen og utboksen. Raden i slettede_organisasjoner blir stående uten navnet og
-- e-postadressen til den som slettet. Filene i Cloud Storage følges opp til de er borte.
--
-- Testen går sist: til slutt stenges og slettes alle organisasjonene de andre testene har laget (i en
-- transaksjon som rulles tilbake), og ingen rad med org_id kan bli igjen. Slik oppdages en ny tabell
-- eller en ny lås på bokført materiale som slettingen ikke tar høyde for.

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
-- Radene med org_id (eller en annen kolonne som viser til en organisasjon) som finnes for
-- organisasjonene i _org, tabell for tabell.
create function test.rester(_org uuid[]) returns text language plpgsql as $$
declare
  k record;
  n bigint;
  ut text[] := '{}';
begin
  for k in
    select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
     where c.table_schema = 'faktura' and c.data_type = 'uuid'
       and (c.column_name in ('org_id', 'klient_org_id', 'byraa_org_id') or (c.table_name = 'organisasjoner' and c.column_name = 'id'))
     order by 1, 2
  loop
    execute format('select count(*) from faktura.%I where %I = any($1)', k.table_name, k.column_name) into n using _org;
    if n > 0 then ut := ut || format('%s.%s: %s', k.table_name, k.column_name, n); end if;
  end loop;
  return nullif(array_to_string(ut, ', '), '');
end $$;
grant execute on all functions in schema test to public;

\c :api
select id as eier from faktura.registrer_bruker('uid-utlopt-eier', 'utlopt-eier@test.no', 'Una Utløpt') \gset
select set_config('app.bruker_id', :'eier', false);

-- Et foretak med en utstedt og betalt faktura, et utkast og et manuelt bilag.
select id as org from faktura.opprett_organisasjon('Utløpt AS', '315000211') \gset
update faktura.organisasjoner set kontonr = '86011117947' where id = :'org';
insert into faktura.kunder (org_id, navn) values (:'org', 'Kari Kunde') returning id as k \gset
insert into faktura.fakturaer (org_id, kunde_id) values (:'org', :'k') returning id as f \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, enhetspris, mva_sats) values (:'org', :'f', 'Rådgivning', 1000, 25);
select faktura.utsted(:'f');
select faktura.registrer_betaling(:'f', 1250, faktura.i_dag(), null, 'bank', 'ref-utlopt');
insert into faktura.fakturaer (org_id, kunde_id) values (:'org', :'k');
select faktura.bokfor_manuelt(:'org', faktura.i_dag(), 'Inngående balanse',
  '[{"konto": "1920", "belop": 5000}, {"konto": "2000", "belop": -5000}]');

-- En privatperson med en utstedt faktura.
select id as priv from faktura.opprett_organisasjon('Pia Privat', null, 'privatperson') \gset
update faktura.organisasjoner set kontonr = '86011117947' where id = :'priv';
insert into faktura.kunder (org_id, navn) values (:'priv', 'Nabo') returning id as pk \gset
insert into faktura.fakturaer (org_id, kunde_id) values (:'priv', :'pk') returning id as pf \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, enhetspris) values (:'priv', :'pf', 'Hagearbeid', 500);
select faktura.utsted(:'pf');

-- Begge stenges, og materialet oppbevares.
select test.er((faktura.slett_organisasjon(:'org', 'Virksomheten er avviklet')).oppbevares_til,
               make_date(extract(year from faktura.i_dag())::int + 5, 12, 31), 'oppbevares i fem år');
select faktura.slett_organisasjon(:'priv', 'Trenger det ikke mer');

-- Bare workeren sletter.
select test.feiler(format($$select faktura.slett_utlopt_materiale(%L)$$, :'org'), '42501');
select test.feiler('select faktura.utlopt_materiale()', '42501');
select test.feiler('select faktura.filer_til_sletting()', '42501');
select test.feiler(format($$select faktura.filer_slettet(%L)$$, :'org'), '42501');

-- Før oppbevaringstiden er ute, slettes ingenting.
\c :worker
select test.er((select count(*)::int from faktura.utlopt_materiale(1000) id where id in (:'org', :'priv')), 0, 'ikke utløpt ennå');
select test.feiler(format($$select faktura.slett_utlopt_materiale(%L)$$, :'org'), 'FA409');
select test.er((select count(*)::int from faktura.filer_til_sletting(1000) id where id in (:'org', :'priv')), 0, 'filene står');
select test.feiler(format($$select faktura.filer_slettet(%L)$$, :'org'), 'FA409');

-- Tiden går: oppbevaringstiden er ute i går.
\c :migrator
update faktura.organisasjoner set oppbevares_til = faktura.i_dag() - 1 where id in (:'org', :'priv');
update faktura.slettede_organisasjoner set oppbevares_til = faktura.i_dag() - 1 where id in (:'org', :'priv');
select test.er(test.rester(array[:'org']::uuid[]) is not null, true, 'materialet er der før slettingen');

\c :worker
select test.er((select array_agg(id order by id) from faktura.utlopt_materiale(1000) id where id in (:'org', :'priv')),
               (select array_agg(id order by id) from unnest(array[:'org', :'priv']::uuid[]) id), 'begge er utløpt');
select test.er(faktura.slett_utlopt_materiale(:'org'),
               jsonb_build_object('navn', 'Utløpt AS', 'fakturaer', 1, 'bilag', 1, 'lonnskjoringer', 0), 'det som ble slettet');
select faktura.slett_utlopt_materiale(:'priv');
select test.feiler(format($$select faktura.slett_utlopt_materiale(%L)$$, :'org'), 'FA404');
select test.er((select count(*)::int from faktura.utlopt_materiale(1000) id where id in (:'org', :'priv')), 0, 'ingen igjen');

\c :migrator
select test.er(test.rester(array[:'org', :'priv']::uuid[]), null, 'ingen rader igjen');
select test.er((select count(*)::int from faktura.revisjonslogg where org_id in (:'org', :'priv')), 0, 'revisjonsloggen er borte');
select test.er((select count(*)::int from faktura.utboks where org_id in (:'org', :'priv')), 0, 'utboksen er borte');
-- Loggen over slettingen står, uten den som slettet, og uten navnet til privatpersonen.
select test.er((select string_agg(concat_ws('|', navn, orgnr, grunn, antall_fakturaer, slettet_av_navn, slettet_av_epost,
                                             materiale_slettet_at is not null, filer_slettet_at is not null), ';' order by navn)
                  from faktura.slettede_organisasjoner where id in (:'org', :'priv')),
               'Privatperson|Trenger det ikke mer|1|t|f;Utløpt AS|315000211|Virksomheten er avviklet|1|t|f',
               'loggen etter slettingen');
select test.er((select slettet_av from faktura.slettede_organisasjoner where id = :'org'), :'eier'::uuid, 'hvem som slettet (id-en) står');

-- Filene i Cloud Storage følges opp til de er borte.
\c :worker
select test.er((select count(*)::int from faktura.filer_til_sletting(1000) id where id in (:'org', :'priv')), 2, 'filene skal slettes');
select faktura.filer_slettet(:'org');
select test.er((select array_agg(id) from faktura.filer_til_sletting(1000) id where id in (:'org', :'priv')), array[:'priv']::uuid[], 'bare privatpersonen igjen');
select faktura.filer_slettet(:'priv');

-- Alle organisasjonene de andre testene har laget, med alt de har ført: stenges eller slettes,
-- og slettes helt når oppbevaringstiden er ute. Ingenting kan bli igjen, og ingen lås kan stoppe
-- det. Rulles tilbake, så servertestene etterpå har dataene som før.
\c :migrator
begin;
set constraints all immediate;
select coalesce(array_agg(id), '{}') as alle from faktura.organisasjoner \gset
select count(*) from (select faktura.slett_organisasjon(id, 'Testen av slettingen') from faktura.organisasjoner where slettet_at is null order by id) x;
update faktura.organisasjoner set oppbevares_til = faktura.i_dag() - 1;
select count(*) from (select faktura.slett_utlopt_materiale(id) from faktura.utlopt_materiale(100000) id) x;
-- Workerens siste steg (filene) tar også det som er igjen i utboksen.
select count(*) from (select faktura.filer_slettet(id) from faktura.filer_til_sletting(100000) id) x;
select test.er((select count(*)::int from faktura.organisasjoner), 0, 'alle organisasjonene er slettet');
select test.er(test.rester(:'alle'::uuid[]), null, 'ingen rader igjen etter noen organisasjon');
rollback;

drop schema test cascade;
\echo '  ok'
