-- A-meldingen (0077_amelding.sql): arbeidsforholdet på de ansatte (kodene, og datoene for siste
-- lønns- og stillingsendring som settes av seg selv), virksomheten og pensjonsinnretningen i
-- lønnsoppsettet, a-meldingene (bare workeren skriver; de som ser lønnen leser), bestillingen (eier
-- og administrator; en ny melding erstatter den siste som er levert, og en måned som venter, får
-- ikke en ny), fila som merkes som levert, og utvidelsen av tilgangen i Altinn.

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
select id as u from faktura.registrer_bruker('uid-amelding-eier', 'eier-amelding@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('A-melding AS', '915000134') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);

-- Virksomheten og pensjonsinnretningen må være gyldige organisasjonsnumre.
select test.feiler(format($$update faktura.lonn_oppsett set virksomhet_orgnr = '915000143' where org_id = %L$$, :'org'), '23514');
update faktura.lonn_oppsett set virksomhet_orgnr = '915000142', pensjonsinnretning_orgnr = '915000150' where org_id = :'org';

insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra, lonnstype, maanedslonn, stillingsprosent)
values (:'org', 'Ola', 'Melding', 'ola-amelding@test.no', '2026-01-01', 'maaned', 50000, 100) returning id as ola \gset

-- Arbeidsforholdet: standardverdiene og kodene.
select test.er((select arbeidsforhold_type || ' ' || arbeidstidsordning from faktura.ansatte where id = :'ola'), 'ordinaertArbeidsforhold ikkeSkift', 'standard');
select test.feiler(format($$update faktura.ansatte set yrkeskode = '123' where id = %L$$, :'ola'), '23514');
select test.feiler(format($$update faktura.ansatte set arbeidstidsordning = 'natt' where id = %L$$, :'ola'), '23514');
select test.feiler(format($$update faktura.ansatte set aarsak_sluttdato = 'lei' where id = %L$$, :'ola'), '23514');
update faktura.ansatte set yrkeskode = '2221104', arbeidstidsordning = 'doegnkontinuerligSkiftOgTurnus355', aarsak_sluttdato = 'arbeidstakerHarSagtOppSelv' where id = :'ola';
select test.er((select siste_lonnsendring from faktura.ansatte where id = :'ola'), null::date, 'ingen lønnsendring ennå');

-- Lønnen og stillingsprosenten endres: datoene settes til i dag (med mindre de settes samtidig).
update faktura.ansatte set maanedslonn = 52000 where id = :'ola';
select test.er((select siste_lonnsendring from faktura.ansatte where id = :'ola'), faktura.i_dag(), 'lønnsendring i dag');
select test.er((select siste_stillingsendring from faktura.ansatte where id = :'ola'), null::date, 'stillingen er ikke endret');
update faktura.ansatte set stillingsprosent = 80, siste_stillingsendring = '2026-03-01' where id = :'ola';
select test.er((select siste_stillingsendring from faktura.ansatte where id = :'ola'), '2026-03-01'::date, 'datoen som ble satt');
update faktura.ansatte set stillingsprosent = 60 where id = :'ola';
select test.er((select siste_stillingsendring from faktura.ansatte where id = :'ola'), faktura.i_dag(), 'stillingsendring i dag');

select faktura.inviter_ansatt(:'org', :'ola') as t_ola \gset
select faktura.inviter_medlem(:'org', 'regn-amelding@test.no', 'regnskap') as t_regn \gset
select id as u_ola from faktura.registrer_bruker('uid-amelding-ola', 'ola-amelding@test.no') \gset
select id as u_regn from faktura.registrer_bruker('uid-amelding-regn', 'regn-amelding@test.no') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'t_regn');

-- Bare eier og administrator bestiller; ingen skriver a-meldingene direkte.
select test.feiler(format($$select faktura.bestill_amelding(%L, '2026-11-01', 'fil')$$, :'org'), 'FA403');
select test.feiler(format($$insert into faktura.ameldinger (org_id, maaned, innsending) values (%L, '2026-11-01', 'fil')$$, :'org'), '42501');
select set_config('app.bruker_id', :'u', false);
select test.feiler(format($$select faktura.bestill_amelding(%L, '2026-11-15', 'fil')$$, :'org'), 'FA400');
select test.feiler(format($$select faktura.bestill_amelding(%L, '2026-11-01', 'post')$$, :'org'), 'FA400');
select * from faktura.bestill_amelding(:'org', '2026-11-01', 'fil') \gset m1_
select test.er(:'m1_status', 'lages', 'den første lages');
select test.er((select erstatter from faktura.ameldinger where id = :'m1_id'), null::text, 'erstatter ingen');
-- Mens den lages, får måneden ikke en ny.
select test.feiler(format($$select faktura.bestill_amelding(%L, '2026-11-01', 'fil')$$, :'org'), 'FA409');

-- Workeren lager fila; eieren merker den som lastet opp.
\c :worker
update faktura.ameldinger set status = 'klar', fil_sti = 'amelding/x.xml' where id = :'m1_id';
\c :api
select set_config('app.bruker_id', :'u_regn', false);
select test.er((select status from faktura.ameldinger where id = :'m1_id'), 'klar', 'regnskap ser a-meldingen');
select test.feiler(format($$select faktura.amelding_levert(%L, %L, true)$$, :'org', :'m1_id'), 'FA403');
select set_config('app.bruker_id', :'u_ola', false);
select test.er((select count(*)::int from faktura.ameldinger), 0, 'den ansatte ser den ikke');
select set_config('app.bruker_id', :'u', false);
select faktura.amelding_levert(:'org', :'m1_id', true);
select test.er((select status from faktura.ameldinger where id = :'m1_id'), 'levert', 'merket som levert');

-- En ny melding for måneden erstatter den som er levert; uten erstatt gjør den ikke det.
select * from faktura.bestill_amelding(:'org', '2026-11-01', 'fil') \gset m2_
select test.er(:'m2_erstatter', :'m1_meldings_id', 'erstatter den leverte');
\c :worker
update faktura.ameldinger set status = 'feil', feil = 'Prøvde' where id = :'m2_id';
\c :api
select set_config('app.bruker_id', :'u', false);
select * from faktura.bestill_amelding(:'org', '2026-11-01', 'fil', false) \gset m3_
select test.er((select erstatter from faktura.ameldinger where id = :'m3_id'), null::text, 'uten erstatt');
\c :worker
update faktura.ameldinger set status = 'klar' where id = :'m3_id';
-- Til API-et: sendt, og venter på tilbakemelding (måneden får ikke en ny i mellomtiden).
\c :api
select set_config('app.bruker_id', :'u', false);
select * from faktura.bestill_amelding(:'org', '2026-10-01', 'api') \gset m4_
\c :worker
update faktura.ameldinger set status = 'sendt', sendt_at = now(), dialog_id = 'd1' where id = :'m4_id';
\c :api
select set_config('app.bruker_id', :'u', false);
select test.feiler(format($$select faktura.bestill_amelding(%L, '2026-10-01', 'api')$$, :'org'), 'FA409');
\c :worker
update faktura.ameldinger set status = 'mottatt' where id = :'m4_id';
\c :api
select set_config('app.bruker_id', :'u', false);
select * from faktura.bestill_amelding(:'org', '2026-10-01', 'api') \gset m5_
select test.er(:'m5_erstatter', :'m4_meldings_id', 'erstatter den mottatte');
-- Fila kan ikke merkes når den ikke er en fil som er klar.
select test.feiler(format($$select faktura.amelding_levert(%L, %L, true)$$, :'org', :'m5_id'), 'FA404');

-- Tilgangen i Altinn utvides bare når den er godkjent.
select test.feiler(format($$select faktura.be_om_utvidet_tilgang(%L)$$, :'org'), 'FA409');
\c :worker
insert into faktura.skattekort_tilgang (org_id, status) values (:'org', 'godkjent');
select test.er((select pakker from faktura.skattekort_tilgang where org_id = :'org'), '{urn:altinn:accesspackage:lonn}'::text[], 'pakken Lønn');
\c :api
select set_config('app.bruker_id', :'u_regn', false);
select test.feiler(format($$select faktura.be_om_utvidet_tilgang(%L)$$, :'org'), 'FA403');
select set_config('app.bruker_id', :'u', false);
select faktura.be_om_utvidet_tilgang(:'org');
select test.er((select endring_status from faktura.skattekort_tilgang where org_id = :'org'), 'venter', 'endringen venter på workeren');
\c :worker
update faktura.skattekort_tilgang set endring_status = 'godkjent', pakker = pakker || '{urn:altinn:accesspackage:a-ordning}' where org_id = :'org';
select test.er((select cardinality(pakker) from faktura.skattekort_tilgang where org_id = :'org'), 2, 'to pakker');

\c :migrator
drop schema test cascade;
\echo '  ok'
