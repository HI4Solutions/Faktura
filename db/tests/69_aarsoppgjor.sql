-- Periodelås og årsoppgjør (0094_aarsoppgjor.sql): et bilag i den låste perioden føres på den første
-- åpne dagen (også reverseringer), med nummer i det nye året når det havner der (og nummeret i det
-- gamle året gis tilbake); årsoppgjøret i serie Å (kontrollene, ett gjeldende per år, angre, låst år),
-- og at fakturerer verken ser eller fører årsoppgjøret.

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
create function test.bilag(_id uuid) returns text language sql as $$
  select serie || '-' || aar || '-' || nummer || ' ' || to_char(dato, 'YYYY-MM-DD') from faktura.bilag where id = _id
$$;
grant execute on all functions in schema test to public;

\c :api
select id as u from faktura.registrer_bruker('uid-aars-eier', 'eier-aars@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Årsoppgjør AS', '915000525') \gset
select faktura.inviter_medlem(:'org', 'fakt-aars@test.no', 'fakturerer') as t_fakt \gset
select id as u_fakt from faktura.registrer_bruker('uid-aars-fakt', 'fakt-aars@test.no') \gset
select set_config('app.bruker_id', :'u_fakt', false);
select faktura.aksepter_invitasjon(:'t_fakt');
select set_config('app.bruker_id', :'u', false);
insert into faktura.regnskap_oppsett (org_id) values (:'org');

-- To bilag i 2025 før låsen.
select faktura.bokfor_manuelt(:'org', '2025-03-01', 'Første', '[{"konto": "1920", "belop": 100}, {"konto": "2050", "belop": -100}]') as m1 \gset
select faktura.bokfor_manuelt(:'org', '2025-06-30', 'Andre', '[{"konto": "1920", "belop": 200}, {"konto": "2050", "belop": -200}]') as m2 \gset
select test.er(test.bilag(:'m2'), 'M-2025-2 2025-06-30', 'før låsen');

-- Låst til og med 30. juni 2025: et bilag i perioden føres 1. juli, med datoen i teksten.
update faktura.regnskap_oppsett set laast_til = '2025-06-30' where org_id = :'org';
select faktura.bokfor_manuelt(:'org', '2025-05-15', 'Sent bilag', '[{"konto": "6800", "belop": 50}, {"konto": "1920", "belop": -50}]') as m3 \gset
select test.er(test.bilag(:'m3'), 'M-2025-3 2025-07-01', 'flyttet til første åpne dag');
select test.er((select tekst from faktura.bilag where id = :'m3'), 'Sent bilag (datert 15.05.2025, perioden er låst)', 'teksten');
select faktura.bokfor_manuelt(:'org', '2025-07-02', 'Åpen periode', '[{"konto": "6800", "belop": 10}, {"konto": "1920", "belop": -10}]') as m4 \gset
select test.er(test.bilag(:'m4'), 'M-2025-4 2025-07-02', 'åpen periode urørt');
-- En reversering av et bilag i den låste perioden føres også 1. juli.
select faktura.reverser_manuelt(:'org', :'m1', null) as r1 \gset
select test.er(test.bilag(:'r1'), 'M-2025-5 2025-07-01', 'reverseringen flyttet');

-- Låst ut 2025: et bilag datert i 2025 får nummer i 2026, og nummeret i 2025 gis tilbake.
update faktura.regnskap_oppsett set laast_til = '2025-12-31' where org_id = :'org';
select faktura.bokfor_manuelt(:'org', '2025-12-15', 'Over årsskiftet', '[{"konto": "6800", "belop": 20}, {"konto": "1920", "belop": -20}]') as m5 \gset
select test.er(test.bilag(:'m5'), 'M-2026-1 2026-01-01', 'nytt år');
update faktura.regnskap_oppsett set laast_til = null where org_id = :'org';
select faktura.bokfor_manuelt(:'org', '2025-12-20', 'Ulåst igjen', '[{"konto": "6800", "belop": 30}, {"konto": "1920", "belop": -30}]') as m6 \gset
select test.er(test.bilag(:'m6'), 'M-2025-6 2025-12-20', 'nummeret ble gitt tilbake');
-- Det første bilaget i en serie som havner i et annet år: serien for året fjernes.
update faktura.regnskap_oppsett set laast_til = '2025-12-31' where org_id = :'org';
select faktura.bokfor_manuelt(:'org', '2024-05-01', 'Fra 2024', '[{"konto": "6800", "belop": 40}, {"konto": "1920", "belop": -40}]') as m7 \gset
select test.er(test.bilag(:'m7'), 'M-2026-2 2026-01-01', 'første i serien, nytt år');
-- Årsoppgjøret for et låst år føres ikke.
insert into faktura.aarsoppgjor (org_id, aar) values (:'org', 2025) returning id as a25 \gset
select test.feiler(format($$select faktura.bokfor_aarsoppgjor(%L, %L, 'Årsoppgjør 2025', '[{"konto": "8960", "belop": 100}, {"konto": "2050", "belop": -100}]')$$, :'org', :'a25'), 'FA409');
update faktura.regnskap_oppsett set laast_til = null where org_id = :'org';
select faktura.bokfor_manuelt(:'org', '2024-06-01', 'Ulåst 2024', '[{"konto": "6800", "belop": 60}, {"konto": "1920", "belop": -60}]') as m8 \gset
select test.er(test.bilag(:'m8'), 'M-2024-1 2024-06-01', 'serien for 2024 begynner på 1');

-- Årsoppgjøret: kontrollene.
insert into faktura.aarsoppgjor (org_id, aar) values (:'org', 2099) returning id as a99 \gset
select test.feiler(format($$select faktura.bokfor_aarsoppgjor(%L, %L, 'x', '[{"konto": "8960", "belop": 100}, {"konto": "2050", "belop": -100}]')$$, :'org', :'a99'), 'FA409');
select test.feiler(format($$select faktura.bokfor_aarsoppgjor(%L, gen_random_uuid(), 'x', '[{"konto": "8960", "belop": 100}, {"konto": "2050", "belop": -100}]')$$, :'org'), 'FA404');
select test.feiler(format($$select faktura.bokfor_aarsoppgjor(%L, %L, ' ', '[{"konto": "8960", "belop": 100}, {"konto": "2050", "belop": -100}]')$$, :'org', :'a25'), 'FA400');
select test.feiler(format($$select faktura.bokfor_aarsoppgjor(%L, %L, 'x', '[{"konto": "8960", "belop": 100}, {"konto": "2050", "belop": -99}]')$$, :'org', :'a25'), 'FA400');
select test.feiler(format($$select faktura.bokfor_aarsoppgjor(%L, %L, 'x', '[{"konto": "8960", "belop": 100}]')$$, :'org', :'a25'), 'FA400');
select test.feiler(format($$insert into faktura.aarsoppgjor (org_id, aar) values (%L, 2025)$$, :'org'), '23505');
select test.feiler(format($$update faktura.aarsoppgjor set skatt = -1 where id = %L$$, :'a25'), '23514');

-- Serie Å den 31. desember; et nytt reverserer det forrige, så ett er gjeldende.
select faktura.bokfor_aarsoppgjor(:'org', :'a25', 'Årsoppgjør 2025', '[{"konto": "8960", "belop": 240}, {"konto": "2050", "belop": -240}]') as o1 \gset
select test.er((select row(serie, aar, nummer, dato, kilde, kilde_id)::text from faktura.bilag where id = :'o1'), row('Å', 2025, 1, '2025-12-31'::date, 'aarsoppgjor', :'a25'::uuid)::text, 'årsoppgjøret');
select faktura.bokfor_aarsoppgjor(:'org', :'a25', 'Årsoppgjør 2025', '[{"konto": "8300", "belop": 50}, {"konto": "2500", "belop": -50}, {"konto": "8960", "belop": 190}, {"konto": "2050", "belop": -190}]') as o2 \gset
select test.er((select count(*)::int from faktura.bilag where org_id = :'org' and kilde = 'aarsoppgjor' and reverserer is null and reversert_av is null), 1, 'ett gjeldende');
select test.er((select string_agg(serie || '-' || nummer, ',' order by nummer) from faktura.bilag where org_id = :'org' and kilde = 'aarsoppgjor'), 'Å-1,Å-2,Å-3', 'nummerne');
-- Låst år: verken nytt årsoppgjør eller angring.
update faktura.regnskap_oppsett set laast_til = '2025-12-31' where org_id = :'org';
select test.feiler(format($$select faktura.angre_aarsoppgjor(%L, %L)$$, :'org', :'a25'), 'FA409');
update faktura.regnskap_oppsett set laast_til = null where org_id = :'org';
select faktura.angre_aarsoppgjor(:'org', :'a25');
select test.er((select count(*)::int from faktura.bilag where org_id = :'org' and kilde = 'aarsoppgjor' and reverserer is null and reversert_av is null), 0, 'angret');
select test.feiler(format($$select faktura.angre_aarsoppgjor(%L, %L)$$, :'org', :'a25'), 'FA409');

-- Fakturerer ser verken årsoppgjøret eller låsen, og fører ikke.
select faktura.bokfor_aarsoppgjor(:'org', :'a25', 'Årsoppgjør 2025', '[{"konto": "8960", "belop": 240}, {"konto": "2050", "belop": -240}]') as o3 \gset
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select count(*)::int from faktura.aarsoppgjor where org_id = :'org'), 0, 'fakturerer ser ikke årsoppgjørene');
select test.er((select count(*)::int from faktura.bilag where org_id = :'org' and kilde = 'aarsoppgjor'), 0, 'fakturerer ser ikke bilaget');
select test.feiler(format($$select faktura.bokfor_aarsoppgjor(%L, %L, 'x', '[{"konto": "8960", "belop": 1}, {"konto": "2050", "belop": -1}]')$$, :'org', :'a25'), 'FA403');
select test.feiler(format($$select faktura.angre_aarsoppgjor(%L, %L)$$, :'org', :'a25'), 'FA403');
select test.er((select count(*)::int from faktura.regnskap_oppsett where org_id = :'org'), 0, 'fakturerer ser ikke oppsettet');
select set_config('app.bruker_id', :'u', false);
select test.er((select count(*)::int from faktura.bilag where id = :'o3' and reversert_av is null), 1, 'årsoppgjøret står');

-- Revisjonsloggen for årsoppgjøret er for dem som fører regnskapet.
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select count(*)::int from faktura.revisjonslogg where org_id = :'org' and tabell = 'aarsoppgjor'), 0, 'fakturerer ser ikke loggen');
select set_config('app.bruker_id', :'u', false);
select test.er((select count(*) > 0 from faktura.revisjonslogg where org_id = :'org' and tabell = 'aarsoppgjor'), true, 'eieren ser loggen');

\c :migrator
drop schema test cascade;
