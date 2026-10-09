-- Vaktbytte for lederen (0072_vaktbytte_leder.sql): eier og administrator gir bort eller bytter
-- vakter (og faste arbeidsdager) rett fra vaktplanen, uten godkjenning, også til ansatte uten
-- innlogging eller med en annen rolle, og også vakter som ikke er publisert. Den som får vakten, må
-- kunne ta den; vakter som har begynt eller har førte timer, byttes ikke. Tavla følger med, den som
-- gir bort en fast arbeidsdag får fri, og et åpent tilbud på vakten gjelder ikke lenger. Datoene
-- regnes fra i dag.

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
create function test.melding(_sql text) returns text language plpgsql as $$
begin
  execute _sql;
  return null;
exception when others then
  return sqlerrm;
end $$;
grant execute on all functions in schema test to public;

\c :api
select id as u from faktura.registrer_bruker('uid-lederbytte-eier', 'eier-lederbytte@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Lederbytte AS', '915000061') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
select faktura.i_dag() - 30 as start, faktura.i_dag() + 1 as d1, faktura.i_dag() + 2 as d2, faktura.i_dag() + 3 as d3,
       faktura.i_dag() + 4 as d4, faktura.i_dag() + 5 as d5, faktura.i_dag() + 6 as d6, faktura.i_dag() + 7 as d7,
       faktura.i_dag() + 8 as d8, faktura.i_dag() + 9 as d9 \gset
select (array_agg(d::date order by d))[1] as fx
  from generate_series(faktura.i_dag() + 12, faktura.i_dag() + 40, interval '1 day') d
 where d::date not in (select faktura.helligdager(extract(year from d)::int)) \gset

insert into faktura.ansattgrupper (org_id, navn) values (:'org', 'Sekretær') returning id as sek \gset
insert into faktura.ansattgrupper (org_id, navn, ikke_ansatt) values (:'org', 'Lege', true) returning id as lege \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, gruppe_id) values (:'org', 'Ola', 'Leder', 'ola-lederbytte@test.no', :'start', :'sek') returning id as ola \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, gruppe_id) values (:'org', 'Kari', 'Leder', :'start', :'sek') returning id as kari \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, gruppe_id) values (:'org', 'Per', 'Leder', :'start', :'sek') returning id as per \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, gruppe_id) values (:'org', 'Lise', 'Leder', :'start', :'lege') returning id as lise \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, gruppe_id) values (:'org', 'Tor', 'Leder', :'start', :'sek') returning id as tor \gset
-- Ola logger inn (den eneste); de andre har ikke innlogging.
select faktura.inviter_ansatt(:'org', :'ola') as t_ola \gset
select id as u_ola from faktura.registrer_bruker('uid-lederbytte-ola', 'ola-lederbytte@test.no') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');

-- Vaktplanen (publisert til og med d9, unntatt Pers utkast d3).
select set_config('app.bruker_id', :'u', false);
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'ola', :'d1', '08:00', '16:00') returning id as v_ola1 \gset
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'kari', :'d2', '08:00', '16:00') returning id as v_kari2 \gset
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'lise', :'d4', '09:00', '15:00') returning id as v_lise4 \gset
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'ola', :'d5', '08:00', '16:00') returning id as v_ola5 \gset
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'kari', :'d5', '10:00', '14:00') returning id as v_kari5 \gset
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'ola', :'d6', '08:00', '16:00') returning id as v_ola6 \gset
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'kari', :'d7', '08:00', '16:00') returning id as v_kari7 \gset
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'kari', :'d8', '08:00', '16:00') returning id as v_kari8 \gset
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'kari', :'d9', '08:00', '16:00') returning id as v_kari9 \gset
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'ola', faktura.i_dag(), '00:00', '00:30') returning id as v_begynt \gset
select count(*) from faktura.publiser_vakter(:'org', faktura.i_dag(), :'d9');
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'per', :'d3', '10:00', '14:00') returning id as v_per3 \gset

-- Tavla: Ola står i resepsjonen om formiddagen d1.
insert into faktura.tavle_faser (org_id, navn, fra, til, rekkefolge) values (:'org', 'Formiddag', '08:00', '12:00', 1) returning id as formiddag \gset
insert into faktura.tavle_oppgaver (org_id, navn, rekkefolge) values (:'org', 'Resepsjon', 1) returning id as resepsjon \gset
insert into faktura.tavle_plasseringer (org_id, dato, fase_id, oppgave_id, ansatt_id) values (:'org', :'d1', :'formiddag', :'resepsjon', :'ola');

-- Bare eier og administrator: ikke den ansatte selv.
select set_config('app.bruker_id', :'u_ola', false);
select test.feiler(format($$select faktura.leder_bytt_vakt(%L, %L, null, null, %L, null, null, null)$$, :'org', :'v_ola1', :'per'), 'FA403');
select test.feiler(format($$select * from faktura.leder_vaktbytte_kolleger(%L, %L, null, null)$$, :'org', :'v_ola1'), 'FA403');
select set_config('app.bruker_id', :'u', false);

-- Hvem vakten kan gis til: alle aktive (også uten innlogging og med en annen rolle), med rollen.
select test.er((select array_agg(navn || ':' || coalesce(rolle, '') order by navn) from faktura.leder_vaktbytte_kolleger(:'org', :'v_kari9', null, null)),
               array['Lise Leder:Lege', 'Ola Leder:Sekretær', 'Per Leder:Sekretær', 'Tor Leder:Sekretær'], 'alle andre aktive');
select test.er((select hindring from faktura.leder_vaktbytte_kolleger(:'org', :'v_kari5', null, null) where ansatt_id = :'ola'),
               'Ola Leder har en annen vakt som overlapper', 'Ola har en vakt som overlapper d5');

-- Ola gir bort vakten d1 til Per (uten innlogging): vakten og plassen på tavla flyttes, og byttet
-- står som godkjent av lederen.
select (faktura.leder_bytt_vakt(:'org', :'v_ola1', null, null, :'per', null, null, ' Per tar denne ')).id as b1 \gset
select test.er((select ansatt_id from faktura.vakter where id = :'v_ola1'), :'per'::uuid, 'Per har vakten');
select test.er((select ansatt_id from faktura.tavle_plasseringer where dato = :'d1' and fase_id = :'formiddag'), :'per'::uuid, 'Per står i resepsjonen');
select test.er((select status || ':' || fra_ansatt || ':' || tatt_av || ':' || behandlet_av || ':' || melding || ':' || av_leder from faktura.vaktbytter where id = :'b1'),
               format('godkjent:%s:%s:%s:Per tar denne:true', :'ola', :'per', :'u'), 'godkjent av lederen');
select test.er((select av_leder from faktura.vaktbytte_liste(:'org') where id = :'b1'), true, 'listen viser at lederen gjorde byttet');

-- Bytte på tvers av roller: Karis vakt d2 mot legens vakt d4.
select faktura.leder_bytt_vakt(:'org', :'v_kari2', null, null, :'lise', :'v_lise4', null, null);
select test.er((select ansatt_id from faktura.vakter where id = :'v_kari2'), :'lise'::uuid, 'Lise har d2');
select test.er((select ansatt_id from faktura.vakter where id = :'v_lise4'), :'kari'::uuid, 'Kari har d4');

-- Et utkast (ikke publisert) kan også gis bort.
select faktura.leder_bytt_vakt(:'org', :'v_per3', null, null, :'ola', null, null, null);
select test.er((select ansatt_id::text || ':' || (publisert_at is null) from faktura.vakter where id = :'v_per3'), :'ola' || ':true', 'Ola har utkastet');

-- Den som får vakten, må kunne ta den.
select test.er(test.melding(format($$select faktura.leder_bytt_vakt(%L, %L, null, null, %L, null, null, null)$$, :'org', :'v_kari5', :'ola')),
               'Ola Leder har en annen vakt som overlapper', 'overlapp');
insert into faktura.fravaer (org_id, ansatt_id, type, fra, til) values (:'org', :'per', 'ferie', :'d7', :'d7');
select test.er(test.melding(format($$select faktura.leder_bytt_vakt(%L, %L, null, null, %L, null, null, null)$$, :'org', :'v_kari7', :'per')),
               'Per Leder er borte denne dagen', 'borte');
select test.er(test.melding(format($$select faktura.leder_bytt_vakt(%L, %L, null, null, %L, null, null, null)$$, :'org', :'v_kari7', :'kari')),
               'Velg en annen enn den som har vakten', 'ikke til den som har den');
-- Vakter som har begynt, eller har førte timer, byttes ikke.
select test.feiler(format($$select faktura.leder_bytt_vakt(%L, %L, null, null, %L, null, null, null)$$, :'org', :'v_begynt', :'tor'), 'FA409');
-- Bare til ansatte i organisasjonen.
select test.feiler(format($$select faktura.leder_bytt_vakt(%L, %L, null, null, %L, null, null, null)$$, :'org', :'v_kari9', gen_random_uuid()), 'FA404');
insert into faktura.timeforinger (org_id, ansatt_id, dato, fra, til, vakt_id) values (:'org', :'kari', :'d8', '08:00', '16:00', :'v_kari8');
select test.er(test.melding(format($$select faktura.leder_bytt_vakt(%L, %L, null, null, %L, null, null, null)$$, :'org', :'v_kari8', :'tor')),
               'Timene for vakten er ført, så den kan ikke byttes', 'timer ført');

-- Et åpent tilbud fra den ansatte gjelder ikke lenger når lederen gir bort vakten.
select set_config('app.bruker_id', :'u_ola', false);
select (faktura.tilby_vaktbytte(:'org', :'v_ola6', null, null, null, null, null)).id as tilbud \gset
select set_config('app.bruker_id', :'u', false);
select faktura.leder_bytt_vakt(:'org', :'v_ola6', null, null, :'tor', null, null, null);
select test.er((select status from faktura.vaktbytter where id = :'tilbud'), 'utgatt', 'tilbudet er utgått');

-- En fast arbeidsdag: Tor jobber 08–12 alle dager fra fx. Lederen gir den bort til Kari (den blir
-- en vakt), og Tor har fri den dagen.
insert into faktura.arbeidsplaner (org_id, ansatt_id, gjelder_fra) values (:'org', :'tor', :'fx') returning id as plan \gset
insert into faktura.arbeidsplan_dager (org_id, plan_id, ukedag, fra, til) select :'org', :'plan', g, '08:00', '12:00' from generate_series(1, 7) g;
select (faktura.leder_bytt_vakt(:'org', null, :'tor', :'fx', :'kari', null, null, null)).vakt_id as v_tor_x \gset
select test.er((select ansatt_id::text || ' ' || to_char(fra, 'HH24:MI') || '-' || to_char(til, 'HH24:MI') from faktura.vakter where id = :'v_tor_x'),
               :'kari' || ' 08:00-12:00', 'Kari har den faste dagen som vakt');
select test.er((select count(*) from faktura.arbeidsplan_fri where ansatt_id = :'tor' and dato = :'fx'), 1::bigint, 'Tor har fri');

-- Vaktene (og de faste dagene) til en kollega som vakten kan byttes mot.
select test.er((select array_agg(coalesce(vakt_id::text, 'fast') || ':' || coalesce(hindring, '') order by dato)
                  from faktura.leder_vaktbytte_kandidater(:'org', :'v_kari9', null, null, :'ola', faktura.i_dag(), :'d9')),
               array[:'v_per3' || ':', :'v_ola5' || ':Kari Leder har en annen vakt som overlapper'], 'Olas vakter: utkastet d3, og d5 (Kari har d5)');
select test.er((select count(*) > 0 and bool_and(vakt_id is null and hindring is null)
                  from faktura.leder_vaktbytte_kandidater(:'org', :'v_kari9', null, null, :'tor', :'fx'::date + 1, :'fx'::date + 7)), true, 'Tors faste dager');
select test.feiler(format($$select * from faktura.leder_vaktbytte_kandidater(%L, %L, null, null, %L, faktura.i_dag(), faktura.i_dag() + 120)$$, :'org', :'v_kari9', :'ola'), 'FA400');

\c :migrator
drop schema test cascade;
\echo '  ok'
