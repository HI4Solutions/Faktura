-- Refusjonene fra NAV (0085_nav_refusjon.sql): eier og administrator registrerer og sletter (bare
-- gjennom funksjonene), refusjonen bokføres med et bilag i lønnsserien som går i null, en refusjon
-- som slettes, reverseres i regnskapet, regnskap ser bilaget men ikke refusjonene (sykepenger),
-- kontrollene og kontoen i lønnsoppsettet.

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
select id as u from faktura.registrer_bruker('uid-ref-eier', 'eier-ref@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Refusjon AS', '915000304') \gset
insert into faktura.lonn_oppsett (org_id, aktiv, bokforing_kontoer) values (:'org', true, '{"nav_refusjon": "5801"}');
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, lonnstype, maanedslonn)
values (:'org', 'Ola', 'Syk', '2025-01-01', 'maaned', 40000) returning id as ola \gset
select faktura.inviter_medlem(:'org', 'regn-ref@test.no', 'regnskap') as t_regn \gset
select id as u_regn from faktura.registrer_bruker('uid-ref-regn', 'regn-ref@test.no') \gset
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'t_regn');
select set_config('app.bruker_id', :'u', false);

-- Kontoen for refusjon fra NAV er en gyldig nøkkel i lønnsoppsettet.
select test.er((select bokforing_kontoer->>'nav_refusjon' from faktura.lonn_oppsett where org_id = :'org'), '5801', 'kontoen i oppsettet');

-- Registrert: raden og bilaget (bank i debet, refusjonskontoen i kredit) på datoen pengene kom.
select faktura.registrer_nav_refusjon(:'org', format('{"type": "sykepenger", "ansatt_id": "%s", "dato": "2026-10-05", "belop": 12345.5, "fra": "2026-09-01", "til": "2026-09-30"}', :'ola')::jsonb,
  '1920', '5801', 'Refusjon fra NAV: sykepenger 01.09.2026–30.09.2026') as ref \gset
select bilag_id as bilag from faktura.nav_refusjoner where id = :'ref' \gset
select test.er((select row(kilde, kilde_id, dato, serie)::text from faktura.bilag where id = :'bilag'), row('nav_refusjon', :'ref'::uuid, '2026-10-05'::date, 'L')::text, 'bilaget');
select test.er((select string_agg(konto || ':' || belop, ',' order by rekke) from faktura.posteringer where bilag_id = :'bilag'), '1920:12345.50,5801:-12345.50', 'posteringene');
select test.er((select sum(belop) from faktura.posteringer where bilag_id = :'bilag'), 0::numeric, 'bilaget går i null');

-- Kontrollene, og ingen skriver rett i tabellen.
select test.feiler(format($$select faktura.registrer_nav_refusjon(%L, '{"type": "sykepenger", "dato": "2026-10-05", "belop": 0}', '1920', '5801', 'x')$$, :'org'), '23514');
select test.feiler(format($$select faktura.registrer_nav_refusjon(%L, '{"type": "sykepenger", "dato": "2026-10-05", "belop": 100, "fra": "2026-09-01"}', '1920', '5801', 'x')$$, :'org'), '23514');
select test.feiler(format($$select faktura.registrer_nav_refusjon(%L, '{"type": "ferie", "dato": "2026-10-05", "belop": 100}', '1920', '5801', 'x')$$, :'org'), '23514');
select test.feiler(format($$insert into faktura.nav_refusjoner (org_id, type, dato, belop) values (%L, 'annet', '2026-10-05', 100)$$, :'org'), '42501');

-- Regnskap ser bilaget, men ikke refusjonene (sykepenger), og registrerer ikke.
select set_config('app.bruker_id', :'u_regn', false);
select test.er((select count(*)::int from faktura.nav_refusjoner where org_id = :'org'), 0, 'regnskap ser ikke refusjonene');
select test.er((select count(*)::int from faktura.bilag where org_id = :'org' and kilde = 'nav_refusjon'), 1, 'regnskap ser bilaget');
select test.feiler(format($$select faktura.registrer_nav_refusjon(%L, '{"type": "annet", "dato": "2026-10-05", "belop": 100}', '1920', '5800', 'x')$$, :'org'), 'FA403');
select test.feiler(format($$select faktura.slett_nav_refusjon(%L, %L)$$, :'org', :'ref'), 'FA403');
-- Heller ikke i revisjonsloggen (men bilaget, som lønnsbilagene).
select test.er((select count(*)::int from faktura.revisjonslogg where org_id = :'org' and tabell = 'nav_refusjoner'), 0, 'regnskap ser ikke loggen for refusjonene');
select test.er((select count(*) > 0 from faktura.revisjonslogg where org_id = :'org' and tabell = 'bilag'), true, 'regnskap ser loggen for bilagene');
select set_config('app.bruker_id', :'u', false);
select test.er((select count(*) > 0 from faktura.revisjonslogg where org_id = :'org' and tabell = 'nav_refusjoner'), true, 'eieren ser loggen for refusjonene');

-- Slettet: bilaget reverseres (med motsatte beløp), og raden er borte.
select faktura.slett_nav_refusjon(:'org', :'ref');
select test.er((select count(*)::int from faktura.nav_refusjoner where id = :'ref'), 0, 'refusjonen er slettet');
select test.er((select reversert_av is not null from faktura.bilag where id = :'bilag'), true, 'bilaget er reversert');
select test.er((select sum(p.belop) from faktura.posteringer p join faktura.bilag b on b.id = p.bilag_id where b.org_id = :'org' and b.kilde = 'nav_refusjon' and p.konto = '5801'), 0::numeric, 'refusjonskontoen er null igjen');
select test.feiler(format($$select faktura.slett_nav_refusjon(%L, %L)$$, :'org', :'ref'), 'FA404');

\c :migrator
drop schema test cascade;
