-- Indeksregulering av produkter (0015_indeksregulering.sql).

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

-- KPI: grunnlag 100, siste kjente 103 (+3 %).
insert into faktura.kpi (maaned, verdi) values ('2025-08-01', 100.0), ('2026-08-01', 103.5), ('2026-09-01', 103.0);

\c :api
select id as u from faktura.registrer_bruker('uid-kpi', 'kpi@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Utleie AS') \gset
update faktura.organisasjoner set kontonr = '86011117947' where id = :'org';
insert into faktura.kunder (org_id, navn, epost) values (:'org', 'Leietaker', 'leie@test.no') returning id as k \gset

-- Kan ikke slå på uten måned og grunnlag.
select test.feiler(format($$insert into faktura.produkter (org_id, navn, enhetspris, indeks_aktiv) values (%L, 'x', 1, true)$$, :'org'), '23514');

-- Reguleringsmåned innen 60 dager, uten varsel (da gjelder datoen som den er).
select extract(month from faktura.i_dag() + 45)::int as mnd \gset
insert into faktura.produkter (org_id, navn, enhetspris, mva_sats, indeks_aktiv, indeks_maaned, indeks_basis, indeks_varsle)
values (:'org', 'Husleie', 10000, 0, true, :mnd, '2025-08-01', false) returning id as p1 \gset
insert into faktura.produkter (org_id, navn, enhetspris, mva_sats, indeks_aktiv, indeks_maaned, indeks_basis, indeks_varsle)
values (:'org', 'Parkering', 1000, 25, true, :mnd, '2025-08-01', false) returning id as p2 \gset
-- KPI har gått ned siden grunnlaget; bare økning er valgt.
insert into faktura.produkter (org_id, navn, enhetspris, mva_sats, indeks_aktiv, indeks_maaned, indeks_basis, indeks_varsle)
values (:'org', 'Bod', 500, 0, true, :mnd, '2026-08-01', false) returning id as p3 \gset

-- Leietakeren har egen pris på linjen (9 500).
insert into faktura.gjentakelser (org_id, kunde_id, linjer, forfall_dag, neste_forfall)
values (:'org', :'k', format('[{"produkt_id": "%s", "beskrivelse": "Husleie", "enhetspris": 9500, "mva_sats": 0},
                             {"beskrivelse": "Strøm", "enhetspris": 400, "mva_sats": 25}]', :'p1')::jsonb, 1, '2030-01-01') returning id as g1 \gset

select test.er((select ny_pris from faktura.beregn_indeksregulering(:'p1')), 10300::numeric, 'forhåndsberegning');

\c :worker
select count(*) as n from faktura.planlegg_indeksreguleringer() \gset
select test.er(:n::int, 2, 'to reguleringer planlagt (boden er uendret)');
select test.er((select ny_pris from faktura.prisreguleringer where produkt_id = :'p1'), 10300::numeric, 'ny husleie, hele kroner');
select test.er((select faktor from faktura.prisreguleringer where produkt_id = :'p1'), 1.03::numeric, 'faktor');
select test.er((select status from faktura.prisreguleringer where produkt_id = :'p3'), 'uendret', 'bod uendret');
select test.er((select count(*) from faktura.planlegg_indeksreguleringer()), 0::bigint, 'planlegges ikke to ganger');

\c :api
select set_config('app.bruker_id', :'u', false);
-- Ny avtale etter at reguleringen er planlagt, får ikke regulering.
insert into faktura.gjentakelser (org_id, kunde_id, linjer, forfall_dag, neste_forfall)
values (:'org', :'k', format('[{"produkt_id": "%s", "beskrivelse": "Husleie", "enhetspris": 10300, "mva_sats": 0}]', :'p1')::jsonb, 1, '2030-01-01')
returning id as g2 \gset

\c :worker
select faktura.anvend_indeksreguleringer();
select test.er((select (linjer -> 0 ->> 'enhetspris')::numeric from faktura.gjentakelser where id = :'g1'), 9785::numeric, 'egen pris regulert med samme faktor');
select test.er((select (linjer -> 1 ->> 'enhetspris')::numeric from faktura.gjentakelser where id = :'g1'), 400::numeric, 'andre linjer urørt');
select test.er((select (linjer -> 0 ->> 'enhetspris')::numeric from faktura.gjentakelser where id = :'g2'), 10300::numeric, 'ny avtale urørt');
select test.er((select enhetspris from faktura.produkter where id = :'p1'), 10000::numeric, 'produktet endres først på datoen');
select faktura.anvend_indeksreguleringer();
select test.er((select (linjer -> 0 ->> 'enhetspris')::numeric from faktura.gjentakelser where id = :'g1'), 9785::numeric, 'reguleres bare én gang');

-- Avbryt husleiereguleringen: gjentakelsen får tilbake gammel pris.
\c :api
select set_config('app.bruker_id', :'u', false);
select id as r1 from faktura.prisreguleringer where produkt_id = :'p1' \gset
select faktura.avbryt_indeksregulering(:'org', :'r1');
select test.er((select (linjer -> 0 ->> 'enhetspris')::numeric from faktura.gjentakelser where id = :'g1'), 9500::numeric, 'satt tilbake');
select test.er((select status from faktura.prisreguleringer where id = :'r1'), 'avbrutt', 'avbrutt');
select test.feiler(format($$select faktura.avbryt_indeksregulering(%L, %L)$$, :'org', :'r1'), 'FA409');

\c :worker
select test.er((select count(*) from faktura.planlegg_indeksreguleringer()), 0::bigint, 'avbrutt regulering planlegges ikke på nytt i år');

-- Parkeringen gjennomføres når datoen er nådd.
\c :migrator
update faktura.prisreguleringer set gjelder_fra = faktura.i_dag() where produkt_id = :'p2';
\c :worker
select faktura.anvend_indeksreguleringer();
select test.er((select enhetspris from faktura.produkter where id = :'p2'), 1030::numeric, 'ny produktpris');
select test.er((select indeks_basis from faktura.produkter where id = :'p2'), '2026-09-01'::date, 'nytt KPI-grunnlag');
select test.er((select status from faktura.prisreguleringer where produkt_id = :'p2'), 'gjennomfort', 'gjennomført');

-- Appen kan ikke lagre KPI eller kjøre reguleringer selv.
\c :api
select set_config('app.bruker_id', :'u', false);
select test.feiler($$select faktura.planlegg_indeksreguleringer()$$, '42501');
select test.feiler($$insert into faktura.kpi (maaned, verdi) values ('2030-01-01', 1)$$, '42501');

\c :migrator
delete from faktura.kpi;
drop schema test cascade;
\echo '  ok'
