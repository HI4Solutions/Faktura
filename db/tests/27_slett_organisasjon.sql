-- Sletting av organisasjoner (0046_slett_organisasjon.sql): bare eieren eller plattform-
-- administratoren, alltid med grunn. Uten utstedte fakturaer slettes alt (også filene og
-- revisjonsloggen); med utstedte fakturaer stenges organisasjonen: ingen har tilgang, utkast,
-- gjentakelser, påminnelser og purring stopper, funksjonene er av, og fakturaene oppbevares i
-- fem år etter regnskapsårets slutt. Begge logges med grunnen.

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
select id as eier from faktura.registrer_bruker('uid-slett-eier', 'eier-slett@test.no', 'Eli Eier') \gset
select id as fakt from faktura.registrer_bruker('uid-slett-fakt', 'fakt-slett@test.no', 'Finn Fakturerer') \gset
select set_config('app.bruker_id', :'eier', false);

-- A: uten utstedte fakturaer, men med kunder, produkter, utkast med vedlegg, gjentakelse,
-- påminnelse og ansatte.
select id as a from faktura.opprett_organisasjon('Slett Meg AS') \gset
insert into faktura.kunder (org_id, navn) values (:'a', 'Kari Kunde') returning id as ka \gset
insert into faktura.produkter (org_id, navn, enhetspris, mva_sats) values (:'a', 'Vask', 500, 25) returning id as pa \gset
insert into faktura.fakturaer (org_id, kunde_id) values (:'a', :'ka') returning id as fa \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, enhetspris, mva_sats, produkt_id) values (:'a', :'fa', 'Vask', 500, 25, :'pa');
insert into faktura.gjentakelser (org_id, kunde_id, linjer, intervall, forfall_dag, neste_forfall)
values (:'a', :'ka', '[{"beskrivelse": "Abonnement", "enhetspris": 299}]', 'maaned', 31, '2027-01-31');
insert into faktura.paaminnelser (org_id, tekst, kunde_id, produkter, intervall, dag, neste_dato)
values (:'a', 'Send faktura', :'ka', array[:'pa']::uuid[], 'maaned', 1, '2027-01-01');
insert into faktura.ansatte (org_id, fornavn, etternavn) values (:'a', 'Anne', 'Ansatt');
select faktura.inviter_medlem(:'a', 'fakt-slett@test.no', 'fakturerer') as token \gset
select set_config('app.bruker_id', :'fakt', false);
select faktura.aksepter_invitasjon(:'token');

-- B: med en utstedt faktura, et utkast og en gjentakelse.
select set_config('app.bruker_id', :'eier', false);
select id as b from faktura.opprett_organisasjon('Steng Meg AS') \gset
update faktura.organisasjoner set kontonr = '86011117947', purring_auto = true where id = :'b';
insert into faktura.kunder (org_id, navn) values (:'b', 'Berit Kunde') returning id as kb \gset
insert into faktura.fakturaer (org_id, kunde_id) values (:'b', :'kb') returning id as fb \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, enhetspris, mva_sats) values (:'b', :'fb', 'Husleie', 1000, 0);
select faktura.utsted(:'fb');
insert into faktura.fakturaer (org_id, kunde_id) values (:'b', :'kb') returning id as ub \gset
insert into faktura.gjentakelser (org_id, kunde_id, linjer, intervall, forfall_dag, neste_forfall)
values (:'b', :'kb', '[{"beskrivelse": "Leie", "enhetspris": 100}]', 'maaned', 31, '2027-01-31');

\c :migrator
update faktura.organisasjoner set logo_sti = 'slett/a/logo.png' where id = :'a';
insert into faktura.vedlegg (org_id, faktura_id, filnavn, type, storrelse, sti) values (:'a', :'fa', 'Timeliste.pdf', 'application/pdf', 100, 'slett/a/vedlegg');

\c :api
-- Bare eieren, og alltid med grunn.
select set_config('app.bruker_id', :'fakt', false);
select test.feiler(format($$select faktura.slett_organisasjon(%L, 'Vil ikke mer')$$, :'a'), 'FA403');
select set_config('app.bruker_id', :'eier', false);
select test.feiler(format($$select faktura.slett_organisasjon(%L, '   ')$$, :'a'), 'FA400');
select test.feiler(format($$select faktura.slett_organisasjon(%L, null)$$, :'a'), 'FA400');
select test.feiler(format($$select faktura.slett_organisasjon(%L, 'ok')$$, :'a'), 'FA400');

-- A slettes helt.
select test.er((faktura.slett_organisasjon(:'a', '  Bare en test  ')).oppbevares_til, null::date, 'alt slettes');
select test.er((select count(*) from faktura.mine_organisasjoner where id = :'a'), 0::bigint, 'borte for eieren');
select test.feiler(format($$select faktura.slett_organisasjon(%L, 'En gang til')$$, :'a'), 'FA404');

\c :migrator
select test.er((select count(*) from faktura.organisasjoner where id = :'a'), 0::bigint, 'organisasjonen er borte');
select test.er((select count(*) from faktura.kunder where org_id = :'a') + (select count(*) from faktura.produkter where org_id = :'a')
               + (select count(*) from faktura.fakturaer where org_id = :'a') + (select count(*) from faktura.ansatte where org_id = :'a')
               + (select count(*) from faktura.medlemmer where org_id = :'a') + (select count(*) from faktura.paaminnelser where org_id = :'a'), 0::bigint,
               'kunder, produkter, utkast, ansatte, medlemmer og påminnelser er borte');
select test.er((select count(*) from faktura.revisjonslogg where org_id = :'a'), 0::bigint, 'og revisjonsloggen');
select test.er((select array_agg(sti order by sti) from faktura.slettede_filer where sti like 'slett/a/%'), array['slett/a/logo.png', 'slett/a/vedlegg'], 'filene ryddes');
select test.er((select grunn || ' | ' || av_plattformen || ' | ' || antall_fakturaer || ' | ' || slettet_av_epost from faktura.slettede_organisasjoner where id = :'a'),
               'Bare en test | false | 0 | eier-slett@test.no', 'logget med grunnen');

-- B stenges av plattformadministratoren: fakturaen oppbevares.
\c :api
select set_config('app.bruker_id', :'fakt', false);
select set_config('app.betrodd', 'on', false);
select test.er((faktura.slett_organisasjon(:'b', 'Konkurs')).oppbevares_til,
               make_date(extract(year from faktura.i_dag())::int + 5, 12, 31), 'oppbevares til fem år etter årets slutt');
select test.er((select count(*) from faktura.admin_organisasjoner() where id = :'b'), 0::bigint, 'ikke i administrasjonens liste');
select test.er((select count(*) from jsonb_array_elements(faktura.admin_funksjoner() -> 'organisasjoner') o where o ->> 'id' = :'b'), 0::bigint, 'ikke under Funksjoner');
select test.er((select av_plattformen from faktura.slettede_organisasjoner where id = :'b'), true, 'av plattformen');
select set_config('app.betrodd', '', false);
select test.er((select count(*) from faktura.slettede_organisasjoner), 0::bigint, 'loggen er bare for plattformen');
select set_config('app.bruker_id', :'eier', false);
select test.er((select count(*) from faktura.mine_organisasjoner where id = :'b'), 0::bigint, 'ingen har tilgang');
select test.er(faktura.har_funksjon(:'b', 'gjentakende'), false, 'funksjonene er av');

\c :migrator
select test.er((select count(*) from faktura.medlemmer where org_id = :'b'), 0::bigint, 'medlemmene er fjernet');
select test.er((select status from faktura.fakturaer where id = :'fb'), 'utstedt', 'den utstedte fakturaen er der');
select test.er((select count(*) from faktura.fakturaer where id = :'ub'), 0::bigint, 'utkastet er slettet');
select test.er((select bool_or(aktiv) from faktura.gjentakelser where org_id = :'b'), false, 'gjentakelsen er stoppet');
select test.er((select purring_auto from faktura.organisasjoner where id = :'b'), false, 'purringen er stoppet');
select test.er((select slettet_grunn from faktura.organisasjoner where id = :'b'), 'Konkurs', 'med grunnen');
-- Rydd bort filradene, så workerens opprydding i andre tester ikke teller dem.
delete from faktura.slettede_filer where sti like 'slett/a/%';

drop schema test cascade;
\echo '  ok'
