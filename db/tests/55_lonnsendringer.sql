-- Lønns- og stillingsendringer med virkningsdato (0080_lonnsendringer.sql): den første raden når
-- den ansatte legges inn; en endring på den ansatte blir en endring fra i dag eller fra datoen
-- API-et setter (fram i tid endrer ikke feltene før dagen kommer; tilbake i tid gjelder en senere
-- endring av samme felt fortsatt); det som gjelder en dag; eier og administrator legger inn og
-- sletter endringer (merkes som slettet; den første kan ikke slettes); de som ser lønnen og den
-- ansatte selv leser historikken; workeren tar i bruk endringer som gjelder fra i dag.

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
select id as u from faktura.registrer_bruker('uid-lonnsendr-eier', 'eier-lonnsendr@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Lønnsendring AS', '915000177') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, lonnstype, maanedslonn, stillingsprosent)
values (:'org', 'Ola', 'Endring', 'ola-lonnsendr@test.no', '2026-01-01', 'maaned', 40000, 80) returning id as ola \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, lonnstype, timelonn)
values (:'org', 'Kari', 'Time', 'kari-lonnsendr@test.no', '2026-01-01', 'time', 250) returning id as kari \gset
select faktura.inviter_ansatt(:'org', :'ola') as t_ola \gset
select faktura.inviter_medlem(:'org', 'regn-lonnsendr@test.no', 'regnskap') as t_regn \gset
select faktura.inviter_ansatt(:'org', :'kari') as t_kari \gset
select id as u_ola from faktura.registrer_bruker('uid-lonnsendr-ola', 'ola-lonnsendr@test.no') \gset
select id as u_regn from faktura.registrer_bruker('uid-lonnsendr-regn', 'regn-lonnsendr@test.no') \gset
select id as u_kari from faktura.registrer_bruker('uid-lonnsendr-kari', 'kari-lonnsendr@test.no') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'t_regn');
select set_config('app.bruker_id', :'u_kari', false);
select faktura.aksepter_invitasjon(:'t_kari');
select set_config('app.bruker_id', :'u', false);

-- Den første raden fra ansettelsen.
select test.er((select count(*)::int from faktura.lonnsendringer where ansatt_id = :'ola'), 1, 'den første raden');
select test.er((select gjelder_fra::text || ' ' || lonnstype || ' ' || maanedslonn || ' ' || stillingsprosent || ' ' || grunn
                  from faktura.lonnsendringer where ansatt_id = :'ola'), '2026-01-01 maaned 40000.00 80.00 Ansatt', 'med alle feltene');
select test.feiler(format($$insert into faktura.lonnsendringer (org_id, ansatt_id, gjelder_fra, maanedslonn) values (%L, %L, '2026-05-01', 1)$$, :'org', :'ola'), '42501');

-- Endret på den ansatte: en endring fra i dag (bare feltet som endres).
update faktura.ansatte set maanedslonn = 42000 where id = :'ola';
select test.er((select maanedslonn from faktura.lonnsendringer where ansatt_id = :'ola' and gjelder_fra = faktura.i_dag() and slettet is null), 42000.00, 'endringen i dag');
select test.er((select stillingsprosent from faktura.lonnsendringer where ansatt_id = :'ola' and gjelder_fra = faktura.i_dag() and slettet is null), null::numeric, 'bare lønnen');
select test.er((select siste_lonnsendring from faktura.ansatte where id = :'ola'), faktura.i_dag(), 'siste lønnsendring i dag');

-- Fram i tid: feltene på den ansatte endres ikke før dagen kommer.
select set_config('faktura.lonn_gjelder_fra', (faktura.i_dag() + 30)::text, false);
select set_config('faktura.lonn_grunn', 'Lønnsoppgjør', false);
update faktura.ansatte set maanedslonn = 45000 where id = :'ola';
select test.er((select maanedslonn from faktura.ansatte where id = :'ola'), 42000.00, 'fram i tid: uendret nå');
select test.er((select grunn from faktura.lonnsendringer where ansatt_id = :'ola' and gjelder_fra = faktura.i_dag() + 30 and slettet is null), 'Lønnsoppgjør', 'med grunnen');

-- Tilbake i tid: stillingen fra 1. mars, og datoen for siste stillingsendring.
select set_config('faktura.lonn_gjelder_fra', '2026-03-01', false);
select set_config('faktura.lonn_grunn', '', false);
update faktura.ansatte set stillingsprosent = 100 where id = :'ola';
select set_config('faktura.lonn_gjelder_fra', '', false);
select test.er((select stillingsprosent from faktura.ansatte where id = :'ola'), 100.00, 'tilbake i tid: endret nå');
select test.er((select siste_stillingsendring from faktura.ansatte where id = :'ola'), '2026-03-01'::date, 'siste stillingsendring');

-- En endring av lønnen 1. februar (tilbake i tid): lønnen i dag er fortsatt den fra i dag.
select (faktura.ny_lonnsendring(:'ola', '2026-02-01', null, 41000, null, null, 'Ny avtale')).id as e_feb \gset
select test.er((select maanedslonn from faktura.ansatte where id = :'ola'), 42000.00, 'den senere endringen gjelder i dag');
select test.er((select maanedslonn::text || '/' || stillingsprosent from faktura.lonn_gjeldende(:'org', :'ola', '2025-12-01')), '40000.00/80.00', 'før ansettelsen: den første');
select test.er((select maanedslonn::text || '/' || stillingsprosent from faktura.lonn_gjeldende(:'org', :'ola', '2026-02-15')), '41000.00/80.00', 'februar');
select test.er((select maanedslonn::text || '/' || stillingsprosent from faktura.lonn_gjeldende(:'org', :'ola', '2026-03-15')), '41000.00/100.00', 'mars');
select test.er((select maanedslonn::text || '/' || stillingsprosent from faktura.lonn_gjeldende(:'org', :'ola', faktura.i_dag())), '42000.00/100.00', 'i dag');
select test.er((select maanedslonn from faktura.lonn_gjeldende(:'org', :'ola', faktura.i_dag() + 31)), 45000.00, 'fram i tid');

-- Samme dato: den gamle merkes som slettet, og feltene slås sammen.
select faktura.ny_lonnsendring(:'ola', '2026-02-01', null, null, null, 90, null);
select test.er((select count(*)::int from faktura.lonnsendringer where ansatt_id = :'ola' and gjelder_fra = '2026-02-01'), 2, 'to rader for datoen');
select test.er((select maanedslonn::text || '/' || stillingsprosent || '/' || grunn from faktura.lonnsendringer
                 where ansatt_id = :'ola' and gjelder_fra = '2026-02-01' and slettet is null), '41000.00/90.00/Ny avtale', 'slått sammen');
select test.er((select slettet is not null and slettet_av = :'u'::uuid from faktura.lonnsendringer where id = :'e_feb'), true, 'den gamle er slettet');

-- Kontrollene: datoen innenfor ansettelsen, noe å endre, og lønnen for lønnstypen.
select test.feiler(format($$select faktura.ny_lonnsendring(%L, '2025-12-01', null, 50000, null, null, null)$$, :'ola'), 'FA400');
select test.feiler(format($$select faktura.ny_lonnsendring(%L, '2026-06-01', null, null, null, null, null)$$, :'ola'), 'FA400');
select test.feiler(format($$select faktura.ny_lonnsendring(%L, '2026-06-01', 'maaned', null, null, null, null)$$, :'kari'), 'FA400');
select test.feiler(format($$select faktura.ny_lonnsendring(%L, '2026-06-01', null, null, null, 0, null)$$, :'ola'), '23514');

-- Før den første raden: lønnen til en som ikke har begynt ennå, rettes (ingen ny endring); en dato
-- før ansettelsen avvises; er startdatoen flyttet tidligere, blir en endring før den første hel.
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, lonnstype, maanedslonn, stillingsprosent)
values (:'org', 'Nina', 'Ny', faktura.i_dag() + 20, 'maaned', 38000, 100) returning id as nina \gset
update faktura.ansatte set maanedslonn = 39000 where id = :'nina';
select test.er((select count(*)::int from faktura.lonnsendringer where ansatt_id = :'nina' and slettet is null), 1, 'ingen ny endring');
select test.er((select maanedslonn::text || ' ' || grunn || ' ' || (gjelder_fra = faktura.i_dag() + 20) from faktura.lonnsendringer
                 where ansatt_id = :'nina' and slettet is null), '39000.00 Ansatt true', 'den første er rettet');
select test.er((select maanedslonn::text || ' ' || coalesce(siste_lonnsendring::text, '-') from faktura.ansatte where id = :'nina'), '39000.00 -', 'på den ansatte, uten lønnsendring');
select set_config('faktura.lonn_gjelder_fra', '2025-06-01', false);
select test.feiler(format($$update faktura.ansatte set maanedslonn = 39500 where id = %L$$, :'nina'), 'FA400');
select set_config('faktura.lonn_gjelder_fra', '', false);
update faktura.ansatte set ansatt_fra = faktura.i_dag() + 10 where id = :'nina';
select faktura.ny_lonnsendring(:'nina', faktura.i_dag() + 10, null, null, null, 80, 'Deltid først');
select test.er((select lonnstype || ' ' || maanedslonn || ' ' || stillingsprosent || ' ' || grunn from faktura.lonnsendringer
                 where ansatt_id = :'nina' and gjelder_fra = faktura.i_dag() + 10 and slettet is null), 'maaned 39000.00 80.00 Deltid først', 'hel rad før den første');
select test.er((select stillingsprosent from faktura.lonn_gjeldende(:'org', :'nina', faktura.i_dag() + 15)), 80.00, 'deltid de første dagene');
select test.er((select stillingsprosent from faktura.lonn_gjeldende(:'org', :'nina', faktura.i_dag() + 25)), 100.00, 'full stilling fra den gamle første raden');
select test.er((select stillingsprosent from faktura.ansatte where id = :'nina'), 80.00, 'på den ansatte: det som gjelder når den ansatte begynner');
-- Et felt som tømmes, er ingen endring i historikken (og ingen feil).
update faktura.ansatte set maanedslonn = null where id = :'nina';
select test.er((select count(*)::int from faktura.lonnsendringer where ansatt_id = :'nina' and slettet is null), 2, 'tømt felt: ingen ny endring');

-- Bare eier og administrator endrer; regnskap og den ansatte leser.
select set_config('app.bruker_id', :'u_regn', false);
select test.feiler(format($$select faktura.ny_lonnsendring(%L, '2026-06-01', null, 50000, null, null, null)$$, :'ola'), 'FA403');
select test.er((select count(*)::int from faktura.lonnsendringer where ansatt_id = :'ola' and slettet is null), 5, 'regnskap ser historikken');
select set_config('app.bruker_id', :'u_ola', false);
select test.feiler(format($$select faktura.ny_lonnsendring(%L, '2026-06-01', null, 50000, null, null, null)$$, :'ola'), 'FA403');
select test.er((select count(*)::int from faktura.lonnsendringer where ansatt_id = :'ola' and slettet is null), 5, 'Ola ser sin egen');
select set_config('app.bruker_id', :'u_kari', false);
select test.er((select count(*)::int from faktura.lonnsendringer where ansatt_id = :'ola'), 0, 'Kari ser ikke Olas');

-- Sletting: ikke den første; den som gjelder fram i tid, forsvinner fra det som gjelder.
select set_config('app.bruker_id', :'u', false);
select test.feiler(format($$select faktura.slett_lonnsendring(id) from faktura.lonnsendringer where ansatt_id = %L and gjelder_fra = '2026-01-01'$$, :'ola'), 'FA409');
select faktura.slett_lonnsendring(id) from faktura.lonnsendringer where ansatt_id = :'ola' and gjelder_fra = faktura.i_dag() + 30 and slettet is null;
select test.er((select maanedslonn from faktura.lonn_gjeldende(:'org', :'ola', faktura.i_dag() + 31)), 42000.00, 'slettet fram i tid');
select set_config('app.bruker_id', :'u_regn', false);
select test.feiler(format($$select faktura.slett_lonnsendring(id) from faktura.lonnsendringer where ansatt_id = %L and gjelder_fra = '2026-02-01' and slettet is null$$, :'ola'), 'FA403');

-- Workeren tar i bruk endringer som gjelder fra i dag (en endring som var fram i tid).
select set_config('app.bruker_id', :'u', false);
select faktura.ny_lonnsendring(:'kari', faktura.i_dag() + 10, null, null, 275, null, 'Ny sats');
select test.er((select timelonn from faktura.ansatte where id = :'kari'), 250.00, 'ikke ennå');
select test.feiler($$select faktura.aktiver_lonnsendringer()$$, '42501');
\c :migrator
update faktura.lonnsendringer set gjelder_fra = faktura.i_dag() where gjelder_fra = faktura.i_dag() + 10 and timelonn = 275;
\c :worker
select test.er(faktura.aktiver_lonnsendringer() >= 1, true, 'tatt i bruk');
select test.er((select timelonn from faktura.ansatte where id = :'kari'), 275.00, 'den nye satsen');
select test.er((select siste_lonnsendring from faktura.ansatte where id = :'kari'), faktura.i_dag(), 'siste lønnsendring');
select test.er((select count(*)::int from faktura.lonnsendringer where ansatt_id = :'kari' and slettet is null), 2, 'ingen ny endring av synkroniseringen');

\c :migrator
drop schema test cascade;
\echo '  ok'
