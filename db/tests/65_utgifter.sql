-- Utgiftene (0090_utgifter.sql): kladden kan endres av den som fører regnskapet, men statusen,
-- bilagene og arkivet settes bare av funksjonene; bokfor_utgift (serie U, kontrollene, én gang),
-- en bokført utgift endres og slettes ikke, betal_utgift (leverandørgjelden mot banken, én gang),
-- angre_utgift (reverserer betalingen og kostnaden), koble_utgift (anleggsmiddel og periodisering),
-- mva-kodene på anleggsmidlene og de manuelle bilagene, og at fakturerer ikke ser eller fører noe.

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
create function test.poster(_bilag uuid) returns text language sql as $$
  select string_agg(konto || ':' || belop || ':' || coalesce(mva_kode, '-'), ',' order by rekke) from faktura.posteringer where bilag_id = _bilag
$$;
grant execute on all functions in schema test to public;

\c :api
select id as u from faktura.registrer_bruker('uid-utg-eier', 'eier-utg@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Utgift AS', '915000401') \gset
select faktura.inviter_medlem(:'org', 'fakt-utg@test.no', 'fakturerer') as t_fakt \gset
select id as u_fakt from faktura.registrer_bruker('uid-utg-fakt', 'fakt-utg@test.no') \gset
select set_config('app.bruker_id', :'u_fakt', false);
select faktura.aksepter_invitasjon(:'t_fakt');
select set_config('app.bruker_id', :'u', false);

-- En kladd med to linjer: 1 000 kr kontorrekvisita med 25 % mva og 400 kr representasjon (uten fradrag).
insert into faktura.utgifter (org_id, type, leverandor, orgnr, fakturanummer, dato, forfallsdato, belop, betaling)
values (:'org', 'faktura', 'Kontorbutikken AS', '974760673', '1001', '2026-09-10', '2026-09-24', 1750, 'ubetalt') returning id as ut \gset
insert into faktura.utgift_linjer (org_id, utgift_id, rekke, beskrivelse, kategori, konto, belop, mva_sats, mva, fradrag)
values (:'org', :'ut', 1, 'Papir', 'kontorrekvisita', '6800', 1000, 25, 250, 100),
       (:'org', :'ut', 2, 'Lunsj', 'representasjon', '7350', 400, 25, 100, 0);
-- Kladden kan endres, men statusen, bilaget og arkivet settes ikke direkte.
update faktura.utgifter set beskrivelse = 'Kontorvarer' where id = :'ut';
select test.feiler(format($$update faktura.utgifter set status = 'bokfort' where id = %L$$, :'ut'), '42501');
select test.feiler(format($$update faktura.utgifter set arkiv_sti = 'x' where id = %L$$, :'ut'), '42501');
select test.feiler(format($$insert into faktura.utgifter (org_id, status) values (%L, 'bokfort')$$, :'org'), '42501');

\set kostnad '[{"konto": "6800", "belop": 1000, "tekst": "Papir", "mva_kode": "1"}, {"konto": "7350", "belop": 500, "tekst": "Lunsj"}, {"konto": "2710", "belop": 250, "mva_kode": "1"}, {"konto": "2400", "belop": -1750, "tekst": "Kontorbutikken AS"}]'
-- Kontrollene: teksten, minst to linjer, ingen på 0, går i null, beløpet på én linje, og bare kostnad.
select test.feiler(format($$select faktura.bokfor_utgift(%L, %L, ' ', %L)$$, :'org', :'ut', :'kostnad'), 'FA400');
select test.feiler(format($$select faktura.bokfor_utgift(%L, %L, 'x', '[{"konto": "6800", "belop": 1750}]')$$, :'org', :'ut'), 'FA400');
select test.feiler(format($$select faktura.bokfor_utgift(%L, %L, 'x', '[{"konto": "6800", "belop": 1750}, {"konto": "2400", "belop": -1750}, {"konto": "7350", "belop": 0}]')$$, :'org', :'ut'), 'FA400');
select test.feiler(format($$select faktura.bokfor_utgift(%L, %L, 'x', '[{"konto": "6800", "belop": 1750}, {"konto": "2400", "belop": -1749}]')$$, :'org', :'ut'), 'FA400');
select test.feiler(format($$select faktura.bokfor_utgift(%L, %L, 'x', '[{"konto": "6800", "belop": 1000}, {"konto": "2400", "belop": -1000}]')$$, :'org', :'ut'), 'FA400');
select test.feiler(format($$select faktura.bokfor_utgift(%L, gen_random_uuid(), 'x', %L)$$, :'org', :'kostnad'), 'FA404');
update faktura.utgifter set behandling = 'anlegg' where id = :'ut';
select test.feiler(format($$select faktura.bokfor_utgift(%L, %L, 'x', %L)$$, :'org', :'ut', :'kostnad'), 'FA409');
update faktura.utgifter set behandling = 'kostnad', dato = faktura.i_dag() + 1 where id = :'ut';
select test.feiler(format($$select faktura.bokfor_utgift(%L, %L, 'x', %L)$$, :'org', :'ut', :'kostnad'), 'FA400');
update faktura.utgifter set dato = '2026-09-10' where id = :'ut';

select faktura.bokfor_utgift(:'org', :'ut', 'Faktura 1001 Kontorbutikken AS', :'kostnad') as ub \gset
select test.er((select row(serie, aar, nummer, kilde, kilde_id, dato)::text from faktura.bilag where id = :'ub'),
               row('U', 2026, 1, 'utgift', :'ut'::uuid, '2026-09-10'::date)::text, 'bilaget i serie U');
select test.er(test.poster(:'ub'), '6800:1000.00:1,7350:500.00:-,2710:250.00:1,2400:-1750.00:-', 'posteringene med mva-kodene');
select test.er((select row(status, bilag_id, auto, betalt_dato)::text from faktura.utgifter where id = :'ut'), row('bokfort', :'ub'::uuid, false, null::date)::text, 'bokført');
select test.feiler(format($$select faktura.bokfor_utgift(%L, %L, 'x', %L)$$, :'org', :'ut', :'kostnad'), 'FA409');
-- Bokført: endres og slettes ikke, heller ikke linjene.
select test.feiler(format($$update faktura.utgifter set belop = 1 where id = %L$$, :'ut'), 'FA409');
select test.feiler(format($$delete from faktura.utgifter where id = %L$$, :'ut'), 'FA409');
select test.feiler(format($$update faktura.utgift_linjer set konto = '6810' where utgift_id = %L$$, :'ut'), 'FA409');
select test.feiler(format($$delete from faktura.utgift_linjer where utgift_id = %L$$, :'ut'), 'FA409');

-- Betalingen: leverandørgjelden mot banken, én gang, ikke før utgiften og ikke fram i tid.
\set betaling '[{"konto": "2400", "belop": 1750}, {"konto": "1920", "belop": -1750}]'
select test.feiler(format($$select faktura.betal_utgift(%L, %L, '2026-09-09', 'bank', 'x', %L)$$, :'org', :'ut', :'betaling'), 'FA400');
select test.feiler(format($$select faktura.betal_utgift(%L, %L, faktura.i_dag() + 1, 'bank', 'x', %L)$$, :'org', :'ut', :'betaling'), 'FA400');
select test.feiler(format($$select faktura.betal_utgift(%L, %L, '2026-09-20', 'kort', 'x', %L)$$, :'org', :'ut', :'betaling'), 'FA400');
select faktura.betal_utgift(:'org', :'ut', '2026-09-20', 'bank', 'Betalt: Faktura 1001 Kontorbutikken AS', :'betaling') as bb \gset
select test.er((select row(serie, nummer, kilde)::text from faktura.bilag where id = :'bb'), row('U', 2, 'utgift_betaling')::text, 'betalingen i serie U');
select test.er((select row(betaling, betalt_dato, betaling_bilag_id)::text from faktura.utgifter where id = :'ut'), row('bank', '2026-09-20'::date, :'bb'::uuid)::text, 'betalt');
select test.feiler(format($$select faktura.betal_utgift(%L, %L, '2026-09-20', 'bank', 'x', %L)$$, :'org', :'ut', :'betaling'), 'FA409');

-- Angre: betalingen og kostnaden reverseres, og den er en kladd igjen (ubetalt).
select faktura.angre_utgift(:'org', :'ut');
select test.er((select row(status, bilag_id, betaling_bilag_id, betaling, betalt_dato)::text from faktura.utgifter where id = :'ut'),
               row('kladd', null::uuid, null::uuid, 'ubetalt', null::date)::text, 'angret');
select test.er((select count(*)::int from faktura.bilag where org_id = :'org' and reverserer in (:'ub', :'bb')), 2, 'begge er reversert');
select test.er((select sum(p.belop) from faktura.posteringer p join faktura.bilag b on b.id = p.bilag_id where b.org_id = :'org' and p.konto in ('2400', '2710', '6800')),
               0::numeric, 'alt går i null');
select test.er((select string_agg(coalesce(mva_kode, '-'), ',' order by rekke) from faktura.posteringer
                 where bilag_id = (select id from faktura.bilag where reverserer = :'ub')), '1,-,1,-', 'reverseringen har mva-kodene');
select test.feiler(format($$select faktura.angre_utgift(%L, %L)$$, :'org', :'ut'), 'FA409');
-- Bokført på nytt (et nytt gjeldende bilag), og en kladd kan slettes.
select faktura.bokfor_utgift(:'org', :'ut', 'Faktura 1001 Kontorbutikken AS', :'kostnad') as ub2 \gset
select test.er((select nummer from faktura.bilag where id = :'ub2'), 5, 'nytt bilag');
insert into faktura.utgifter (org_id, leverandor) values (:'org', 'Slett meg') returning id as slett \gset
delete from faktura.utgifter where id = :'slett';

-- Anleggsmiddel: anskaffelsen (serie A, med mva-koden) kobles til utgiften; en kostnad kobles ikke.
insert into faktura.utgifter (org_id, leverandor, dato, belop, behandling, anlegg_kategori, levetid_mnd)
values (:'org', 'Elkjøp Nordic AS', '2026-09-20', 50000, 'anlegg', 'kontormaskiner', 36) returning id as pc \gset
insert into faktura.utgift_linjer (org_id, utgift_id, rekke, konto, belop, mva_sats, mva) values (:'org', :'pc', 1, '6551', 40000, 25, 10000);
insert into faktura.anleggsmidler (org_id, navn, kategori, anskaffet, avskrives_fra, kostpris, levetid_mnd, konto, skatt)
values (:'org', 'PC-er', 'kontormaskiner', '2026-09-20', '2026-09-01', 40000, 36, '1280', 'a') returning id as anl \gset
select faktura.bokfor_anlegg(:'org', '2026-09-20', 'Anskaffelse: PC-er',
  '[{"konto": "1280", "belop": 40000}, {"konto": "2710", "belop": 10000, "mva_kode": "1"}, {"konto": "2400", "belop": -50000}]',
  format('[{"anleggsmiddel_id": "%s", "type": "anskaffelse", "belop": 40000}]', :'anl')::jsonb) as ab \gset
select test.er(test.poster(:'ab'), '1280:40000.00:-,2710:10000.00:1,2400:-50000.00:-', 'anskaffelsen med mva-koden');
select test.feiler(format($$select faktura.koble_utgift(%L, %L, %L, null, null)$$, :'org', :'pc', :'ub2'), 'FA400');
select faktura.koble_utgift(:'org', :'pc', :'ab', :'anl', null);
select test.er((select row(status, bilag_id, anlegg_id)::text from faktura.utgifter where id = :'pc'), row('bokfort', :'ab'::uuid, :'anl'::uuid)::text, 'koblet');
select test.feiler(format($$select faktura.koble_utgift(%L, %L, %L, %L, null)$$, :'org', :'pc', :'ab', :'anl'), 'FA409');
-- Angre: anskaffelsen reverseres og anleggsmiddelet slettes.
select faktura.angre_utgift(:'org', :'pc');
select test.er((select count(*)::int from faktura.anleggsmidler where id = :'anl'), 0, 'anleggsmiddelet er slettet');
select test.er((select status from faktura.utgifter where id = :'pc'), 'kladd', 'kladd igjen');
select test.er((select count(*)::int from faktura.bilag where reverserer = :'ab'), 1, 'anskaffelsen er reversert');

-- Manuelle bilag kan ha mva-koden.
select faktura.bokfor_manuelt(:'org', '2026-09-30', 'Kjøp med mva', '[{"konto": "6300", "belop": 1000, "mva_kode": "1"}, {"konto": "2710", "belop": 250, "mva_kode": "1"}, {"konto": "1920", "belop": -1250}]') as mb \gset
select test.er(test.poster(:'mb'), '6300:1000.00:1,2710:250.00:1,1920:-1250.00:-', 'det manuelle bilaget med mva-koden');

-- Fakturerer ser ikke utgiftene og fører ikke.
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select count(*)::int from faktura.utgifter where org_id = :'org'), 0, 'fakturerer ser ikke utgiftene');
select test.er((select count(*)::int from faktura.utgift_linjer where org_id = :'org'), 0, 'fakturerer ser ikke linjene');
select test.feiler(format($$insert into faktura.utgifter (org_id, leverandor) values (%L, 'x')$$, :'org'), '42501');
select test.feiler(format($$select faktura.bokfor_utgift(%L, %L, 'x', %L)$$, :'org', :'pc', :'kostnad'), 'FA403');
select test.feiler(format($$select faktura.angre_utgift(%L, %L)$$, :'org', :'ut'), 'FA403');
select set_config('app.bruker_id', :'u', false);
select test.er((select count(*)::int from faktura.utgifter where org_id = :'org'), 2, 'eieren ser utgiftene');

\c :migrator
drop schema test cascade;
