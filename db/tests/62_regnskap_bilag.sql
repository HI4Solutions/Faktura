-- Regnskapsmodulen, andre del (0087_regnskap_bilag.sql): periodiseringene (nummeret, starten bare
-- for forskudd, hele beløpet, én gang og før månedene, månedene innenfor periodiseringen og i
-- rekkefølge, ikke mer fordelt enn beløpet, det som ikke kan endres når noe er bokført, reversering
-- det siste først), manuelle bilag i serie M (går i null, minst to linjer, reversering), at hver
-- kilde reverseres med sin funksjon, at fakturerer ikke ser eller fører noe, og revisjonsloggen.

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
select id as u from faktura.registrer_bruker('uid-pbilag-eier', 'eier-pbilag@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Periode AS', '915000339') \gset
select faktura.inviter_medlem(:'org', 'regn-pbilag@test.no', 'regnskap') as t_regn \gset
select faktura.inviter_medlem(:'org', 'fakt-pbilag@test.no', 'fakturerer') as t_fakt \gset
select id as u_regn from faktura.registrer_bruker('uid-pbilag-regn', 'regn-pbilag@test.no') \gset
select id as u_fakt from faktura.registrer_bruker('uid-pbilag-fakt', 'fakt-pbilag@test.no') \gset
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'t_regn');
select set_config('app.bruker_id', :'u_fakt', false);
select faktura.aksepter_invitasjon(:'t_fakt');
select set_config('app.bruker_id', :'u_regn', false);

-- Regnskap legger inn periodiseringene: forsikringen for 2026 betalt på forskudd (fakturaen er ført
-- på 7500 og flyttes til 1700), og en påløpt bonus over tre måneder.
insert into faktura.periodiseringer (org_id, navn, type, belop, fra, antall_maaneder, resultatkonto, balansekonto, start)
values (:'org', 'Forsikring 2026', 'forskuddsbetalt_kostnad', 12000, '2026-01-01', 12, '7500', '1700', 'flytt') returning id as fors \gset
insert into faktura.periodiseringer (org_id, navn, type, belop, fra, antall_maaneder, resultatkonto, balansekonto)
values (:'org', 'Bonus', 'paalopt_kostnad', 6000, '2026-01-01', 3, '5000', '2960') returning id as bonus \gset
select test.er((select string_agg(nummer::text, ',' order by nummer) from faktura.periodiseringer where org_id = :'org'), '1,2', 'nummeret');
-- Kontrollene i tabellen: start bare for forskudd, den første dagen i måneden, to forskjellige
-- kontoer og høyst 120 måneder.
select test.feiler(format($$insert into faktura.periodiseringer (org_id, navn, type, belop, fra, antall_maaneder, resultatkonto, balansekonto, start)
                           values (%L, 'X', 'paalopt_kostnad', 100, '2026-01-01', 2, '5000', '2960', 'flytt')$$, :'org'), '23514');
select test.feiler(format($$insert into faktura.periodiseringer (org_id, navn, type, belop, fra, antall_maaneder, resultatkonto, balansekonto)
                           values (%L, 'X', 'paalopt_kostnad', 100, '2026-01-15', 2, '5000', '2960')$$, :'org'), '23514');
select test.feiler(format($$insert into faktura.periodiseringer (org_id, navn, type, belop, fra, antall_maaneder, resultatkonto, balansekonto)
                           values (%L, 'X', 'paalopt_kostnad', 100, '2026-01-01', 2, '2960', '2960')$$, :'org'), '23514');
select test.feiler(format($$insert into faktura.periodiseringer (org_id, navn, type, belop, fra, antall_maaneder, resultatkonto, balansekonto)
                           values (%L, 'X', 'paalopt_kostnad', 100, '2026-01-01', 121, '5000', '2960')$$, :'org'), '23514');
-- Ingen skriver postene direkte.
select test.feiler(format($$insert into faktura.periodiseringsposter (org_id, periodisering_id, type, belop, bilag_id)
                           values (%L, %L, 'start', 1, gen_random_uuid())$$, :'org', :'fors'), '42501');

-- Forsikringen fordeles ikke før starten er bokført.
select test.feiler(format($$select faktura.bokfor_periodisering(%L, '2026-01-31', 'x', '[{"konto": "7500", "belop": 1000}, {"konto": "1700", "belop": -1000}]',
  '[{"periodisering_id": "%s", "type": "maaned", "maaned": "2026-01-01", "belop": 1000}]')$$, :'org', :'fors'), 'FA409');
-- Starten: hele beløpet, bare én gang, og ikke for en påløpt kostnad.
select test.feiler(format($$select faktura.bokfor_periodisering(%L, '2026-01-05', 'x', '[{"konto": "1700", "belop": 100}, {"konto": "7500", "belop": -100}]',
  '[{"periodisering_id": "%s", "type": "start", "belop": 100}]')$$, :'org', :'fors'), 'FA400');
select faktura.bokfor_periodisering(:'org', '2026-01-05', 'Forskuddsbetalt kostnad: Forsikring 2026 (nr. 1)',
  '[{"konto": "1700", "belop": 12000}, {"konto": "7500", "belop": -12000}]',
  format('[{"periodisering_id": "%s", "type": "start", "belop": 12000}]', :'fors')::jsonb) as start \gset
select test.er((select row(serie, aar, nummer, kilde, dato)::text from faktura.bilag where id = :'start'), row('P', 2026, 1, 'periodisering', '2026-01-05'::date)::text, 'bilaget i serie P');
select test.feiler(format($$select faktura.bokfor_periodisering(%L, '2026-01-05', 'x', '[{"konto": "1700", "belop": 12000}, {"konto": "7500", "belop": -12000}]',
  '[{"periodisering_id": "%s", "type": "start", "belop": 12000}]')$$, :'org', :'fors'), 'FA409');
select test.feiler(format($$select faktura.bokfor_periodisering(%L, '2026-01-05', 'x', '[{"konto": "5000", "belop": 6000}, {"konto": "2960", "belop": -6000}]',
  '[{"periodisering_id": "%s", "type": "start", "belop": 6000}]')$$, :'org', :'bonus'), 'FA409');

-- Januar for begge i ett bilag, så februar for bonusen.
select faktura.bokfor_periodisering(:'org', '2026-01-31', 'Periodiseringer januar 2026',
  '[{"konto": "7500", "belop": 1000}, {"konto": "1700", "belop": -1000}, {"konto": "5000", "belop": 2000}, {"konto": "2960", "belop": -2000}]',
  format('[{"periodisering_id": "%s", "type": "maaned", "maaned": "2026-01-01", "belop": 1000}, {"periodisering_id": "%s", "type": "maaned", "maaned": "2026-01-01", "belop": 2000}]',
         :'fors', :'bonus')::jsonb) as jan \gset
select faktura.bokfor_periodisering(:'org', '2026-02-28', 'Periodiseringer februar 2026',
  '[{"konto": "5000", "belop": 2000}, {"konto": "2960", "belop": -2000}]',
  format('[{"periodisering_id": "%s", "type": "maaned", "maaned": "2026-02-01", "belop": 2000}]', :'bonus')::jsonb) as feb \gset
select test.er((select row(serie, nummer)::text from faktura.bilag where id = :'feb'), row('P', 3)::text, 'nummeret i serien');
select test.er((select string_agg(to_char(maaned, 'YYYY-MM') || ':' || belop, ',' order by maaned) from faktura.periodiseringsposter where periodisering_id = :'bonus'),
               '2026-01:2000.00,2026-02:2000.00', 'postene for bonusen');
-- Ikke samme måned igjen, ikke en tidligere måned, ikke utenfor periodiseringen, og bilaget må gå i null.
select test.feiler(format($$select faktura.bokfor_periodisering(%L, '2026-02-28', 'x', '[{"konto": "5000", "belop": 1}, {"konto": "2960", "belop": -1}]',
  '[{"periodisering_id": "%s", "type": "maaned", "maaned": "2026-02-01", "belop": 1}]')$$, :'org', :'bonus'), 'FA409');
select test.feiler(format($$select faktura.bokfor_periodisering(%L, '2026-01-31', 'x', '[{"konto": "5000", "belop": 1}, {"konto": "2960", "belop": -1}]',
  '[{"periodisering_id": "%s", "type": "maaned", "maaned": "2026-01-01", "belop": 1}]')$$, :'org', :'bonus'), 'FA409');
select test.feiler(format($$select faktura.bokfor_periodisering(%L, '2026-04-30', 'x', '[{"konto": "5000", "belop": 1}, {"konto": "2960", "belop": -1}]',
  '[{"periodisering_id": "%s", "type": "maaned", "maaned": "2026-04-01", "belop": 1}]')$$, :'org', :'bonus'), 'FA409');
select test.feiler(format($$select faktura.bokfor_periodisering(%L, '2025-12-31', 'x', '[{"konto": "7500", "belop": 1}, {"konto": "1700", "belop": -1}]',
  '[{"periodisering_id": "%s", "type": "maaned", "maaned": "2025-12-01", "belop": 1}]')$$, :'org', :'fors'), 'FA409');
select test.feiler(format($$select faktura.bokfor_periodisering(%L, '2026-03-31', 'x', '[{"konto": "5000", "belop": 2000}, {"konto": "2960", "belop": -1999}]',
  '[{"periodisering_id": "%s", "type": "maaned", "maaned": "2026-03-01", "belop": 2000}]')$$, :'org', :'bonus'), 'FA400');
select test.feiler(format($$select faktura.bokfor_periodisering(%L, '2026-03-31', 'x', '[{"konto": "5000", "belop": 1}, {"konto": "2960", "belop": -1}]', '[]')$$, :'org'), 'FA400');
-- Ikke mer fordelt enn beløpet (bonusen: 4 000 fordelt, 2 000 igjen).
select test.feiler(format($$select faktura.bokfor_periodisering(%L, '2026-03-31', 'x', '[{"konto": "5000", "belop": 2000.01}, {"konto": "2960", "belop": -2000.01}]',
  '[{"periodisering_id": "%s", "type": "maaned", "maaned": "2026-03-01", "belop": 2000.01}]')$$, :'org', :'bonus'), 'FA409');

-- Når noe er bokført: beløpet, kontoene og starten kan ikke endres; navnet og antallet måneder kan,
-- men ikke færre enn det som er bokført; periodiseringen slettes ikke.
select test.feiler(format($$update faktura.periodiseringer set belop = 7000 where id = %L$$, :'bonus'), 'FA409');
select test.feiler(format($$update faktura.periodiseringer set resultatkonto = '5001' where id = %L$$, :'bonus'), 'FA409');
select test.feiler(format($$update faktura.periodiseringer set start = 'ingen' where id = %L$$, :'fors'), 'FA409');
update faktura.periodiseringer set navn = 'Bonus 2026', antall_maaneder = 4 where id = :'bonus';
select test.er((select row(navn, antall_maaneder, nummer)::text from faktura.periodiseringer where id = :'bonus'), row('Bonus 2026', 4, 2)::text, 'navnet og månedene');
select test.feiler(format($$update faktura.periodiseringer set antall_maaneder = 1 where id = %L$$, :'bonus'), 'FA409');
select test.feiler(format($$delete from faktura.periodiseringer where id = %L$$, :'bonus'), 'FA409');

-- Reversering: det siste først (februar før januar, og starten når ingen måned er bokført).
select test.feiler(format($$select faktura.reverser_periodisering(%L, %L, null)$$, :'org', :'jan'), 'FA409');
select test.feiler(format($$select faktura.reverser_periodisering(%L, %L, null)$$, :'org', :'start'), 'FA409');
select faktura.reverser_periodisering(:'org', :'feb', null) as feb_rev \gset
select test.er((select row(tekst, serie, reverserer)::text from faktura.bilag where id = :'feb_rev'), row('Reversert: Periodiseringer februar 2026', 'P', :'feb'::uuid)::text, 'reverseringen');
select test.er((select reversert from faktura.periodiseringsposter where bilag_id = :'feb'), true, 'februar gjelder ikke lenger');
select test.feiler(format($$select faktura.reverser_periodisering(%L, %L, null)$$, :'org', :'feb'), 'FA409');
select test.feiler(format($$select faktura.reverser_periodisering(%L, %L, null)$$, :'org', :'feb_rev'), 'FA409');
select faktura.reverser_periodisering(:'org', :'jan', 'Feil beløp') as jan_rev \gset
select test.er((select tekst from faktura.bilag where id = :'jan_rev'), 'Feil beløp', 'egen tekst på reverseringen');
select faktura.reverser_periodisering(:'org', :'start', null);
select test.er((select coalesce(sum(p.belop), 0) from faktura.posteringer p join faktura.bilag b on b.id = p.bilag_id where b.org_id = :'org' and p.konto in ('1700', '2960')),
               0::numeric, 'alt er reversert');
-- Uten bokføringer kan alt endres, og periodiseringen slettes (bilagene står).
update faktura.periodiseringer set belop = 6500, start = 'ingen' where id = :'fors';
delete from faktura.periodiseringer where id = :'bonus';
select test.er((select count(*)::int from faktura.periodiseringer where org_id = :'org'), 1, 'bonusen er slettet');
select test.er((select count(*)::int from faktura.bilag where org_id = :'org' and kilde = 'periodisering'), 6, 'bilagene står');

-- Manuelle bilag (serie M), f.eks. den inngående balansen: går i null og har minst to linjer.
select faktura.bokfor_manuelt(:'org', '2026-01-01', 'Inngående balanse',
  '[{"konto": "1920", "belop": 50000, "tekst": "Bank"}, {"konto": "2000", "belop": -30000}, {"konto": "2050", "belop": -20000, "tekst": " "}]') as ib \gset
select test.er((select row(serie, aar, nummer, kilde, tekst)::text from faktura.bilag where id = :'ib'), row('M', 2026, 1, 'manuell', 'Inngående balanse')::text, 'bilaget i serie M');
select test.er((select string_agg(konto || ':' || belop || ':' || coalesce(tekst, '-'), ',' order by rekke) from faktura.posteringer where bilag_id = :'ib'),
               '1920:50000.00:Bank,2000:-30000.00:-,2050:-20000.00:-', 'posteringene');
select test.feiler(format($$select faktura.bokfor_manuelt(%L, '2026-01-01', 'x', '[{"konto": "1920", "belop": 1}, {"konto": "2000", "belop": -0.99}]')$$, :'org'), 'FA400');
select test.feiler(format($$select faktura.bokfor_manuelt(%L, '2026-01-01', 'x', '[{"konto": "1920", "belop": 1}]')$$, :'org'), 'FA400');
select test.feiler(format($$select faktura.bokfor_manuelt(%L, '2026-01-01', ' ', '[{"konto": "1920", "belop": 1}, {"konto": "2000", "belop": -1}]')$$, :'org'), 'FA400');
select test.feiler(format($$select faktura.bokfor_manuelt(%L, '2026-01-01', 'x', '[{"konto": "19", "belop": 1}, {"konto": "2000", "belop": -1}]')$$, :'org'), '23514');
-- Reverseres én gang, og hver kilde med sin funksjon.
select test.feiler(format($$select faktura.reverser_manuelt(%L, %L, null)$$, :'org', :'jan'), 'FA404');
select test.feiler(format($$select faktura.reverser_periodisering(%L, %L, null)$$, :'org', :'ib'), 'FA404');
select test.feiler(format($$select faktura.reverser_anlegg(%L, %L, null)$$, :'org', :'ib'), 'FA404');
select faktura.reverser_manuelt(:'org', :'ib', null) as ib_rev \gset
select test.er((select row(serie, nummer, tekst, reverserer)::text from faktura.bilag where id = :'ib_rev'), row('M', 2, 'Reversert: Inngående balanse', :'ib'::uuid)::text, 'reversert');
select test.er((select sum(belop) from faktura.posteringer where bilag_id in (:'ib', :'ib_rev') and konto = '1920'), 0::numeric, 'banken går i null');
select test.feiler(format($$select faktura.reverser_manuelt(%L, %L, null)$$, :'org', :'ib'), 'FA409');
select test.feiler(format($$select faktura.reverser_manuelt(%L, %L, null)$$, :'org', :'ib_rev'), 'FA409');
select faktura.bokfor_manuelt(:'org', '2026-01-01', 'Inngående balanse',
  '[{"konto": "1920", "belop": 50000}, {"konto": "2000", "belop": -30000}, {"konto": "2050", "belop": -20000}]') as ib2 \gset

-- Fakturerer ser ikke periodiseringene, bilagene, posteringene eller loggen, og fører ikke.
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select count(*)::int from faktura.periodiseringer where org_id = :'org'), 0, 'fakturerer ser ikke periodiseringene');
select test.er((select count(*)::int from faktura.periodiseringsposter where org_id = :'org'), 0, 'fakturerer ser ikke postene');
select test.er((select count(*)::int from faktura.bilag where org_id = :'org'), 0, 'fakturerer ser ikke bilagene');
select test.er((select count(*)::int from faktura.posteringer where org_id = :'org'), 0, 'fakturerer ser ikke posteringene');
select test.er((select count(*)::int from faktura.revisjonslogg where org_id = :'org' and tabell in ('periodiseringer', 'bilag')), 0, 'fakturerer ser ikke loggen');
select test.feiler(format($$select faktura.bokfor_manuelt(%L, '2026-01-01', 'x', '[{"konto": "1920", "belop": 1}, {"konto": "2000", "belop": -1}]')$$, :'org'), 'FA403');
select test.feiler(format($$select faktura.bokfor_periodisering(%L, '2026-01-31', 'x', '[{"konto": "7500", "belop": 1}, {"konto": "1700", "belop": -1}]',
  '[{"periodisering_id": "%s", "type": "maaned", "maaned": "2026-01-01", "belop": 1}]')$$, :'org', :'fors'), 'FA403');
select test.feiler(format($$select faktura.reverser_manuelt(%L, %L, null)$$, :'org', :'ib2'), 'FA403');
select test.feiler(format($$insert into faktura.periodiseringer (org_id, navn, type, belop, fra, antall_maaneder, resultatkonto, balansekonto)
                           values (%L, 'X', 'paalopt_kostnad', 100, '2026-01-01', 2, '5000', '2960')$$, :'org'), '42501');
select set_config('app.bruker_id', :'u', false);
select test.er((select count(*)::int from faktura.bilag where org_id = :'org' and kilde in ('periodisering', 'manuell')), 9, 'eieren ser bilagene');
select test.er((select count(*) > 0 from faktura.revisjonslogg where org_id = :'org' and tabell = 'periodiseringer'), true, 'eieren ser loggen');

\c :migrator
drop schema test cascade;
