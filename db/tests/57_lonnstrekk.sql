-- Faste trekk i lønnen (0082_lonnstrekk.sql): kontrollene på trekket, at eier og administrator
-- endrer og de som ser lønnen og den ansatte selv leser, revisjonsloggen bare for dem som ser
-- lønnen, KID-en for forskuddstrekket (også når kjøringen er godkjent, og til de andre kjøringene
-- i måneden), Skatteetatens kontonummer og de nye kontoene i lønnsbilaget.

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
select id as u from faktura.registrer_bruker('uid-ltrekk-eier', 'eier-ltrekk@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Trekk AS', '915000177') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, lonnstype, maanedslonn)
values (:'org', 'Ola', 'Trekk', 'ola-ltrekk@test.no', '2025-01-01', 'maaned', 40000) returning id as ola \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, lonnstype, maanedslonn)
values (:'org', 'Kari', 'Trekk', '2025-01-01', 'maaned', 50000) returning id as kari \gset
select faktura.inviter_ansatt(:'org', :'ola') as t_ola \gset
select faktura.inviter_medlem(:'org', 'regn-ltrekk@test.no', 'regnskap') as t_regn \gset
select faktura.inviter_medlem(:'org', 'fakt-ltrekk@test.no', 'fakturerer') as t_fakt \gset
select id as u_ola from faktura.registrer_bruker('uid-ltrekk-ola', 'ola-ltrekk@test.no') \gset
select id as u_regn from faktura.registrer_bruker('uid-ltrekk-regn', 'regn-ltrekk@test.no') \gset
select id as u_fakt from faktura.registrer_bruker('uid-ltrekk-fakt', 'fakt-ltrekk@test.no') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'t_regn');
select set_config('app.bruker_id', :'u_fakt', false);
select faktura.aksepter_invitasjon(:'t_fakt');
select set_config('app.bruker_id', :'u', false);

-- Trekkene: et beløp eller en prosent, datoene i rekkefølge, gyldig kontonummer, KID eller melding.
insert into faktura.lonnstrekk (org_id, ansatt_id, type, tekst, prosent, fra, mottaker, kontonr, melding)
values (:'org', :'ola', 'fagforening', 'Fellesforbundet', 1.4, '2026-01-01', 'Fellesforbundet', '86011117947', 'Kontingent') returning id as fag \gset
insert into faktura.lonnstrekk (org_id, ansatt_id, type, belop, fra, mottaker, kontonr, kid)
values (:'org', :'ola', 'utlegg_samordnet', 3000, '2026-09-01', 'Skatteetaten', '86011117947', '12345678903') returning id as utlegg \gset
insert into faktura.lonnstrekk (org_id, ansatt_id, type, belop, totalt, fra) values (:'org', :'kari', 'forskudd', 2000, 10000, '2026-10-01');
select test.feiler(format($$insert into faktura.lonnstrekk (org_id, ansatt_id, type, belop, prosent, fra) values (%L, %L, 'annet', 100, 5, '2026-01-01')$$, :'org', :'ola'), '23514');
select test.feiler(format($$insert into faktura.lonnstrekk (org_id, ansatt_id, type, fra) values (%L, %L, 'annet', '2026-01-01')$$, :'org', :'ola'), '23514');
select test.feiler(format($$insert into faktura.lonnstrekk (org_id, ansatt_id, type, belop, fra, til) values (%L, %L, 'annet', 100, '2026-02-01', '2026-01-01')$$, :'org', :'ola'), '23514');
select test.feiler(format($$insert into faktura.lonnstrekk (org_id, ansatt_id, type, belop, fra, kontonr) values (%L, %L, 'bidrag', 100, '2026-01-01', '86011117948')$$, :'org', :'ola'), '23514');
select test.feiler(format($$insert into faktura.lonnstrekk (org_id, ansatt_id, type, belop, fra, kid, melding) values (%L, %L, 'bidrag', 100, '2026-01-01', '1234', 'x')$$, :'org', :'ola'), '23514');
select test.feiler(format($$insert into faktura.lonnstrekk (org_id, ansatt_id, type, belop, fra) values (%L, %L, 'lotteri', 100, '2026-01-01')$$, :'org', :'ola'), '23514');

-- Regnskap ser trekkene, men endrer dem ikke; den ansatte ser sine egne; fakturereren ingen.
select set_config('app.bruker_id', :'u_regn', false);
select test.er((select count(*)::int from faktura.lonnstrekk where org_id = :'org'), 3, 'regnskap ser alle');
select test.feiler(format($$insert into faktura.lonnstrekk (org_id, ansatt_id, type, belop, fra) values (%L, %L, 'annet', 100, '2026-01-01')$$, :'org', :'ola'), '42501');
select test.er((select count(*)::int from faktura.revisjonslogg where org_id = :'org' and tabell = 'lonnstrekk'), 3, 'og loggen for dem');
update faktura.lonnstrekk set belop = 1 where org_id = :'org';
select test.er((select count(*)::int from faktura.lonnstrekk where org_id = :'org' and belop = 1), 0, 'regnskap endrer ingenting');
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select count(*)::int from faktura.lonnstrekk where org_id = :'org'), 2, 'Ola ser sine egne');
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select count(*)::int from faktura.lonnstrekk where org_id = :'org'), 0, 'fakturereren ser ingen');
select test.er((select count(*)::int from faktura.revisjonslogg where org_id = :'org' and tabell = 'lonnstrekk'), 0, 'og ikke loggen');

-- Eieren endrer og sletter.
select set_config('app.bruker_id', :'u', false);
update faktura.lonnstrekk set belop = 3500 where id = :'utlegg';
select test.er((select belop from faktura.lonnstrekk where id = :'utlegg'), 3500.00, 'endret');

-- Skatteetatens kontonummer og de nye kontoene i lønnsbilaget.
update faktura.lonn_oppsett set skatt_kontonr = '86011117947', bokforing_kontoer = '{"paaleggstrekk": "2611", "bidragstrekk": "2621", "forskudd": "1571"}' where org_id = :'org';
select test.er((select skatt_kontonr from faktura.lonn_oppsett where org_id = :'org'), '86011117947', 'kontonummeret');
select test.feiler(format($$update faktura.lonn_oppsett set skatt_kontonr = '12345678901' where org_id = %L$$, :'org'), '23514');
select test.feiler(format($$update faktura.lonn_oppsett set bokforing_kontoer = '{"ukjent": "2611"}' where org_id = %L$$, :'org'), '23514');

-- KID-en for forskuddstrekket: 19 siffer, også når kjøringen er godkjent, og de andre kjøringene i
-- samme måned uten KID får den samme.
insert into faktura.lonnskjoringer (org_id, periode, utbetalingsdato) values (:'org', '2026-10-01', '2026-10-20') returning id as okt \gset
insert into faktura.lonnskjoringer (org_id, periode, type, utbetalingsdato) values (:'org', '2026-10-01', 'ekstra', '2026-10-30') returning id as ekstra \gset
insert into faktura.lonnskjoringer (org_id, periode, utbetalingsdato) values (:'org', '2026-11-01', '2026-11-20') returning id as nov \gset
select test.feiler(format($$select faktura.sett_forskuddstrekk_kid(%L, '123')$$, :'okt'), 'FA400');
\c :migrator
update faktura.lonnskjoringer set status = 'godkjent', godkjent_at = now() where id = :'okt';
\c :api
select set_config('app.bruker_id', :'u', false);
select faktura.sett_forskuddstrekk_kid(:'okt', '0091500017705261012');
select test.er((select forskuddstrekk_kid from faktura.lonnskjoringer where id = :'okt'), '0091500017705261012', 'satt på en godkjent kjøring');
select test.er((select forskuddstrekk_kid from faktura.lonnskjoringer where id = :'ekstra'), '0091500017705261012', 'og den andre kjøringen i oktober');
select test.er((select forskuddstrekk_kid from faktura.lonnskjoringer where id = :'nov'), null::text, 'men ikke november');
select faktura.sett_forskuddstrekk_kid(:'okt', null);
select test.er((select forskuddstrekk_kid from faktura.lonnskjoringer where id = :'okt'), null::text, 'fjernet');
select set_config('app.bruker_id', :'u_regn', false);
select test.feiler(format($$select faktura.sett_forskuddstrekk_kid(%L, '0091500017705261012')$$, :'okt'), 'FA403');

\c :migrator
drop schema test cascade;
\echo '  ok'
