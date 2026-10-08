-- Funksjoner per organisasjon (0041_funksjoner.sql): en ny organisasjon får standarden,
-- medlemmene ser hvilke funksjoner organisasjonen har (også i mine_organisasjoner), en
-- funksjon som bygger på en annen virker bare når begge er slått på, og bare betrodde kall
-- (plattformadministratoren) endrer dem.

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
select id as u from faktura.registrer_bruker('uid-funk-eier', 'eier-funk@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Funksjoner AS', '917654107') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);

-- En ny organisasjon har alle funksjonene (standarden er alt).
select test.er(faktura.har_funksjon(:'org', 'ehf'), true, 'EHF er på');
select test.er(faktura.har_funksjon(:'org', 'vaktplan'), true, 'vaktplanen er på');
select test.er(faktura.har_funksjon(:'org', 'finnes_ikke'), false, 'ukjent funksjon er av');
select test.er(array_length((select funksjoner from faktura.mine_organisasjoner where id = :'org'), 1), (select count(*)::int from faktura.funksjoner), 'alle i mine_organisasjoner');
select test.er((select personal from faktura.mine_organisasjoner where id = :'org'), true, 'ansatte og timer er på');
select test.er((select count(*) from faktura.funksjoner), 12::bigint, 'medlemmet ser funksjonene');
select test.er((select count(*) from faktura.org_funksjoner where org_id = :'org'), 12::bigint, 'og hva organisasjonen har');

-- Medlemmet kan ikke endre funksjonene selv.
select test.feiler($$select faktura.admin_sett_funksjon('$$ || :'org' || $$', 'ehf', false)$$, 'FA403');
select test.feiler($$select faktura.admin_sett_standard('ehf', false)$$, 'FA403');
select test.feiler($$select faktura.admin_funksjoner()$$, 'FA403');
select test.feiler($$update faktura.org_funksjoner set aktiv = false where org_id = '$$ || :'org' || $$'$$, '42501');
select test.feiler($$insert into faktura.org_funksjoner (org_id, kode, aktiv) values ('$$ || :'org' || $$', 'ehf', false)$$, '42501');

-- Plattformadministratoren (betrodd) slår av EHF og ansatte og timer.
select set_config('app.betrodd', 'on', false);
select faktura.admin_sett_funksjon(:'org', 'ehf', false);
select faktura.admin_sett_funksjon(:'org', 'ansatte', false);
select test.feiler($$select faktura.admin_sett_funksjon('$$ || :'org' || $$', 'finnes_ikke', true)$$, 'FA400');
select test.feiler($$select faktura.admin_sett_funksjon(gen_random_uuid(), 'ehf', true)$$, 'FA404');
select test.er((select o -> 'aktive' ? 'ehf' from jsonb_array_elements(faktura.admin_funksjoner() -> 'organisasjoner') o where o ->> 'id' = :'org'), false, 'EHF er av i oversikten');
select test.er((select (o ->> 'endret') is not null from jsonb_array_elements(faktura.admin_funksjoner() -> 'organisasjoner') o where o ->> 'id' = :'org'), true, 'med når det ble endret');
select test.er((select endret_av from faktura.org_funksjoner where org_id = :'org' and kode = 'ehf'), :'u'::uuid, 'og av hvem');
select set_config('app.betrodd', '', false);

select test.er(faktura.har_funksjon(:'org', 'ehf'), false, 'EHF er av');
select test.feiler($$select faktura.krev_funksjon('$$ || :'org' || $$', 'ehf')$$, 'FA403');
-- Vaktplanen er slått på, men bygger på ansatte og timer, som er av.
select test.er((select aktiv from faktura.org_funksjoner where org_id = :'org' and kode = 'vaktplan'), true, 'vaktplanen står på');
select test.er(faktura.har_funksjon(:'org', 'vaktplan'), false, 'men virker ikke uten ansatte og timer');
select test.er((select personal from faktura.mine_organisasjoner where id = :'org'), false, 'ansatte og timer er av i appen');
select test.er((select 'vaktplan' = any(funksjoner) or 'ehf' = any(funksjoner) from faktura.mine_organisasjoner where id = :'org'), false, 'og ikke i lista');
select test.er((select 'bank' = any(funksjoner) from faktura.mine_organisasjoner where id = :'org'), true, 'bank er fortsatt med');

-- Standarden for nye organisasjoner: uten AI.
select set_config('app.betrodd', 'on', false);
select faktura.admin_sett_standard('ai', false);
select set_config('app.betrodd', '', false);
select id as org2 from faktura.opprett_organisasjon('Ny etter standard AS', '917654115') \gset
select test.er(faktura.har_funksjon(:'org2', 'ai'), false, 'den nye har ikke AI');
select test.er(faktura.har_funksjon(:'org2', 'bank'), true, 'men bank');
select test.er(faktura.har_funksjon(:'org', 'ai'), true, 'den gamle beholder AI');

-- Andre ser ikke hva en organisasjon de ikke er med i har.
select id as u2 from faktura.registrer_bruker('uid-funk-annen', 'annen-funk@test.no') \gset
select set_config('app.bruker_id', :'u2', false);
select test.er((select count(*) from faktura.org_funksjoner where org_id = :'org'), 0::bigint, 'en annen ser ikke funksjonene');

-- Workeren kan sjekke funksjonene.
\c :worker
select test.er(faktura.har_funksjon(:'org', 'ehf'), false, 'workeren ser at EHF er av');
select test.er(faktura.har_funksjon(:'org', 'bank'), true, 'og at bank er på');

\c :migrator
update faktura.funksjoner set standard = true;
drop schema test cascade;
\echo '  ok'
