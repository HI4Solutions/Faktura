-- Databasetester. Kjøres av scripts/test-db.sh med variablene :api, :worker og :migrator
-- (tilkoblingsadresser for de tre rollene). Testene stopper på første feil.

\set QUIET on
\set ON_ERROR_STOP on

-- Hjelpere, eid av migrator.
create schema test;
grant usage on schema test to public;

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

create function test.er(_faktisk anycompatible, _forventet anycompatible, _hva text) returns void language plpgsql as $$
begin
  if _faktisk is distinct from _forventet then
    raise exception 'FEIL %: fikk %, forventet %', _hva, _faktisk, _forventet;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Rene regler
-- ---------------------------------------------------------------------------
select test.er(faktura.kid(10001, 1000001), '01000110000014', 'KID-eksempelet fra MedSide');
select test.er(faktura.orgnr_gyldig('923609016'), true, 'gyldig orgnr');
select test.er(faktura.orgnr_gyldig('923609017'), false, 'ugyldig orgnr');
select test.er(faktura.kontonr_gyldig('86011117947'), true, 'gyldig kontonr');
select test.er(faktura.kontonr_gyldig('86011117948'), false, 'ugyldig kontonr');
select test.er(faktura.neste_forfall('2026-01-31', 'maaned', 31), '2026-02-28'::date, '31.01 -> 28.02');
select test.er(faktura.neste_forfall('2026-02-28', 'maaned', 31), '2026-03-31'::date, '28.02 -> 31.03 (dagen holdes)');
select test.er(faktura.neste_forfall('2028-02-29', 'aar', 29), '2029-02-28'::date, 'skuddår');
select test.er(faktura.neste_forfall('2026-11-15', 'kvartal', 15), '2027-02-15'::date, 'kvartal');
select test.er(faktura.periode_slutt('2026-10-05', 'maaned'), '2026-11-04'::date, 'månedsperiode');
select test.er(faktura.periode_slutt('2026-10-05', 'aar'), '2027-10-04'::date, 'årsperiode');

-- ---------------------------------------------------------------------------
-- Brukere og organisasjon (som API-rollen)
-- ---------------------------------------------------------------------------
\c :api
select id as u1 from faktura.registrer_bruker('uid-1', 'Ola@Firma.no', 'Ola') \gset
select id as u2 from faktura.registrer_bruker('uid-2', 'kari@byraa.no', 'Kari') \gset
select id as u3 from faktura.registrer_bruker('uid-3', 'per@annet.no', 'Per') \gset
select test.er((select epost from faktura.registrer_bruker('uid-1', 'ola@firma.no')), 'ola@firma.no', 'e-post lagres med små bokstaver');

-- Uten innlogget bruker ser man ingenting og kan ikke opprette organisasjoner.
select test.feiler($$select faktura.opprett_organisasjon('X')$$, 'FA403');

select set_config('app.bruker_id', :'u1', false);
select id as org1 from faktura.opprett_organisasjon('Firma AS', '923609016') \gset
select test.feiler($$select faktura.opprett_organisasjon('Feil AS', '923609017')$$, 'FA400');
select test.er((select rolle from faktura.mine_organisasjoner where id = :'org1'), 'eier', 'skaper blir eier');

update faktura.organisasjoner
   set kontonr = '86011117947', bruk_kid = true, mva_registrert = true, adresse = 'Gate 1', postnr = '0150', poststed = 'Oslo'
 where id = :'org1';
select test.feiler($$update faktura.organisasjoner set kontonr = '86011117948'$$, '23514');
select test.feiler($$update faktura.organisasjoner set verifisering = 'verifisert'$$, '42501');

-- ---------------------------------------------------------------------------
-- Kunder, produkter og utstedelse
-- ---------------------------------------------------------------------------
insert into faktura.kunder (org_id, navn, orgnr, epost, adresse, postnr, poststed)
values (:'org1', 'Kunde AS', '974760673', 'faktura@kunde.no', 'Vei 2', '5003', 'Bergen')
returning id as k1, kundenummer as knr1 \gset
select test.er(:knr1::bigint, 10001::bigint, 'første kundenummer');
select test.feiler(format($$update faktura.kunder set kundenummer = 1 where id = %L$$, :'k1'), '42501');

insert into faktura.produkter (org_id, navn, enhetspris, mva_sats)
values (:'org1', 'Konsulenttime', 1000, 25) returning id as p1 \gset

insert into faktura.fakturaer (org_id, kunde_id) values (:'org1', :'k1') returning id as f1 \gset
select test.feiler(format($$select faktura.utsted(%L)$$, :'f1'), 'FA400');  -- ingen linjer
insert into faktura.faktura_linjer (org_id, faktura_id, rekke, produkt_id, beskrivelse, antall, enhetspris, mva_sats)
values (:'org1', :'f1', 1, :'p1', 'Konsulenttime', 2, 1000, 25),
       (:'org1', :'f1', 2, null, 'Fakturagebyr', 1, 8, 25);

-- Appen kan ikke sette status eller nummer direkte.
select test.feiler(format($$update faktura.fakturaer set status = 'utstedt' where id = %L$$, :'f1'), '42501');
select test.feiler(format($$update faktura.fakturaer set fakturanummer = 5 where id = %L$$, :'f1'), '42501');

select fakturanummer as nr1, sum_eks_mva, mva, sum_inkl_mva, kid, status
  from faktura.utsted(:'f1') \gset
select test.er(:nr1::bigint, 1::bigint, 'første fakturanummer');
select test.er(:sum_eks_mva::numeric, 2008.00, 'sum eks. mva');
select test.er(:mva::numeric, 502.00, 'mva');
select test.er(:sum_inkl_mva::numeric, 2510.00, 'sum inkl. mva');
select test.er(:'kid', faktura.kid(10001, 1), 'KID settes');
select test.er(:'status', 'utstedt', 'status utstedt');
select test.er((select fakturanummer from faktura.utsted(:'f1')), 1::bigint, 'utstedelse kan gjentas');
select test.er((select selger ->> 'kontonr' from faktura.fakturaer where id = :'f1'), '86011117947', 'selger kopieres');

-- Utstedt faktura er låst.
with u as (update faktura.fakturaer set notat = 'x' where id = :'f1' returning 1) select test.er(count(*), 0::bigint, 'RLS hindrer endring av utstedt faktura') from u;
with u as (update faktura.faktura_linjer set antall = 9 where faktura_id = :'f1' returning 1) select test.er(count(*), 0::bigint, 'RLS hindrer endring av linjer') from u;
with d as (delete from faktura.fakturaer where id = :'f1' returning 1) select test.er(count(*), 0::bigint, 'RLS hindrer sletting av utstedt faktura') from d;
select test.feiler(format($$insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, enhetspris) values (%L, %L, 'x', 1)$$, :'org1', :'f1'), 'FA409');

\c :migrator
-- Selv eieren av tabellene kan ikke endre en utstedt faktura.
select test.feiler(format($$update faktura.fakturaer set sum_inkl_mva = 1 where id = %L$$, :'f1'), 'FA409');
select test.feiler(format($$delete from faktura.fakturaer where id = %L$$, :'f1'), 'FA409');
select test.feiler(format($$update faktura.faktura_linjer set antall = 9 where faktura_id = %L$$, :'f1'), 'FA409');
select test.feiler(format($$delete from faktura.faktura_linjer where faktura_id = %L$$, :'f1'), 'FA409');

-- ---------------------------------------------------------------------------
-- Betaling og refusjon
-- ---------------------------------------------------------------------------
\c :api
select set_config('app.bruker_id', :'u1', false);
select test.feiler(format($$select faktura.registrer_betaling(%L, 100, faktura.i_dag() + 1)$$, :'f1'), 'FA400');
select test.feiler(format($$select faktura.registrer_betaling(%L, 0, faktura.i_dag())$$, :'f1'), 'FA400');
select test.er((select status from faktura.registrer_betaling(:'f1', 1000, faktura.i_dag(), null, 'bank', 'ref-1')), 'utstedt', 'delbetaling');
select test.er((select betalt_belop from faktura.registrer_betaling(:'f1', 1000, faktura.i_dag(), null, 'bank', 'ref-1')), 1000.00, 'samme bankreferanse registreres ikke to ganger');
select test.er((select status from faktura.registrer_betaling(:'f1', 1510, faktura.i_dag())), 'betalt', 'hele beløpet betalt');
select test.feiler(format($$select faktura.registrer_refusjon(%L, 3000, faktura.i_dag())$$, :'f1'), 'FA400');
select test.er((select refusjon_belop from faktura.registrer_refusjon(:'f1', 510, faktura.i_dag(), 'Rabatt')), 510.00, 'refusjon');
select test.er((select status from faktura.fakturaer where id = :'f1'), 'betalt', 'refusjon endrer ikke status');
select test.feiler(format($$select faktura.registrer_refusjon(%L, 2000.01, faktura.i_dag())$$, :'f1'), 'FA400');
select test.feiler(format($$insert into faktura.betalinger (org_id, faktura_id, type, belop, betalt_dato) values (%L, %L, 'betaling', 1, faktura.i_dag())$$, :'org1', :'f1'), '42501');

-- ---------------------------------------------------------------------------
-- Delvis og hel kreditering
-- ---------------------------------------------------------------------------
insert into faktura.fakturaer (org_id, kunde_id) values (:'org1', :'k1') returning id as f2 \gset
insert into faktura.faktura_linjer (org_id, faktura_id, rekke, beskrivelse, antall, enhetspris, mva_sats)
values (:'org1', :'f2', 1, 'Lisens', 3, 100, 25) returning id as l2 \gset
select test.er((select fakturanummer from faktura.utsted(:'f2')), 2::bigint, 'nummerserien er sammenhengende');

select test.feiler(format($$select faktura.krediter(%L, '[{"linje_id": "%s", "antall": 4}]')$$, :'f2', :'l2'), 'FA400');
select test.feiler(format($$select faktura.krediter(%L, '[{"linje_id": "%s", "antall": 1}]')$$, :'f2', gen_random_uuid()), 'FA400');
select fakturanummer as kn1, sum_inkl_mva as kn1_sum, type as kn1_type
  from faktura.krediter(:'f2', format('[{"linje_id": "%s", "antall": 1}]', :'l2')::jsonb) \gset
select test.er(:kn1::bigint, 3::bigint, 'kreditnota får neste nummer');
select test.er(:kn1_sum::numeric, -125.00, 'delvis kreditnota');
select test.er(:'kn1_type', 'kreditnota', 'type kreditnota');
select test.er((select status from faktura.fakturaer where id = :'f2'), 'utstedt', 'delvis kreditert er fortsatt utstedt');
select test.er((select kreditert_belop from faktura.fakturaer where id = :'f2'), 125.00, 'kreditert beløp');

-- Betaling av resten gjør fakturaen betalt.
select test.er((select status from faktura.registrer_betaling(:'f2', 250, faktura.i_dag())), 'betalt', 'betalt etter delkreditering');

select test.er((select sum_inkl_mva from faktura.krediter(:'f2')), -250.00, 'resten krediteres');
select test.er((select status from faktura.fakturaer where id = :'f2'), 'kreditert', 'hel kreditering');
select test.feiler(format($$select faktura.krediter(%L)$$, :'f2'), 'FA409');
select test.feiler(format($$select faktura.krediter(%L)$$, (select id from faktura.fakturaer where fakturanummer = 3 and org_id = :'org1')), 'FA409');

-- ---------------------------------------------------------------------------
-- Andre brukere ser ingenting
-- ---------------------------------------------------------------------------
select set_config('app.bruker_id', :'u3', false);
select test.er((select count(*) from faktura.fakturaer), 0::bigint, 'fremmed ser ingen fakturaer');
select test.er((select count(*) from faktura.kunder), 0::bigint, 'fremmed ser ingen kunder');
select test.er((select count(*) from faktura.organisasjoner), 0::bigint, 'fremmed ser ingen organisasjoner');
select test.feiler(format($$select faktura.utsted(%L)$$, :'f1'), 'FA403');
select test.feiler(format($$select faktura.registrer_betaling(%L, 1, faktura.i_dag())$$, :'f1'), 'FA403');
select test.feiler(format($$insert into faktura.kunder (org_id, navn) values (%L, 'Inntrenger')$$, :'org1'), '42501');
select test.feiler($$select * from faktura.utboks$$, '42501');

-- Grenser for uverifiserte organisasjoner.
select id as org3 from faktura.opprett_organisasjon('Ny AS') \gset
update faktura.organisasjoner set kontonr = '86011117947' where id = :'org3';
insert into faktura.kunder (org_id, navn) values (:'org3', 'K') returning id as k3 \gset
insert into faktura.fakturaer (org_id, kunde_id) values (:'org3', :'k3') returning id as f3 \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, antall, enhetspris) values (:'org3', :'f3', 'Stor jobb', 1, 60000);
select test.feiler(format($$select faktura.utsted(%L)$$, :'f3'), 'FA429');

-- ---------------------------------------------------------------------------
-- Regnskapsbyrå
-- ---------------------------------------------------------------------------
select set_config('app.bruker_id', :'u2', false);
select id as byraa from faktura.opprett_organisasjon('Byrå AS', '974760673', 'regnskapsbyraa') \gset

\c :worker
select faktura.sett_verifisering(:'org1', 'verifisert', 'epostdomene');
select faktura.sett_verifisering(:'byraa', 'verifisert', 'manuell');

\c :api
select set_config('app.bruker_id', :'u1', false);
select test.feiler($$select faktura.sett_verifisering(gen_random_uuid(), 'verifisert')$$, '42501');
select id as t1, status as t1_status from faktura.opprett_tilgang(:'org1', '974760673', 'bokfor') \gset
select test.er(:'t1_status', 'invitert', 'klienten inviterer');
select test.feiler(format($$select faktura.svar_tilgang(%L, true)$$, :'t1'), 'FA403');

select set_config('app.bruker_id', :'u2', false);
select test.er((select count(*) from faktura.fakturaer), 0::bigint, 'byrået ser ingenting før aksept');
select test.er((select status from faktura.svar_tilgang(:'t1', true)), 'aktiv', 'byrået aksepterer');
select test.er((select count(*) from faktura.fakturaer where org_id = :'org1'), 4::bigint, 'byrået ser klientens fakturaer');
select test.er((select rolle from faktura.mine_organisasjoner where id = :'org1'), 'regnskap', 'byrået får rollen regnskap');
select test.er((select count(*) from faktura.mine_organisasjoner), 2::bigint, 'byråets dashboard viser eget byrå og klient');
select faktura.logg_oppslag(:'org1', 'dashboard');

select test.feiler(format($$insert into faktura.fakturaer (org_id, kunde_id) values (%L, %L)$$, :'org1', :'k1'), '42501');
select set_config('app.bruker_id', :'u1', false);
insert into faktura.fakturaer (org_id, kunde_id) values (:'org1', :'k1') returning id as f4 \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, enhetspris) values (:'org1', :'f4', 'Tjeneste', 400);
select faktura.utsted(:'f4');

select set_config('app.bruker_id', :'u2', false);
select test.er((select status from faktura.registrer_betaling(:'f4', 500, faktura.i_dag())), 'betalt', 'regnskapsfører kan bokføre betaling');
select test.feiler(format($$select faktura.krediter(%L)$$, :'f4'), 'FA403');
select test.feiler(format($$insert into faktura.kunder (org_id, navn) values (%L, 'X')$$, :'org1'), '42501');
with u as (update faktura.organisasjoner set kontonr = '86011117947' where id = :'org1' returning 1) select test.er(count(*), 0::bigint, 'regnskapsfører kan ikke endre kontonummer') from u;

-- Klienten trekker tilgangen.
select set_config('app.bruker_id', :'u1', false);
select faktura.trekk_tilgang(:'t1');
select set_config('app.bruker_id', :'u2', false);
select test.er((select count(*) from faktura.fakturaer), 0::bigint, 'tilgangen er trukket');

-- ---------------------------------------------------------------------------
-- Medlemmer
-- ---------------------------------------------------------------------------
select set_config('app.bruker_id', :'u1', false);
select faktura.inviter_medlem(:'org1', 'per@annet.no', 'fakturerer') as token \gset
select set_config('app.bruker_id', :'u2', false);
select test.feiler(format($$select faktura.aksepter_invitasjon(%L)$$, :'token'), 'FA403');
select set_config('app.bruker_id', :'u3', false);
select test.er(faktura.aksepter_invitasjon(:'token'), :'org1'::uuid, 'invitasjon akseptert');
select test.feiler(format($$select faktura.aksepter_invitasjon(%L)$$, :'token'), 'FA404');
select test.er(faktura.rolle(:'org1'), 'fakturerer', 'ny rolle');
select test.feiler(format($$select faktura.endre_rolle(%L, %L, 'eier')$$, :'org1', :'u3'), 'FA403');
select set_config('app.bruker_id', :'u1', false);
select test.feiler(format($$select faktura.fjern_medlem(%L, %L)$$, :'org1', :'u1'), 'FA409');

-- ---------------------------------------------------------------------------
-- Gjentakelser (som workeren, uten innlogget bruker)
-- ---------------------------------------------------------------------------
insert into faktura.gjentakelser (org_id, kunde_id, linjer, intervall, forfall_dag, neste_forfall)
values (:'org1', :'k1', '[{"beskrivelse": "Abonnement", "enhetspris": 299}]', 'maaned', 31, '2026-01-31')
returning id as g1 \gset

\c :worker
select faktura.lag_fra_gjentakelse(:'g1') as gf1 \gset
select test.er((select neste_forfall from faktura.gjentakelser where id = :'g1'), '2026-02-28'::date, 'neste forfall flyttes');
select test.er((select sum_inkl_mva from faktura.utsted(:'gf1')), 373.75, 'gjentakelsesfaktura utstedes');
select test.er((select count(*) from faktura.utboks where hendelse = 'faktura.utstedt' and org_id = :'org1'), 4::bigint, 'utboks: utstedt');
select test.er((select count(*) from faktura.utboks where hendelse = 'kreditnota.utstedt'), 2::bigint, 'utboks: kreditnota');
select test.er((select count(*) from faktura.utboks where hendelse = 'organisasjon.kontonr_endret' and org_id = :'org1'), 1::bigint, 'utboks: kontonr endret');
select test.er((select count(*) > 0 from faktura.revisjonslogg where handling = 'OPPSLAG' and org_id = :'org1'), true, 'oppslag logges');

update faktura.kunder set aktiv = false where id = :'k1';
select test.er(faktura.lag_fra_gjentakelse(:'g1'), null::uuid, 'inaktiv kunde faktureres ikke');
select test.er((select aktiv from faktura.gjentakelser where id = :'g1'), false, 'gjentakelsen slås av');

\c :migrator
drop schema test cascade;
\echo '  ok'
