-- Bruksvilkårene og databehandleravtalen (0122_avtaler.sql): versjonene som gjelder, godkjenningen
-- (bare eier og administrator, bare gjeldende versjoner), avtaler_godtatt i mine_organisasjoner og
-- at en ny versjon må godtas på nytt.

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
-- Versjonene som gjelder, kan leses av appen.
select test.er((select string_agg(type || '=' || versjon || sti, ',' order by type) from faktura.avtaler),
               'databehandleravtale=1.0/databehandleravtale.html,vilkar=1.0/vilkar.html', 'versjonene og adressene');

select id as u from faktura.registrer_bruker('uid-avtaler', 'avtaler@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Avtaler AS', '315000157') \gset
select faktura.inviter_medlem(:'org', 'fakt-avtaler@test.no', 'fakturerer') as t_fakt \gset
select faktura.inviter_medlem(:'org', 'admin-avtaler@test.no', 'admin') as t_admin \gset
select id as u_fakt from faktura.registrer_bruker('uid-avtaler-fakt', 'fakt-avtaler@test.no') \gset
select id as u_admin from faktura.registrer_bruker('uid-avtaler-admin', 'admin-avtaler@test.no') \gset
select set_config('app.bruker_id', :'u_fakt', false);
select faktura.aksepter_invitasjon(:'t_fakt');
select set_config('app.bruker_id', :'u_admin', false);
select faktura.aksepter_invitasjon(:'t_admin');

-- En ny organisasjon har ikke godtatt noe ennå.
select set_config('app.bruker_id', :'u', false);
select test.er((select avtaler_godtatt from faktura.mine_organisasjoner where id = :'org'), false, 'ikke godtatt ennå');
select test.er(faktura.avtaler_godtatt(:'org'), false, 'avtaler_godtatt uten godkjenning');

-- Fakturereren kan ikke godta på vegne av organisasjonen, og ser ikke godkjenningene.
select set_config('app.bruker_id', :'u_fakt', false);
select test.feiler(format($$select faktura.godta_avtaler(%L, '1.0', '1.0')$$, :'org'), 'FA403');
select test.er((select avtaler_godtatt from faktura.mine_organisasjoner where id = :'org'), false, 'fakturereren ser at det ikke er godtatt');

-- Eieren må godta versjonene som gjelder.
select set_config('app.bruker_id', :'u', false);
select test.feiler(format($$select faktura.godta_avtaler(%L, '0.9', '1.0')$$, :'org'), 'FA409');
select test.feiler(format($$select faktura.godta_avtaler(%L, '1.0', null)$$, :'org'), 'FA409');
select (faktura.godta_avtaler(:'org', '1.0', '1.0')).id as g \gset
select test.er((select vilkar_versjon || '|' || databehandleravtale_versjon || '|' || (godtatt_av = :'u')
                  from faktura.avtalegodkjenninger where id = :'g'), '1.0|1.0|true', 'versjonene og hvem som godtok');
select test.er((select avtaler_godtatt from faktura.mine_organisasjoner where id = :'org'), true, 'godtatt');
select test.er((select count(*)::int from faktura.revisjonslogg where org_id = :'org' and tabell = 'avtalegodkjenninger'), 1, 'godkjenningen i revisjonsloggen');

-- Fakturereren ser at det er godtatt, men ikke hvem som godtok.
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select avtaler_godtatt from faktura.mine_organisasjoner where id = :'org'), true, 'fakturereren ser at det er godtatt');
select test.er((select count(*)::int from faktura.avtalegodkjenninger), 0, 'fakturereren ser ikke godkjenningene');
-- Godkjenningene kan ikke endres eller slettes av appen.
select test.feiler(format($$update faktura.avtalegodkjenninger set vilkar_versjon = '9' where id = %L$$, :'g'), '42501');
select test.feiler(format($$delete from faktura.avtalegodkjenninger where id = %L$$, :'g'), '42501');
select test.feiler($$insert into faktura.avtalegodkjenninger (org_id, vilkar_versjon, databehandleravtale_versjon) values (gen_random_uuid(), '1.0', '1.0')$$, '42501');
select test.feiler($$update faktura.avtaler set versjon = '0.1'$$, '42501');

-- Administratoren ser dem og kan også godta.
select set_config('app.bruker_id', :'u_admin', false);
select test.er((select count(*)::int from faktura.avtalegodkjenninger where org_id = :'org'), 1, 'administratoren ser godkjenningen');
select faktura.godta_avtaler(:'org', '1.0', '1.0');

-- En ny versjon av databehandleravtalen må godtas på nytt.
\c :migrator
update faktura.avtaler set versjon = '1.1' where type = 'databehandleravtale';
\c :api
select set_config('app.bruker_id', :'u', false);
select test.er((select avtaler_godtatt from faktura.mine_organisasjoner where id = :'org'), false, 'ny versjon er ikke godtatt');
select test.feiler(format($$select faktura.godta_avtaler(%L, '1.0', '1.0')$$, :'org'), 'FA409');
select faktura.godta_avtaler(:'org', '1.0', '1.1');
select test.er((select avtaler_godtatt from faktura.mine_organisasjoner where id = :'org'), true, 'den nye versjonen er godtatt');
select test.er((select string_agg(databehandleravtale_versjon, ',' order by godtatt_at, databehandleravtale_versjon)
                  from faktura.avtalegodkjenninger where org_id = :'org'), '1.0,1.0,1.1', 'alle godkjenningene er tatt vare på');

\c :migrator
update faktura.avtaler set versjon = '1.0' where type = 'databehandleravtale';
drop schema test cascade;
\echo '  ok'
