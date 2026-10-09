-- Betalingsfila (0076_lonn_betalingsfil.sql): lønnskontoen og BIC-en i lønnsoppsettet må være
-- gyldige, og betalingsfila lastes ned bare for godkjente kjøringer av de som ser lønnen; kjøringen
-- merkes med når, av hvem og hvor mange ganger, og funksjonen gir når den ble lastet ned før.

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
select id as u from faktura.registrer_bruker('uid-betfil-eier', 'eier-betfil@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Betalingsfil AS', '915000126') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);

-- Lønnskontoen og BIC-en må være gyldige; formatet er .03 som standard.
select test.feiler(format($$update faktura.lonn_oppsett set lonnskonto = '12345678901' where org_id = %L$$, :'org'), '23514');
select test.feiler(format($$update faktura.lonn_oppsett set bank_bic = 'DNB' where org_id = %L$$, :'org'), '23514');
select test.feiler(format($$update faktura.lonn_oppsett set betalingsfil_format = 'pain.001.001.02' where org_id = %L$$, :'org'), '23514');
update faktura.lonn_oppsett set lonnskonto = '86011117947', bank_bic = 'DNBANOKK' where org_id = :'org';
select test.er((select lonnskonto || ' ' || bank_bic || ' ' || betalingsfil_format from faktura.lonn_oppsett where org_id = :'org'),
               '86011117947 DNBANOKK pain.001.001.03', 'oppsettet');

insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, lonnstype, maanedslonn, kontonr)
values (:'org', 'Ola', 'Betal', 'ola-betfil@test.no', '2026-01-01', 'maaned', 50000, '12345678903') returning id as ola \gset
select faktura.inviter_ansatt(:'org', :'ola') as t_ola \gset
select faktura.inviter_medlem(:'org', 'regn-betfil@test.no', 'regnskap') as t_regn \gset
select id as u_ola from faktura.registrer_bruker('uid-betfil-ola', 'ola-betfil@test.no') \gset
select id as u_regn from faktura.registrer_bruker('uid-betfil-regn', 'regn-betfil@test.no') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'t_regn');

select set_config('app.bruker_id', :'u', false);
insert into faktura.lonnskjoringer (org_id, periode, utbetalingsdato) values (:'org', '2026-11-01', '2026-11-20') returning id as k \gset
insert into faktura.lonnsslipper (org_id, kjoring_id, ansatt_id, navn, ansattnummer, lonnstype, periode, utbetalingsdato, brutto, netto)
values (:'org', :'k', :'ola', 'Ola Betal', 1, 'maaned', '2026-11-01', '2026-11-20', 50000, 39000);

-- Et utkast har ingen betalingsfil.
select test.feiler(format($$select faktura.lonn_betalingsfil(%L)$$, :'k'), 'FA409');
select faktura.lonn_godkjenn(:'k');

-- Den ansatte laster den ikke ned; eieren og regnskap gjør det.
select set_config('app.bruker_id', :'u_ola', false);
select test.feiler(format($$select faktura.lonn_betalingsfil(%L)$$, :'k'), 'FA403');
select set_config('app.bruker_id', :'u', false);
select test.er(faktura.lonn_betalingsfil(:'k'), null::timestamptz, 'første gang: ikke lastet ned før');
select test.er((select betalingsfil_antall from faktura.lonnskjoringer where id = :'k'), 1, 'lastet ned én gang');
select test.er((select betalingsfil_av from faktura.lonnskjoringer where id = :'k'), :'u'::uuid, 'av eieren');
select betalingsfil_lastet as forste from faktura.lonnskjoringer where id = :'k' \gset
select set_config('app.bruker_id', :'u_regn', false);
select test.er(faktura.lonn_betalingsfil(:'k'), :'forste'::timestamptz, 'andre gang: når den ble lastet ned før');
select test.er((select betalingsfil_antall || ':' || (betalingsfil_av = :'u_regn')::text from faktura.lonnskjoringer where id = :'k'), '2:true', 'regnskap lastet ned');
-- Merket endres ikke for hånd.
select set_config('app.bruker_id', :'u', false);
select test.feiler(format($$update faktura.lonnskjoringer set betalingsfil_antall = 0 where id = %L$$, :'k'), '42501');
select test.feiler($$select faktura.lonn_betalingsfil('00000000-0000-0000-0000-000000000000')$$, 'FA404');

\c :migrator
drop schema test cascade;
\echo '  ok'
