-- Årsregnskapet (0120_aarsregnskap.sql): én rad per år med opplysningene og innsendingen, bare for
-- dem som har Regnskap; kolonnene appen kan endre, og workeren (systemet) som oppdaterer
-- innsendingen; antall årsverk (forslaget i noten); og tilgangen i Altinn for Regnskap, også uten
-- Personal og Lønn.

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
select id as u from faktura.registrer_bruker('uid-aarsregnskap', 'aarsregnskap@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Årsregnskap AS', '315000122') \gset
-- Økonomiansvarlig med bare Regnskap (ikke Personal eller Lønn), og en fakturerer.
select id as okonomi from faktura.lagre_tilgangsrolle(:'org', null, 'Økonomiansvarlig', null, array['regnskap']) \gset
select faktura.inviter_medlem(:'org', 'okonomi-aarsregnskap@test.no', 'tilpasset', :'okonomi') as t_okonomi \gset
select faktura.inviter_medlem(:'org', 'fakt-aarsregnskap@test.no', 'fakturerer') as t_fakt \gset
select id as u_okonomi from faktura.registrer_bruker('uid-aarsregnskap-okonomi', 'okonomi-aarsregnskap@test.no') \gset
select id as u_fakt from faktura.registrer_bruker('uid-aarsregnskap-fakt', 'fakt-aarsregnskap@test.no') \gset
select set_config('app.bruker_id', :'u_okonomi', false);
select faktura.aksepter_invitasjon(:'t_okonomi');
select set_config('app.bruker_id', :'u_fakt', false);
select faktura.aksepter_invitasjon(:'t_fakt');

-- Eieren lager årsregnskapet for 2025; det er ett per år.
select set_config('app.bruker_id', :'u', false);
insert into faktura.aarsregnskap (org_id, aar, opplysninger) values (:'org', 2025, '{"revideres": false}') returning id as a25 \gset
select test.er((select status || '|' || laast from faktura.aarsregnskap where id = :'a25'), 'utkast|false', 'nytt utkast');
select test.feiler(format($$insert into faktura.aarsregnskap (org_id, aar) values (%L, 2025)$$, :'org'), '23505');
select test.feiler(format($$insert into faktura.aarsregnskap (org_id, aar) values (%L, 1999)$$, :'org'), '23514');
-- Status og innsendingen settes ikke når raden lages, og året og organisasjonen endres ikke.
select test.feiler(format($$insert into faktura.aarsregnskap (org_id, aar, status) values (%L, 2024, 'levert')$$, :'org'), '42501');
select test.feiler(format($$update faktura.aarsregnskap set aar = 2024 where id = %L$$, :'a25'), '42501');
select test.feiler(format($$update faktura.aarsregnskap set org_id = gen_random_uuid() where id = %L$$, :'a25'), '42501');
select test.feiler(format($$update faktura.aarsregnskap set status = 'ukjent' where id = %L$$, :'a25'), '23514');
-- Appen merker innsendingen (status «sender», skjemaene som sendes) før workeren tar over.
update faktura.aarsregnskap set status = 'sender', hovedskjema = '<x/>', underskjema = '<y/>', sendt_at = now(), sendt_av = :'u', oppdatert = now()
 where id = :'a25';
select test.er((select status from faktura.aarsregnskap where id = :'a25'), 'sender', 'appen setter «sender»');

-- Økonomiansvarlig (bare Regnskap) ser og endrer årsregnskapet.
select set_config('app.bruker_id', :'u_okonomi', false);
select test.er((select count(*)::int from faktura.aarsregnskap where org_id = :'org'), 1, 'regnskap ser årsregnskapet');
update faktura.aarsregnskap set opplysninger = opplysninger || '{"aarsverk": 1.5}' where id = :'a25';
select test.er((select opplysninger ->> 'aarsverk' from faktura.aarsregnskap where id = :'a25'), '1.5', 'regnskap endrer opplysningene');
insert into faktura.aarsregnskap (org_id, aar) values (:'org', 2024);

-- Fakturereren ser det ikke, og kan ikke lage det.
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select count(*)::int from faktura.aarsregnskap), 0, 'fakturereren ser ikke årsregnskapet');
select test.feiler(format($$insert into faktura.aarsregnskap (org_id, aar) values (%L, 2023)$$, :'org'), '42501');
update faktura.aarsregnskap set opplysninger = '{}' where org_id = :'org';
select test.feiler(format($$select faktura.aarsverk(%L, 2025)$$, :'org'), 'FA403');

-- Workeren (systemet) oppdaterer innsendingen: instansen i Altinn, låst for signering.
\c :worker
update faktura.aarsregnskap
   set status = 'til_signering', instans = '50001234/0b8e7a46-6c55-4d2e-9a3e-5b2a1f4e9c11', laast = true,
       instans_url = 'https://brg.apps.tt02.altinn.no/brg/aarsregnskap-vanlig-202406/#/instance/50001234/0b8e7a46-6c55-4d2e-9a3e-5b2a1f4e9c11'
 where id = :'a25';
select test.er((select count(*)::int from faktura.aarsregnskap where org_id = :'org'), 2, 'workeren ser årsregnskapene');

\c :api
select set_config('app.bruker_id', :'u', false);
select test.er((select status || '|' || laast || '|' || (opplysninger ->> 'aarsverk') from faktura.aarsregnskap where id = :'a25'),
               'til_signering|true|1.5', 'fakturereren endret ingenting, workeren satte instansen');

-- Antall årsverk: stillingsprosenten vektet med delen av året, bare arbeidstakerne.
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, stillingsprosent)
values (:'org', 'Hel', 'Tid', '2024-01-01', 100);
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, stillingsprosent)
values (:'org', 'Halv', 'Høst', '2025-07-01', 50);
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, ansatt_til, aktiv, stillingsprosent)
values (:'org', 'Slutta', 'Mars', '2024-01-01', '2025-03-31', false, 100);
-- Ikke med: frilanseren, rollen som ikke er ansatt, og den som er inaktiv uten sluttdato.
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, stillingsprosent, arbeidsforhold_type)
values (:'org', 'Fri', 'Lanser', '2024-01-01', 100, 'frilanserOppdragstakerHonorarPersonerMm');
insert into faktura.ansattgrupper (org_id, navn, ikke_ansatt) values (:'org', 'Styreleder', true) returning id as styret \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, stillingsprosent, gruppe_id)
values (:'org', 'Styre', 'Leder', '2024-01-01', 100, :'styret');
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, aktiv, stillingsprosent)
values (:'org', 'In', 'Aktiv', '2024-01-01', false, 100);
-- 2025: 1 + 0,5 · 184/365 + 90/365 = 1,4986 ≈ 1,5. 2024: to hele årsverk.
select test.er(faktura.aarsverk(:'org', 2025), 1.5, 'årsverk 2025');
select test.er(faktura.aarsverk(:'org', 2024), 2.0, 'årsverk 2024');
select test.er(faktura.aarsverk(:'org', 2023), 0::numeric, 'ingen årsverk før de ble ansatt');
-- Regnskap ser tallet uten å se de ansatte.
select set_config('app.bruker_id', :'u_okonomi', false);
select test.er((select count(*)::int from faktura.ansatte where org_id = :'org'), 0, 'regnskap ser ikke de ansatte');
select test.er(faktura.aarsverk(:'org', 2025), 1.5, 'men ser årsverkene');

-- Tilgangen i Altinn: Regnskap ber om den uten Personal, men ikke gjennom skattekortsidene.
select test.feiler(format($$select faktura.be_om_skattekorttilgang(%L)$$, :'org'), 'FA403');
select test.feiler(format($$select faktura.be_om_utvidet_tilgang_regnskap(%L)$$, :'org'), 'FA409');
select test.er((select status from faktura.be_om_altinntilgang_regnskap(:'org')), 'venter', 'regnskap ber om tilgang');
select test.er((select status || '|' || bedt_av from faktura.skattekort_tilgang where org_id = :'org'), 'venter|' || :'u_okonomi', 'regnskap ser tilgangen');
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select count(*)::int from faktura.skattekort_tilgang), 0, 'fakturereren ser ikke tilgangen');
select test.feiler(format($$select faktura.be_om_altinntilgang_regnskap(%L)$$, :'org'), 'FA403');
select test.feiler(format($$select faktura.be_om_utvidet_tilgang_regnskap(%L)$$, :'org'), 'FA403');

\c :worker
update faktura.skattekort_tilgang set status = 'godkjent' where org_id = :'org';

-- Godkjent: kan ikke bes om på nytt, men utvides med tilgangspakken for årsregnskapet.
\c :api
select set_config('app.bruker_id', :'u_okonomi', false);
select test.feiler(format($$select faktura.be_om_altinntilgang_regnskap(%L)$$, :'org'), 'FA409');
select faktura.be_om_utvidet_tilgang_regnskap(:'org');
select test.er((select endring_status from faktura.skattekort_tilgang where org_id = :'org'), 'venter', 'utvidelsen venter på workeren');

-- Uten organisasjonsnummer er det ingen tilgang i Altinn å be om.
select set_config('app.bruker_id', :'u', false);
select id as uten from faktura.opprett_organisasjon('Uten Nummer AS') \gset
select test.feiler(format($$select faktura.be_om_altinntilgang_regnskap(%L)$$, :'uten'), 'FA400');

-- Workeren ser at årsregnskapet er signert (levert), og at utvidelsen er godkjent. Da har
-- hjerteslaget ikke noe igjen å sjekke for organisasjonen (servertestene bruker samme database).
\c :worker
update faktura.aarsregnskap set status = 'levert', levert_at = now() where id = :'a25';
update faktura.skattekort_tilgang set endring_status = 'godkjent' where org_id = :'org';
\c :api
select set_config('app.bruker_id', :'u_okonomi', false);
select test.er((select status || '|' || (levert_at is not null) from faktura.aarsregnskap where id = :'a25'), 'levert|true', 'levert');
select test.er((select count(*)::int from faktura.aarsregnskap where status in ('sender', 'til_signering')), 0, 'ingen venter på Altinn');

\c :migrator
drop schema test cascade;
\echo '  ok'
