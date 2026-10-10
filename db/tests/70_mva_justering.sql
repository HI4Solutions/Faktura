-- Mva-justering for kapitalvarer (0095_mva_justering.sql): kontrollene på anleggsmiddelet, justeringen
-- for året i serie V (kontrollene, ett gjeldende per år, angre, låst år), den samlede justeringen ved
-- salg (på salgsdatoen, reversert med salget), at avgiften ikke endres etter salget, at et
-- anleggsmiddel med en bokført justering ikke slettes, og at fakturerer verken ser eller fører.

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
create function test.bilag(_id uuid) returns text language sql as $$
  select serie || '-' || aar || '-' || nummer || ' ' || to_char(dato, 'YYYY-MM-DD') from faktura.bilag where id = _id
$$;
grant execute on all functions in schema test to public;

\c :api
select id as u from faktura.registrer_bruker('uid-mvaj-eier', 'eier-mvaj@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Kapitalvarer AS', '915000568') \gset
select faktura.inviter_medlem(:'org', 'fakt-mvaj@test.no', 'fakturerer') as t_fakt \gset
select id as u_fakt from faktura.registrer_bruker('uid-mvaj-fakt', 'fakt-mvaj@test.no') \gset
select set_config('app.bruker_id', :'u_fakt', false);
select faktura.aksepter_invitasjon(:'t_fakt');
select set_config('app.bruker_id', :'u', false);
insert into faktura.regnskap_oppsett (org_id) values (:'org');

-- Kontrollene på anleggsmiddelet: avgiften og fradraget sammen, prosent, og egen prosent per år.
select test.feiler(format($$insert into faktura.anleggsmidler (org_id, navn, kategori, anskaffet, avskrives_fra, kostpris, levetid_mnd, konto, skatt, mva_inngaende)
                           values (%L, 'X', 'maskiner', '2024-03-15', '2024-03-01', 440000, 60, '1200', 'd', 100000)$$, :'org'), '23514');
select test.feiler(format($$insert into faktura.anleggsmidler (org_id, navn, kategori, anskaffet, avskrives_fra, kostpris, levetid_mnd, konto, skatt, mva_inngaende, mva_fradrag)
                           values (%L, 'X', 'maskiner', '2024-03-15', '2024-03-01', 440000, 60, '1200', 'd', 100000, 101)$$, :'org'), '23514');
select test.feiler(format($$insert into faktura.anleggsmidler (org_id, navn, kategori, anskaffet, avskrives_fra, kostpris, levetid_mnd, konto, skatt, mva_bruk)
                           values (%L, 'X', 'maskiner', '2024-03-15', '2024-03-01', 440000, 60, '1200', 'd', '{"20x5": 40}')$$, :'org'), '23514');
select test.feiler(format($$insert into faktura.anleggsmidler (org_id, navn, kategori, anskaffet, avskrives_fra, kostpris, levetid_mnd, konto, skatt, mva_bruk)
                           values (%L, 'X', 'maskiner', '2024-03-15', '2024-03-01', 440000, 60, '1200', 'd', '{"2026": 120}')$$, :'org'), '23514');
insert into faktura.anleggsmidler (org_id, navn, kategori, anskaffet, avskrives_fra, kostpris, levetid_mnd, konto, skatt, mva_inngaende, mva_fradrag, mva_bruk)
values (:'org', 'Røntgen', 'maskiner', '2024-03-15', '2024-03-01', 440000, 60, '1200', 'd', 100000, 60, '{"2026": 100}') returning id as maskin \gset
insert into faktura.anleggsmidler (org_id, navn, kategori, anskaffet, avskrives_fra, kostpris, levetid_mnd, konto, skatt)
values (:'org', 'Hylle', 'inventar', '2024-03-15', '2024-03-01', 40000, 60, '1250', 'd') returning id as hylle \gset
-- Ingen skriver linjene direkte.
select test.feiler(format($$insert into faktura.mva_justeringslinjer (org_id, bilag_id, anleggsmiddel_id, aar, aar_til, fradrag, belop)
                           values (%L, gen_random_uuid(), %L, 2025, 2025, 30, -6000)$$, :'org', :'maskin'), '42501');

-- Justeringen for året: kontrollene.
\set poster '[{"konto": "2710", "belop": -6000, "tekst": "Røntgen", "mva_kode": "1"}, {"konto": "7798", "belop": 6000, "tekst": "Røntgen"}]'
select format('[{"anleggsmiddel_id": "%s", "aar": 2025, "aar_til": 2025, "fradrag": 30, "belop": -6000}]', :'maskin') as linjer \gset
select test.feiler(format($$select faktura.bokfor_mva_justering(%L, 2099, null, 'x', %L, %L)$$, :'org', :'poster', replace(:'linjer', '2025', '2099')), 'FA409');
select test.feiler(format($$select faktura.bokfor_mva_justering(%L, 2025, null, ' ', %L, %L)$$, :'org', :'poster', :'linjer'), 'FA400');
select test.feiler(format($$select faktura.bokfor_mva_justering(%L, 2025, null, 'x', '[{"konto": "2710", "belop": -6000, "mva_kode": "1"}, {"konto": "7798", "belop": 5999}]', %L)$$, :'org', :'linjer'), 'FA400');
select test.feiler(format($$select faktura.bokfor_mva_justering(%L, 2025, null, 'x', %L, %L)$$, :'org', :'poster', replace(:'linjer', '-6000', '-5000')), 'FA400');
select test.feiler(format($$select faktura.bokfor_mva_justering(%L, 2025, null, 'x', %L, %L)$$, :'org', :'poster', replace(:'linjer', :'maskin', :'hylle')), 'FA400');
select test.feiler(format($$select faktura.bokfor_mva_justering(%L, 2025, null, 'x', %L, %L)$$, :'org', :'poster', replace(:'linjer', '"aar": 2025', '"aar": 2024')), 'FA400');
select test.feiler(format($$select faktura.bokfor_mva_justering(%L, 2025, null, 'x', %L, %L)$$, :'org', :'poster', replace(:'linjer', '"aar_til": 2025', '"aar_til": 2028')), 'FA400');
select test.feiler(format($$select faktura.bokfor_mva_justering(%L, 2025, null, 'x', %L, '[]')$$, :'org', :'poster'), 'FA400');

-- Serie V den 31. desember, knyttet til året; et nytt reverserer det forrige, så ett er gjeldende.
select faktura.bokfor_mva_justering(:'org', 2025, null, 'Mva-justering for kapitalvarer 2025', :'poster', :'linjer') as j1 \gset
select id as aar25 from faktura.mva_justeringer where org_id = :'org' and aar = 2025 \gset
select test.er((select row(serie, aar, nummer, dato, kilde, kilde_id)::text from faktura.bilag where id = :'j1'), row('V', 2025, 1, '2025-12-31'::date, 'mva_justering', :'aar25'::uuid)::text, 'bilaget for året');
select test.er((select string_agg(konto || ' ' || belop || ' ' || coalesce(mva_kode, '-'), ', ' order by rekke) from faktura.posteringer where bilag_id = :'j1'), '2710 -6000.00 1, 7798 6000.00 -', 'posteringene med koden');
select test.er((select row(anleggsmiddel_id, aar, aar_til, fradrag, belop)::text from faktura.mva_justeringslinjer where bilag_id = :'j1'),
               row(:'maskin'::uuid, 2025, 2025, 30.00, -6000.00)::text, 'linjen');
select faktura.bokfor_mva_justering(:'org', 2025, null, 'Mva-justering for kapitalvarer 2025',
  '[{"konto": "2710", "belop": -4000, "mva_kode": "1"}, {"konto": "7798", "belop": 4000}]', replace(replace(:'linjer', '-6000', '-4000'), '"fradrag": 30', '"fradrag": 40')::jsonb) as j2 \gset
select test.er(test.bilag(:'j2'), 'V-2025-3 2025-12-31', 'på nytt etter reverseringen');
select test.er((select count(*)::int from faktura.bilag where org_id = :'org' and kilde = 'mva_justering' and reverserer is null and reversert_av is null), 1, 'ett gjeldende');
select test.er((select sum(p.belop) from faktura.posteringer p join faktura.bilag b on b.id = p.bilag_id where b.org_id = :'org' and b.kilde = 'mva_justering' and p.konto = '2710'), -4000.00, 'summen på 2710');
-- Låst år: verken ført eller angret.
update faktura.regnskap_oppsett set laast_til = '2025-12-31' where org_id = :'org';
select test.feiler(format($$select faktura.bokfor_mva_justering(%L, 2025, null, 'x', %L, %L)$$, :'org', :'poster', :'linjer'), 'FA409');
select test.feiler(format($$select faktura.angre_mva_justering(%L, 2025, null)$$, :'org'), 'FA409');
update faktura.regnskap_oppsett set laast_til = null where org_id = :'org';
-- Et anleggsmiddel med en bokført justering slettes ikke.
select test.feiler(format($$delete from faktura.anleggsmidler where id = %L$$, :'maskin'), 'FA409');
select faktura.angre_mva_justering(:'org', 2025, null);
select test.er((select count(*)::int from faktura.bilag where org_id = :'org' and kilde = 'mva_justering' and reverserer is null and reversert_av is null), 0, 'angret');
select test.feiler(format($$select faktura.angre_mva_justering(%L, 2025, null)$$, :'org'), 'FA409');
-- Fradragsprosenten for året kan settes, i prosent.
update faktura.mva_justeringer set fradrag = 40 where id = :'aar25';
select test.feiler(format($$update faktura.mva_justeringer set fradrag = 101 where id = %L$$, :'aar25'), '23514');

-- Den samlede justeringen ved salg: bare for et solgt anleggsmiddel i salgsåret, på salgsdatoen.
\set samlet '[{"konto": "2710", "belop": 24000, "mva_kode": "1"}, {"konto": "3800", "belop": -24000}]'
select format('[{"anleggsmiddel_id": "%s", "aar": 2026, "aar_til": 2028, "fradrag": 100, "belop": 24000}]', :'maskin') as slinjer \gset
select test.feiler(format($$select faktura.bokfor_mva_justering(%L, 2026, %L, 'x', %L, %L)$$, :'org', :'maskin', :'samlet', :'slinjer'), 'FA409');
select faktura.bokfor_anlegg(:'org', '2026-06-15', 'Salg: Røntgen (nr. 1)',
  '[{"konto": "1920", "belop": 375000}, {"konto": "2700", "belop": -75000, "mva_kode": "3"}, {"konto": "1200", "belop": -440000, "mva_kode": "3"}, {"konto": "7800", "belop": 140000, "mva_kode": "3"}]',
  format('[{"anleggsmiddel_id": "%s", "type": "avgang", "belop": 440000, "vederlag": 300000, "avgang_type": "salg"}]', :'maskin')::jsonb) as salg \gset
select test.feiler(format($$select faktura.bokfor_mva_justering(%L, 2025, %L, 'x', %L, %L)$$, :'org', :'maskin', :'samlet', replace(:'slinjer', '"aar": 2026', '"aar": 2025')), 'FA409');
select test.feiler(format($$select faktura.bokfor_mva_justering(%L, 2026, %L, 'x', %L, %L)$$, :'org', :'hylle', :'samlet', :'slinjer'), 'FA409');
select test.feiler(format($$select faktura.bokfor_mva_justering(%L, 2026, gen_random_uuid(), 'x', %L, %L)$$, :'org', :'samlet', :'slinjer'), 'FA404');
select faktura.bokfor_mva_justering(:'org', 2026, :'maskin', 'Mva-justering ved salg: Røntgen (nr. 1)', :'samlet', :'slinjer') as s1 \gset
select test.er((select row(serie, aar, nummer, dato, kilde, kilde_id)::text from faktura.bilag where id = :'s1'), row('V', 2026, 1, '2026-06-15'::date, 'mva_justering', :'maskin'::uuid)::text, 'den samlede justeringen');
select test.er((select row(aar, aar_til, fradrag, belop)::text from faktura.mva_justeringslinjer where bilag_id = :'s1'), row(2026, 2028, 100.00, 24000.00)::text, 'linjen for resten av perioden');
-- Avgiften, fradraget og bruken endres ikke etter salget.
select test.feiler(format($$update faktura.anleggsmidler set mva_bruk = '{}' where id = %L$$, :'maskin'), 'FA409');
select test.feiler(format($$update faktura.anleggsmidler set mva_fradrag = 50 where id = %L$$, :'maskin'), 'FA409');
-- Salget reverseres: den samlede justeringen også, og anleggsmiddelet er aktivt igjen.
select faktura.reverser_anlegg(:'org', :'salg', null);
select test.er((select reversert_av is not null from faktura.bilag where id = :'s1'), true, 'justeringen er reversert med salget');
select test.er((select count(*)::int from faktura.bilag where org_id = :'org' and kilde = 'mva_justering' and kilde_id = :'maskin' and reverserer is null and reversert_av is null), 0, 'ingen gjeldende samlet justering');
select test.er((select avgang_dato from faktura.anleggsmidler where id = :'maskin'), null::date, 'aktiv igjen');
update faktura.anleggsmidler set mva_bruk = '{}' where id = :'maskin';

-- Fakturerer ser verken justeringene eller linjene, og fører ikke.
select faktura.bokfor_mva_justering(:'org', 2025, null, 'Mva-justering for kapitalvarer 2025', :'poster', :'linjer') as j3 \gset
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select count(*)::int from faktura.mva_justeringer where org_id = :'org'), 0, 'fakturerer ser ikke årene');
select test.er((select count(*)::int from faktura.mva_justeringslinjer where org_id = :'org'), 0, 'fakturerer ser ikke linjene');
select test.er((select count(*)::int from faktura.bilag where org_id = :'org' and kilde = 'mva_justering'), 0, 'fakturerer ser ikke bilagene');
select test.feiler(format($$select faktura.bokfor_mva_justering(%L, 2025, null, 'x', %L, %L)$$, :'org', :'poster', :'linjer'), 'FA403');
select test.feiler(format($$select faktura.angre_mva_justering(%L, 2025, null)$$, :'org'), 'FA403');
select test.er((select count(*)::int from faktura.revisjonslogg where org_id = :'org' and tabell = 'mva_justeringer'), 0, 'fakturerer ser ikke loggen');
select set_config('app.bruker_id', :'u', false);
select test.er((select count(*) > 0 from faktura.revisjonslogg where org_id = :'org' and tabell = 'mva_justeringer'), true, 'eieren ser loggen');
select test.er((select count(*)::int from faktura.bilag where id = :'j3' and reversert_av is null), 1, 'justeringen står');

\c :migrator
drop schema test cascade;
