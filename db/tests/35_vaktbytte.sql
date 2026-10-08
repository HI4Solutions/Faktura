-- Vaktbytte (0060_vaktbytte.sql): den ansatte gir bort eller bytter en vakt (eller en fast
-- arbeidsdag) med en kollega med samme rolle; kollegaen tar den, bytter eller sier nei takk, og
-- eier eller administrator godkjenner (eller ikke, etter innstillingen). Vakten flyttes, plassene på
-- tavla følger med, og den som ga bort en fast arbeidsdag, har fri den dagen. Datoene regnes fra i
-- dag, så testene ikke avhenger av når de kjøres.

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
-- Feilmeldingen (eller null).
create function test.melding(_sql text) returns text language plpgsql as $$
begin
  execute _sql;
  return null;
exception when others then
  return sqlerrm;
end $$;
grant execute on all functions in schema test to public;

\c :api
select id as u from faktura.registrer_bruker('uid-bytte-eier', 'eier-bytte@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Vaktbytte AS', '917654301') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
select test.er((select vaktbytte from faktura.lonn_oppsett where org_id = :'org'), 'godkjenning', 'standard: lederen godkjenner');
select faktura.i_dag() - 30 as start, faktura.i_dag() + 1 as d1, faktura.i_dag() + 2 as d2, faktura.i_dag() + 3 as d3,
       faktura.i_dag() + 4 as d4, faktura.i_dag() + 5 as d5 \gset
-- Tre dager som ikke er helligdager, til de faste arbeidsdagene.
select (array_agg(d::date order by d))[1] as fx, (array_agg(d::date order by d))[2] as fy, (array_agg(d::date order by d))[3] as fz
  from generate_series(faktura.i_dag() + 10, faktura.i_dag() + 40, interval '1 day') d
 where d::date not in (select faktura.helligdager(extract(year from d)::int)) \gset

insert into faktura.ansattgrupper (org_id, navn) values (:'org', 'Sekretær') returning id as sek \gset
insert into faktura.ansattgrupper (org_id, navn, ikke_ansatt) values (:'org', 'Lege', true) returning id as lege \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, gruppe_id) values (:'org', 'Ola', 'Bytte', 'ola-bytte@test.no', :'start', :'sek') returning id as ola \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, gruppe_id) values (:'org', 'Kari', 'Bytte', 'kari-bytte@test.no', :'start', :'sek') returning id as kari \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, gruppe_id) values (:'org', 'Siri', 'Bytte', 'siri-bytte@test.no', :'start', :'sek') returning id as siri \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, gruppe_id) values (:'org', 'Per', 'Uten', :'start', :'sek') returning id as per \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, gruppe_id) values (:'org', 'Lise', 'Lege', 'lise-bytte@test.no', :'start', :'lege') returning id as lise \gset

-- Alle unntatt Per logger inn.
select faktura.inviter_ansatt(:'org', :'ola') as t_ola \gset
select faktura.inviter_ansatt(:'org', :'kari') as t_kari \gset
select faktura.inviter_ansatt(:'org', :'siri') as t_siri \gset
select faktura.inviter_ansatt(:'org', :'lise') as t_lise \gset
select id as u_ola from faktura.registrer_bruker('uid-bytte-ola', 'ola-bytte@test.no') \gset
select id as u_kari from faktura.registrer_bruker('uid-bytte-kari', 'kari-bytte@test.no') \gset
select id as u_siri from faktura.registrer_bruker('uid-bytte-siri', 'siri-bytte@test.no') \gset
select id as u_lise from faktura.registrer_bruker('uid-bytte-lise', 'lise-bytte@test.no') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');
select set_config('app.bruker_id', :'u_kari', false);
select faktura.aksepter_invitasjon(:'t_kari');
select set_config('app.bruker_id', :'u_siri', false);
select faktura.aksepter_invitasjon(:'t_siri');
select set_config('app.bruker_id', :'u_lise', false);
select faktura.aksepter_invitasjon(:'t_lise');

-- Vaktplanen.
select set_config('app.bruker_id', :'u', false);
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'ola', :'d1', '08:00', '16:00') returning id as v_ola1 \gset
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'kari', :'d1', '18:00', '22:00') returning id as v_kari1 \gset
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'kari', :'d2', '08:00', '16:00') returning id as v_kari2 \gset
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'ola', :'d3', '08:00', '16:00') returning id as v_ola3 \gset
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'ola', :'d4', '08:00', '16:00') returning id as v_ola4 \gset
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'kari', :'d4', '10:00', '14:00') returning id as v_kari4 \gset
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'ola', :'d5', '08:00', '16:00') returning id as v_ola5 \gset
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'lise', :'d1', '08:00', '16:00') returning id as v_lise1 \gset
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'ola', faktura.i_dag(), '00:00', '00:30') returning id as v_begynt \gset
select count(*) from faktura.publiser_vakter(:'org', faktura.i_dag(), :'d5');
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'ola', :'d2', '18:00', '20:00') returning id as v_utkast \gset

-- Tavla: Ola står i resepsjonen om formiddagen d1 og har telefonen som fast oppgave; Kari står på
-- telefonen om kvelden.
insert into faktura.tavle_faser (org_id, navn, fra, til, rekkefolge) values (:'org', 'Formiddag', '08:00', '12:00', 1) returning id as formiddag \gset
insert into faktura.tavle_faser (org_id, navn, fra, til, rekkefolge) values (:'org', 'Ettermiddag', '12:00', '16:00', 2) returning id as ettermiddag \gset
insert into faktura.tavle_faser (org_id, navn, fra, til, rekkefolge) values (:'org', 'Kveld', '16:00', '22:00', 3) returning id as kveld \gset
insert into faktura.tavle_oppgaver (org_id, navn, rekkefolge) values (:'org', 'Resepsjon', 1) returning id as resepsjon \gset
insert into faktura.tavle_oppgaver (org_id, navn, rekkefolge) values (:'org', 'Telefon', 2) returning id as telefon \gset
insert into faktura.tavle_plasseringer (org_id, dato, fase_id, oppgave_id, ansatt_id) values (:'org', :'d1', :'formiddag', :'resepsjon', :'ola');
insert into faktura.tavle_plasseringer (org_id, dato, fase_id, oppgave_id, ansatt_id) values (:'org', :'d1', :'kveld', :'telefon', :'kari');
insert into faktura.tavle_fast_oppgave (org_id, ansatt_id, oppgave_id) values (:'org', :'ola', :'telefon');

-- Kollegaene: samme rolle og innlogging (ikke Per uten innlogging, ikke legen).
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select array_agg(navn order by navn) from faktura.vaktbytte_kolleger(:'org', :'v_ola1', null)), array['Kari Bytte', 'Siri Bytte'], 'kollegaene');
select test.er((select hindring from faktura.vaktbytte_kolleger(:'org', :'v_ola1', null) where ansatt_id = :'kari'), null::text, 'Kari kan ta vakten (kveldsvakten overlapper ikke)');
select test.er((select hindring from faktura.vaktbytte_kolleger(:'org', :'v_ola4', null) where ansatt_id = :'kari'), 'overlapp', 'men ikke den d4');

-- Ola gir bort vakten d1 til alle.
select (faktura.tilby_vaktbytte(:'org', :'v_ola1', null, null, null, null, ' Kan noen ta denne? ')).id as b1 \gset
select test.er((select status from faktura.vaktbytter where id = :'b1'), 'tilbudt', 'tilbudt');
select test.er((select melding from faktura.vaktbytter where id = :'b1'), 'Kan noen ta denne?', 'meldingen uten mellomrom');
select test.feiler(format($$select faktura.tilby_vaktbytte(%L, %L, null, null, null, null, null)$$, :'org', :'v_ola1'), 'FA409');
select test.feiler(format($$select faktura.tilby_vaktbytte(%L, %L, null, null, null, null, null)$$, :'org', :'v_kari2'), 'FA404');
select test.feiler(format($$select faktura.tilby_vaktbytte(%L, %L, null, null, null, null, null)$$, :'org', :'v_utkast'), 'FA404');
select test.er(test.melding(format($$select faktura.tilby_vaktbytte(%L, %L, null, null, null, null, null)$$, :'org', :'v_begynt')), 'Vakten har begynt', 'en vakt som har begynt');
select test.er(test.melding(format($$select faktura.tilby_vaktbytte(%L, %L, null, %L, null, null, null)$$, :'org', :'v_ola3', :'lise')),
               'Du kan bare bytte med kolleger med samme rolle', 'ikke med legen');
select test.feiler(format($$select faktura.tilby_vaktbytte(%L, %L, null, %L, null, null, null)$$, :'org', :'v_ola3', :'per'), 'FA400');
select test.feiler(format($$insert into faktura.vaktbytter (org_id, vakt_id, fra_ansatt) values (%L, %L, %L)$$, :'org', :'v_ola3', :'ola'), '42501');
select test.feiler(format($$update faktura.vaktbytter set status = 'godkjent' where id = %L$$, :'b1'), '42501');

-- Kari ser tilbudet (gjennom listen), legen ikke.
select set_config('app.bruker_id', :'u_kari', false);
select test.er((select count(*) from faktura.vaktbytte_liste(:'org') where id = :'b1'), 1::bigint, 'Kari ser tilbudet');
select test.er((select hindring from faktura.vaktbytte_liste(:'org') where id = :'b1'), null::text, 'og kan ta vakten');
select test.er((select fra || '-' || til from faktura.vaktbytte_liste(:'org') where id = :'b1'), '08:00-16:00', 'med tiden');
select test.er((select count(*) from faktura.vaktbytter where id = :'b1'), 0::bigint, 'men ikke rett fra tabellen');
select set_config('app.bruker_id', :'u_lise', false);
select test.er((select count(*) from faktura.vaktbytte_liste(:'org')), 0::bigint, 'legen ser ikke sekretærenes tilbud');
select test.feiler(format($$select faktura.svar_vaktbytte(%L, %L, true)$$, :'org', :'b1'), 'FA404');

-- Kari tar vakten, angrer og tar den igjen; den venter på godkjenning.
select set_config('app.bruker_id', :'u_kari', false);
select test.feiler(format($$select faktura.svar_vaktbytte(%L, %L, false)$$, :'org', :'b1'), 'FA400');
select test.er((faktura.svar_vaktbytte(:'org', :'b1', true)).status, 'akseptert', 'Kari tok vakten');
select test.er((faktura.svar_vaktbytte(:'org', :'b1', false)).status, 'tilbudt', 'Kari angret, og tilbudet er åpent igjen');
select test.er((faktura.svar_vaktbytte(:'org', :'b1', true)).status, 'akseptert', 'Kari tok den igjen');
select set_config('app.bruker_id', :'u_siri', false);
select test.er(test.melding(format($$select faktura.svar_vaktbytte(%L, %L, true)$$, :'org', :'b1')), 'Vakten er allerede tatt', 'Siri kom for sent');

-- Bare eier og administrator godkjenner. Vakten flyttes, og Kari tar over Olas plass i resepsjonen
-- og den faste oppgaven hans om ettermiddagen; kveldsplassen hennes står.
select set_config('app.bruker_id', :'u_lise', false);
select test.feiler(format($$select faktura.behandle_vaktbytte(%L, %L, true, null)$$, :'org', :'b1'), 'FA403');
select set_config('app.bruker_id', :'u', false);
select test.er((select ansatt_id from faktura.vakter where id = :'v_ola1'), :'ola'::uuid, 'vakten er Olas til byttet er godkjent');
select test.er((faktura.behandle_vaktbytte(:'org', :'b1', true, null)).status, 'godkjent', 'godkjent');
select test.er((select ansatt_id from faktura.vakter where id = :'v_ola1'), :'kari'::uuid, 'vakten er Karis');
select test.er((select ansatt_id from faktura.tavle_plasseringer where dato = :'d1' and fase_id = :'formiddag'), :'kari'::uuid, 'Kari står i resepsjonen');
select test.er((select oppgave_id from faktura.tavle_plasseringer where dato = :'d1' and fase_id = :'ettermiddag' and ansatt_id = :'kari'), :'telefon'::uuid,
               'og på telefonen om ettermiddagen (Olas faste oppgave)');
select test.er((select count(*) from faktura.tavle_plasseringer where dato = :'d1' and ansatt_id = :'ola'), 0::bigint, 'Ola har ingen plass den dagen');
select test.er((select count(*) from faktura.tavle_plasseringer where dato = :'d1' and fase_id = :'kveld' and ansatt_id = :'kari'), 1::bigint, 'kveldsplassen står');
select test.feiler(format($$select faktura.behandle_vaktbytte(%L, %L, true, null)$$, :'org', :'b1'), 'FA409');
select test.er((select count(*) from faktura.vaktbytte_liste(:'org')), 1::bigint, 'eieren ser byttet');

-- En bestemt kollega som har en vakt som overlapper, eller er borte (det sies ikke til Ola).
select set_config('app.bruker_id', :'u_ola', false);
select test.er(test.melding(format($$select faktura.tilby_vaktbytte(%L, %L, null, %L, null, null, null)$$, :'org', :'v_ola4', :'kari')),
               'Kari Bytte har en annen vakt som overlapper', 'Kari har en annen vakt');
select set_config('app.bruker_id', :'u', false);
insert into faktura.fravaer (org_id, ansatt_id, type, fra, til) values (:'org', :'kari', 'syk', :'d5', :'d5');
select set_config('app.bruker_id', :'u_ola', false);
select test.er(test.melding(format($$select faktura.tilby_vaktbytte(%L, %L, null, %L, null, null, null)$$, :'org', :'v_ola5', :'kari')),
               'Kari Bytte kan ikke ta vakten denne dagen', 'fraværet sies ikke');
-- Den som er borte, kan ikke gi bort vakten (lederen setter inn vikar).
select set_config('app.bruker_id', :'u', false);
insert into faktura.fravaer (org_id, ansatt_id, type, fra, til) values (:'org', :'ola', 'syk', :'d4', :'d4');
select set_config('app.bruker_id', :'u_ola', false);
select test.feiler(format($$select faktura.tilby_vaktbytte(%L, %L, null, null, null, null, null)$$, :'org', :'v_ola4'), 'FA409');

-- Et bytte: Kari bytter vakten sin d2 mot Olas d3.
select set_config('app.bruker_id', :'u_kari', false);
select (faktura.tilby_vaktbytte(:'org', :'v_kari2', null, :'ola', :'v_ola3', null, null)).id as b2 \gset
select test.feiler(format($$select faktura.tilby_vaktbytte(%L, %L, null, null, %L, null, null)$$, :'org', :'v_kari1', :'v_ola3'), 'FA400');
select set_config('app.bruker_id', :'u_siri', false);
select test.er((select count(*) from faktura.vaktbytte_liste(:'org') where id = :'b2'), 0::bigint, 'Siri ser ikke et bytte mellom to andre');
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select mot_vakt_id from faktura.vaktbytte_liste(:'org') where id = :'b2'), :'v_ola3'::uuid, 'Ola ser byttet');
select test.er((faktura.svar_vaktbytte(:'org', :'b2', true)).status, 'akseptert', 'Ola sa ja');
select set_config('app.bruker_id', :'u', false);
select test.er((faktura.behandle_vaktbytte(:'org', :'b2', true, null)).status, 'godkjent', 'byttet er godkjent');
select test.er((select ansatt_id from faktura.vakter where id = :'v_kari2'), :'ola'::uuid, 'Karis vakt er Olas');
select test.er((select ansatt_id from faktura.vakter where id = :'v_ola3'), :'kari'::uuid, 'og Olas er Karis');

-- Nei takk, avvist med grunn, trukket tilbake og utgått.
select set_config('app.bruker_id', :'u_ola', false);
select (faktura.tilby_vaktbytte(:'org', :'v_ola5', null, :'siri', null, null, null)).id as b3 \gset
select set_config('app.bruker_id', :'u_kari', false);
select test.feiler(format($$select faktura.svar_vaktbytte(%L, %L, true)$$, :'org', :'b3'), 'FA404');
select set_config('app.bruker_id', :'u_siri', false);
select test.er((faktura.svar_vaktbytte(:'org', :'b3', false)).status, 'avslatt', 'Siri sa nei takk');
select set_config('app.bruker_id', :'u_ola', false);
select (faktura.tilby_vaktbytte(:'org', :'v_ola5', null, :'siri', null, null, 'Bytte?')).id as b4 \gset
select set_config('app.bruker_id', :'u_siri', false);
select test.er((faktura.svar_vaktbytte(:'org', :'b4', true)).status, 'akseptert', 'Siri tok den');
select set_config('app.bruker_id', :'u', false);
select test.er((faktura.behandle_vaktbytte(:'org', :'b4', false, ' Vi trenger Ola den dagen ')).grunn, 'Vi trenger Ola den dagen', 'avvist med grunn');
select test.er((select ansatt_id from faktura.vakter where id = :'v_ola5'), :'ola'::uuid, 'vakten er fortsatt Olas');
select set_config('app.bruker_id', :'u_ola', false);
select (faktura.tilby_vaktbytte(:'org', :'v_ola5', null, null, null, null, null)).id as b5 \gset
select set_config('app.bruker_id', :'u_kari', false);
select test.feiler(format($$select faktura.trekk_vaktbytte(%L, %L)$$, :'org', :'b5'), 'FA404');
select set_config('app.bruker_id', :'u_ola', false);
select test.er((faktura.trekk_vaktbytte(:'org', :'b5')).status, 'trukket', 'Ola trakk tilbudet');
select set_config('app.bruker_id', :'u_siri', false);
select test.er(test.melding(format($$select faktura.svar_vaktbytte(%L, %L, true)$$, :'org', :'b5')), 'Tilbudet er trukket tilbake', 'for sent');
select set_config('app.bruker_id', :'u_ola', false);
select (faktura.tilby_vaktbytte(:'org', :'v_ola5', null, null, null, null, null)).id as b6 \gset
select set_config('app.bruker_id', :'u', false);
update faktura.vakter set oppgave = 'Kasse' where id = :'v_ola5';
select test.er((select status from faktura.vaktbytter where id = :'b6'), 'tilbudt', 'en ny oppgave endrer ikke tilbudet');
update faktura.vakter set fra = '09:00' where id = :'v_ola5';
select test.er((select status from faktura.vaktbytter where id = :'b6'), 'utgatt', 'en ny tid gjør tilbudet utgått');

-- Uten godkjenning går byttet gjennom med en gang; slått av kan ingen tilby.
update faktura.lonn_oppsett set vaktbytte = 'fritt' where org_id = :'org';
select set_config('app.bruker_id', :'u_ola', false);
select (faktura.tilby_vaktbytte(:'org', :'v_ola5', null, :'siri', null, null, null)).id as b7 \gset
select set_config('app.bruker_id', :'u_siri', false);
select test.er((faktura.svar_vaktbytte(:'org', :'b7', true)).status, 'godkjent', 'gjennom med en gang');
select test.er((select ansatt_id from faktura.vakter where id = :'v_ola5'), :'siri'::uuid, 'vakten er Siris');
select set_config('app.bruker_id', :'u', false);
update faktura.lonn_oppsett set vaktbytte = 'av' where org_id = :'org';
select set_config('app.bruker_id', :'u_siri', false);
select test.feiler(format($$select faktura.tilby_vaktbytte(%L, %L, null, null, null, null, null)$$, :'org', :'v_ola5'), 'FA403');
select set_config('app.bruker_id', :'u', false);
update faktura.lonn_oppsett set vaktbytte = 'godkjenning' where org_id = :'org';

-- Faste arbeidsdager: Siri jobber 08–12 alle dager fra fx. Hun gir bort den faste dagen fx til
-- Kari (den blir en vakt), og har fri den dagen.
insert into faktura.arbeidsplaner (org_id, ansatt_id, gjelder_fra) values (:'org', :'siri', :'fx') returning id as plan \gset
insert into faktura.arbeidsplan_dager (org_id, plan_id, ukedag, fra, til) select :'org', :'plan', g, '08:00', '12:00' from generate_series(1, 7) g;
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'kari', :'fz', '13:00', '17:00') returning id as v_kari_z \gset
select faktura.publiser_vakt(:'org', :'v_kari_z');
select set_config('app.bruker_id', :'u_siri', false);
select (faktura.tilby_vaktbytte(:'org', null, :'fx', :'kari', null, null, null)).vakt_id as v_siri_x \gset
select test.er((select to_char(fra, 'HH24:MI') || '-' || to_char(til, 'HH24:MI') from faktura.vakter where id = :'v_siri_x'), '08:00-12:00', 'den faste dagen ble en vakt');
select test.er(test.melding(format($$select faktura.tilby_vaktbytte(%L, null, %L, null, null, null, null)$$, :'org', :'d1')),
               'Det er ingen fast arbeidsdag denne dagen', 'før planen begynner er det ingen fast dag');
select set_config('app.bruker_id', :'u_kari', false);
select id as b8 from faktura.vaktbytte_liste(:'org') where vakt_id = :'v_siri_x' \gset
select faktura.svar_vaktbytte(:'org', :'b8', true);
select set_config('app.bruker_id', :'u', false);
select faktura.behandle_vaktbytte(:'org', :'b8', true, null);
select test.er((select ansatt_id from faktura.vakter where id = :'v_siri_x'), :'kari'::uuid, 'Kari har den faste dagen som vakt');
select test.er((select count(*) from faktura.arbeidsplan_fri where ansatt_id = :'siri' and dato = :'fx' and byttet_til is null), 1::bigint, 'Siri har fri');

-- Siri bytter den faste dagen fy mot Karis vakt fz (13–17): den faste dagen hennes fz (08–12)
-- overlapper ikke, og blir en vakt ved siden av. Timene i planen flyttes til fz.
select set_config('app.bruker_id', :'u_siri', false);
select test.er((select hindring_meg is null and hindring_annen is null from faktura.vaktbytte_kandidater(:'org', null, :'fy', :'fx', :'fz') where vakt_id = :'v_kari_z'),
               true, 'Karis vakt kan byttes mot Siris faste dag');
select test.er((select count(*) from faktura.vaktbytte_kandidater(:'org', null, :'fy', :'fx', :'fz') where ansatt_id = :'siri'), 0::bigint, 'ikke egne vakter');
select (faktura.tilby_vaktbytte(:'org', null, :'fy', :'kari', :'v_kari_z', null, null)).id as b9 \gset
select set_config('app.bruker_id', :'u_kari', false);
select faktura.svar_vaktbytte(:'org', :'b9', true);
select set_config('app.bruker_id', :'u', false);
select faktura.behandle_vaktbytte(:'org', :'b9', true, null);
select test.er((select ansatt_id from faktura.vakter where id = :'v_kari_z'), :'siri'::uuid, 'Siri fikk Karis vakt');
select test.er((select count(*) from faktura.vakter where ansatt_id = :'siri' and dato = :'fz'), 2::bigint, 'og den faste dagen hennes ble en vakt');
select test.er((select count(*) from faktura.vakter where ansatt_id = :'kari' and dato = :'fy'), 1::bigint, 'Kari har Siris faste dag');
select test.er((select byttet_til from faktura.arbeidsplan_fri where ansatt_id = :'siri' and dato = :'fy'), :'fz'::date, 'timene er flyttet til fz');

-- En fast arbeidsdag en kollega har, kan byttes mot (den blir en vakt for kollegaen).
insert into faktura.vakter (org_id, ansatt_id, dato, fra, til) values (:'org', :'ola', :'fx', '13:00', '16:00') returning id as v_ola_x \gset
select faktura.publiser_vakt(:'org', :'v_ola_x');
select set_config('app.bruker_id', :'u_ola', false);
select (array_agg(dato order by dato))[1] as siri_fast
  from faktura.vaktbytte_kandidater(:'org', :'v_ola_x', null, :'fz'::date + 1, :'fz'::date + 7)
 where ansatt_id = :'siri' and vakt_id is null and hindring_meg is null and hindring_annen is null \gset
select (faktura.tilby_vaktbytte(:'org', :'v_ola_x', null, :'siri', null, :'siri_fast', null)).mot_vakt_id as v_siri_mot \gset
select set_config('app.bruker_id', :'u', false);
select test.er((select ansatt_id from faktura.vakter where id = :'v_siri_mot'), :'siri'::uuid, 'Siris faste dag ble en vakt å bytte mot');

\c :migrator
drop schema test cascade;
\echo '  ok'
