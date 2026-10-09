-- Årsoversikten (0075_lonn_aarsoversikt.sql): de som får varsel (de ansatte med innlogging og lønn
-- i året fra godkjente kjøringer), når den daglige jobben varsler (lønn i året, ingen kjøring
-- som utkast eller 25. januar, ikke varslet før), hvem som ser og skriver når de ble varslet, og
-- når trekktabellene mangler.

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
select id as u from faktura.registrer_bruker('uid-aar-eier', 'eier-aar@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Årsoversikt AS', '915000118') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);

insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, lonnstype, maanedslonn, kontonr)
values (:'org', 'Ola', 'År', 'ola-aar@test.no', '2026-01-01', 'maaned', 50000, '12345678903') returning id as ola \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, lonnstype, timelonn)
values (:'org', 'Kari', 'År', 'kari-aar@test.no', '2026-01-01', 'time', 250) returning id as kari \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, lonnstype, timelonn)
values (:'org', 'Per', 'Uten', '2026-01-01', 'time', 200) returning id as per \gset

select faktura.inviter_ansatt(:'org', :'ola') as t_ola \gset
select faktura.inviter_ansatt(:'org', :'kari') as t_kari \gset
select faktura.inviter_medlem(:'org', 'regn-aar@test.no', 'regnskap') as t_regn \gset
select id as u_ola from faktura.registrer_bruker('uid-aar-ola', 'ola-aar@test.no') \gset
select id as u_kari from faktura.registrer_bruker('uid-aar-kari', 'kari-aar@test.no') \gset
select id as u_regn from faktura.registrer_bruker('uid-aar-regn', 'regn-aar@test.no') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');
select set_config('app.bruker_id', :'u_kari', false);
select faktura.aksepter_invitasjon(:'t_kari');
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'t_regn');

-- November er godkjent for alle tre; desember er et utkast (bare Ola).
select set_config('app.bruker_id', :'u', false);
insert into faktura.lonnskjoringer (org_id, periode, utbetalingsdato) values (:'org', '2030-11-01', '2030-11-20') returning id as k11 \gset
insert into faktura.lonnsslipper (org_id, kjoring_id, ansatt_id, navn, ansattnummer, lonnstype, periode, utbetalingsdato, brutto, netto)
values (:'org', :'k11', :'ola', 'Ola År', 1, 'maaned', '2030-11-01', '2030-11-20', 50000, 39000),
       (:'org', :'k11', :'kari', 'Kari År', 2, 'time', '2030-11-01', '2030-11-20', 3750, 3750),
       (:'org', :'k11', :'per', 'Per Uten', 3, 'time', '2030-11-01', '2030-11-20', 2000, 2000);
select faktura.lonn_godkjenn(:'k11');
insert into faktura.lonnskjoringer (org_id, periode, utbetalingsdato) values (:'org', '2030-12-01', '2030-12-20') returning id as k12 \gset
insert into faktura.lonnsslipper (org_id, kjoring_id, ansatt_id, navn, ansattnummer, lonnstype, periode, utbetalingsdato, brutto, netto)
values (:'org', :'k12', :'ola', 'Ola År', 1, 'maaned', '2030-12-01', '2030-12-20', 50000, 39000);

-- Mottakerne: Ola og Kari (Per har ikke innlogging). Bare eier og administrator (og workeren).
select test.er((select array_agg(ansatt_id order by ansatt_id) from faktura.aarsoversikt_mottakere(:'org', 2030)),
               (select array_agg(x order by x) from unnest(array[:'ola', :'kari']::uuid[]) x), 'Ola og Kari får varsel');
select test.er((select count(*)::int from faktura.aarsoversikt_mottakere(:'org', 2029)), 0, 'ingen i et år uten lønn');
select set_config('app.bruker_id', :'u_regn', false);
select test.feiler(format($$select * from faktura.aarsoversikt_mottakere(%L, 2030)$$, :'org'), 'FA403');
select set_config('app.bruker_id', :'u_ola', false);
select test.feiler(format($$select * from faktura.aarsoversikt_mottakere(%L, 2030)$$, :'org'), 'FA403');
-- Bare workeren spør hvem som skal varsles.
select set_config('app.bruker_id', :'u', false);
select test.feiler($$select * from faktura.aarsoversikt_klar(2030, '2031-01-25')$$, '42501');

-- Den daglige jobben: desember er et utkast, så organisasjonen venter til 25. januar.
\c :worker
select test.er((select count(*)::int from faktura.aarsoversikt_klar(2030, '2031-01-10') where org_id = :'org'), 0, 'venter på utkastet');
select test.er((select count(*)::int from faktura.aarsoversikt_klar(2030, '2031-01-25') where org_id = :'org'), 1, 'senest 25. januar');
select test.er((select count(*)::int from faktura.aarsoversikt_klar(2029, '2030-01-25') where org_id = :'org'), 0, 'ikke for et år uten lønn');
select test.er((select count(*)::int from faktura.aarsoversikt_mottakere(:'org', 2030)), 2, 'workeren ser mottakerne');

-- Desember godkjennes: da er organisasjonen klar 10. januar.
\c :api
select set_config('app.bruker_id', :'u', false);
select faktura.lonn_godkjenn(:'k12');
\c :worker
select test.er((select count(*)::int from faktura.aarsoversikt_klar(2030, '2031-01-10') where org_id = :'org'), 1, 'klar når alt er godkjent');
insert into faktura.lonn_aarsoversikt_varslet (org_id, aar, antall) values (:'org', 2030, 2);
select test.er((select count(*)::int from faktura.aarsoversikt_klar(2030, '2031-01-25') where org_id = :'org'), 0, 'ikke igjen når de er varslet');

-- Når de ble varslet: de som ser lønnen leser det; eier og administrator skriver det.
\c :api
select set_config('app.bruker_id', :'u_regn', false);
select test.er((select antall from faktura.lonn_aarsoversikt_varslet where org_id = :'org' and aar = 2030), 2, 'regnskap ser når de ble varslet');
with x as (update faktura.lonn_aarsoversikt_varslet set antall = 9 where org_id = :'org' returning 1)
select test.er((select count(*)::int from x), 0, 'regnskap endrer det ikke');
select test.feiler(format($$insert into faktura.lonn_aarsoversikt_varslet (org_id, aar) values (%L, 2029)$$, :'org'), '42501');
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select count(*)::int from faktura.lonn_aarsoversikt_varslet), 0, 'den ansatte ser det ikke');
select set_config('app.bruker_id', :'u', false);
update faktura.lonn_aarsoversikt_varslet set varslet = now(), varslet_av = :'u', antall = 2 where org_id = :'org' and aar = 2030;
select test.er((select varslet_av from faktura.lonn_aarsoversikt_varslet where org_id = :'org' and aar = 2030), :'u'::uuid, 'eieren varslet på nytt');

-- Den ansatte ser sine egne slipper fra de godkjente kjøringene (til årsoversikten).
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select count(*)::int from faktura.lonnsslipper where extract(year from utbetalingsdato) = 2030 and not faktura.lonn_utkast(kjoring_id)), 2,
               'Ola ser to slipper i 2030');

-- Trekktabellene mangler for et år når noen med lønn har tabelltrekk; bare workeren spør.
\c :api
select set_config('app.bruker_id', :'u', false);
update faktura.ansatte set skattekort = 'tabell', skatt_tabell = 7100, skatt_prosent = 34, skattekort_aar = 2030 where id = :'ola';
select test.feiler($$select faktura.trekktabeller_mangler(2035)$$, '42501');
\c :worker
select test.er(faktura.trekktabeller_mangler(2035), true, 'tabellene for 2035 mangler');
\c :api
select set_config('app.betrodd', 'on', false);
select test.er(faktura.trekktabell_last(2035, true, array[7100], array[0], array[0]), 1, 'lastet inn');
\c :worker
select test.er(faktura.trekktabeller_mangler(2035), false, 'lastet inn for 2035');

\c :migrator
delete from faktura.trekktabeller where aar = 2035;
drop schema test cascade;
\echo '  ok'
