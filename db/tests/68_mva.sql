-- Mva-meldingen (0093_mva.sql): terminene (type og nummer, levert med beløp), oppgjøret i serie V
-- (kontrollene, ett gjeldende per termin: et nytt reverserer det forrige, og det kan angres), at
-- den som fører regnskapet ser og fører, og at fakturerer verken ser terminene eller oppgjøret.

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
  select string_agg(konto || ':' || belop, ',' order by rekke) from faktura.posteringer where bilag_id = _bilag
$$;
grant execute on all functions in schema test to public;

\c :api
select id as u from faktura.registrer_bruker('uid-mva-eier', 'eier-mva@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Mva AS', '915000428') \gset
select faktura.inviter_medlem(:'org', 'fakt-mva@test.no', 'fakturerer') as t_fakt \gset
select id as u_fakt from faktura.registrer_bruker('uid-mva-fakt', 'fakt-mva@test.no') \gset
select set_config('app.bruker_id', :'u_fakt', false);
select faktura.aksepter_invitasjon(:'t_fakt');
select set_config('app.bruker_id', :'u', false);

-- Terminene: tomånedlige som standard; årstermin eller månedlig kan velges.
insert into faktura.regnskap_oppsett (org_id) values (:'org');
select test.er((select mva_termin from faktura.regnskap_oppsett where org_id = :'org'), 'tomaaneder', 'standarden');
update faktura.regnskap_oppsett set mva_termin = 'aar' where org_id = :'org';
select test.feiler(format($$update faktura.regnskap_oppsett set mva_termin = 'kvartal' where org_id = %L$$, :'org'), '23514');
update faktura.regnskap_oppsett set mva_termin = 'tomaaneder' where org_id = :'org';

insert into faktura.mva_terminer (org_id, aar, type, termin) values (:'org', 2026, 'tomaaneder', 4) returning id as t4 \gset
select test.feiler(format($$insert into faktura.mva_terminer (org_id, aar, type, termin) values (%L, 2026, 'tomaaneder', 7)$$, :'org'), '23514');
select test.feiler(format($$insert into faktura.mva_terminer (org_id, aar, type, termin) values (%L, 2026, 'aar', 2)$$, :'org'), '23514');
select test.feiler(format($$insert into faktura.mva_terminer (org_id, aar, type, termin) values (%L, 2026, 'tomaaneder', 4)$$, :'org'), '23505');
-- Levert: datoen og beløpet sammen.
select test.feiler(format($$update faktura.mva_terminer set levert = '2026-10-05' where id = %L$$, :'t4'), '23514');
update faktura.mva_terminer set levert = '2026-10-05', levert_belop = 2500, levert_av = :'u' where id = :'t4';
update faktura.mva_terminer set levert = null, levert_belop = null, levert_av = null where id = :'t4';

-- Oppgjøret: kontrollene.
select test.feiler(format($$select faktura.bokfor_mva_oppgjor(%L, gen_random_uuid(), '2026-08-31', 'x', '[{"konto": "2700", "belop": 100}, {"konto": "2740", "belop": -100}]')$$, :'org'), 'FA404');
select test.feiler(format($$select faktura.bokfor_mva_oppgjor(%L, %L, '2099-08-31', 'x', '[{"konto": "2700", "belop": 100}, {"konto": "2740", "belop": -100}]')$$, :'org', :'t4'), 'FA400');
select test.feiler(format($$select faktura.bokfor_mva_oppgjor(%L, %L, '2026-08-31', ' ', '[{"konto": "2700", "belop": 100}, {"konto": "2740", "belop": -100}]')$$, :'org', :'t4'), 'FA400');
select test.feiler(format($$select faktura.bokfor_mva_oppgjor(%L, %L, '2026-08-31', 'x', '[{"konto": "2700", "belop": 100}]')$$, :'org', :'t4'), 'FA400');
select test.feiler(format($$select faktura.bokfor_mva_oppgjor(%L, %L, '2026-08-31', 'x', '[{"konto": "2700", "belop": 100}, {"konto": "2740", "belop": -99}]')$$, :'org', :'t4'), 'FA400');
select test.feiler(format($$select faktura.bokfor_mva_oppgjor(%L, %L, '2026-08-31', 'x', '[{"konto": "27", "belop": 100}, {"konto": "2740", "belop": -100}]')$$, :'org', :'t4'), 'FA400');
select test.feiler(format($$select faktura.bokfor_mva_oppgjor(%L, %L, '2026-08-31', 'x', '[{"konto": "2700", "belop": 0}, {"konto": "2740", "belop": 0}]')$$, :'org', :'t4'), 'FA400');

-- Serie V, kilde mva, på datoen; et nytt oppgjør reverserer det forrige, så ett er gjeldende.
select faktura.bokfor_mva_oppgjor(:'org', :'t4', '2026-08-31', 'Mva-oppgjør 4. termin 2026',
  '[{"konto": "2700", "belop": 2500, "tekst": "Mva-oppgjør"}, {"konto": "2710", "belop": -1000}, {"konto": "2740", "belop": -1500}]') as o1 \gset
select test.er((select row(serie, nummer, dato, kilde, kilde_id)::text from faktura.bilag where id = :'o1'), row('V', 1, '2026-08-31'::date, 'mva', :'t4'::uuid)::text, 'oppgjøret');
select test.er(test.poster(:'o1'), '2700:2500.00,2710:-1000.00,2740:-1500.00', 'posteringene');
select faktura.bokfor_mva_oppgjor(:'org', :'t4', '2026-08-31', 'Mva-oppgjør 4. termin 2026',
  '[{"konto": "2700", "belop": 3000}, {"konto": "2710", "belop": -1000}, {"konto": "2740", "belop": -2000}]') as o2 \gset
select test.er((select reversert_av is not null from faktura.bilag where id = :'o1'), true, 'det første er reversert');
select test.er((select count(*)::int from faktura.bilag where org_id = :'org' and kilde = 'mva' and kilde_id = :'t4' and reverserer is null and reversert_av is null), 1, 'ett gjeldende');
select test.er((select string_agg(serie || '-' || nummer, ',' order by nummer) from faktura.bilag where org_id = :'org' and kilde = 'mva'), 'V-1,V-2,V-3', 'nummerne');
-- Angre: det gjeldende reverseres; uten oppgjør feiler det.
select faktura.angre_mva_oppgjor(:'org', :'t4');
select test.er((select count(*)::int from faktura.bilag where org_id = :'org' and kilde = 'mva' and reverserer is null and reversert_av is null), 0, 'angret');
select test.feiler(format($$select faktura.angre_mva_oppgjor(%L, %L)$$, :'org', :'t4'), 'FA409');
select test.er((select coalesce(sum(p.belop), 0) from faktura.posteringer p join faktura.bilag b on b.id = p.bilag_id where b.org_id = :'org' and p.konto = '2740'), 0::numeric, '2740 i null etter angring');

-- Fakturerer ser verken terminene eller oppgjøret, og fører ikke.
select faktura.bokfor_mva_oppgjor(:'org', :'t4', '2026-08-31', 'Mva-oppgjør 4. termin 2026',
  '[{"konto": "2700", "belop": 100}, {"konto": "2740", "belop": -100}]') as o3 \gset
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select count(*)::int from faktura.mva_terminer where org_id = :'org'), 0, 'fakturerer ser ikke terminene');
select test.er((select count(*)::int from faktura.bilag where org_id = :'org' and kilde = 'mva'), 0, 'fakturerer ser ikke oppgjøret');
select test.feiler(format($$insert into faktura.mva_terminer (org_id, aar, type, termin) values (%L, 2026, 'tomaaneder', 5)$$, :'org'), '42501');
select test.feiler(format($$select faktura.bokfor_mva_oppgjor(%L, %L, '2026-08-31', 'x', '[{"konto": "2700", "belop": 100}, {"konto": "2740", "belop": -100}]')$$, :'org', :'t4'), 'FA403');
select test.feiler(format($$select faktura.angre_mva_oppgjor(%L, %L)$$, :'org', :'t4'), 'FA403');
select set_config('app.bruker_id', :'u', false);
select test.er((select count(*)::int from faktura.bilag where id = :'o3' and reversert_av is null), 1, 'oppgjøret står');

\c :migrator
drop schema test cascade;
