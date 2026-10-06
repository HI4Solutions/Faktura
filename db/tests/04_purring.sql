-- Purring (0008_purring.sql).

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

\c :api
select id as u from faktura.registrer_bruker('uid-pur', 'pur@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Purr AS') \gset
update faktura.organisasjoner set kontonr = '86011117947', mva_registrert = true, purregebyr = 35 where id = :'org';
insert into faktura.kunder (org_id, navn, epost) values (:'org', 'Treg Kunde', 'treg@kunde.no') returning id as k \gset

-- Faktura som ikke har forfalt kan ikke purres.
insert into faktura.fakturaer (org_id, kunde_id) values (:'org', :'k') returning id as fersk \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, enhetspris) values (:'org', :'fersk', 'Jobb', 800);
select faktura.utsted(:'fersk');
select test.feiler(format($$select faktura.lag_purring(%L, 'paaminnelse')$$, :'fersk'), 'FA409');

-- Forfalt faktura.
insert into faktura.fakturaer (org_id, kunde_id, fakturadato, forfallsdato)
values (:'org', :'k', faktura.i_dag() - 40, faktura.i_dag() - 26) returning id as f \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, enhetspris) values (:'org', :'f', 'Jobb', 800);
select faktura.utsted(:'f');
select test.feiler(format($$select faktura.lag_purring(%L, 'inkassovarsel')$$, :'f'), 'FA409');

select nummer as n1, gebyr as g1, utestaende as u1, ny_frist as frist1 from faktura.lag_purring(:'f', 'paaminnelse') \gset
select test.er(:n1::int, 1, 'første purring');
select test.er(:g1::numeric, 35::numeric, 'purregebyr');
select test.er(:u1::numeric, 1000::numeric, 'utestående');
select test.er(:'frist1'::date, faktura.i_dag() + 14, '14 dagers frist');
select test.feiler(format($$select faktura.lag_purring(%L, 'inkassovarsel')$$, :'f'), 'FA409');  -- fristen er ikke ute

\c :migrator
-- La fristen gå ut.
update faktura.purringer set ny_frist = faktura.i_dag() - 1 where faktura_id = :'f';

\c :api
select set_config('app.bruker_id', :'u', false);
select nummer as n2, gebyr as g2, type as t2 from faktura.lag_purring(:'f', 'inkassovarsel') \gset
select test.er(:n2::int, 2, 'andre purring');
select test.er(:g2::numeric, 0::numeric, 'inkassovarsel uten gebyr');
select test.er(:'t2', 'inkassovarsel', 'type');
select test.er((select count(*) from faktura.purringer where faktura_id = :'f'), 2::bigint, 'to purringer');

-- Betalt faktura kan ikke purres.
select faktura.registrer_betaling(:'fersk', 1000, faktura.i_dag());
select test.feiler(format($$select faktura.lag_purring(%L, 'paaminnelse')$$, :'fersk'), 'FA409');

-- Andre ser ingenting.
select id as fremmed from faktura.registrer_bruker('uid-pur2', 'pur2@test.no') \gset
select set_config('app.bruker_id', :'fremmed', false);
select test.er((select count(*) from faktura.purringer), 0::bigint, 'fremmed ser ikke purringer');
select test.feiler(format($$select faktura.lag_purring(%L, 'paaminnelse')$$, :'f'), 'FA403');

\c :migrator
drop schema test cascade;
\echo '  ok'
