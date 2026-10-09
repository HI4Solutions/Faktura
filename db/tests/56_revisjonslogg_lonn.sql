-- Revisjonsloggen for lønnstabellene (0081_revisjonslogg_lonn.sql): lønnshistorikken, a-meldingene
-- og lønnsbilagene bare for dem som ser lønnen (ikke fakturerer), og inntektsmeldingene til NAV
-- bare for eier og administrator (ikke regnskap).

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
grant execute on all functions in schema test to public;

\c :api
select id as u from faktura.registrer_bruker('uid-revlonn-eier', 'eier-revlonn@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Revisjon Lønn AS', '915000177') \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, lonnstype, maanedslonn, stillingsprosent)
values (:'org', 'Ola', 'Logg', '2026-01-01', 'maaned', 40000, 100) returning id as ola \gset
select faktura.ny_lonnsendring(:'ola', '2026-03-01', null, 42000, null, null, 'Lønnsoppgjør');
select faktura.inviter_medlem(:'org', 'fakt-revlonn@test.no', 'fakturerer') as t_fakt \gset
select faktura.inviter_medlem(:'org', 'regn-revlonn@test.no', 'regnskap') as t_regn \gset
select id as u_fakt from faktura.registrer_bruker('uid-revlonn-fakt', 'fakt-revlonn@test.no') \gset
select id as u_regn from faktura.registrer_bruker('uid-revlonn-regn', 'regn-revlonn@test.no') \gset
select set_config('app.bruker_id', :'u_fakt', false);
select faktura.aksepter_invitasjon(:'t_fakt');
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'t_regn');

-- Rader i loggen for a-meldingene, bilagene og inntektsmeldingene (som workeren og godkjenningen lager).
\c :migrator
insert into faktura.revisjonslogg (org_id, bruker_id, handling, tabell, rad_id, endring)
select :'org', null, 'INSERT', t, gen_random_uuid(), '{}'::jsonb from unnest(array['ameldinger', 'bilag', 'nav_inntektsmeldinger']) t;

\c :api
create temp table tabeller as select unnest(array['lonnsendringer', 'ameldinger', 'bilag', 'nav_inntektsmeldinger']) as tabell;
grant select on tabeller to public;
select set_config('app.bruker_id', :'u', false);
select test.er((select count(distinct r.tabell)::int from faktura.revisjonslogg r join tabeller t using (tabell) where r.org_id = :'org'), 4, 'eieren ser alle');
select set_config('app.bruker_id', :'u_regn', false);
select test.er((select string_agg(distinct r.tabell, ',' order by r.tabell) from faktura.revisjonslogg r join tabeller t using (tabell) where r.org_id = :'org'),
               'ameldinger,bilag,lonnsendringer', 'regnskap: ikke inntektsmeldingene');
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select count(*)::int from faktura.revisjonslogg r join tabeller t using (tabell) where r.org_id = :'org'), 0, 'fakturereren ser ingen av dem');
select test.er((select count(*) > 0 from faktura.revisjonslogg where org_id = :'org' and tabell = 'organisasjoner'), true, 'men resten av loggen');

\c :migrator
drop schema test cascade;
\echo '  ok'
