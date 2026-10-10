-- Bankpostene (0091_bankposter.sql): workeren lagrer dem (ikke API-et), den som fører regnskapet ser
-- dem, men status og koblinger settes bare av funksjonene; bokfor_bankpost (serie B, kontrollene,
-- posten på riktig konto i regnskapet, én gang, med motposten for en overføring), avstem_bankpost
-- (det som ikke er koblet, med samme fortegn; flere poster kan dele et bilag), avstem_overforing,
-- sett_bankpost, apne_bankpost (reverserer bilaget i serie B og åpner motposten), at et bilag som
-- reverseres slipper postene, angre_utgift_betaling, startdatoen, og at fakturerer verken ser eller
-- fører noe.

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
create function test.post(_id uuid) returns text language sql as $$
  select row(status, b.serie || '-' || b.nummer, p.regel, p.auto)::text
    from faktura.bankposter p left join faktura.bilag b on b.id = p.bilag_id where p.id = _id
$$;
grant execute on all functions in schema test to public;

\c :api
select id as u from faktura.registrer_bruker('uid-bp-eier', 'eier-bp@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Bankpost AS', '915000428') \gset
select faktura.inviter_medlem(:'org', 'fakt-bp@test.no', 'fakturerer') as t_fakt \gset
select id as u_fakt from faktura.registrer_bruker('uid-bp-fakt', 'fakt-bp@test.no') \gset
select set_config('app.bruker_id', :'u_fakt', false);
select faktura.aksepter_invitasjon(:'t_fakt');
select set_config('app.bruker_id', :'u', false);

-- Kontoen i regnskapet for hver bankkonto: sparekontoen på 1921, resten på bankkontoen (1920).
insert into faktura.regnskap_oppsett (org_id, bankkontoer) values (:'org', '{"15035656262": "1921"}');
select test.feiler(format($$update faktura.regnskap_oppsett set bankkontoer = '{"x": "1921"}' where org_id = %L$$, :'org'), '23514');
select test.feiler(format($$update faktura.regnskap_oppsett set bankkontoer = '{"15035656262": "19x"}' where org_id = %L$$, :'org'), '23514');
select test.er(faktura.bankpost_konto(:'org', '86011117947'), '1920', 'bankkontoen i kontoplanen');
select test.er(faktura.bankpost_konto(:'org', '15035656262'), '1921', 'sparekontoen');
-- API-et lagrer ikke bankposter.
select test.feiler(format($$insert into faktura.bankposter (org_id, konto, ekstern_id, dato, belop) values (%L, '86011117947', 'x', '2026-10-01', -45)$$, :'org'), '42501');

\c :worker
insert into faktura.bankposter (org_id, konto, ekstern_id, dato, belop, motpart, motpart_konto, melding, referanse) values
  (:'org', '86011117947', 'gebyr', '2026-10-01', -45, null, null, 'Gebyr', null),
  (:'org', '86011117947', 'telenor', '2026-10-02', -1250, 'Telenor Norge AS', '86011117947', null, '1234567890'),
  (:'org', '86011117947', 'kort', '2026-10-03', -499, 'Clas Ohlson', null, 'Varekjøp', null),
  (:'org', '86011117947', 'spar-ut', '2026-10-04', -10000, null, '15035656262', 'Til sparekonto', null),
  (:'org', '15035656262', 'spar-inn', '2026-10-04', 10000, null, '86011117947', 'Fra driftskonto', null),
  (:'org', '86011117947', 'gammel', '2026-09-15', -100, null, null, 'Gebyr', null),
  (:'org', '86011117947', 'drift-ut', '2026-10-05', -500, null, '12345678903', null, null),
  (:'org', '12345678903', 'drift-inn', '2026-10-05', 500, null, '86011117947', null, null),
  (:'org', '86011117947', 'lonn-1', '2026-10-06', -20000, 'Ola Nordmann', null, 'Lønn', null),
  (:'org', '86011117947', 'lonn-2', '2026-10-06', -10000, 'Kari Nordmann', null, 'Lønn', null),
  (:'org', '86011117947', 'lonn-3', '2026-10-06', -1, 'Per Nordmann', null, 'Lønn', null);
select id as gebyr from faktura.bankposter where ekstern_id = 'gebyr' \gset
select id as telenor from faktura.bankposter where ekstern_id = 'telenor' \gset
select id as kort from faktura.bankposter where ekstern_id = 'kort' \gset
select id as spar_ut from faktura.bankposter where ekstern_id = 'spar-ut' \gset
select id as spar_inn from faktura.bankposter where ekstern_id = 'spar-inn' \gset
select id as gammel from faktura.bankposter where ekstern_id = 'gammel' \gset
select id as drift_ut from faktura.bankposter where ekstern_id = 'drift-ut' \gset
select id as drift_inn from faktura.bankposter where ekstern_id = 'drift-inn' \gset
select id as lonn1 from faktura.bankposter where ekstern_id = 'lonn-1' \gset
select id as lonn2 from faktura.bankposter where ekstern_id = 'lonn-2' \gset
select id as lonn3 from faktura.bankposter where ekstern_id = 'lonn-3' \gset
-- Samme transaksjon lagres én gang; saldoen kan oppdateres, men ikke statusen.
select test.feiler(format($$insert into faktura.bankposter (org_id, konto, ekstern_id, dato, belop) values (%L, '86011117947', 'gebyr', '2026-10-01', -45)$$, :'org'), '23505');
update faktura.bankposter set saldo = 12345.67 where id = :'gebyr';
select test.feiler(format($$update faktura.bankposter set status = 'avstemt' where id = %L$$, :'gebyr'), '42501');
-- Workeren fører gebyret av seg selv (serie B, kilde bank, på bankdatoen).
select test.feiler(format($$select faktura.bokfor_bankpost(%L, %L, ' ', '[{"konto": "7770", "belop": 45}, {"konto": "1920", "belop": -45}]', 'x', true)$$, :'org', :'gebyr'), 'FA400');
select test.feiler(format($$select faktura.bokfor_bankpost(%L, %L, 'x', '[{"konto": "1920", "belop": -45}]', 'x', true)$$, :'org', :'gebyr'), 'FA400');
select test.feiler(format($$select faktura.bokfor_bankpost(%L, %L, 'x', '[{"konto": "7770", "belop": 45}, {"konto": "1920", "belop": -44}]', 'x', true)$$, :'org', :'gebyr'), 'FA400');
select test.feiler(format($$select faktura.bokfor_bankpost(%L, %L, 'x', '[{"konto": "7770", "belop": 45}, {"konto": "1921", "belop": -45}]', 'x', true)$$, :'org', :'gebyr'), 'FA400');
select test.feiler(format($$select faktura.bokfor_bankpost(%L, %L, 'x', '[{"konto": "7770", "belop": 45}, {"konto": "1920", "belop": -45}, {"konto": "7790", "belop": 0}]', 'x', true)$$, :'org', :'gebyr'), 'FA400');
select faktura.bokfor_bankpost(:'org', :'gebyr', 'Bankgebyr', '[{"konto": "7770", "belop": 45, "tekst": "Gebyr"}, {"konto": "1920", "belop": -45}]', 'Gebyr fra banken', true) as gb \gset
select test.er((select row(serie, aar, nummer, kilde, kilde_id, dato)::text from faktura.bilag where id = :'gb'),
               row('B', 2026, 1, 'bank', :'gebyr'::uuid, '2026-10-01'::date)::text, 'bilaget i serie B');
select test.er(test.poster(:'gb'), '7770:45.00,1920:-45.00', 'posteringene');
select test.er(test.post(:'gebyr'), row('avstemt', 'B-1', 'Gebyr fra banken', true)::text, 'gebyret er ført');
select test.er((select avstemt_av from faktura.bankposter where id = :'gebyr'), null::uuid, 'av seg selv');
select test.feiler(format($$select faktura.bokfor_bankpost(%L, %L, 'x', '[{"konto": "7770", "belop": 45}, {"konto": "1920", "belop": -45}]', 'x', true)$$, :'org', :'gebyr'), 'FA409');

\c :api
select set_config('app.bruker_id', :'u', false);
select test.er((select count(*)::int from faktura.bankposter where org_id = :'org'), 11, 'eieren ser bankpostene');
select test.feiler(format($$update faktura.bankposter set status = 'avstemt' where id = %L$$, :'kort'), '42501');

-- Startdatoen: det som er fra før, føres ikke.
update faktura.regnskap_oppsett set bank_fra = '2026-10-01' where org_id = :'org';
select test.feiler(format($$select faktura.bokfor_bankpost(%L, %L, 'x', '[{"konto": "7770", "belop": 100}, {"konto": "1920", "belop": -100}]', 'x')$$, :'org', :'gammel'), 'FA409');

-- Betalingen av en leverandørfaktura (serie U) kobles til posten.
insert into faktura.utgifter (org_id, type, leverandor, orgnr, dato, belop, betaling, kid)
values (:'org', 'faktura', 'Telenor Norge AS', '976967631', '2026-09-15', 1250, 'ubetalt', '1234567890') returning id as ut \gset
insert into faktura.utgift_linjer (org_id, utgift_id, rekke, konto, belop, mva_sats, mva, fradrag) values (:'org', :'ut', 1, '6900', 1000, 25, 250, 100);
select faktura.bokfor_utgift(:'org', :'ut', 'Telenor', '[{"konto": "6900", "belop": 1000}, {"konto": "2710", "belop": 250}, {"konto": "2400", "belop": -1250}]') as ub \gset
select faktura.betal_utgift(:'org', :'ut', '2026-10-02', 'bank', 'Betalt: Telenor', '[{"konto": "2400", "belop": 1250}, {"konto": "1920", "belop": -1250}]') as bb \gset
select faktura.avstem_bankpost(:'org', :'telenor', :'bb', 'KID 1234567890');
select test.er(test.post(:'telenor'), row('avstemt', 'U-2', 'KID 1234567890', true)::text, 'koblet til betalingen');
select test.er((select avstemt_av from faktura.bankposter where id = :'telenor'), :'u'::uuid, 'av eieren');
select test.feiler(format($$select faktura.avstem_bankpost(%L, %L, %L, 'x')$$, :'org', :'telenor', :'bb'), 'FA409');
-- Ingenting igjen å koble på det bilaget, og ikke et bilag med feil fortegn.
select test.feiler(format($$select faktura.avstem_bankpost(%L, %L, %L, 'x')$$, :'org', :'kort', :'bb'), 'FA400');
select test.feiler(format($$select faktura.avstem_bankpost(%L, %L, %L, 'x')$$, :'org', :'kort', :'ub'), 'FA400');
select test.feiler(format($$select faktura.avstem_bankpost(%L, %L, gen_random_uuid(), 'x')$$, :'org', :'kort'), 'FA404');
-- Kvitteringen er ført mot banken før: posten kobles til det bilaget.
select faktura.bokfor_manuelt(:'org', '2026-10-03', 'Kvittering Clas Ohlson', '[{"konto": "6560", "belop": 399.20}, {"konto": "2710", "belop": 99.80}, {"konto": "1920", "belop": -499}]') as kb \gset
select faktura.avstem_bankpost(:'org', :'kort', :'kb', 'Samme beløp');
select test.er(test.post(:'kort'), row('avstemt', 'M-1', 'Samme beløp', true)::text, 'koblet til kvitteringen');
-- Flere poster deler et bilag (lønnen til hver ansatt mot én banklinje), men ikke mer enn det står.
select faktura.bokfor_manuelt(:'org', '2026-10-06', 'Lønn oktober', '[{"konto": "5000", "belop": 30000}, {"konto": "1920", "belop": -30000}]') as lb \gset
select faktura.avstem_bankpost(:'org', :'lonn1', :'lb', 'Lønn');
select faktura.avstem_bankpost(:'org', :'lonn2', :'lb', 'Lønn');
select test.er(faktura.bilag_bankrest(:'lb', '1920'), 0::numeric, 'hele bilaget er koblet');
select test.feiler(format($$select faktura.avstem_bankpost(%L, %L, %L, 'x')$$, :'org', :'lonn3', :'lb'), 'FA400');

-- Overføring mellom to kontoer på samme konto i regnskapet: koblet til hverandre, uten bilag.
select test.feiler(format($$select faktura.avstem_overforing(%L, %L, %L, 'x')$$, :'org', :'drift_ut', :'spar_inn'), 'FA400');
select faktura.avstem_overforing(:'org', :'drift_ut', :'drift_inn', 'Overføring mellom egne kontoer');
select test.er((select string_agg(status || ':' || (par_id = case when id = :'drift_ut'::uuid then :'drift_inn'::uuid else :'drift_ut'::uuid end)::text, ',')
                  from faktura.bankposter where id in (:'drift_ut', :'drift_inn')), 'avstemt:true,avstemt:true', 'paret');
-- Sparekontoen er på 1921: overføringen må bokføres, med begge postene på bilaget.
select test.feiler(format($$select faktura.avstem_overforing(%L, %L, %L, 'x')$$, :'org', :'spar_ut', :'spar_inn'), 'FA400');
select test.feiler(format($$select faktura.bokfor_bankpost(%L, %L, 'x', '[{"konto": "1921", "belop": 10000}, {"konto": "1920", "belop": -10000}]', 'x', false, %L)$$, :'org', :'spar_ut', :'kort'), 'FA409');
select test.feiler(format($$select faktura.bokfor_bankpost(%L, %L, 'x', '[{"konto": "7790", "belop": 10000}, {"konto": "1920", "belop": -10000}]', 'x', false, %L)$$, :'org', :'spar_ut', :'spar_inn'), 'FA400');
select faktura.bokfor_bankpost(:'org', :'spar_ut', 'Overføring til sparekonto', '[{"konto": "1921", "belop": 10000}, {"konto": "1920", "belop": -10000}]', 'Overføring', false, :'spar_inn') as ob \gset
select test.er((select count(*)::int from faktura.bankposter where bilag_id = :'ob' and status = 'avstemt'), 2, 'begge postene på bilaget');

-- Forslag og uavklart: ikke på en post som er ført.
select faktura.sett_bankpost(:'org', :'lonn3', 'forslag', 'Samme beløp som bilag M-9', '{"type": "bilag"}');
select test.er((select row(status, regel, forslag ->> 'type')::text from faktura.bankposter where id = :'lonn3'), row('forslag', 'Samme beløp som bilag M-9', 'bilag')::text, 'forslaget');
select test.feiler(format($$select faktura.sett_bankpost(%L, %L, 'forslag', 'x', null)$$, :'org', :'lonn3'), 'FA400');
select test.feiler(format($$select faktura.sett_bankpost(%L, %L, 'avstemt', 'x', null)$$, :'org', :'lonn3'), 'FA400');
select test.feiler(format($$select faktura.sett_bankpost(%L, %L, 'uavklart', 'x', null)$$, :'org', :'kort'), 'FA409');
select faktura.sett_bankpost(:'org', :'lonn3', 'uavklart', 'Velg kontoen', null);
select test.er((select row(status, forslag)::text from faktura.bankposter where id = :'lonn3'), row('uavklart', null::jsonb)::text, 'uavklart uten forslag');

-- Angre: motposten på sparekontoen angres, så bilaget i serie B reverseres og begge åpnes; den
-- som er angret, blir uavklart (reglene foreslår bare), den andre vurderes på nytt.
select test.feiler(format($$select faktura.apne_bankpost(%L, %L)$$, :'org', :'lonn3'), 'FA409');
select faktura.apne_bankpost(:'org', :'spar_inn');
select test.er((select count(*)::int from faktura.bilag where reverserer = :'ob'), 1, 'overføringen er reversert');
select test.er(test.post(:'spar_inn'), row('uavklart', null::text, 'Angret. Velg hvordan den skal føres.', false)::text, 'den angrede');
select test.er(test.post(:'spar_ut'), row('ny', null::text, null::text, true)::text, 'motposten vurderes på nytt');
-- Paret uten bilag: begge åpnes.
select faktura.apne_bankpost(:'org', :'drift_inn');
select test.er((select string_agg(status, ',' order by ekstern_id) from faktura.bankposter where id in (:'drift_ut', :'drift_inn')), 'uavklart,ny', 'paret er åpnet');
-- Kvitteringen er koblet til et manuelt bilag: koblingen fjernes, bilaget står.
select faktura.apne_bankpost(:'org', :'kort');
select test.er((select count(*)::int from faktura.bilag where reverserer = :'kb'), 0, 'det manuelle bilaget står');
select test.er((select status from faktura.bankposter where id = :'kort'), 'uavklart', 'kvitteringen er åpnet');

-- Betalingen angres (utgiften står): betalingsbilaget reverseres, og posten slippes og vurderes på nytt.
select faktura.angre_utgift_betaling(:'org', :'ut');
select test.er((select row(status, betaling, betalt_dato, betaling_bilag_id)::text from faktura.utgifter where id = :'ut'),
               row('bokfort', 'ubetalt', null::date, null::uuid)::text, 'utgiften er ubetalt igjen');
select test.er((select count(*)::int from faktura.bilag where reverserer = :'bb'), 1, 'betalingen er reversert');
select test.er(test.post(:'telenor'), row('ny', null::text, null::text, true)::text, 'posten vurderes på nytt');
select test.feiler(format($$select faktura.angre_utgift_betaling(%L, %L)$$, :'org', :'ut'), 'FA409');

-- Fakturerer ser ikke bankpostene og fører ikke.
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select count(*)::int from faktura.bankposter where org_id = :'org'), 0, 'fakturerer ser ikke bankpostene');
select test.feiler(format($$select faktura.bokfor_bankpost(%L, %L, 'x', '[{"konto": "7770", "belop": 499}, {"konto": "1920", "belop": -499}]', 'x')$$, :'org', :'kort'), 'FA403');
select test.feiler(format($$select faktura.apne_bankpost(%L, %L)$$, :'org', :'gebyr'), 'FA403');
select test.feiler(format($$insert into faktura.bankregler (org_id, retning, motpart, konto) values (%L, 'ut', 'x', '7790')$$, :'org'), '42501');
select set_config('app.bruker_id', :'u', false);
-- Reglene som er lært: unike per motpart.
insert into faktura.bankregler (org_id, retning, motpart, konto, tekst) values (:'org', 'ut', 'clas ohlson', '6560', 'Rekvisita');
select test.feiler(format($$insert into faktura.bankregler (org_id, retning, motpart, konto) values (%L, 'ut', 'clas ohlson', '6800')$$, :'org'), '23505');
select test.feiler(format($$insert into faktura.bankregler (org_id, retning, motpart, konto) values (%L, 'ut', 'Clas Ohlson', '6800')$$, :'org'), '23514');

\c :migrator
drop schema test cascade;
