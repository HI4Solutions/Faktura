-- Fridagen ved vaktbytte (0074_vaktbytte_fridag.sql): den som gir bort en fast arbeidsdag uten å
-- få en vakt igjen, velger hva fridagen tas fra (en feriedag, timebanken eller betalt fravær; med
-- timelønn også fri uten lønn). Feriedagene og timene sjekkes (det som er valgt i bytter som venter,
-- regnes som brukt), og fraværet registreres når byttet går gjennom. Et bytte med fravær må
-- godkjennes også når vaktbytte ellers går uten godkjenning. Ikke for bytter, vakter utenom den
-- faste planen eller når organisasjonen ikke spør. Lederen kan velge fridagen selv i vaktplanen.
-- Permisjon med lønn har timene. Datoene regnes fra i dag.

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
select id as u from faktura.registrer_bruker('uid-fridag-eier', 'eier-fridag@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Fridag AS', '915000096') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
update faktura.lonn_oppsett set timebank = true where org_id = :'org';
-- Hverdagene (ikke helligdager) fra en uke fram, i samme år.
select faktura.i_dag() - 60 as start,
       case when faktura.i_dag() + 7 > make_date(extract(year from faktura.i_dag())::int, 12, 10)
            then make_date(extract(year from faktura.i_dag())::int + 1, 1, 10) else faktura.i_dag() + 7 end as fra0 \gset
select d[1] as d1, d[2] as d2, d[3] as d3, d[4] as d4, d[5] as d5, d[6] as d6, d[7] as d7, d[8] as d8, d[9] as d9,
       extract(year from d[1])::int as aar
  from (select array_agg(x::date order by x) as d
          from generate_series(:'fra0'::date, :'fra0'::date + 30, interval '1 day') x
         where extract(isodow from x) <= 5 and x::date not in (select faktura.helligdager(extract(year from x)::int))) h \gset
select (array_agg(x::date order by x))[1] as lor1, (array_agg(x::date order by x))[2] as lor2
  from generate_series(:'fra0'::date, :'fra0'::date + 30, interval '1 day') x where extract(isodow from x) = 6 \gset

insert into faktura.ansattgrupper (org_id, navn) values (:'org', 'Sekretær') returning id as sek \gset
-- Kari har fastlønn og én feriedag i året; Ola timelønn; Per tar vaktene.
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, gruppe_id, lonnstype, maanedslonn, ferie_dager)
values (:'org', 'Kari', 'Fri', 'kari-fridag@test.no', :'start', :'sek', 'maaned', 50000, 1) returning id as kari \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, gruppe_id, lonnstype, timelonn)
values (:'org', 'Ola', 'Fri', 'ola-fridag@test.no', :'start', :'sek', 'time', 250) returning id as ola \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, gruppe_id, lonnstype, maanedslonn)
values (:'org', 'Per', 'Fri', 'per-fridag@test.no', :'start', :'sek', 'maaned', 45000) returning id as per \gset
select faktura.inviter_ansatt(:'org', :'kari') as t_kari, faktura.inviter_ansatt(:'org', :'ola') as t_ola, faktura.inviter_ansatt(:'org', :'per') as t_per \gset
select id as u_kari from faktura.registrer_bruker('uid-fridag-kari', 'kari-fridag@test.no') \gset
select id as u_ola from faktura.registrer_bruker('uid-fridag-ola', 'ola-fridag@test.no') \gset
select id as u_per from faktura.registrer_bruker('uid-fridag-per', 'per-fridag@test.no') \gset
select set_config('app.bruker_id', :'u_kari', false);
select faktura.aksepter_invitasjon(:'t_kari');
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');
select set_config('app.bruker_id', :'u_per', false);
select faktura.aksepter_invitasjon(:'t_per');

-- De faste dagene: Kari 08–16 med en halvtimes pause (7,5 t), Ola 08–12 (4 t), mandag til fredag.
select set_config('app.bruker_id', :'u', false);
insert into faktura.arbeidsplaner (org_id, ansatt_id, gjelder_fra) values (:'org', :'kari', :'start') returning id as plan_kari \gset
insert into faktura.arbeidsplan_dager (org_id, plan_id, ukedag, fra, til, pause_min) select :'org', :'plan_kari', g, '08:00', '16:00', 30 from generate_series(1, 5) g;
insert into faktura.arbeidsplaner (org_id, ansatt_id, gjelder_fra) values (:'org', :'ola', :'start') returning id as plan_ola \gset
insert into faktura.arbeidsplan_dager (org_id, plan_id, ukedag, fra, til) select :'org', :'plan_ola', g, '08:00', '12:00' from generate_series(1, 5) g;
-- Kari har 10 t i timebanken. En lørdagsvakt til Kari (utenom planen) og en til Per (å bytte mot).
insert into faktura.timebank_poster (org_id, ansatt_id, dato, type, timer, tekst) values (:'org', :'kari', :'start', 'justering', 10, 'Fra før');
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'kari', :'lor1', '10:00', '14:00') returning id as v_kari_lor \gset
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'per', :'lor2', '10:00', '14:00') returning id as v_per_lor \gset
select count(*) from faktura.publiser_vakter(:'org', :'lor1', :'lor2');

-- Hva fridagen kan tas fra: Kari får fri på en fast dag, og spørres.
select set_config('app.bruker_id', :'u_kari', false);
select test.er((select array[fridag::text, sporres::text, timer::text, lonnstype, ferie_aar::text, ferie_igjen::text, timebank::text, timebank_igjen::text]
                  from faktura.vaktbytte_fridag(:'org', :'kari', null, :'d1')),
               array['true', 'true', '7.50', 'maaned', :'aar', '1.0', 'true', '10.00'], 'Kari på en fast dag');
select test.er((select fridag from faktura.vaktbytte_fridag(:'org', :'kari', :'v_kari_lor', null)), false, 'lørdagsvakten er utenom planen');
select test.feiler(format($$select * from faktura.vaktbytte_fridag(%L, %L, null, %L)$$, :'org', :'ola', :'d1'), 'FA404');

-- Med fastlønn må fridagen tas fra noe.
select test.er(test.melding(format($$select faktura.tilby_vaktbytte(%L, null, %L, null, null, null, null)$$, :'org', :'d1')),
               'Velg hva du tar fridagen fra: en feriedag, timebanken eller betalt fravær', 'må velge');
select test.er(test.melding(format($$select faktura.tilby_vaktbytte(%L, null, %L, null, null, null, null, 'uten_lonn')$$, :'org', :'d1')),
               'Med fastlønn tas fridagen fra ferien, timebanken eller som betalt fravær', 'ikke uten lønn med fastlønn');
select test.er((select count(*) from faktura.vakter where ansatt_id = :'kari' and dato = :'d1'), 0::bigint, 'den faste dagen er ikke gjort til vakt');

-- Ferie d1: den ene feriedagen er nå valgt, så den neste stopper.
select (faktura.tilby_vaktbytte(:'org', null, :'d1', null, null, null, null, 'ferie', 'ikke brukt')).id as b1 \gset
select test.er((select fri || ':' || coalesce(fri_timer::text, '-') || ':' || coalesce(fri_grunn, '-') from faktura.vaktbytter where id = :'b1'), 'ferie:-:-', 'ferie uten timer og grunn');
select test.er((select ferie_igjen from faktura.vaktbytte_fridag(:'org', :'kari', null, :'d2')), 0::numeric, 'feriedagen er valgt');
select test.er(test.melding(format($$select faktura.tilby_vaktbytte(%L, null, %L, null, null, null, null, 'ferie')$$, :'org', :'d2')),
               format('Du har ingen feriedager igjen i %s (utenom 1 du har valgt i andre vaktbytter)', :'aar'), 'ingen feriedager igjen');

-- Timebanken d2: 7,5 t er søkt om, så det er 2,5 t igjen til d3.
select (faktura.tilby_vaktbytte(:'org', null, :'d2', null, null, null, 'Kan noen ta fredagen?', 'avspasering')).id as b2 \gset
select test.er((select fri || ':' || fri_timer from faktura.vaktbytter where id = :'b2'), 'avspasering:7.50', 'avspasering med timene');
select test.er((select array[saldo, sokt] from faktura.timebank(:'org') where ansatt_id = :'kari'), array[10, 7.5]::numeric[], 'søkt om i timebanken');
select test.er(test.melding(format($$select faktura.tilby_vaktbytte(%L, null, %L, null, null, null, null, 'avspasering')$$, :'org', :'d3')),
               'Vakten er 7,5 t, og du har 2,5 t i timebanken (utenom 7,5 t du har søkt om fra før)', 'for lite i timebanken');

-- Betalt fravær d3 trenger en grunn.
select test.er(test.melding(format($$select faktura.tilby_vaktbytte(%L, null, %L, null, null, null, null, 'betalt', '  ')$$, :'org', :'d3')),
               'Skriv hva det betalte fraværet gjelder', 'betalt trenger grunn');
select (faktura.tilby_vaktbytte(:'org', null, :'d3', :'per', null, null, null, 'betalt', ' Begravelse ')).id as b3 \gset
select test.er((select fri || ':' || fri_timer || ':' || fri_grunn from faktura.vaktbytter where id = :'b3'), 'betalt:7.50:Begravelse', 'betalt med grunn');

-- Et bytte (en vakt igjen) og en vakt utenom planen gir ikke fridag: valget blir borte.
select (faktura.tilby_vaktbytte(:'org', null, :'d8', :'per', :'v_per_lor', null, null, 'ferie')).id as b_bytt \gset
select test.er((select fri from faktura.vaktbytter where id = :'b_bytt'), null::text, 'ikke ved bytte');
select (faktura.tilby_vaktbytte(:'org', :'v_kari_lor', null, null, null, null, null, 'ferie')).id as b_lor \gset
select test.er((select fri from faktura.vaktbytter where id = :'b_lor'), null::text, 'ikke utenom planen');

-- Kollegaen ser ikke valget; Kari og lederen ser det.
select test.er((select fri from faktura.vaktbytte_liste(:'org') where id = :'b1'), 'ferie', 'Kari ser valget');
select set_config('app.bruker_id', :'u_per', false);
select test.er((select count(*)::text || ':' || count(fri)::text from faktura.vaktbytte_liste(:'org') where id in (:'b1', :'b3')), '2:0', 'Per ser ikke valget');

-- Med godkjenning: Per tar d1, og lederen godkjenner. Kari har ferie d1, og banken teller den.
select faktura.svar_vaktbytte(:'org', :'b1', true);
select test.er((select status from faktura.vaktbytter where id = :'b1'), 'akseptert', 'venter på godkjenning');
select set_config('app.bruker_id', :'u', false);
select test.er((select fri from faktura.vaktbytte_liste(:'org') where id = :'b1'), 'ferie', 'lederen ser valget');
select faktura.behandle_vaktbytte(:'org', :'b1', true, null);
select test.er((select ansatt_id from faktura.vakter where ansatt_id = :'per' and dato = :'d1'), :'per'::uuid, 'Per har vakten');
select test.er((select count(*) from faktura.arbeidsplan_fri where ansatt_id = :'kari' and dato = :'d1'), 1::bigint, 'Kari har fri');
select test.er((select f.type || ':' || f.notat || ':' || (f.timer is null) || ':' || f.betalt || ':' || (b.fravaer_id = f.id)
                  from faktura.fravaer f join faktura.vaktbytter b on b.id = :'b1' where f.ansatt_id = :'kari' and f.fra = :'d1'),
               'ferie:Vaktbytte: Per Fri tok vakten:true:false:true', 'ferien er registrert');
select test.er((select planlagt from faktura.feriebank(:'org', :'aar') where ansatt_id = :'kari'), 1::numeric, 'feriebanken teller dagen');

-- Uten godkjenning går byttet gjennom med en gang, men ikke når fridagen tas fra timebanken.
update faktura.lonn_oppsett set vaktbytte = 'fritt' where org_id = :'org';
select set_config('app.bruker_id', :'u_per', false);
select faktura.svar_vaktbytte(:'org', :'b2', true);
select test.er((select status from faktura.vaktbytter where id = :'b2'), 'akseptert', 'timebanken må godkjennes');
select set_config('app.bruker_id', :'u', false);
select faktura.behandle_vaktbytte(:'org', :'b2', true, null);
select test.er((select type || ':' || timer from faktura.fravaer where ansatt_id = :'kari' and fra = :'d2'), 'avspasering:7.50', 'avspaseringen er registrert');
select test.er((select array[saldo, sokt] from faktura.timebank(:'org') where ansatt_id = :'kari'), array[2.5, 0]::numeric[], 'tatt fra timebanken');

-- Betalt fravær d3: permisjon med lønn, med timene og grunnen.
select set_config('app.bruker_id', :'u_per', false);
select faktura.svar_vaktbytte(:'org', :'b3', true);
select set_config('app.bruker_id', :'u', false);
select faktura.behandle_vaktbytte(:'org', :'b3', true, null);
select test.er((select type || ':' || betalt || ':' || timer || ':' || notat from faktura.fravaer where ansatt_id = :'kari' and fra = :'d3'),
               'permisjon:true:7.50:Begravelse · Vaktbytte: Per Fri tok vakten', 'permisjon med lønn');

-- Ola (timelønn): uten valg er dagen fri uten lønn, og byttet går gjennom med en gang uten fravær.
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select lonnstype from faktura.vaktbytte_fridag(:'org', :'ola', null, :'d4')), 'time', 'Ola har timelønn');
select (faktura.tilby_vaktbytte(:'org', null, :'d4', null, null, null, null)).id as b4 \gset
select test.er((select fri from faktura.vaktbytter where id = :'b4'), 'uten_lonn', 'uten lønn');
select (faktura.tilby_vaktbytte(:'org', null, :'d5', null, null, null, null, 'betalt', 'Legetime')).id as b5 \gset
select set_config('app.bruker_id', :'u_per', false);
select faktura.svar_vaktbytte(:'org', :'b4', true);
select test.er((select status from faktura.vaktbytter where id = :'b4'), 'godkjent', 'fri uten lønn går rett gjennom');
select test.er((select count(*) from faktura.fravaer where ansatt_id = :'ola' and fra = :'d4'), 0::bigint, 'ikke noe fravær');
select test.er((select count(*) from faktura.arbeidsplan_fri where ansatt_id = :'ola' and dato = :'d4'), 1::bigint, 'Ola har fri');
select faktura.svar_vaktbytte(:'org', :'b5', true);
select test.er((select status from faktura.vaktbytter where id = :'b5'), 'akseptert', 'betalt fravær må godkjennes');
select set_config('app.bruker_id', :'u', false);
select faktura.behandle_vaktbytte(:'org', :'b5', true, null);
select test.er((select type || ':' || betalt || ':' || timer from faktura.fravaer where ansatt_id = :'ola' and fra = :'d5'), 'permisjon:true:4.00', 'Olas timer lønnes');

-- Når organisasjonen ikke spør, blir ingenting valgt og ingenting registrert.
update faktura.lonn_oppsett set vaktbytte_fridag = false where org_id = :'org';
select set_config('app.bruker_id', :'u_kari', false);
select test.er((select fridag::text || ':' || sporres::text from faktura.vaktbytte_fridag(:'org', :'kari', null, :'d6')), 'true:false', 'spørres ikke');
select (faktura.tilby_vaktbytte(:'org', null, :'d6', null, null, null, null, 'ferie')).id as b6 \gset
select test.er((select fri from faktura.vaktbytter where id = :'b6'), null::text, 'ikke noe valg');
select set_config('app.bruker_id', :'u_per', false);
select faktura.svar_vaktbytte(:'org', :'b6', true);
select test.er((select status from faktura.vaktbytter where id = :'b6'), 'godkjent', 'går rett gjennom');
select test.er((select count(*) from faktura.fravaer where ansatt_id = :'kari' and fra = :'d6'), 0::bigint, 'ikke noe fravær');

-- Lederen gir bort Karis faste dag d7 i vaktplanen og velger ferie (forbi feriebanken); avspasering
-- trenger timebanken, og betalt fravær kan stå uten grunn.
select set_config('app.bruker_id', :'u', false);
select faktura.leder_bytt_vakt(:'org', null, :'kari', :'d7', :'per', null, null, null, 'ferie', null);
select test.er((select type from faktura.fravaer where ansatt_id = :'kari' and fra = :'d7'), 'ferie', 'lederen valgte ferie');
update faktura.lonn_oppsett set timebank = false where org_id = :'org';
select test.er(test.melding(format($$select faktura.leder_bytt_vakt(%L, null, %L, %L, %L, null, null, null, 'avspasering', null)$$, :'org', :'ola', :'d9', :'per')),
               'Timebanken er ikke slått på (Innstillinger → Ansatte og timer)', 'avspasering trenger timebanken');
select faktura.leder_bytt_vakt(:'org', null, :'ola', :'d9', :'per', null, null, null, 'betalt', null);
select test.er((select type || ':' || betalt || ':' || timer || ':' || notat from faktura.fravaer where ansatt_id = :'ola' and fra = :'d9'),
               'permisjon:true:4.00:Vaktbytte: Per Fri tok vakten', 'lederen ga permisjon med lønn');

-- Permisjon med lønn trenger timene; annet fravær er ikke betalt og har ikke timer.
select test.er(test.melding(format($$insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, betalt) values (%L, %L, 'permisjon', %L, %L, true)$$,
                                   :'org', :'per', :'d8', :'d8')), 'Skriv hvor mange timer permisjonen med lønn gjelder', 'timene mangler');
insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, betalt, timer) values (:'org', :'per', 'ferie', :'d8', :'d8', true, 3) returning id as f_per \gset
select test.er((select betalt::text || ':' || coalesce(timer::text, '-') from faktura.fravaer where id = :'f_per'), 'false:-', 'ferie er ikke betalt permisjon');
update faktura.fravaer set type = 'permisjon', betalt = true, timer = 7.5 where id = :'f_per';
update faktura.fravaer set type = 'kurs' where id = :'f_per';
select test.er((select type || ':' || betalt::text || ':' || coalesce(timer::text, '-') from faktura.fravaer where id = :'f_per'), 'kurs:false:-', 'ny type: ikke betalt');

\c :migrator
drop schema test cascade;
\echo '  ok'
