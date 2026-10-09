-- Bokføringen av lønnen i eget regnskap (0078_lonn_bokforing.sql): kontoene og valgene i
-- lønnsoppsettet må være gyldige; bare eier og administrator fører lønnsbilaget for en godkjent
-- kjøring, i serien L med neste nummer, og bare ett gjeldende bilag per kjøring; bilaget må gå i
-- null; ingen skriver, endrer eller sletter bilag direkte; når kjøringen åpnes igjen, reverseres
-- bilaget på samme dato; de som ser lønnen leser bilagene, og bilagene blir stående når kjøringen
-- slettes.

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
select id as u from faktura.registrer_bruker('uid-bokf-eier', 'eier-bokf@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Bokføring AS', '915000177') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);

-- Standardvalgene, og kontoene må være kjente roller med kontonumre.
select test.er((select bokforing_kontoer::text || ' ' || bokforing_feriepenger || ' ' || bokforing_netto || ' ' || bokforing_otp
                  from faktura.lonn_oppsett where org_id = :'org'), '{} avsetning skyldig false', 'standard');
select test.feiler(format($$update faktura.lonn_oppsett set bokforing_kontoer = '{"kaffe": "5000"}' where org_id = %L$$, :'org'), '23514');
select test.feiler(format($$update faktura.lonn_oppsett set bokforing_kontoer = '{"lonn": "500"}' where org_id = %L$$, :'org'), '23514');
select test.feiler(format($$update faktura.lonn_oppsett set bokforing_kontoer = '{"lonn": 5000}' where org_id = %L$$, :'org'), '23514');
select test.feiler(format($$update faktura.lonn_oppsett set bokforing_kontoer = '["5000"]' where org_id = %L$$, :'org'), '23514');
select test.feiler(format($$update faktura.lonn_oppsett set bokforing_feriepenger = 'aldri' where org_id = %L$$, :'org'), '23514');
select test.feiler(format($$update faktura.lonn_oppsett set bokforing_netto = 'kontant' where org_id = %L$$, :'org'), '23514');
update faktura.lonn_oppsett set bokforing_kontoer = '{"lonn": "5001"}', bokforing_netto = 'bank' where org_id = :'org';

insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, lonnstype, maanedslonn)
values (:'org', 'Ola', 'Bokført', 'ola-bokf@test.no', '2026-01-01', 'maaned', 50000) returning id as ola \gset
select faktura.inviter_ansatt(:'org', :'ola') as t_ola \gset
select faktura.inviter_medlem(:'org', 'regn-bokf@test.no', 'regnskap') as t_regn \gset
select id as u_ola from faktura.registrer_bruker('uid-bokf-ola', 'ola-bokf@test.no') \gset
select id as u_regn from faktura.registrer_bruker('uid-bokf-regn', 'regn-bokf@test.no') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'t_regn');

select set_config('app.bruker_id', :'u', false);
insert into faktura.lonnskjoringer (org_id, periode, utbetalingsdato) values (:'org', '2026-11-01', '2026-11-20') returning id as k \gset
insert into faktura.lonnsslipper (org_id, kjoring_id, ansatt_id, navn, ansattnummer, lonnstype, periode, utbetalingsdato, brutto, netto)
values (:'org', :'k', :'ola', 'Ola Bokført', 1, 'maaned', '2026-11-01', '2026-11-20', 50000, 39000);

\set poster '[{"konto": "5001", "belop": 50000, "tekst": "Lønn"}, {"konto": "2600", "belop": -11000, "tekst": "Forskuddstrekk"}, {"konto": "1920", "belop": -39000, "tekst": "Nettolønn"}]'

-- Et utkast bokføres ikke.
select test.feiler(format($$select faktura.bokfor_lonn(%L, '2026-11-20', 'Lønn november 2026', %L)$$, :'k', :'poster'), 'FA409');
select faktura.lonn_godkjenn(:'k');

-- Den ansatte og regnskap fører ikke bilag; et bilag som ikke går i null, føres ikke.
select set_config('app.bruker_id', :'u_ola', false);
select test.feiler(format($$select faktura.bokfor_lonn(%L, '2026-11-20', 'Lønn november 2026', %L)$$, :'k', :'poster'), 'FA403');
select set_config('app.bruker_id', :'u_regn', false);
select test.feiler(format($$select faktura.bokfor_lonn(%L, '2026-11-20', 'Lønn november 2026', %L)$$, :'k', :'poster'), 'FA403');
select set_config('app.bruker_id', :'u', false);
select test.feiler(format($$select faktura.bokfor_lonn(%L, '2026-11-20', 'Lønn', '[{"konto": "5000", "belop": 100}, {"konto": "2930", "belop": -99}]')$$, :'k'), 'FA400');
select test.feiler(format($$select faktura.bokfor_lonn(%L, '2026-11-20', 'Lønn', '[{"konto": "50", "belop": 100}, {"konto": "2930", "belop": -100}]')$$, :'k'), '23514');
select test.feiler(format($$select faktura.bokfor_lonn(%L, '2026-11-20', 'Lønn', '[{"konto": "5000", "belop": 100}]')$$, :'k'), 'FA400');

-- Eieren fører bilaget: L-2026-1, med posteringene.
select * from faktura.bokfor_lonn(:'k', '2026-11-20', 'Lønn november 2026', :'poster') \gset b1_
select test.er(:'b1_serie' || '-' || :'b1_aar' || '-' || :'b1_nummer', 'L-2026-1', 'første bilag i serien');
select test.er((select count(*)::int from faktura.posteringer where bilag_id = :'b1_id'), 3, 'tre posteringer');
select test.er((select sum(belop) from faktura.posteringer where bilag_id = :'b1_id'), 0::numeric, 'går i null');
select test.er(:'b1_opprettet_av'::uuid, :'u'::uuid, 'av eieren');
-- Bare ett gjeldende bilag per kjøring.
select test.feiler(format($$select faktura.bokfor_lonn(%L, '2026-11-20', 'Lønn november 2026', %L)$$, :'k', :'poster'), 'FA409');

-- Ingen skriver, endrer eller sletter bilag direkte.
select test.feiler(format($$insert into faktura.bilag (org_id, serie, aar, nummer, dato, tekst, kilde) values (%L, 'L', 2026, 99, '2026-11-20', 'x', 'lonn')$$, :'org'), '42501');
select test.feiler(format($$update faktura.bilag set tekst = 'endret' where id = %L$$, :'b1_id'), '42501');
select test.feiler(format($$delete from faktura.bilag where id = %L$$, :'b1_id'), '42501');
select test.feiler(format($$update faktura.posteringer set belop = 1 where bilag_id = %L$$, :'b1_id'), '42501');
select test.feiler(format($$delete from faktura.posteringer where bilag_id = %L$$, :'b1_id'), '42501');
select test.feiler($$select faktura.reverser_bilag('00000000-0000-0000-0000-000000000000', 'x')$$, '42501');
select test.feiler($$select faktura.neste_bilagsnummer('00000000-0000-0000-0000-000000000000', 'L', 2026)$$, '42501');

-- Regnskap ser bilagene; den ansatte gjør det ikke.
select set_config('app.bruker_id', :'u_regn', false);
select test.er((select count(*)::int from faktura.posteringer where bilag_id = :'b1_id'), 3, 'regnskap ser posteringene');
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select count(*)::int from faktura.bilag), 0, 'den ansatte ser ikke bilagene');
select test.er((select count(*)::int from faktura.posteringer), 0, 'eller posteringene');

-- Åpnes kjøringen, reverseres bilaget på samme dato (L-2026-2, motsatte beløp).
select set_config('app.bruker_id', :'u', false);
select faktura.lonn_gjenapne(:'k');
select id as r1 from faktura.bilag where reverserer = :'b1_id' \gset
select test.er((select serie || '-' || aar || '-' || nummer || ' ' || dato from faktura.bilag where id = :'r1'), 'L-2026-2 2026-11-20', 'reverseringen');
select test.er((select reversert_av from faktura.bilag where id = :'b1_id'), :'r1'::uuid, 'det gamle er reversert');
select test.er((select string_agg(konto || ':' || belop, ' ' order by rekke) from faktura.posteringer where bilag_id = :'r1'), '5001:-50000.00 2600:11000.00 1920:39000.00', 'motsatte beløp');
-- Godkjennes den igjen, føres et nytt bilag (L-2026-3).
select faktura.lonn_godkjenn(:'k');
select * from faktura.bokfor_lonn(:'k', '2026-11-20', 'Lønn november 2026', :'poster') \gset b2_
select test.er(:'b2_nummer'::int, 3, 'nytt bilag');
select test.er((select count(*)::int from faktura.bilag where kilde_id = :'k' and reverserer is null and reversert_av is null), 1, 'ett gjeldende');

-- En kjøring som slettes (som utkast), tar ikke med seg bilagene.
select faktura.lonn_gjenapne(:'k');
delete from faktura.lonnskjoringer where id = :'k';
select test.er((select count(*)::int from faktura.bilag where org_id = :'org'), 4, 'bilagene står igjen');
select test.er((select coalesce(sum(p.belop), 0) from faktura.posteringer p where p.org_id = :'org'), 0::numeric, 'og går i null');
select test.feiler($$select faktura.bokfor_lonn('00000000-0000-0000-0000-000000000000', '2026-11-20', 'x', '[]')$$, 'FA404');

\c :migrator
drop schema test cascade;
\echo '  ok'
