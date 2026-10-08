-- Makstak (0049_makstak.sql): er summen over makstaket, får fakturaen et fratrekk ned til
-- makstaket, fordelt på mva-satsene. Fratrekket låses ved utstedelse, regnes på nytt ved
-- delvis kreditering, følger med til gjentakelser, og kundens makstak følger med til utkast
-- og gjentakelser som hadde det gamle.

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

-- Fordelingen alene.
select test.er(faktura.kr_tekst(70000), '70 000', 'hele kroner');
select test.er(faktura.kr_tekst(1234567.5), '1 234 567,50', 'med øre');
select test.er(faktura.kr_tekst(999.05), '999,05', 'under tusen');
select test.er((select count(*) from faktura.makstak_fordel(70000, array[25], array[70000])), 0::bigint, 'ikke over makstaket');
select test.er((select count(*) from faktura.makstak_fordel(null, array[25], array[90000])), 0::bigint, 'uten makstak');
select test.er((select array[belop_eks, mva_belop] from faktura.makstak_fordel(70000, array[25], array[112500])), array[-34000.00, -8500.00], 'én sats');
-- 25 % og 0 %: fordelt etter andelen, og 0 % tar øreavrundingen.
select test.er((select array_agg(array[mva_sats, belop_eks, mva_belop] order by mva_sats desc) from faktura.makstak_fordel(70000, array[25, 0], array[62500, 40000])),
               array[array[25, -15853.66, -3963.42], array[0, -12682.92, 0]]::numeric[], 'to satser');
select test.er((select sum(belop_eks + mva_belop) from faktura.makstak_fordel(70000, array[25, 0], array[62500, 40000])), -32500.00, 'akkurat ned til makstaket');
-- Går det ikke opp på øret (25 % mva), blir summen ett øre under, aldri over.
select test.er((select sum(belop_eks + mva_belop) from faktura.makstak_fordel(100, array[25], array[100.02])), -0.03, 'ett øre under');
-- En sats med negativ sum får ikke fratrekk.
select test.er((select array_agg(mva_sats) from faktura.makstak_fordel(1000, array[25, 0], array[2500, -100])), array[25]::numeric[], 'bare positive satser');

\c :api
select id as eier from faktura.registrer_bruker('uid-makstak', 'eier-makstak@test.no', 'Mia Makstak') \gset
select set_config('app.bruker_id', :'eier', false);
select id as org from faktura.opprett_organisasjon('Legesenteret AS') \gset
update faktura.organisasjoner set kontonr = '86011117947', mva_registrert = true where id = :'org';
\c :migrator
update faktura.organisasjoner set maks_fakturaer_mnd = null, maks_belop_mnd = null where id = :'org';
\c :api
select set_config('app.bruker_id', :'eier', false);
insert into faktura.kunder (org_id, navn, makstak) values (:'org', 'Dr. Lege', 70000) returning id as lege \gset
select test.feiler(format($$update faktura.kunder set makstak = 0 where id = %L$$, :'lege'), '23514');

-- Over makstaket: fratrekket vises for utkastet og blir linjer ved utstedelse.
insert into faktura.fakturaer (org_id, kunde_id, makstak) values (:'org', :'lege', 70000) returning id as f1 \gset
insert into faktura.faktura_linjer (org_id, faktura_id, rekke, beskrivelse, antall, enhetspris, mva_sats)
values (:'org', :'f1', 1, 'Hjelpepersonell', 1, 50000, 25), (:'org', :'f1', 2, 'Kontorleie', 1, 40000, 0);
select test.feiler(format($$insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, enhetspris, makstak) values (%L, %L, 'Juks', 1, true)$$, :'org', :'f1'), '42501');
select test.er(faktura.utkast_sum(:'f1'), 70000.00, 'utkastet viser summen etter fratrekket');
select test.er((select count(*) from faktura.makstak_fratrekk(:'f1')), 2::bigint, 'én linje per sats');
select test.er((select beskrivelse from faktura.makstak_fratrekk(:'f1') limit 1), 'Fratrekk etter avtalt makstak (70 000 kr)', 'teksten');

select test.er((faktura.utsted(:'f1')).sum_inkl_mva, 70000.00, 'å betale er makstaket');
select test.er((select array[sum_eks_mva, mva] from faktura.fakturaer where id = :'f1'), array[61463.42, 8536.58], 'eks. mva og mva');
select test.er((select array_agg(array[rekke, antall, enhetspris, mva_sats, belop_eks, mva_belop] order by rekke) from faktura.faktura_linjer where faktura_id = :'f1' and makstak),
               array[array[3, -1, 15853.66, 25, -15853.66, -3963.42], array[4, -1, 12682.92, 0, -12682.92, 0]]::numeric[], 'fratrekket er linjer sist');
select test.er((select count(*) from faktura.makstak_fratrekk(:'f1') x), 2::bigint, 'regnes av linjene uten fratrekket');

\c :migrator
select test.feiler(format($$update faktura.fakturaer set makstak = 80000 where id = %L$$, :'f1'), 'FA409');
select test.feiler(format($$update faktura.faktura_linjer set enhetspris = 1 where faktura_id = %L and makstak$$, :'f1'), 'FA409');
-- En kreditnota har aldri makstak.
select test.feiler(format($$insert into faktura.fakturaer (org_id, kunde_id, type, kreditnota_for, makstak) values (%L, %L, 'kreditnota', %L, 1)$$, :'org', :'lege', :'f1'), '23514');

\c :api
select set_config('app.bruker_id', :'eier', false);

-- Under makstaket: ingen fratrekk.
insert into faktura.fakturaer (org_id, kunde_id, makstak) values (:'org', :'lege', 70000) returning id as f2 \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, antall, enhetspris, mva_sats) values (:'org', :'f2', 'Kontorleie', 1, 40000, 0);
select test.er((faktura.utsted(:'f2')).sum_inkl_mva, 40000.00, 'under makstaket');
select test.er((select count(*) from faktura.faktura_linjer where faktura_id = :'f2' and makstak), 0::bigint, 'uten fratrekk');

-- Delvis kreditering: krediteres kontorleia, er resten under makstaket, og fratrekket går tilbake.
select id as l_leie from faktura.faktura_linjer where faktura_id = :'f1' and beskrivelse = 'Kontorleie' \gset
select id as l_fratrekk from faktura.faktura_linjer where faktura_id = :'f1' and makstak limit 1 \gset
select test.feiler(format($$select faktura.krediter(%L, '[{"linje_id": "%s", "antall": -1}]')$$, :'f1', :'l_fratrekk'), 'FA400');
select (faktura.krediter(:'f1', format('[{"linje_id": "%s", "antall": 1}]', :'l_leie')::jsonb)).id as kn1 \gset
select test.er((select sum_inkl_mva from faktura.fakturaer where id = :'kn1'), -7500.00, 'kreditnotaen tar bare det som var over makstaket');
select test.er((select count(*) from faktura.faktura_linjer where faktura_id = :'kn1' and makstak), 2::bigint, 'med fratrekket regnet på nytt');
select test.er((select sum_inkl_mva - kreditert_belop from faktura.fakturaer where id = :'f1'), 62500.00, 'igjen: hjelpepersonellet');
-- Resten krediteres: fratrekket er allerede tilbakeført.
select (faktura.krediter(:'f1')).id as kn2 \gset
select test.er((select sum_inkl_mva from faktura.fakturaer where id = :'kn2'), -62500.00, 'resten');
select test.er((select count(*) from faktura.faktura_linjer where faktura_id = :'kn2' and makstak), 0::bigint, 'uten nytt fratrekk');
select test.er((select array[status, kreditert_belop::text] from faktura.fakturaer where id = :'f1'), array['kreditert', '70000.00'], 'hele fakturaen er kreditert');

-- Er resten fortsatt over makstaket, blir kreditnotaen 0 kr.
insert into faktura.fakturaer (org_id, kunde_id, makstak) values (:'org', :'lege', 70000) returning id as f3 \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, antall, enhetspris, mva_sats) values (:'org', :'f3', 'Andel av omsetning', 10, 10000, 0) returning id as l3 \gset
select faktura.utsted(:'f3');
select test.feiler(format($$select faktura.krediter(%L, '[{"linje_id": "%s", "antall": 1}]')$$, :'f3', :'l3'), 'FA400');
select (faktura.krediter(:'f3', format('[{"linje_id": "%s", "antall": 4}]', :'l3')::jsonb)).sum_inkl_mva as kn3 \gset
select test.er(:'kn3'::numeric, -10000.00, 'ned fra 100 000 til 60 000: 10 000 under makstaket');

-- Gjentakende: gjentakelsen får makstaket og linjene uten fratrekket.
insert into faktura.fakturaer (org_id, kunde_id, makstak, forfallsdato, gjenta)
values (:'org', :'lege', 70000, faktura.i_dag() + 14, '{"intervall": "maaned"}') returning id as f4 \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, antall, enhetspris, mva_sats) values (:'org', :'f4', 'Andel av omsetning', 1, 90000, 0);
select (faktura.utsted(:'f4')).gjentakelse_id as g4 \gset
select test.er((select array[makstak::text, jsonb_array_length(linjer)::text] from faktura.gjentakelser where id = :'g4'), array['70000.00', '1'], 'gjentakelsen');
select faktura.lag_fra_gjentakelse(:'g4') as f5 \gset
select test.er((select makstak from faktura.fakturaer where id = :'f5'), 70000.00, 'neste faktura har makstaket');
select test.er((faktura.utsted(:'f5')).sum_inkl_mva, 70000.00, 'og fratrekket');

-- Kundens makstak følger med til utkast og gjentakelser som hadde det gamle.
insert into faktura.fakturaer (org_id, kunde_id, makstak) values (:'org', :'lege', 70000) returning id as u1 \gset
insert into faktura.fakturaer (org_id, kunde_id, makstak) values (:'org', :'lege', null) returning id as u2 \gset
insert into faktura.fakturaer (org_id, kunde_id, makstak) values (:'org', :'lege', 80000) returning id as u3 \gset
update faktura.kunder set makstak = 75000 where id = :'lege';
select test.er((select array[(select makstak from faktura.fakturaer where id = :'u1'), (select makstak from faktura.fakturaer where id = :'u3')]),
               array[75000.00, 80000.00], 'det gamle følger med, et annet beholdes');
select test.er((select makstak from faktura.fakturaer where id = :'u2'), null::numeric, 'fjernet beholdes');
select test.er((select makstak from faktura.gjentakelser where id = :'g4'), 75000.00, 'gjentakelsen følger med');
select test.er((select makstak from faktura.fakturaer where id = :'f5'), 70000.00, 'utstedte endres ikke');

-- Uten mva: alt er 0 %, også fratrekket.
select id as org2 from faktura.opprett_organisasjon('Uten Mva AS') \gset
update faktura.organisasjoner set kontonr = '86011117947', mva_registrert = false where id = :'org2';
insert into faktura.kunder (org_id, navn) values (:'org2', 'Kari') returning id as kari \gset
insert into faktura.fakturaer (org_id, kunde_id, makstak) values (:'org2', :'kari', 1000) returning id as f6 \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, antall, enhetspris, mva_sats) values (:'org2', :'f6', 'Vask', 3, 500, 25);
select test.er((select array[sum_inkl_mva, mva] from faktura.utsted(:'f6')), array[1000.00, 0.00], 'uten mva');

\c :migrator
drop schema test cascade;
\echo '  ok'
