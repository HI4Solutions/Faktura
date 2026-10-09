-- Naturalytelser og reiseregninger (0083_naturalytelser_reiser.sql): kontrollene, at eier og
-- administrator endrer naturalytelsene og de som ser lønnen og den ansatte selv leser dem, at den
-- ansatte fører, sender og retter sine egne reiseregninger og ikke andres, at bare eier og
-- administrator godkjenner, avviser og åpner, at lønnskjøringen merker reiseregningene som utbetalt
-- (og ikke når de er godkjent på nytt etter at lønnen ble regnet ut), og revisjonsloggen.

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
select id as u from faktura.registrer_bruker('uid-reise-eier', 'eier-reise@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Reise AS', '915000282') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, lonnstype, maanedslonn)
values (:'org', 'Ola', 'Reise', 'ola-reise@test.no', '2025-01-01', 'maaned', 40000) returning id as ola \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, lonnstype, maanedslonn)
values (:'org', 'Kari', 'Reise', '2025-01-01', 'maaned', 50000) returning id as kari \gset
select faktura.inviter_ansatt(:'org', :'ola') as t_ola \gset
select faktura.inviter_medlem(:'org', 'regn-reise@test.no', 'regnskap') as t_regn \gset
select faktura.inviter_medlem(:'org', 'fakt-reise@test.no', 'fakturerer') as t_fakt \gset
select id as u_ola from faktura.registrer_bruker('uid-reise-ola', 'ola-reise@test.no') \gset
select id as u_regn from faktura.registrer_bruker('uid-reise-regn', 'regn-reise@test.no') \gset
select id as u_fakt from faktura.registrer_bruker('uid-reise-fakt', 'fakt-reise@test.no') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'t_regn');
select set_config('app.bruker_id', :'u_fakt', false);
select faktura.aksepter_invitasjon(:'t_fakt');
select set_config('app.bruker_id', :'u', false);

-- Naturalytelsene: fri bil med listepris og registreringsnummer (eller bilpool), rentefordel med
-- lån og rente, de andre med beløp.
insert into faktura.naturalytelser (org_id, ansatt_id, type, listepris, regnr, fra)
values (:'org', :'ola', 'bil', 450000, 'EL12345', '2026-01-01') returning id as bil \gset
insert into faktura.naturalytelser (org_id, ansatt_id, type, fra) values (:'org', :'ola', 'ek', '2026-01-01');
insert into faktura.naturalytelser (org_id, ansatt_id, type, belop, fra) values (:'org', :'kari', 'forsikring', 150, '2026-01-01');
select test.feiler(format($$insert into faktura.naturalytelser (org_id, ansatt_id, type, regnr, fra) values (%L, %L, 'bil', 'EL1', '2026-01-01')$$, :'org', :'ola'), '23514');
select test.feiler(format($$insert into faktura.naturalytelser (org_id, ansatt_id, type, listepris, fra) values (%L, %L, 'bil', 300000, '2026-01-01')$$, :'org', :'ola'), '23514');
insert into faktura.naturalytelser (org_id, ansatt_id, type, listepris, bilpool, fra) values (:'org', :'kari', 'bil', 300000, true, '2026-01-01');
select test.feiler(format($$insert into faktura.naturalytelser (org_id, ansatt_id, type, laan, fra) values (%L, %L, 'rentefordel', 100000, '2026-01-01')$$, :'org', :'ola'), '23514');
select test.feiler(format($$insert into faktura.naturalytelser (org_id, ansatt_id, type, fra) values (%L, %L, 'bolig', '2026-01-01')$$, :'org', :'ola'), '23514');
select test.feiler(format($$insert into faktura.naturalytelser (org_id, ansatt_id, type, belop, fra, til) values (%L, %L, 'annet', 100, '2026-02-01', '2026-01-01')$$, :'org', :'ola'), '23514');
select test.feiler(format($$insert into faktura.naturalytelser (org_id, ansatt_id, type, belop, fra) values (%L, %L, 'yacht', 100, '2026-01-01')$$, :'org', :'ola'), '23514');

-- Regnskap ser dem, men endrer dem ikke; den ansatte ser sine egne; fakturereren ingen.
select set_config('app.bruker_id', :'u_regn', false);
select test.er((select count(*)::int from faktura.naturalytelser where org_id = :'org'), 4, 'regnskap ser alle');
select test.feiler(format($$insert into faktura.naturalytelser (org_id, ansatt_id, type, belop, fra) values (%L, %L, 'annet', 100, '2026-01-01')$$, :'org', :'ola'), '42501');
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select count(*)::int from faktura.naturalytelser where org_id = :'org'), 2, 'Ola ser sine egne');
select test.feiler(format($$insert into faktura.naturalytelser (org_id, ansatt_id, type, belop, fra) values (%L, %L, 'annet', 100, '2026-01-01')$$, :'org', :'ola'), '42501');
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select count(*)::int from faktura.naturalytelser where org_id = :'org'), 0, 'fakturereren ser ingen');

-- Reiseregninger: Ola fører sin egen, men ikke for Kari, og skriver ikke rett i tabellen.
select set_config('app.bruker_id', :'u_ola', false);
select (faktura.lagre_reiseregning(:'org', null, null,
  '{"formaal": "Kurs", "sted": "Bergen", "fra": "2026-10-05T08:00", "til": "2026-10-06T18:00", "overnatting": "hotell", "maaltider": {"1": "F"}}'::jsonb)).id as reise \gset
select test.er((select ansatt_id from faktura.reiseregninger where id = :'reise'), :'ola'::uuid, 'Olas egen');
select test.er((select status from faktura.reiseregninger where id = :'reise'), 'utkast', 'et utkast');
select test.feiler(format($$select faktura.lagre_reiseregning(%L, null, %L, '{"formaal": "x", "fra": "2026-10-05T08:00", "til": "2026-10-05T18:00"}'::jsonb)$$, :'org', :'kari'), 'FA403');
select test.feiler(format($$insert into faktura.reiseregninger (org_id, ansatt_id, formaal, fra, til) values (%L, %L, 'x', '2026-10-05 08:00', '2026-10-05 18:00')$$, :'org', :'ola'), '42501');
select test.feiler(format($$update faktura.reiseregninger set status = 'godkjent' where id = %L$$, :'reise'), '42501');
-- Kontrollene: hjemkomsten etter avreisen, en dagsreise høyst et døgn, nattillegg ikke på hotell.
select test.feiler(format($$select faktura.lagre_reiseregning(%L, null, null, '{"formaal": "x", "fra": "2026-10-05T08:00", "til": "2026-10-05T07:00"}'::jsonb)$$, :'org'), '23514');
select test.feiler(format($$select faktura.lagre_reiseregning(%L, null, null, '{"formaal": "x", "fra": "2026-10-05T08:00", "til": "2026-10-06T18:00"}'::jsonb)$$, :'org'), '23514');
select test.feiler(format($$select faktura.lagre_reiseregning(%L, null, null, '{"formaal": "x", "fra": "2026-10-05T08:00", "til": "2026-10-06T18:00", "overnatting": "hotell", "nattillegg": true}'::jsonb)$$, :'org'), '23514');

-- Ola sender; bare eier og administrator godkjenner og avviser.
select faktura.send_reiseregning(:'org', :'reise');
select test.er((select status from faktura.reiseregninger where id = :'reise'), 'sendt', 'sendt');
select test.feiler(format($$select faktura.godkjenn_reiseregning(%L, %L, true, '[]'::jsonb, 100)$$, :'org', :'reise'), 'FA403');
select test.feiler(format($$select faktura.avvis_reiseregning(%L, %L, 'Nei')$$, :'org', :'reise'), 'FA403');
select set_config('app.bruker_id', :'u_regn', false);
select test.er((select count(*)::int from faktura.reiseregninger where org_id = :'org'), 1, 'regnskap ser reiseregningen');
select test.feiler(format($$select faktura.godkjenn_reiseregning(%L, %L, true, '[]'::jsonb, 100)$$, :'org', :'reise'), 'FA403');
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select count(*)::int from faktura.reiseregninger where org_id = :'org'), 0, 'fakturereren ser ingen');

-- Eieren avviser (med en grunn); Ola retter (et utkast igjen) og sender på nytt.
select set_config('app.bruker_id', :'u', false);
select test.feiler(format($$select faktura.avvis_reiseregning(%L, %L, ' ')$$, :'org', :'reise'), 'FA400');
select faktura.avvis_reiseregning(:'org', :'reise', 'Mangler kvittering for hotellet');
select test.er((select avvist_grunn from faktura.reiseregninger where id = :'reise'), 'Mangler kvittering for hotellet', 'grunnen');
select set_config('app.bruker_id', :'u_ola', false);
select faktura.lagre_reiseregning(:'org', :'reise', null,
  '{"formaal": "Kurs", "sted": "Bergen", "fra": "2026-10-05T08:00", "til": "2026-10-06T18:00", "overnatting": "hotell", "maaltider": {"1": "F"}, "utlegg": [{"dato": "2026-10-05", "tekst": "Hotell", "belop": 1450}]}'::jsonb);
select test.er((select status || '|' || coalesce(avvist_grunn, '-') from faktura.reiseregninger where id = :'reise'), 'utkast|-', 'rettet blir utkast');
select faktura.send_reiseregning(:'org', :'reise');

-- Eieren godkjenner med beregningen; Ola endrer og sletter den ikke da.
select set_config('app.bruker_id', :'u', false);
select faktura.godkjenn_reiseregning(:'org', :'reise', true, '[{"lonnsart": "reise_kost_hotell", "tekst": "Bergen 5.–6.10: kost 2 døgn (hotell)", "antall": 2, "sats": null, "belop": 1247}, {"lonnsart": "reise_utlegg", "tekst": "Bergen 5.–6.10: utlegg", "antall": null, "sats": null, "belop": 1450}]'::jsonb, 2697);
select test.er((select status || '|' || belop::text from faktura.reiseregninger where id = :'reise'), 'godkjent|2697.00', 'godkjent');
select test.feiler(format($$select faktura.godkjenn_reiseregning(%L, %L, true, '[]'::jsonb, 1)$$, :'org', :'reise'), 'FA409');
select set_config('app.bruker_id', :'u_ola', false);
select test.feiler(format($$select faktura.lagre_reiseregning(%L, %L, null, '{"formaal": "x", "fra": "2026-10-05T08:00", "til": "2026-10-05T18:00"}'::jsonb)$$, :'org', :'reise'), 'FA409');
select test.feiler(format($$select faktura.slett_reiseregning(%L, %L)$$, :'org', :'reise'), 'FA409');

-- Lønnskjøringen: slippen med reiseregningen. Godkjent på nytt etter at slippen ble regnet ut, må
-- lønnen regnes ut på nytt.
select set_config('app.bruker_id', :'u', false);
insert into faktura.lonnskjoringer (org_id, periode, utbetalingsdato) values (:'org', '2026-10-01', '2026-10-20') returning id as okt \gset
insert into faktura.lonnsslipper (org_id, kjoring_id, ansatt_id, navn, ansattnummer, lonnstype, periode, utbetalingsdato, reiseregninger)
select :'org', :'okt', a.id, 'Ola Reise', a.ansattnummer, 'maaned', '2026-10-01', '2026-10-20', array[:'reise'::uuid]
  from faktura.ansatte a where a.id = :'ola' returning id as slipp \gset
select faktura.apne_reiseregning(:'org', :'reise');
select test.er((select status || '|' || coalesce(belop::text, '-') from faktura.reiseregninger where id = :'reise'), 'sendt|-', 'åpnet igjen');
select faktura.godkjenn_reiseregning(:'org', :'reise', true, '[{"lonnsart": "reise_utlegg", "tekst": "Bergen: utlegg", "antall": null, "sats": null, "belop": 1450}]'::jsonb, 1450);
select test.feiler(format($$select faktura.lonn_godkjenn(%L)$$, :'okt'), 'FA409');
update faktura.lonnsslipper set merknader = '{}' where id = :'slipp';
select faktura.lonn_godkjenn(:'okt');
select test.er((select lonnskjoring_id from faktura.reiseregninger where id = :'reise'), :'okt'::uuid, 'utbetalt i oktober');
select test.feiler(format($$select faktura.apne_reiseregning(%L, %L)$$, :'org', :'reise'), 'FA409');
select test.feiler(format($$select faktura.slett_reiseregning(%L, %L)$$, :'org', :'reise'), 'FA409');
select test.feiler(format($$select faktura.lagre_reiseregning(%L, %L, null, '{"formaal": "x", "fra": "2026-10-05T08:00", "til": "2026-10-05T18:00"}'::jsonb)$$, :'org', :'reise'), 'FA409');

-- En annen kjøring kan ikke betale den igjen; åpnes oktober, er den ikke utbetalt lenger.
insert into faktura.lonnskjoringer (org_id, periode, type, utbetalingsdato) values (:'org', '2026-10-01', 'ekstra', '2026-10-30') returning id as ekstra \gset
insert into faktura.lonnsslipper (org_id, kjoring_id, ansatt_id, navn, ansattnummer, lonnstype, periode, utbetalingsdato, reiseregninger)
select :'org', :'ekstra', a.id, 'Ola Reise', a.ansattnummer, 'maaned', '2026-10-01', '2026-10-30', array[:'reise'::uuid]
  from faktura.ansatte a where a.id = :'ola';
select test.feiler(format($$select faktura.lonn_godkjenn(%L)$$, :'ekstra'), 'FA409');
select faktura.lonn_gjenapne(:'okt');
select test.er((select lonnskjoring_id from faktura.reiseregninger where id = :'reise'), null::uuid, 'ikke utbetalt etter at kjøringen er åpnet');

-- Eieren fører for Kari og sletter den; Ola sletter sitt eget utkast.
select (faktura.lagre_reiseregning(:'org', null, :'kari', '{"formaal": "Møte", "fra": "2026-10-07T08:00", "til": "2026-10-07T17:00"}'::jsonb)).id as kreise \gset
select test.er((select ansatt_id from faktura.reiseregninger where id = :'kreise'), :'kari'::uuid, 'for Kari');
select faktura.slett_reiseregning(:'org', :'kreise');
select set_config('app.bruker_id', :'u_ola', false);
select (faktura.lagre_reiseregning(:'org', null, null, '{"formaal": "Kunde", "fra": "2026-10-08T08:00", "til": "2026-10-08T15:00"}'::jsonb)).id as oreise \gset
select faktura.slett_reiseregning(:'org', :'oreise');
select test.er((select count(*)::int from faktura.reiseregninger where org_id = :'org'), 1, 'slettet');

-- Revisjonsloggen: for dem som ser lønnen, ikke for fakturereren.
select set_config('app.bruker_id', :'u_regn', false);
select test.er((select count(*) > 0 from faktura.revisjonslogg where org_id = :'org' and tabell = 'reiseregninger'), true, 'regnskap ser loggen');
select test.er((select count(*) > 0 from faktura.revisjonslogg where org_id = :'org' and tabell = 'naturalytelser'), true, 'og for naturalytelsene');
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select count(*)::int from faktura.revisjonslogg where org_id = :'org' and tabell in ('reiseregninger', 'naturalytelser')), 0, 'fakturereren ser den ikke');

-- Satsene for reiser og de nye kontoene i lønnsbilaget.
select set_config('app.bruker_id', :'u', false);
update faktura.lonn_oppsett set reise_satser = 'trekkfri', bokforing_kontoer = '{"bilgodtgjorelse": "7101", "diett": "7151", "reiseutlegg": "7141", "naturalytelser": "5281", "naturalytelser_mot": "5291"}' where org_id = :'org';
select test.er((select reise_satser from faktura.lonn_oppsett where org_id = :'org'), 'trekkfri', 'satsene');
select test.feiler(format($$update faktura.lonn_oppsett set reise_satser = 'egne' where org_id = %L$$, :'org'), '23514');

\c :migrator
drop schema test cascade;
\echo '  ok'
