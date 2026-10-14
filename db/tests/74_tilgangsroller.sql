-- Modulene (0110_moduler.sql) og de egne rollene (0111_tilgangsroller.sql): fire moduler med
-- hver sin kjerne, Faktura kan slås av, eier og administrator lager roller med modulene de gir,
-- og tilgangen i faktura.kan følger modulene (lønnsdataene etter modulen forespørselen gjelder).

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
-- Hva den innloggede kan, som tekst (lett å sammenligne): handlingene som er sanne.
create function test.kan(_org uuid) returns text language sql as $$
  select coalesce(string_agg(h, ',' order by n), '')
    from unnest(array['les', 'skriv', 'utsted', 'bokfor', 'regnskap', 'personal', 'personal_les', 'plan', 'admin', 'eier', 'medlem']) with ordinality x (h, n)
   where faktura.kan(_org, h)
$$;
grant execute on all functions in schema test to public;

-- ---------------------------------------------------------------------------
-- Modulene
-- ---------------------------------------------------------------------------

\c :api
select test.er((select string_agg(kode || ':' || kjerne || ':' || coalesce(krever, '-'), ' ' order by rekkefolge) from faktura.moduler),
               'faktura:faktura:- personal:ansatte:- lonn:lonn:personal regnskap:regnskap:-', 'fire moduler med kjerne');
select test.er((select modul from faktura.funksjoner where kode = 'vaktplan'), 'personal', 'vaktplanen er Personal');
select test.er((select modul from faktura.funksjoner where kode = 'lonn'), 'lonn', 'lønnen er Lønn');
select test.er((select krever from faktura.funksjoner where kode = 'ehf'), 'faktura', 'EHF bygger på fakturaene');
select test.er((select krever from faktura.funksjoner where kode = 'bank'), null::text, 'banken står for seg selv (regnskapet bruker den)');

select id as eier from faktura.registrer_bruker('uid-roller-eier', 'eier@roller.test') \gset
select set_config('app.bruker_id', :'eier', false);
select id as org from faktura.opprett_organisasjon('Klinikken AS', '918765018') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
select test.er(faktura.org_modulliste(:'org'), array['faktura', 'personal', 'lonn', 'regnskap'], 'alle modulene for en organisasjon uten modulvalg');
insert into faktura.kunder (org_id, navn) values (:'org', 'Pasient AS');
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, lonnstype, maanedslonn)
values (:'org', 'Kari', 'Hansen', '2026-01-01', 'maaned', 50000) returning id as kari \gset

-- Lønn tar med Personal når kontoen godkjennes.
select id as ny from faktura.registrer_bruker('uid-roller-ny', 'ny@roller.test') \gset
select set_config('app.betrodd', 'on', false);
select faktura.behandle_konto(:'ny', true, null, array['lonn']);
select test.er((select array_agg(modul order by modul) from faktura.bruker_moduler where bruker_id = :'ny'), array['lonn', 'personal'], 'Lønn tar med Personal');
select set_config('app.betrodd', '', false);

-- Plattformadministratoren slår av Faktura: fakturafunksjonene går med, banken står.
\c :api
select set_config('app.bruker_id', :'eier', false);
select set_config('app.betrodd', 'on', false);
select faktura.admin_sett_funksjon(:'org', 'faktura', false);
select test.er(faktura.har_modul(:'org', 'faktura'), false, 'Faktura er av');
select test.er(faktura.har_funksjon(:'org', 'ehf'), false, 'EHF er av med Faktura');
select test.er(faktura.har_funksjon(:'org', 'bank'), true, 'banken er på');
select test.er(faktura.org_modulliste(:'org'), array['personal', 'lonn', 'regnskap'], 'modulene uten Faktura');
select faktura.admin_sett_funksjon(:'org', 'ansatte', false);
select test.er(faktura.har_modul(:'org', 'lonn'), false, 'Lønn er av uten Personal');
select faktura.admin_sett_funksjon(:'org', 'ansatte', true);
select faktura.admin_sett_funksjon(:'org', 'faktura', true);
select test.er((select jsonb_path_query_first(faktura.admin_funksjoner(), '$.moduler[*] ? (@.kode == "lonn")') ->> 'krever'), 'personal',
               'administrasjonen ser hva modulene bygger på');
select set_config('app.betrodd', '', false);

-- ---------------------------------------------------------------------------
-- Rollene
-- ---------------------------------------------------------------------------

select id as okonomi from faktura.lagre_tilgangsrolle(:'org', null, 'Økonomiansvarlig', 'Fakturaene og regnskapet', array['regnskap', 'faktura']) \gset
select id as hr from faktura.lagre_tilgangsrolle(:'org', null, 'Personalansvarlig', null, array['personal']) \gset
select id as lonnrolle, moduler as lonnmod from faktura.lagre_tilgangsrolle(:'org', null, 'Lønnsansvarlig', null, array['lonn']) \gset
select id as tom from faktura.lagre_tilgangsrolle(:'org', null, 'Vikar', null, array[]::text[]) \gset
select test.er(:'lonnmod', '{personal,lonn}', 'Lønn tar med Personal, i modulenes rekkefølge');
select test.er((select moduler from faktura.tilgangsroller where id = :'okonomi'), array['faktura', 'regnskap'], 'modulene i rekkefølge');
select test.feiler(format($$select faktura.lagre_tilgangsrolle(%L, null, ' økonomiansvarlig ', null, '{}')$$, :'org'), 'FA409');
select test.feiler(format($$select faktura.lagre_tilgangsrolle(%L, null, 'Ukjent', null, '{bemanning}')$$, :'org'), 'FA400');
select test.feiler(format($$select faktura.lagre_tilgangsrolle(%L, null, 'X', null, '{}')$$, :'org'), 'FA400');
select test.er((select navn from faktura.lagre_tilgangsrolle(:'org', :'tom', 'Vikar uten tilgang', null, '{}')), 'Vikar uten tilgang', 'endre navnet');

-- En modul som ikke er slått på, kan ikke gis.
select set_config('app.betrodd', 'on', false);
select faktura.admin_sett_funksjon(:'org', 'regnskap', false);
select set_config('app.betrodd', '', false);
select test.feiler(format($$select faktura.lagre_tilgangsrolle(%L, null, 'Regnskapsansvarlig', null, '{regnskap}')$$, :'org'), 'FA400');
select test.feiler(format($$select faktura.lagre_tilgangsrolle(%L, %L, 'Personalansvarlig', null, '{personal,regnskap}')$$, :'org', :'hr'), 'FA400');
-- En rolle som har modulen fra før, beholder den når rollen endres.
select test.er((select moduler from faktura.lagre_tilgangsrolle(:'org', :'okonomi', 'Økonomiansvarlig', 'Fakturaene og regnskapet', array['faktura', 'regnskap'])),
               array['faktura', 'regnskap'], 'beholder Regnskap som er slått av');
select set_config('app.betrodd', 'on', false);
select faktura.admin_sett_funksjon(:'org', 'regnskap', true);
select set_config('app.betrodd', '', false);

-- Invitasjon med rollen.
select test.feiler(format($$select faktura.inviter_medlem(%L, 'x@roller.test', 'tilpasset')$$, :'org'), 'FA400');
select test.feiler(format($$select faktura.inviter_medlem(%L, 'x@roller.test', 'les', %L)$$, :'org', :'okonomi'), 'FA400');
select faktura.inviter_medlem(:'org', 'okonomi@roller.test', 'tilpasset', :'okonomi') as token \gset

select id as anne from faktura.registrer_bruker('uid-roller-anne', 'okonomi@roller.test') \gset
select set_config('app.bruker_id', :'anne', false);
select test.er(faktura.aksepter_invitasjon(:'token'), :'org'::uuid, 'invitasjonen tas imot');
select test.er((select rolle || ':' || tilgangsrolle_id from faktura.medlemmer where org_id = :'org' and bruker_id = :'anne'), 'tilpasset:' || :'okonomi',
               'medlem med rollen');
select test.er((select tilgangsrolle || ':' || array_to_string(rollemoduler, ',') from faktura.mine_organisasjoner where id = :'org'),
               'Økonomiansvarlig:faktura,regnskap', 'appen får rollen og modulene');

-- Økonomiansvarlig: fakturaene og regnskapet, ikke personalet eller administrasjonen.
select test.er(test.kan(:'org'), 'les,skriv,utsted,bokfor,regnskap,medlem', 'økonomiansvarlig');
select test.er((select count(*) from faktura.kunder where org_id = :'org'), 1::bigint, 'ser kundene');
select test.er((select count(*) from faktura.ansatte where org_id = :'org'), 0::bigint, 'ser ikke de ansatte');
select test.feiler(format($$select faktura.lagre_tilgangsrolle(%L, null, 'Egen', null, '{}')$$, :'org'), 'FA403');
-- I regnskapsrutene: lesetilgangen til personaldataene (lønnsbilagene).
select set_config('app.modul', 'regnskap', false);
select test.er(test.kan(:'org'), 'les,skriv,utsted,bokfor,regnskap,personal_les,medlem', 'økonomiansvarlig i regnskapet');
select set_config('app.modul', '', false);

-- Personalansvarlig: personalet, men ikke lønnsrutene.
select set_config('app.bruker_id', :'eier', false);
select faktura.endre_rolle(:'org', :'anne', 'tilpasset', :'hr');
select set_config('app.bruker_id', :'anne', false);
select test.er(test.kan(:'org'), 'personal,personal_les,plan,medlem', 'personalansvarlig');
select test.er((select count(*) from faktura.ansatte where org_id = :'org'), 1::bigint, 'ser de ansatte');
select test.er((select count(*) from faktura.kunder where org_id = :'org'), 0::bigint, 'ser ikke kundene');
select set_config('app.modul', 'lonn', false);
select test.er(test.kan(:'org'), 'medlem', 'personalansvarlig i lønnsrutene');
select test.er((select count(*) from faktura.ansatte where org_id = :'org'), 0::bigint, 'ingen ansatte i lønnsrutene');
select set_config('app.modul', '', false);

-- Lønnsansvarlig (Lønn og Personal): personaldataene også i lønnsrutene.
select set_config('app.bruker_id', :'eier', false);
select faktura.endre_rolle(:'org', :'anne', 'tilpasset', :'lonnrolle');
select set_config('app.bruker_id', :'anne', false);
select test.er(test.kan(:'org'), 'personal,personal_les,plan,medlem', 'lønnsansvarlig');
select set_config('app.modul', 'lonn', false);
select test.er(test.kan(:'org'), 'les,personal,personal_les,plan,medlem', 'lønnsansvarlig i lønnsrutene (kontoene)');
select test.er((select count(*) from faktura.ansatte where org_id = :'org'), 1::bigint, 'de ansatte i lønnsrutene');
select set_config('app.modul', '', false);

-- En rolle uten moduler er som rollen ansatt; som ansatt ser man planen.
select set_config('app.bruker_id', :'eier', false);
select faktura.endre_rolle(:'org', :'anne', 'tilpasset', :'tom');
select set_config('app.bruker_id', :'anne', false);
select test.er(test.kan(:'org'), 'medlem', 'rolle uten moduler');
\c :migrator
update faktura.ansatte set bruker_id = :'anne' where id = :'kari';
\c :api
select set_config('app.bruker_id', :'anne', false);
select test.er(test.kan(:'org'), 'plan,medlem', 'rolle uten moduler, som ansatt');
select test.er((select count(*) from faktura.ansatte where org_id = :'org'), 1::bigint, 'ser seg selv');

-- Varslene: hvem som har modulen gjennom rollen.
\c :worker
select test.er(faktura.tilpasset_har(:'org', :'anne', 'personal'), false, 'uten moduler: ikke personal');
select test.er(faktura.bruker_kan_lese(:'anne', :'org'), false, 'uten Faktura og Regnskap: ingen fakturavarsler');

-- Rollen kan ikke slettes mens noen har den, eller er invitert med den.
\c :api
select set_config('app.bruker_id', :'eier', false);
select test.feiler(format($$select faktura.slett_tilgangsrolle(%L, %L)$$, :'org', :'tom'), 'FA409');
select faktura.endre_rolle(:'org', :'anne', 'tilpasset', :'okonomi');
select faktura.slett_tilgangsrolle(:'org', :'tom');
select test.er((select count(*) from faktura.tilgangsroller where id = :'tom'), 0::bigint, 'rollen er slettet');
select faktura.inviter_medlem(:'org', 'ny-hr@roller.test', 'tilpasset', :'hr') as token2 \gset
select test.feiler(format($$select faktura.slett_tilgangsrolle(%L, %L)$$, :'org', :'hr'), 'FA409');
select test.feiler(format($$select faktura.endre_rolle(%L, %L, 'tilpasset', gen_random_uuid())$$, :'org', :'anne'), 'FA404');
select test.er((select count(*) from faktura.tilgangsroller where org_id = :'org'), 3::bigint, 'tre roller igjen');

\c :worker
select test.er(faktura.tilpasset_har(:'org', :'anne', 'faktura'), true, 'økonomiansvarlig har Faktura');
select test.er(faktura.bruker_kan_lese(:'anne', :'org'), true, 'økonomiansvarlig får fakturavarslene');

-- Plattformadministratoren ser rollen og modulene til funksjonene.
\c :api
select set_config('app.bruker_id', :'eier', false);
select set_config('app.betrodd', 'on', false);
select test.er((select m ->> 'tilgangsrolle' from jsonb_array_elements(faktura.admin_organisasjon(:'org') -> 'medlemmer') m where m ->> 'epost' = 'okonomi@roller.test'),
               'Økonomiansvarlig', 'administrasjonen ser rollen');
select test.er((select f ->> 'modul' from jsonb_array_elements(faktura.admin_organisasjon(:'org') -> 'funksjoner') f where f ->> 'kode' = 'faktura'),
               'faktura', 'funksjonene med modulen');
select set_config('app.betrodd', '', false);

-- ---------------------------------------------------------------------------
-- Byrået: en egen rolle gir tilgang hos klientene bare med Regnskap
-- ---------------------------------------------------------------------------

select id as byraa from faktura.opprett_organisasjon('Regnskapsbyrået AS', '918765026', 'regnskapsbyraa') \gset
select id as bperson from faktura.lagre_tilgangsrolle(:'byraa', null, 'Personal i byrået', null, array['personal']) \gset
select id as bregnskap from faktura.lagre_tilgangsrolle(:'byraa', null, 'Regnskapsmedarbeider', null, array['regnskap']) \gset
select faktura.inviter_medlem(:'byraa', 'byraa-ansatt@roller.test', 'tilpasset', :'bperson') as token3 \gset
select id as bruno from faktura.registrer_bruker('uid-roller-bruno', 'byraa-ansatt@roller.test') \gset
select set_config('app.bruker_id', :'bruno', false);
select faktura.aksepter_invitasjon(:'token3');

\c :worker
select faktura.sett_verifisering(:'org', 'verifisert', 'epostdomene');
select faktura.sett_verifisering(:'byraa', 'verifisert', 'manuell');
\c :api
select set_config('app.bruker_id', :'eier', false);
select id as t from faktura.opprett_tilgang(:'org', '918765026', 'bokfor') \gset
select faktura.svar_tilgang(:'t', true);

select set_config('app.bruker_id', :'bruno', false);
select test.er(faktura.rolle(:'org'), null::text, 'uten Regnskap: ingen tilgang hos klienten');
select set_config('app.bruker_id', :'eier', false);
select faktura.endre_rolle(:'byraa', :'bruno', 'tilpasset', :'bregnskap');
select set_config('app.bruker_id', :'bruno', false);
select test.er(faktura.rolle(:'org'), 'regnskap', 'med Regnskap: regnskapsfører hos klienten');

\c :migrator
drop schema test cascade;
\echo '  ok'
