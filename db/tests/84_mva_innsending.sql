-- Mva-meldingen sendt fra appen (0125_mva_innsending.sql): bare dem som har Regnskap ser og starter
-- innsendinger; API-et ser ikke innloggingen (nonce og PKCE-verifikatoren) eller Altinn-tokenet og
-- endrer bare statusen og innloggingen, mens workeren (systemet) kan alt; bare én sending om gangen
-- for en termin; og terminen må passe til terminlengden.

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
select id as u from faktura.registrer_bruker('uid-mvainn', 'mvainn@test.no', 'Mona Mva') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Mva Innsending AS', '315000254') \gset
-- Økonomiansvarlig med bare Regnskap, og en fakturerer.
select id as okonomi from faktura.lagre_tilgangsrolle(:'org', null, 'Økonomiansvarlig', null, array['regnskap']) \gset
select faktura.inviter_medlem(:'org', 'okonomi-mvainn@test.no', 'tilpasset', :'okonomi') as t_okonomi \gset
select faktura.inviter_medlem(:'org', 'fakt-mvainn@test.no', 'fakturerer') as t_fakt \gset
select id as u_okonomi from faktura.registrer_bruker('uid-mvainn-okonomi', 'okonomi-mvainn@test.no') \gset
select id as u_fakt from faktura.registrer_bruker('uid-mvainn-fakt', 'fakt-mvainn@test.no') \gset
select set_config('app.bruker_id', :'u_okonomi', false);
select faktura.aksepter_invitasjon(:'t_okonomi');
select set_config('app.bruker_id', :'u_fakt', false);
select faktura.aksepter_invitasjon(:'t_fakt');

-- Økonomiansvarlig starter en innsending: meldingen og innloggingen lagres.
select set_config('app.bruker_id', :'u_okonomi', false);
insert into faktura.mva_innsendinger (org_id, aar, type, termin, state, nonce, verifikator, tilbake_url, utloper, melding, sum, linjer, startet_av)
values (:'org', 2026, 'tomaaneder', 4, :'org' || '.state-1', 'nonce-1', 'verifikator-1', 'https://app.test/mva/idporten', now() + interval '15 minutes',
        '<mvaMeldingDto/>', 750, '[{"kode": "3"}]', faktura.bruker_id())
returning id as i1 \gset
select test.er((select status || '|' || sum || '|' || startet_av from faktura.mva_innsendinger where id = :'i1'), 'innlogging|750|' || :'u_okonomi', 'ny innsending');
-- Status, instansen og tokenet settes ikke av API-et, og innloggingen kan ikke leses tilbake.
select test.feiler(format($$insert into faktura.mva_innsendinger (org_id, aar, type, termin, melding, sum, status) values (%L, 2026, 'tomaaneder', 3, '<x/>', 0, 'sendt')$$, :'org'), '42501');
select test.feiler(format($$select nonce from faktura.mva_innsendinger where id = %L$$, :'i1'), '42501');
select test.feiler(format($$select verifikator from faktura.mva_innsendinger where id = %L$$, :'i1'), '42501');
select test.feiler(format($$select altinn_token from faktura.mva_innsendinger where id = %L$$, :'i1'), '42501');
select test.feiler(format($$update faktura.mva_innsendinger set instans = '1/2' where id = %L$$, :'i1'), '42501');
select test.feiler(format($$update faktura.mva_innsendinger set altinn_token = 'x' where id = %L$$, :'i1'), '42501');
select test.feiler(format($$update faktura.mva_innsendinger set org_id = gen_random_uuid() where id = %L$$, :'i1'), '42501');
select test.feiler(format($$update faktura.mva_innsendinger set status = 'ukjent' where id = %L$$, :'i1'), '23514');
-- Terminen passer til terminlengden.
select test.feiler(format($$insert into faktura.mva_innsendinger (org_id, aar, type, termin, melding, sum) values (%L, 2026, 'tomaaneder', 7, '<x/>', 0)$$, :'org'), '23514');
select test.feiler(format($$insert into faktura.mva_innsendinger (org_id, aar, type, termin, melding, sum) values (%L, 2026, 'aar', 2, '<x/>', 0)$$, :'org'), '23514');

-- Innloggingen er fullført: API-et setter «sender» og tømmer state.
update faktura.mva_innsendinger set status = 'sender', state = null, oppdatert = now() where id = :'i1';
select test.er((select status || '|' || coalesce(state, '-') from faktura.mva_innsendinger where id = :'i1'), 'sender|-', 'sendes');
-- Bare én sending om gangen for terminen.
insert into faktura.mva_innsendinger (org_id, aar, type, termin, state, melding, sum)
values (:'org', 2026, 'tomaaneder', 4, :'org' || '.state-2', '<mvaMeldingDto/>', 750) returning id as i2 \gset
select test.feiler(format($$update faktura.mva_innsendinger set status = 'sender' where id = %L$$, :'i2'), '23505');
update faktura.mva_innsendinger set status = 'avbrutt', state = null where id = :'i2';

-- Fakturereren ser ingenting og kan ikke starte en innsending.
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select count(*)::int from faktura.mva_innsendinger), 0, 'fakturereren ser ikke innsendingene');
select test.feiler(format($$insert into faktura.mva_innsendinger (org_id, aar, type, termin, melding, sum) values (%L, 2026, 'tomaaneder', 3, '<x/>', 0)$$, :'org'), '42501');
update faktura.mva_innsendinger set feil = 'x' where org_id = :'org';

-- En annen organisasjons eier ser dem ikke.
select id as annen from faktura.registrer_bruker('uid-mvainn-annen', 'annen-mvainn@test.no') \gset
select set_config('app.bruker_id', :'annen', false);
select test.er((select count(*)::int from faktura.mva_innsendinger where org_id = :'org'), 0, 'en annen organisasjon ser ikke innsendingene');

-- Workeren (systemet) leser innloggingen, sender og lagrer Altinn-tokenet kryptert.
\c :worker
select test.er((select nonce || '|' || verifikator from faktura.mva_innsendinger where id = :'i1'), 'nonce-1|verifikator-1', 'workeren leser innloggingen');
update faktura.mva_innsendinger
   set status = 'sendt', steg = 'sendt', instans = '50012345/7d1f3c2a-5b6e-4f80-9a1b-2c3d4e5f6a7b', nonce = null, verifikator = null,
       altinn_token = 'kryptert', token_utloper = now() + interval '30 minutes', sendt_at = now()
 where id = :'i1';
insert into faktura.mva_terminer (org_id, aar, type, termin, levert, levert_belop, levert_av)
values (:'org', 2026, 'tomaaneder', 4, '2026-10-18', 750, :'u_okonomi');

\c :api
select set_config('app.bruker_id', :'u', false);
select test.er((select status || '|' || instans || '|' || coalesce(feil, '-') from faktura.mva_innsendinger where id = :'i1'),
               'sendt|50012345/7d1f3c2a-5b6e-4f80-9a1b-2c3d4e5f6a7b|-', 'eieren ser at den er sendt, fakturereren endret ingenting');
select test.er((select levert_belop::int from faktura.mva_terminer where org_id = :'org' and aar = 2026 and termin = 4), 750, 'terminen er levert');

-- Workeren er ferdig: tokenet slettes, så servertestene (samme database) ikke finner noe å hente.
\c :worker
update faktura.mva_innsendinger set status = 'mottatt', altinn_token = null, token_utloper = null, mottatt_at = now() where id = :'i1';

\c :migrator
drop schema test cascade;
\echo '  ok'
