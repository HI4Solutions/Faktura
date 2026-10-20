-- Trekkpålegg fra Skatteetaten (0127_trekkpaalegg.sql): bare workeren skriver påleggene og
-- hentingen; de som ser lønnen og den ansatte selv ser dem. Et pålegg for en ansatt blir et fast
-- trekk uten beløp og prosent (de står i pålegget), et trekk lagt inn for hånd med samme KID kobles
-- til, eier og administrator kan ikke endre eller slette trekket, et avsluttet pålegg gir en
-- til-dato, en endring gjør lønnsutkastene utdatert, og revisjonsloggen er for dem som ser lønnen.

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
select id as u from faktura.registrer_bruker('uid-tpaal-eier', 'eier-tpaal@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Trekkpålegg AS', '915000185') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, lonnstype, maanedslonn)
values (:'org', 'Ola', 'Skyldner', 'ola-tpaal@test.no', '2025-01-01', 'maaned', 40000) returning id as ola \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, lonnstype, maanedslonn)
values (:'org', 'Kari', 'Skyldner', '2025-01-01', 'maaned', 50000) returning id as kari \gset
select faktura.inviter_ansatt(:'org', :'ola') as t_ola \gset
select faktura.inviter_medlem(:'org', 'regn-tpaal@test.no', 'regnskap') as t_regn \gset
select faktura.inviter_medlem(:'org', 'fakt-tpaal@test.no', 'fakturerer') as t_fakt \gset
select id as u_ola from faktura.registrer_bruker('uid-tpaal-ola', 'ola-tpaal@test.no') \gset
select id as u_regn from faktura.registrer_bruker('uid-tpaal-regn', 'regn-tpaal@test.no') \gset
select id as u_fakt from faktura.registrer_bruker('uid-tpaal-fakt', 'fakt-tpaal@test.no') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'t_regn');
select set_config('app.bruker_id', :'u_fakt', false);
select faktura.aksepter_invitasjon(:'t_fakt');
select set_config('app.bruker_id', :'u', false);

-- Et utleggstrekk eieren har lagt inn for hånd for Kari, med KID-en fra pålegget.
insert into faktura.lonnstrekk (org_id, ansatt_id, type, belop, fra, mottaker, kontonr, kid)
values (:'org', :'kari', 'utlegg_samordnet', 3000, '2026-09-01', 'Skatteetaten', '86011117947', '12345678903') returning id as for_haand \gset
-- Et utkast til lønnskjøring (utdatert når et pålegg kommer).
insert into faktura.lonnskjoringer (org_id, periode, utbetalingsdato) values (:'org', '2026-11-01', '2026-11-20') returning id as nov \gset

-- Bare workeren skriver påleggene og hentingen, og kobler dem til trekkene.
select test.feiler(format($$insert into faktura.trekkpaalegg (org_id, trekkid, trekkversjon, sekvensnummer, trekkstatus) values (%L, '1', 1, 1, 'aktiv')$$, :'org'), '42501');
select test.feiler(format($$insert into faktura.trekkpaalegg_henting (org_id, forsokt) values (%L, now())$$, :'org'), '42501');
select test.feiler($$select faktura.koble_trekkpaalegg(gen_random_uuid())$$, '42501');

\c :worker
insert into faktura.trekkpaalegg (org_id, trekkid, trekkversjon, sekvensnummer, saksnummer, trekkstatus, formidlet, ansatt_id, fodselsdato,
                                  betalingsmottaker, kontonr, kid, perioder)
values (:'org', '10001', 1, 38, 'TREKK/2026/1', 'aktiv', '2026-10-09T15:00:00Z', :'ola', '1984-10-10', '971648199', '70213997155', '6487719756',
        '[{"fra": "2026-11-01", "til": null, "belop": null, "prosent": 17}]')
returning id as p_ola \gset
insert into faktura.trekkpaalegg (org_id, trekkid, trekkversjon, sekvensnummer, saksnummer, trekkstatus, formidlet, ansatt_id, fodselsdato,
                                  betalingsmottaker, kontonr, kid, perioder, merknader)
values (:'org', '10002', 1, 51, 'TREKK/2026/2', 'aktiv', '2026-10-09T15:00:00Z', null, '1990-01-02', '971648199', '70213997155', '6487719772',
        '[{"fra": "2026-11-01", "til": null, "belop": 5000, "prosent": null}]', '{"Skyldneren er ikke registrert som ansatt her."}')
returning id as p_ukjent \gset
insert into faktura.trekkpaalegg (org_id, trekkid, trekkversjon, sekvensnummer, saksnummer, trekkstatus, formidlet, ansatt_id, betalingsmottaker, kontonr, kid, perioder)
values (:'org', '10003', 2, 101, 'TREKK/2026/3', 'aktiv', '2026-10-08T15:00:00Z', :'kari', '971648199', '70213997155', '12345678903',
        '[{"fra": "2026-09-01", "til": "2026-10-08", "belop": 3000, "prosent": null}, {"fra": "2026-10-09", "til": null, "belop": 2500, "prosent": null}]')
returning id as p_kari \gset
select test.feiler(format($$insert into faktura.trekkpaalegg (org_id, trekkid, trekkversjon, sekvensnummer, trekkstatus) values (%L, '10001', 2, 60, 'aktiv')$$, :'org'), '23505');
select test.feiler(format($$insert into faktura.trekkpaalegg (org_id, trekkid, trekkversjon, sekvensnummer, trekkstatus) values (%L, '10009', 1, 60, 'stoppet')$$, :'org'), '23514');
select test.feiler(format($$insert into faktura.trekkpaalegg (org_id, trekkid, trekkversjon, sekvensnummer, trekkstatus, kid) values (%L, '10009', 1, 60, 'aktiv', '12a')$$, :'org'), '23514');
insert into faktura.trekkpaalegg_henting (org_id, forsokt, hentet, antall) values (:'org', now(), now(), 3);

-- Ola: et nytt fast trekk, uten beløp og prosent, til Skatteetaten med kontonummeret og KID-en.
select faktura.koble_trekkpaalegg(:'p_ola') as t_ola \gset
select test.er((select row(ansatt_id, type, tekst, belop, prosent, totalt, fra, til, mottaker, kontonr, kid)::text from faktura.lonnstrekk where id = :'t_ola'),
               row(:'ola'::uuid, 'utlegg_samordnet', 'Sak TREKK/2026/1', null::numeric, null::numeric, null::numeric, '2026-11-01'::date, null::date,
                   'Skatteetaten', '70213997155', '6487719756')::text, 'trekket for Ola');
select test.er((select paalegg_id from faktura.lonnstrekk where id = :'t_ola'), :'p_ola'::uuid, 'koblet til pålegget');
-- En gang til: det samme trekket, og ingen endring.
select test.er(faktura.koble_trekkpaalegg(:'p_ola'), :'t_ola'::uuid, 'det samme trekket');
-- Den ukjente skyldneren: ikke noe trekk.
select test.er(faktura.koble_trekkpaalegg(:'p_ukjent'), null::uuid, 'ingen ansatt, ikke noe trekk');
-- Et pålegg som alt var avsluttet da det kom: ikke noe trekk.
insert into faktura.trekkpaalegg (org_id, trekkid, trekkversjon, sekvensnummer, saksnummer, trekkstatus, ansatt_id, kid, perioder)
values (:'org', '10004', 2, 159, 'TREKK/2026/4', 'avsluttet', :'ola', '6487719798', '[{"fra": "2026-07-01", "til": "2026-09-12", "belop": null, "prosent": 17}]')
returning id as p_gammel \gset
select test.er(faktura.koble_trekkpaalegg(:'p_gammel'), null::uuid, 'avsluttet før det kom, ikke noe trekk');
delete from faktura.trekkpaalegg where id = :'p_gammel';
-- Kari: trekket lagt inn for hånd med samme KID kobles til pålegget (beløpet står nå i pålegget).
select test.er(faktura.koble_trekkpaalegg(:'p_kari'), :'for_haand'::uuid, 'trekket for hånd brukes');
select test.er((select row(paalegg_id, belop, fra, til, tekst)::text from faktura.lonnstrekk where id = :'for_haand'),
               row(:'p_kari'::uuid, null::numeric, '2026-09-01'::date, null::date, 'Sak TREKK/2026/3')::text, 'og koblet til pålegget');
select test.er((select count(*)::int from faktura.lonnstrekk where org_id = :'org'), 2, 'to trekk');
-- Et trekk fra et pålegg har ikke beløp eller prosent, og er et samordnet utleggstrekk.
select test.feiler(format($$update faktura.lonnstrekk set belop = 100 where id = %L$$, :'t_ola'), '23514');
select test.feiler(format($$update faktura.lonnstrekk set type = 'bidrag' where id = %L$$, :'t_ola'), '23514');

-- Pålegget for Ola avsluttes: trekket får til-datoen.
update faktura.trekkpaalegg set trekkversjon = 2, sekvensnummer = 159, trekkstatus = 'avsluttet',
       perioder = '[{"fra": "2026-11-01", "til": "2026-12-15", "belop": null, "prosent": 17}]' where id = :'p_ola';
select faktura.koble_trekkpaalegg(:'p_ola');
select test.er((select row(fra, til)::text from faktura.lonnstrekk where id = :'t_ola'), row('2026-11-01'::date, '2026-12-15'::date)::text, 'avsluttet 15.12.');
-- Avsluttet før det startet (sluttdatoen før startdatoen): datoene er likevel i rekkefølge.
update faktura.trekkpaalegg set perioder = '[{"fra": "2027-01-10", "til": "2027-01-05", "belop": 2000, "prosent": null}]' where id = :'p_ola';
select faktura.koble_trekkpaalegg(:'p_ola');
select test.er((select row(fra, til)::text from faktura.lonnstrekk where id = :'t_ola'), row('2027-01-05'::date, '2027-01-05'::date)::text, 'sluttdato før startdato');

\c :migrator
-- Påleggene gjorde utkastet utdatert.
select test.er((select count(*)::int from faktura.lonn_endringer where org_id = :'org') > 0, true, 'lønnen er endret');
-- Revisjonsloggen har påleggene og trekkene.
select test.er((select count(*)::int from faktura.revisjonslogg where org_id = :'org' and tabell = 'trekkpaalegg'), 7, 'fire nye pålegg, to endringer og én sletting');

\c :api
-- Eieren ser alt, men kan ikke endre eller slette trekkene fra påleggene (bare de for hånd).
select set_config('app.bruker_id', :'u', false);
select test.er((select count(*)::int from faktura.trekkpaalegg where org_id = :'org'), 3, 'eieren ser påleggene');
select test.er((select antall from faktura.trekkpaalegg_henting where org_id = :'org'), 3, 'og hentingen');
update faktura.lonnstrekk set til = '2026-11-30' where id = :'t_ola';
delete from faktura.lonnstrekk where id = :'for_haand';
select test.er((select count(*)::int from faktura.lonnstrekk where org_id = :'org' and paalegg_id is not null and (til is distinct from '2027-01-05' or id = :'for_haand')), 1,
               'trekkene fra påleggene er uendret');
select test.feiler(format($$update faktura.trekkpaalegg set trekkstatus = 'avsluttet' where id = %L$$, :'p_kari'), '42501');
select test.feiler(format($$insert into faktura.lonnstrekk (org_id, ansatt_id, type, fra, paalegg_id) values (%L, %L, 'utlegg_samordnet', '2026-11-01', %L)$$, :'org', :'kari', :'p_ukjent'), '42501');
select test.er((select count(*)::int from faktura.revisjonslogg where org_id = :'org' and tabell = 'trekkpaalegg'), 7, 'eieren ser loggen');
-- Et trekk for hånd endres fortsatt.
insert into faktura.lonnstrekk (org_id, ansatt_id, type, belop, fra) values (:'org', :'ola', 'annet', 100, '2026-11-01') returning id as annet \gset
update faktura.lonnstrekk set belop = 150 where id = :'annet';
select test.er((select belop from faktura.lonnstrekk where id = :'annet'), 150.00, 'et trekk for hånd endres');
delete from faktura.lonnstrekk where id = :'annet';
select test.er((select count(*)::int from faktura.lonnstrekk where id = :'annet'), 0, 'og slettes');
-- Regnskap ser påleggene; Ola bare sitt eget; fakturereren ingen, og ikke loggen.
select set_config('app.bruker_id', :'u_regn', false);
select test.er((select count(*)::int from faktura.trekkpaalegg where org_id = :'org'), 3, 'regnskap ser påleggene');
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select string_agg(trekkid, ',') from faktura.trekkpaalegg where org_id = :'org'), '10001', 'Ola ser sitt eget');
select test.er((select count(*)::int from faktura.trekkpaalegg_henting where org_id = :'org'), 0, 'men ikke hentingen');
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select count(*)::int from faktura.trekkpaalegg where org_id = :'org'), 0, 'fakturereren ser ingen');
select test.er((select count(*)::int from faktura.trekkpaalegg_henting where org_id = :'org'), 0, 'og ikke hentingen');
select test.er((select count(*)::int from faktura.revisjonslogg where org_id = :'org' and tabell = 'trekkpaalegg'), 0, 'og ikke loggen');

\c :migrator
-- Den ansatte slettes: pålegget står igjen uten ansatt, og trekket er borte.
delete from faktura.ansatte where id = :'kari';
select test.er((select ansatt_id from faktura.trekkpaalegg where id = :'p_kari'), null::uuid, 'pålegget uten ansatt');
select test.er((select count(*)::int from faktura.lonnstrekk where paalegg_id = :'p_kari'), 0, 'trekket er borte');
-- Organisasjonen slettes (som når oppbevaringstiden er ute): påleggene, hentingen og trekkene følger med.
delete from faktura.organisasjoner where id = :'org';
select test.er((select count(*)::int from faktura.trekkpaalegg where org_id = :'org'), 0, 'påleggene er slettet');
select test.er((select count(*)::int from faktura.trekkpaalegg_henting where org_id = :'org'), 0, 'og hentingen');
select test.er((select count(*)::int from faktura.lonnstrekk where org_id = :'org'), 0, 'og trekkene');

drop schema test cascade;
\echo '  ok'
