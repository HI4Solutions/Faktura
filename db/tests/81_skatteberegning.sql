-- Skatteberegningen (0121_skatteberegning.sql): det brukeren legger inn i skatteberegningen og den
-- utsatte skatten som føres i årsoppgjøret, med tilgangen som for årsoppgjøret.

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
select id as u from faktura.registrer_bruker('uid-skatteberegning', 'skatteberegning@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Skatteberegning AS', '315000130') \gset
select faktura.inviter_medlem(:'org', 'fakt-skatteberegning@test.no', 'fakturerer') as t_fakt \gset
select id as u_fakt from faktura.registrer_bruker('uid-skatteberegning-fakt', 'fakt-skatteberegning@test.no') \gset
select set_config('app.bruker_id', :'u_fakt', false);
select faktura.aksepter_invitasjon(:'t_fakt');

-- Eieren legger inn skatteberegningen og den utsatte skatten (negativ: utsatt skattefordel).
select set_config('app.bruker_id', :'u', false);
insert into faktura.aarsoppgjor (org_id, aar, skatteberegning, utsatt_skatt) values (:'org', 2025, '{"skattefordel": true}', -8800) returning id as a \gset
select test.er((select utsatt_skatt from faktura.aarsoppgjor where id = :'a'), -8800.00::numeric, 'utsatt skattefordel som negativt beløp');
update faktura.aarsoppgjor set skatteberegning = skatteberegning || '{"underskudd_ib": 40000}', utsatt_skatt = null where id = :'a';
select test.er((select (skatteberegning ->> 'underskudd_ib') || '|' || (utsatt_skatt is null) from faktura.aarsoppgjor where id = :'a'), '40000|true', 'det brukeren legger inn, og ingen utsatt skatt');
select test.er((select skatteberegning from faktura.aarsoppgjor where org_id = :'org' and aar = 2025), '{"skattefordel": true, "underskudd_ib": 40000}'::jsonb, 'slått sammen');
select test.feiler(format($$update faktura.aarsoppgjor set skatteberegning = '[]' where id = %L$$, :'a'), '23514');
-- En ny rad uten noe lagt inn: tomt objekt og ingen utsatt skatt.
insert into faktura.aarsoppgjor (org_id, aar) values (:'org', 2024) returning id as a24 \gset
select test.er((select skatteberegning::text || '|' || (utsatt_skatt is null) from faktura.aarsoppgjor where id = :'a24'), '{}|true', 'standardverdiene');

-- Fakturereren ser ikke årsoppgjøret og kan ikke endre det.
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select count(*)::int from faktura.aarsoppgjor where org_id = :'org'), 0, 'fakturereren ser ikke skatteberegningen');
update faktura.aarsoppgjor set utsatt_skatt = 1 where org_id = :'org';
select set_config('app.bruker_id', :'u', false);
select test.er((select count(*)::int from faktura.aarsoppgjor where org_id = :'org' and utsatt_skatt = 1), 0, 'fakturereren endret ingenting');

\c :migrator
drop schema test cascade;
\echo '  ok'
