-- Fakturaene og innbetalingene i regnskapet (0089_regnskap_salg.sql): bilaget for en faktura (serie
-- F, på fakturadatoen, med mva-kodene) og for en innbetaling (serie B, på betalingsdatoen),
-- kontrollene i bokfor_salg (utstedt, datoen, teksten, linjene, går i null, kundefordringen eller
-- banken på én linje, én gang og ikke fra før startdatoen), reverseringen (bare når fakturaen eller
-- betalingen er slettet eller er fra før startdatoen, og med mva-kodene), at det kan bokføres på
-- nytt etter en reversering, og at fakturerer ikke ser eller fører noe.

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
-- Posteringene i et bilag: konto:beløp:mva-kode.
create function test.poster(_bilag uuid) returns text language sql as $$
  select string_agg(konto || ':' || belop || ':' || coalesce(mva_kode, '-'), ',' order by rekke) from faktura.posteringer where bilag_id = _bilag
$$;
grant execute on all functions in schema test to public;

\c :api
select id as u from faktura.registrer_bruker('uid-salg-eier', 'eier-salg@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Salg AS', '915000371') \gset
update faktura.organisasjoner set kontonr = '86011117947', mva_registrert = true where id = :'org';
select faktura.inviter_medlem(:'org', 'fakt-salg@test.no', 'fakturerer') as t_fakt \gset
select id as u_fakt from faktura.registrer_bruker('uid-salg-fakt', 'fakt-salg@test.no') \gset
select set_config('app.bruker_id', :'u_fakt', false);
select faktura.aksepter_invitasjon(:'t_fakt');
select set_config('app.bruker_id', :'u', false);

insert into faktura.kunder (org_id, navn, epost) values (:'org', 'Kunde AS', 'kunde@test.no') returning id as k \gset
insert into faktura.fakturaer (org_id, kunde_id, fakturadato, forfallsdato) values (:'org', :'k', '2026-09-01', '2026-09-15') returning id as f \gset
insert into faktura.faktura_linjer (org_id, faktura_id, rekke, beskrivelse, antall, enhetspris, mva_sats)
values (:'org', :'f', 1, 'Krem', 2, 200, 25), (:'org', :'f', 2, 'Konsultasjon', 1, 600, 0);

\set fakturalinjer '[{"konto": "1500", "belop": 1100, "tekst": "Kunde AS, faktura 1"}, {"konto": "3000", "belop": -400, "tekst": "Salg 25 % mva", "mva_kode": "3"}, {"konto": "2700", "belop": -100, "mva_kode": "3"}, {"konto": "3200", "belop": -600, "mva_kode": "6"}]'

-- Et utkast bokføres ikke.
select test.feiler(format($$select faktura.bokfor_salg(%L, 'faktura', %L, '2026-09-01', 'x', %L)$$, :'org', :'f', :'fakturalinjer'), 'FA409');
select faktura.utsted(:'f');

-- Kontrollene: fakturadatoen, teksten, minst to linjer, ingen på 0, går i null, fakturaens sum på
-- én linje, kilden, fakturaen finnes og mva-koden er ett eller to sifre.
select test.feiler(format($$select faktura.bokfor_salg(%L, 'faktura', %L, '2026-09-02', 'x', %L)$$, :'org', :'f', :'fakturalinjer'), 'FA400');
select test.feiler(format($$select faktura.bokfor_salg(%L, 'faktura', %L, '2026-09-01', ' ', %L)$$, :'org', :'f', :'fakturalinjer'), 'FA400');
select test.feiler(format($$select faktura.bokfor_salg(%L, 'faktura', %L, '2026-09-01', 'x', '[{"konto": "1500", "belop": 1100}]')$$, :'org', :'f'), 'FA400');
select test.feiler(format($$select faktura.bokfor_salg(%L, 'faktura', %L, '2026-09-01', 'x',
  '[{"konto": "1500", "belop": 1100}, {"konto": "3000", "belop": -1100}, {"konto": "3200", "belop": 0}]')$$, :'org', :'f'), 'FA400');
select test.feiler(format($$select faktura.bokfor_salg(%L, 'faktura', %L, '2026-09-01', 'x', '[{"konto": "1500", "belop": 1100}, {"konto": "3000", "belop": -1000}]')$$, :'org', :'f'), 'FA400');
select test.feiler(format($$select faktura.bokfor_salg(%L, 'faktura', %L, '2026-09-01', 'x', '[{"konto": "1500", "belop": 1000}, {"konto": "3000", "belop": -1000}]')$$, :'org', :'f'), 'FA400');
select test.feiler(format($$select faktura.bokfor_salg(%L, 'lonn', %L, '2026-09-01', 'x', %L)$$, :'org', :'f', :'fakturalinjer'), 'FA400');
select test.feiler(format($$select faktura.bokfor_salg(%L, 'faktura', gen_random_uuid(), '2026-09-01', 'x', %L)$$, :'org', :'fakturalinjer'), 'FA404');
select test.feiler(format($$select faktura.bokfor_salg(%L, 'faktura', %L, '2026-09-01', 'x',
  '[{"konto": "1500", "belop": 1100}, {"konto": "3000", "belop": -1100, "mva_kode": "3a"}]')$$, :'org', :'f'), '23514');

select faktura.bokfor_salg(:'org', 'faktura', :'f', '2026-09-01', 'Faktura 1 Kunde AS', :'fakturalinjer') as fb \gset
select test.er((select row(serie, aar, nummer, kilde, kilde_id, dato, tekst)::text from faktura.bilag where id = :'fb'),
               row('F', 2026, 1, 'faktura', :'f'::uuid, '2026-09-01'::date, 'Faktura 1 Kunde AS')::text, 'bilaget i serie F');
select test.er(test.poster(:'fb'), '1500:1100.00:-,3000:-400.00:3,2700:-100.00:3,3200:-600.00:6', 'posteringene med mva-kodene');
-- Én gang.
select test.feiler(format($$select faktura.bokfor_salg(%L, 'faktura', %L, '2026-09-01', 'x', %L)$$, :'org', :'f', :'fakturalinjer'), 'FA409');
-- Ingen skriver bilagene eller posteringene direkte.
select test.feiler(format($$insert into faktura.bilag (org_id, serie, aar, nummer, dato, tekst, kilde, kilde_id) values (%L, 'F', 2026, 9, '2026-09-01', 'x', 'faktura', %L)$$, :'org', :'f'), '42501');
select test.feiler(format($$update faktura.posteringer set mva_kode = '5' where bilag_id = %L$$, :'fb'), '42501');

-- En innbetaling: serie B på betalingsdatoen, med betalingens beløp på én linje.
select faktura.registrer_betaling(:'f', 1100, '2026-09-20');
select id as p from faktura.betalinger where faktura_id = :'f' \gset
select test.feiler(format($$select faktura.bokfor_salg(%L, 'innbetaling', %L, '2026-09-21', 'x', '[{"konto": "1920", "belop": 1100}, {"konto": "1500", "belop": -1100}]')$$, :'org', :'p'), 'FA400');
select test.feiler(format($$select faktura.bokfor_salg(%L, 'innbetaling', %L, '2026-09-20', 'x', '[{"konto": "1920", "belop": 1000}, {"konto": "1500", "belop": -1000}]')$$, :'org', :'p'), 'FA400');
select faktura.bokfor_salg(:'org', 'innbetaling', :'p', '2026-09-20', 'Innbetaling faktura 1 Kunde AS', '[{"konto": "1920", "belop": 1100}, {"konto": "1500", "belop": -1100}]') as pb \gset
select test.er((select row(serie, nummer, kilde, dato)::text from faktura.bilag where id = :'pb'), row('B', 1, 'innbetaling', '2026-09-20'::date)::text, 'bilaget i serie B');

-- Så lenge fakturaen og betalingen finnes, reverseres bilagene ikke (og ikke med de andre funksjonene).
select test.feiler(format($$select faktura.reverser_salg(%L, %L)$$, :'org', :'fb'), 'FA409');
select test.feiler(format($$select faktura.reverser_salg(%L, %L)$$, :'org', :'pb'), 'FA409');
select test.feiler(format($$select faktura.reverser_manuelt(%L, %L, null)$$, :'org', :'fb'), 'FA404');
select faktura.bokfor_manuelt(:'org', '2026-01-01', 'Inngående balanse', '[{"konto": "1920", "belop": 100}, {"konto": "2050", "belop": -100}]') as ib \gset
select test.feiler(format($$select faktura.reverser_salg(%L, %L)$$, :'org', :'ib'), 'FA404');

-- Startdatoen flyttes fram: det som er fra før, bokføres ikke, og bilaget før den reverseres, med
-- mva-kodene. Innbetalingen etter datoen står.
insert into faktura.regnskap_oppsett (org_id, salg_fra) values (:'org', '2026-09-10');
select faktura.reverser_salg(:'org', :'fb') as fb_rev \gset
select test.er((select row(serie, nummer, dato, tekst, reverserer)::text from faktura.bilag where id = :'fb_rev'),
               row('F', 2, '2026-09-01'::date, 'Reversert, fra før startdatoen for salget: Faktura 1 Kunde AS', :'fb'::uuid)::text, 'reversert');
select test.er(test.poster(:'fb_rev'), '1500:-1100.00:-,3000:400.00:3,2700:100.00:3,3200:600.00:6', 'reverseringen har mva-kodene');
select test.feiler(format($$select faktura.reverser_salg(%L, %L)$$, :'org', :'pb'), 'FA409');
select test.feiler(format($$select faktura.bokfor_salg(%L, 'faktura', %L, '2026-09-01', 'x', %L)$$, :'org', :'f', :'fakturalinjer'), 'FA409');
-- Et bilag som er reversert, og en reversering, reverseres ikke.
select test.feiler(format($$select faktura.reverser_salg(%L, %L)$$, :'org', :'fb'), 'FA409');
select test.feiler(format($$select faktura.reverser_salg(%L, %L)$$, :'org', :'fb_rev'), 'FA409');

-- Startdatoen flyttes tilbake: fakturaen bokføres på nytt (ett gjeldende bilag).
update faktura.regnskap_oppsett set salg_fra = null where org_id = :'org';
select faktura.bokfor_salg(:'org', 'faktura', :'f', '2026-09-01', 'Faktura 1 Kunde AS', :'fakturalinjer') as fb2 \gset
select test.er((select row(serie, nummer)::text from faktura.bilag where id = :'fb2'), row('F', 3)::text, 'bokført på nytt');
select test.feiler(format($$select faktura.bokfor_salg(%L, 'faktura', %L, '2026-09-01', 'x', %L)$$, :'org', :'f', :'fakturalinjer'), 'FA409');

-- Fakturaen slettes (med betalingen): bilagene reverseres.
select faktura.slett_faktura(:'org', :'f', 'Feil kunde');
select faktura.reverser_salg(:'org', :'fb2') as fb2_rev \gset
select faktura.reverser_salg(:'org', :'pb') as pb_rev \gset
select test.er((select tekst from faktura.bilag where id = :'fb2_rev'), 'Reversert, fakturaen er slettet: Faktura 1 Kunde AS', 'den slettede fakturaen');
select test.er((select row(serie, tekst)::text from faktura.bilag where id = :'pb_rev'), row('B', 'Reversert, betalingen er tatt bort: Innbetaling faktura 1 Kunde AS')::text, 'den slettede betalingen');
select test.feiler(format($$select faktura.reverser_salg(%L, %L)$$, :'org', :'pb'), 'FA409');
select test.er((select sum(p.belop) from faktura.posteringer p join faktura.bilag b on b.id = p.bilag_id where b.org_id = :'org' and p.konto in ('1500', '3000', '2700', '3200')),
               0::numeric, 'alt går i null');
select test.er((select count(*)::int from faktura.bilag where org_id = :'org' and kilde in ('faktura', 'innbetaling')), 6, 'bilagene står');

-- Fakturerer ser ikke bilagene og fører eller reverserer ikke.
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select count(*)::int from faktura.bilag where org_id = :'org'), 0, 'fakturerer ser ikke bilagene');
select test.er((select count(*)::int from faktura.posteringer where org_id = :'org'), 0, 'fakturerer ser ikke posteringene');
select test.feiler(format($$select faktura.bokfor_salg(%L, 'faktura', gen_random_uuid(), '2026-09-01', 'x', '[]')$$, :'org'), 'FA403');
select test.feiler(format($$select faktura.reverser_salg(%L, %L)$$, :'org', :'fb2'), 'FA403');
select set_config('app.bruker_id', :'u', false);
select test.er((select count(*)::int from faktura.bilag where org_id = :'org' and kilde in ('faktura', 'innbetaling')), 6, 'eieren ser bilagene');

\c :migrator
drop schema test cascade;
