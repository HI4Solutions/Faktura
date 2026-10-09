-- Sykepenger og NAV (0079_nav_sykepenger.sql): lønn under sykdom (refusjon) er standard;
-- sykmeldingsgraden på fraværet er 1–99 % og bare for egen sykdom, og bare workeren kobler fraværet
-- til en sykmelding fra NAV; sykmeldingene, hentingen og forespørslene skriver bare workeren, og
-- bare eier og administrator (og den ansatte for sine egne sykmeldinger) ser dem; inntektsmeldingen
-- bestilles med en funksjon (eier og administrator, en registrert ansatt, ikke mens en sendes eller
-- NAV kontrollerer den, og ikke når NAV har trukket tilbake forespørselen), og bare workeren endrer
-- statusen.

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
select id as u from faktura.registrer_bruker('uid-navdb-eier', 'eier-navdb@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Sykepenger AS', '915000258') \gset
insert into faktura.lonn_oppsett (org_id, aktiv, virksomhet_orgnr) values (:'org', true, '915000177');
select test.er((select sykepenger_refusjon from faktura.lonn_oppsett where org_id = :'org'), true, 'refusjon er standard');
update faktura.lonn_oppsett set sykepenger_refusjon = false where org_id = :'org';
update faktura.lonn_oppsett set sykepenger_refusjon = true where org_id = :'org';

insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, lonnstype, maanedslonn)
values (:'org', 'Ola', 'Sykmeldt', 'ola-navdb@test.no', '2026-01-01', 'maaned', 50000) returning id as ola \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, lonnstype, maanedslonn)
values (:'org', 'Kari', 'Frisk', 'kari-navdb@test.no', '2026-01-01', 'maaned', 50000) returning id as kari \gset
select faktura.inviter_ansatt(:'org', :'ola') as t_ola \gset
select faktura.inviter_ansatt(:'org', :'kari') as t_kari \gset
select faktura.inviter_medlem(:'org', 'regn-navdb@test.no', 'regnskap') as t_regn \gset
select id as u_ola from faktura.registrer_bruker('uid-navdb-ola', 'ola-navdb@test.no') \gset
select id as u_kari from faktura.registrer_bruker('uid-navdb-kari', 'kari-navdb@test.no') \gset
select id as u_regn from faktura.registrer_bruker('uid-navdb-regn', 'regn-navdb@test.no') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');
select set_config('app.bruker_id', :'u_kari', false);
select faktura.aksepter_invitasjon(:'t_kari');
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'t_regn');

-- Sykmeldingsgraden: 1–99 % (null er 100 %), og bare for egen sykdom.
select set_config('app.bruker_id', :'u', false);
insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, dokumentasjon, sykmeldingsgrad)
values (:'org', :'ola', 'syk', '2026-09-01', '2026-09-10', 'sykmelding', 50) returning id as f1 \gset
select test.er((select sykmeldingsgrad from faktura.fravaer where id = :'f1'), 50, 'gradert');
select test.feiler(format($$insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, sykmeldingsgrad) values (%L, %L, 'syk', '2026-10-01', '2026-10-02', 100)$$, :'org', :'kari'), '23514');
select test.feiler(format($$insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, sykmeldingsgrad) values (%L, %L, 'syk', '2026-10-01', '2026-10-02', 0)$$, :'org', :'kari'), '23514');
select test.feiler(format($$insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, sykmeldingsgrad) values (%L, %L, 'sykt_barn', '2026-10-01', '2026-10-02', 50)$$, :'org', :'kari'), '23514');
select test.feiler(format($$insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, sykmeldingsgrad) values (%L, %L, 'ferie', '2026-10-01', '2026-10-02', 50)$$, :'org', :'kari'), '23514');
update faktura.fravaer set sykmeldingsgrad = 40 where id = :'f1';
update faktura.fravaer set sykmeldingsgrad = null where id = :'f1';
-- Koblingen til sykmeldingen fra NAV setter bare workeren.
select test.feiler(format($$insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, nav_sykmelding) values (%L, %L, 'syk', '2026-10-01', '2026-10-02', gen_random_uuid())$$, :'org', :'kari'), '42501');
select test.feiler(format($$update faktura.fravaer set nav_sykmelding = gen_random_uuid() where id = %L$$, :'f1'), '42501');

-- Sykmeldingene, hentingen og forespørslene skriver bare workeren.
select test.feiler(format($$insert into faktura.nav_sykmeldinger (org_id, sykmelding_id, loepenr, virksomhet_orgnr) values (%L, 'x', 1, '915000177')$$, :'org'), '42501');
select test.feiler(format($$insert into faktura.nav_henting (org_id, type, virksomhet_orgnr) values (%L, 'sykmelding', '915000177')$$, :'org'), '42501');
select test.feiler(format($$insert into faktura.nav_forespoersler (org_id, nav_referanse_id, virksomhet_orgnr, status) values (%L, 'r', '915000177', 'AKTIV')$$, :'org'), '42501');

\c :worker
-- Hentingen: typen og virksomhetsnummeret må være gyldige.
select test.feiler(format($$insert into faktura.nav_henting (org_id, type, virksomhet_orgnr) values (%L, 'soeknad', '915000177')$$, :'org'), '23514');
select test.feiler(format($$insert into faktura.nav_henting (org_id, type, virksomhet_orgnr) values (%L, 'sykmelding', '123')$$, :'org'), '23514');
insert into faktura.nav_henting (org_id, type, virksomhet_orgnr, siste_loepenr, sist_hentet) values (:'org', 'sykmelding', '915000177', 7, now());
insert into faktura.nav_sykmeldinger (org_id, sykmelding_id, loepenr, virksomhet_orgnr, ansatt_id, navn, sykefravaer_fom, perioder)
values (:'org', 'sm-1', 7, '915000177', :'ola', 'Ola Sykmeldt', '2026-11-02', '[{"fom": "2026-11-02", "tom": "2026-11-15", "grad": 60, "type": "gradert", "reisetilskudd": false}]')
returning id as sm \gset
-- Én gang per sykmelding.
select test.feiler(format($$insert into faktura.nav_sykmeldinger (org_id, sykmelding_id, loepenr, virksomhet_orgnr) values (%L, 'sm-1', 8, '915000177')$$, :'org'), '23505');
-- Workeren registrerer fraværet fra sykmeldingen.
insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, notat, dokumentasjon, sykmeldingsgrad, nav_sykmelding)
values (:'org', :'ola', 'syk', '2026-11-02', '2026-11-15', 'Sykmelding fra NAV', 'sykmelding', 60, :'sm') returning id as f2 \gset
update faktura.nav_sykmeldinger set fravaer = array[:'f2'::uuid], merknader = '{}' where id = :'sm';
insert into faktura.nav_forespoersler (org_id, nav_referanse_id, loepenr, virksomhet_orgnr, ansatt_id, navn, status, data)
values (:'org', 'ref-1', 3, '915000177', :'ola', 'Ola Sykmeldt', 'AKTIV', '{"sykmeldingsperioder": [{"fom": "2026-11-02", "tom": "2026-11-15"}]}') returning id as fo \gset
insert into faktura.nav_forespoersler (org_id, nav_referanse_id, loepenr, virksomhet_orgnr, navn, status)
values (:'org', 'ref-2', 4, '915000177', 'Ukjent Person', 'AKTIV') returning id as fo_ukjent \gset

-- Eier og administrator ser alt; regnskap ingenting; den ansatte bare sine egne sykmeldinger.
\c :api
select set_config('app.bruker_id', :'u', false);
select test.er((select count(*)::int from faktura.nav_sykmeldinger where org_id = :'org'), 1, 'eieren ser sykmeldingen');
select test.er((select count(*)::int from faktura.nav_henting where org_id = :'org'), 1, 'eieren ser hentingen');
select test.er((select count(*)::int from faktura.nav_forespoersler where org_id = :'org'), 2, 'eieren ser forespørslene');
select test.er((select nav_sykmelding from faktura.fravaer where id = :'f2'), :'sm'::uuid, 'fraværet fra sykmeldingen');
select test.feiler(format($$update faktura.nav_sykmeldinger set merknader = '{x}' where id = %L$$, :'sm'), '42501');
select set_config('app.bruker_id', :'u_regn', false);
select test.er((select count(*)::int from faktura.nav_sykmeldinger where org_id = :'org'), 0, 'regnskap ser ikke sykmeldingene');
select test.er((select count(*)::int from faktura.nav_forespoersler where org_id = :'org'), 0, 'regnskap ser ikke forespørslene');
select test.er((select count(*)::int from faktura.nav_henting where org_id = :'org'), 0, 'regnskap ser ikke hentingen');
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select count(*)::int from faktura.nav_sykmeldinger where org_id = :'org'), 1, 'Ola ser sin egen');
select test.er((select count(*)::int from faktura.nav_forespoersler where org_id = :'org'), 0, 'men ikke forespørslene');
select set_config('app.bruker_id', :'u_kari', false);
select test.er((select count(*)::int from faktura.nav_sykmeldinger where org_id = :'org'), 0, 'Kari ser ikke Olas');

-- Inntektsmeldingen: eier og administrator, for en registrert ansatt, med innhold.
select test.feiler(format($$select faktura.bestill_inntektsmelding(%L, '{}')$$, :'fo'), 'FA403');
select set_config('app.bruker_id', :'u_regn', false);
select test.feiler(format($$select faktura.bestill_inntektsmelding(%L, '{}')$$, :'fo'), 'FA403');
select set_config('app.bruker_id', :'u', false);
select test.feiler($$select faktura.bestill_inntektsmelding('00000000-0000-0000-0000-000000000000', '{}')$$, 'FA404');
select test.feiler(format($$select faktura.bestill_inntektsmelding(%L, '{}')$$, :'fo_ukjent'), 'FA409');
select test.feiler(format($$select faktura.bestill_inntektsmelding(%L, '[]')$$, :'fo'), 'FA400');
select test.feiler(format($$insert into faktura.nav_inntektsmeldinger (org_id, forespoersel_id, innhold) values (%L, %L, '{}')$$, :'org', :'fo'), '42501');
select * from faktura.bestill_inntektsmelding(:'fo', '{"agp": [], "inntekt": 50000}') \gset im1_
select test.er(:'im1_status', 'sender', 'sendes');
select test.er(:'im1_ansatt_id'::uuid, :'ola'::uuid, 'for Ola');
select test.er(:'im1_sendt_av'::uuid, :'u'::uuid, 'sendt av eieren');
-- Mens den sendes, får forespørselen ikke en ny.
select test.feiler(format($$select faktura.bestill_inntektsmelding(%L, '{}')$$, :'fo'), 'FA409');
select test.feiler(format($$update faktura.nav_inntektsmeldinger set status = 'sendt' where id = %L$$, :'im1_id'), '42501');

\c :worker
select test.feiler(format($$update faktura.nav_inntektsmeldinger set innhold = '{}' where id = %L$$, :'im1_id'), '42501');
select test.feiler(format($$update faktura.nav_inntektsmeldinger set status = 'borte' where id = %L$$, :'im1_id'), '23514');
update faktura.nav_inntektsmeldinger set status = 'sendt', aarsak = 'Ny', innsending_id = 'inn-1', sendt_at = now() where id = :'im1_id';
select test.feiler(format($$update faktura.nav_inntektsmeldinger set aarsak = 'Kanskje' where id = %L$$, :'im1_id'), '23514');

-- Mens NAV kontrollerer den, får forespørselen ikke en ny.
\c :api
select set_config('app.bruker_id', :'u', false);
select test.feiler(format($$select faktura.bestill_inntektsmelding(%L, '{}')$$, :'fo'), 'FA409');

-- Når NAV har godkjent den, kan en ny (korrigert) sendes.
\c :worker
update faktura.nav_inntektsmeldinger set status = 'godkjent' where id = :'im1_id';
update faktura.nav_forespoersler set status = 'BESVART' where id = :'fo';
select test.feiler(format($$update faktura.nav_forespoersler set status = 'BORTE' where id = %L$$, :'fo'), '23514');
\c :api
select set_config('app.bruker_id', :'u', false);
select * from faktura.bestill_inntektsmelding(:'fo', '{"agp": [], "inntekt": 51000}') \gset im2_
select test.er((select count(*)::int from faktura.nav_inntektsmeldinger where forespoersel_id = :'fo'), 2, 'to inntektsmeldinger');
select test.er((select count(*)::int from faktura.revisjonslogg where tabell = 'nav_inntektsmeldinger' and rad_id = :'im1_id'), 3, 'i revisjonsloggen (ny, sendt, godkjent)');
select set_config('app.bruker_id', :'u_regn', false);
select test.er((select count(*)::int from faktura.nav_inntektsmeldinger where org_id = :'org'), 0, 'regnskap ser ikke inntektsmeldingene');

-- En forespørsel NAV har trukket tilbake, kan ikke besvares.
\c :worker
update faktura.nav_inntektsmeldinger set status = 'avvist', feil = 'Inntekten avviker' where id = :'im2_id';
update faktura.nav_forespoersler set status = 'FORKASTET' where id = :'fo';
\c :api
select set_config('app.bruker_id', :'u', false);
select test.feiler(format($$select faktura.bestill_inntektsmelding(%L, '{}')$$, :'fo'), 'FA409');

-- Sykmeldingen blir stående når fraværet slettes; den ansatte som slettes, blir borte fra den.
select set_config('app.bruker_id', :'u', false);
delete from faktura.fravaer where id = :'f2';
select test.er((select count(*)::int from faktura.nav_sykmeldinger where id = :'sm'), 1, 'sykmeldingen står');

\c :migrator
drop schema test cascade;
\echo '  ok'
