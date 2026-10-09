-- Regnskapsmodulen, anleggsmidlene (0086_regnskap_anlegg.sql): tilgangen (eier, administrator og
-- regnskap; ikke fakturerer), nummeret, kontrollene i bokføringen (avskrivningene i rekkefølge, ikke
-- før avskrivningen begynner eller det som er ført før HI4, verdien blir ikke negativ, avgangen tar
-- ut den bokførte verdien, nedskrivning av goodwill reverseres ikke, ikke mer reversert enn
-- nedskrevet), det som ikke kan endres når noe er bokført, reversering (det siste først),
-- revisjonsloggen, og at en organisasjon med regnskapsbilag stenges i stedet for å slettes.

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
select id as u from faktura.registrer_bruker('uid-anlegg-eier', 'eier-anlegg@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Anlegg AS', '915000312') \gset
select faktura.inviter_medlem(:'org', 'regn-anlegg@test.no', 'regnskap') as t_regn \gset
select faktura.inviter_medlem(:'org', 'fakt-anlegg@test.no', 'fakturerer') as t_fakt \gset
select id as u_regn from faktura.registrer_bruker('uid-anlegg-regn', 'regn-anlegg@test.no') \gset
select id as u_fakt from faktura.registrer_bruker('uid-anlegg-fakt', 'fakt-anlegg@test.no') \gset
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'t_regn');
select set_config('app.bruker_id', :'u_fakt', false);
select faktura.aksepter_invitasjon(:'t_fakt');

-- Tilgangen: regnskap ja, fakturerer nei. Funksjonen er på for nye organisasjoner.
select test.er(faktura.kan(:'org', 'regnskap'), false, 'fakturerer har ikke regnskap');
select set_config('app.bruker_id', :'u_regn', false);
select test.er(faktura.kan(:'org', 'regnskap'), true, 'regnskap har regnskap');
select test.er(faktura.har_funksjon(:'org', 'regnskap'), true, 'funksjonen er på');

-- Regnskap legger inn anleggsmidlene (nummer 1 og 2).
insert into faktura.anleggsmidler (org_id, navn, kategori, anskaffet, avskrives_fra, kostpris, levetid_mnd, konto, skatt)
values (:'org', 'Varebil', 'varebil', '2026-01-10', '2026-01-01', 120000, 60, '1240', 'c') returning id as bil \gset
insert into faktura.anleggsmidler (org_id, navn, kategori, anskaffet, avskrives_fra, kostpris, levetid_mnd, konto, skatt)
values (:'org', 'Goodwill Kafé', 'goodwill', '2026-02-01', '2026-02-01', 600000, 60, '1080', 'b') returning id as gw \gset
select test.er((select string_agg(nummer::text, ',' order by nummer) from faktura.anleggsmidler where org_id = :'org'), '1,2', 'nummeret');
-- Kontrollene i tabellen.
select test.feiler(format($$insert into faktura.anleggsmidler (org_id, navn, kategori, anskaffet, avskrives_fra, kostpris, levetid_mnd, konto, skatt)
                           values (%L, 'X', 'goodwill', '2026-01-10', '2026-01-01', 1000, 60, '1080', 'd')$$, :'org'), '23514');
select test.feiler(format($$insert into faktura.anleggsmidler (org_id, navn, kategori, anskaffet, avskrives_fra, kostpris, levetid_mnd, konto, skatt)
                           values (%L, 'X', 'tomt', '2026-01-10', '2026-01-01', 1000, 60, '1150', 'ingen')$$, :'org'), '23514');
select test.feiler(format($$insert into faktura.anleggsmidler (org_id, navn, kategori, anskaffet, avskrives_fra, kostpris, levetid_mnd, konto, skatt)
                           values (%L, 'X', 'inventar', '2026-03-10', '2026-02-01', 1000, 60, '1250', 'd')$$, :'org'), '23514');
select test.feiler(format($$insert into faktura.anleggsmidler (org_id, navn, kategori, anskaffet, avskrives_fra, kostpris, restverdi, levetid_mnd, konto, skatt)
                           values (%L, 'X', 'inventar', '2026-03-10', '2026-03-01', 1000, 1000, 60, '1250', 'd')$$, :'org'), '23514');
select test.feiler(format($$insert into faktura.anleggsmidler (org_id, navn, kategori, anskaffet, avskrives_fra, kostpris, levetid_mnd, konto, skatt, skatt_sats)
                           values (%L, 'X', 'inventar', '2026-03-10', '2026-03-01', 1000, 60, '1250', 'd', 10)$$, :'org'), '23514');
-- Ingen skriver hendelsene direkte.
select test.feiler(format($$insert into faktura.anleggshendelser (org_id, anleggsmiddel_id, type, dato, belop, bilag_id)
                           values (%L, %L, 'nedskrivning', '2026-03-01', 1, gen_random_uuid())$$, :'org', :'bil'), '42501');

-- Avskrivningene for januar og februar (varebilen), med bilaget i serie A.
select faktura.bokfor_anlegg(:'org', '2026-01-31', 'Avskrivninger januar 2026',
  '[{"konto": "6010", "belop": 2000, "tekst": "Avskrivning"}, {"konto": "1240", "belop": -2000, "tekst": "Avskrivning"}]',
  format('[{"anleggsmiddel_id": "%s", "type": "avskrivning", "maaned": "2026-01-01", "belop": 2000}]', :'bil')::jsonb) as jan \gset
select test.er((select row(serie, aar, nummer, kilde, dato)::text from faktura.bilag where id = :'jan'), row('A', 2026, 1, 'anlegg', '2026-01-31'::date)::text, 'bilaget i serie A');
select test.er((select dato from faktura.anleggshendelser where bilag_id = :'jan'), '2026-01-31'::date, 'avskrivningen står på den siste dagen i måneden');
select faktura.bokfor_anlegg(:'org', '2026-02-28', 'Avskrivninger februar 2026',
  '[{"konto": "6010", "belop": 2000}, {"konto": "1240", "belop": -2000}]',
  format('[{"anleggsmiddel_id": "%s", "type": "avskrivning", "maaned": "2026-02-01", "belop": 2000}]', :'bil')::jsonb) as feb \gset
-- Samme måned igjen, en måned før, før avskrivningen begynner, og et bilag som ikke går i null.
select test.feiler(format($$select faktura.bokfor_anlegg(%L, '2026-02-28', 'x', '[{"konto": "6010", "belop": 1}, {"konto": "1240", "belop": -1}]',
  '[{"anleggsmiddel_id": "%s", "type": "avskrivning", "maaned": "2026-02-01", "belop": 1}]')$$, :'org', :'bil'), 'FA409');
select test.feiler(format($$select faktura.bokfor_anlegg(%L, '2026-01-31', 'x', '[{"konto": "6010", "belop": 1}, {"konto": "1240", "belop": -1}]',
  '[{"anleggsmiddel_id": "%s", "type": "avskrivning", "maaned": "2026-01-01", "belop": 1}]')$$, :'org', :'bil'), 'FA409');
select test.feiler(format($$select faktura.bokfor_anlegg(%L, '2026-01-31', 'x', '[{"konto": "6020", "belop": 1}, {"konto": "1080", "belop": -1}]',
  '[{"anleggsmiddel_id": "%s", "type": "avskrivning", "maaned": "2026-01-01", "belop": 1}]')$$, :'org', :'gw'), 'FA409');
select test.feiler(format($$select faktura.bokfor_anlegg(%L, '2026-03-31', 'x', '[{"konto": "6010", "belop": 2000}, {"konto": "1240", "belop": -1999}]',
  '[{"anleggsmiddel_id": "%s", "type": "avskrivning", "maaned": "2026-03-01", "belop": 2000}]')$$, :'org', :'bil'), 'FA400');
-- Verdien blir ikke negativ (varebilen står i 116 000).
select test.feiler(format($$select faktura.bokfor_anlegg(%L, '2026-03-15', 'x', '[{"konto": "6050", "belop": 116000.01}, {"konto": "1240", "belop": -116000.01}]',
  '[{"anleggsmiddel_id": "%s", "type": "nedskrivning", "belop": 116000.01}]')$$, :'org', :'bil'), 'FA409');

-- Nedskrivning av goodwill reverseres ikke; for varebilen ikke mer enn det som er nedskrevet.
select faktura.bokfor_anlegg(:'org', '2026-02-28', 'Nedskrivning: Goodwill Kafé', '[{"konto": "6050", "belop": 50000}, {"konto": "1080", "belop": -50000}]',
  format('[{"anleggsmiddel_id": "%s", "type": "nedskrivning", "belop": 50000, "tekst": "Kafeen er stengt"}]', :'gw')::jsonb);
select test.feiler(format($$select faktura.bokfor_anlegg(%L, '2026-03-31', 'x', '[{"konto": "1080", "belop": 1000}, {"konto": "6050", "belop": -1000}]',
  '[{"anleggsmiddel_id": "%s", "type": "reversering", "belop": 1000}]')$$, :'org', :'gw'), 'FA409');
select faktura.bokfor_anlegg(:'org', '2026-02-28', 'Nedskrivning: Varebil', '[{"konto": "6050", "belop": 10000}, {"konto": "1240", "belop": -10000}]',
  format('[{"anleggsmiddel_id": "%s", "type": "nedskrivning", "belop": 10000}]', :'bil')::jsonb) as ned \gset
select test.feiler(format($$select faktura.bokfor_anlegg(%L, '2026-03-31', 'x', '[{"konto": "1240", "belop": 10000.01}, {"konto": "6050", "belop": -10000.01}]',
  '[{"anleggsmiddel_id": "%s", "type": "reversering", "belop": 10000.01}]')$$, :'org', :'bil'), 'FA409');

-- Når noe er bokført: kostprisen kan ikke endres, levetiden kan.
select test.feiler(format($$update faktura.anleggsmidler set kostpris = 130000 where id = %L$$, :'bil'), 'FA409');
update faktura.anleggsmidler set levetid_mnd = 48 where id = :'bil';
select test.feiler(format($$delete from faktura.anleggsmidler where id = %L$$, :'bil'), 'FA409');

-- Reversering: det siste først (nedskrivningen og februar før januar).
select test.feiler(format($$select faktura.reverser_anlegg(%L, %L, null)$$, :'org', :'jan'), 'FA409');
select faktura.reverser_anlegg(:'org', :'ned', null) as ned_rev \gset
select test.er((select tekst from faktura.bilag where id = :'ned_rev'), 'Reversert: Nedskrivning: Varebil', 'teksten på reverseringen');
select test.er((select reversert from faktura.anleggshendelser where bilag_id = :'ned'), true, 'nedskrivningen gjelder ikke lenger');
select test.feiler(format($$select faktura.reverser_anlegg(%L, %L, null)$$, :'org', :'ned'), 'FA409');
select faktura.reverser_anlegg(:'org', :'feb', 'Feil beløp');
-- Februar kan bokføres igjen.
select faktura.bokfor_anlegg(:'org', '2026-02-28', 'Avskrivninger februar 2026',
  '[{"konto": "6010", "belop": 2000}, {"konto": "1240", "belop": -2000}]',
  format('[{"anleggsmiddel_id": "%s", "type": "avskrivning", "maaned": "2026-02-01", "belop": 2000}]', :'bil')::jsonb);

-- Avgangen tar ut den bokførte verdien (116 000), og anleggsmiddelet er solgt.
select test.feiler(format($$select faktura.bokfor_anlegg(%L, '2026-03-15', 'Salg', '[{"konto": "1920", "belop": 100000}, {"konto": "1240", "belop": -100000}]',
  '[{"anleggsmiddel_id": "%s", "type": "avgang", "belop": 100000, "vederlag": 100000, "avgang_type": "salg"}]')$$, :'org', :'bil'), 'FA409');
select faktura.bokfor_anlegg(:'org', '2026-03-15', 'Salg: Varebil',
  '[{"konto": "1920", "belop": 125000}, {"konto": "2700", "belop": -25000}, {"konto": "1240", "belop": -116000}, {"konto": "7800", "belop": 16000}]',
  format('[{"anleggsmiddel_id": "%s", "type": "avgang", "belop": 116000, "vederlag": 100000, "avgang_type": "salg"}]', :'bil')::jsonb) as salg \gset
select test.er((select row(avgang_dato, avgang_type, avgang_vederlag)::text from faktura.anleggsmidler where id = :'bil'), row('2026-03-15'::date, 'salg', 100000.00)::text, 'solgt');
select test.er((select sum(p.belop) from faktura.posteringer p join faktura.bilag b on b.id = p.bilag_id where b.org_id = :'org' and p.konto = '1240'), -120000::numeric,
               'varebilkontoen: avskrivningene og avgangen (anskaffelsen er ikke ført her)');
select test.feiler(format($$select faktura.bokfor_anlegg(%L, '2026-03-31', 'x', '[{"konto": "6010", "belop": 1}, {"konto": "1240", "belop": -1}]',
  '[{"anleggsmiddel_id": "%s", "type": "avskrivning", "maaned": "2026-03-01", "belop": 1}]')$$, :'org', :'bil'), 'FA409');
select test.feiler(format($$update faktura.anleggsmidler set levetid_mnd = 36 where id = %L$$, :'bil'), 'FA409');
-- Salget reverseres: aktiv igjen.
select faktura.reverser_anlegg(:'org', :'salg', null);
select test.er((select avgang_dato from faktura.anleggsmidler where id = :'bil'), null::date, 'aktiv igjen');

-- Fakturerer ser ikke anleggsmidlene, bilagene eller revisjonsloggen for dem, og fører ikke.
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select count(*)::int from faktura.anleggsmidler where org_id = :'org'), 0, 'fakturerer ser ikke anleggsmidlene');
select test.er((select count(*)::int from faktura.bilag where org_id = :'org'), 0, 'fakturerer ser ikke bilagene');
select test.er((select count(*)::int from faktura.revisjonslogg where org_id = :'org' and tabell = 'anleggsmidler'), 0, 'fakturerer ser ikke loggen');
select test.feiler(format($$select faktura.bokfor_anlegg(%L, '2026-03-31', 'x', '[]', '[{"anleggsmiddel_id": "%s", "type": "nedskrivning", "belop": 1}]')$$, :'org', :'gw'), 'FA403');
select test.feiler(format($$insert into faktura.anleggsmidler (org_id, navn, kategori, anskaffet, avskrives_fra, kostpris, levetid_mnd, konto, skatt)
                           values (%L, 'X', 'inventar', '2026-03-10', '2026-03-01', 1000, 60, '1250', 'd')$$, :'org'), '42501');
select set_config('app.bruker_id', :'u', false);
select test.er((select count(*) > 0 from faktura.revisjonslogg where org_id = :'org' and tabell = 'anleggsmidler'), true, 'eieren ser loggen');
select test.er((select count(*)::int from faktura.bilag where org_id = :'org' and kilde = 'anlegg'), 9, 'eieren ser bilagene');

-- Et anleggsmiddel uten bokføringer slettes; ført i et annet system før.
insert into faktura.anleggsmidler (org_id, navn, kategori, anskaffet, avskrives_fra, kostpris, levetid_mnd, konto, skatt, tidligere_til, tidligere_avskrevet)
values (:'org', 'Gammel maskin', 'maskiner', '2023-01-05', '2023-01-01', 60000, 60, '1200', 'd', '2025-12-31', 36000) returning id as gammel \gset
select test.feiler(format($$select faktura.bokfor_anlegg(%L, '2025-12-31', 'x', '[{"konto": "6010", "belop": 1000}, {"konto": "1200", "belop": -1000}]',
  '[{"anleggsmiddel_id": "%s", "type": "avskrivning", "maaned": "2025-12-01", "belop": 1000}]')$$, :'org', :'gammel'), 'FA409');
select test.feiler(format($$select faktura.bokfor_anlegg(%L, '2023-01-05', 'x', '[{"konto": "1200", "belop": 60000}, {"konto": "2400", "belop": -60000}]',
  '[{"anleggsmiddel_id": "%s", "type": "anskaffelse", "belop": 60000}]')$$, :'org', :'gammel'), 'FA409');
select test.feiler(format($$update faktura.anleggsmidler set tidligere_til = '2025-12-15' where id = %L$$, :'gammel'), '23514');
delete from faktura.anleggsmidler where id = :'gammel';

\c :migrator
-- En organisasjon med bilag i regnskapet (bare anleggsmidler) stenges og oppbevares i fem år.
select set_config('app.bruker_id', :'u', false);
select faktura.slett_organisasjon(:'org', 'Avvikles');
select test.er((select row(slettet_at is not null, oppbevares_til)::text from faktura.organisasjoner where id = :'org'), row(true, '2031-12-31'::date)::text, 'stengt, ikke slettet');
drop schema test cascade;
