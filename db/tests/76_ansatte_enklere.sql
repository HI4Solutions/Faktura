-- Enklere å legge inn ansatte (0113_ansatte_enklere.sql): den ansatte sender inn sine egne
-- opplysninger (bare de tillatte feltene, aldri for andre), ser bare sin egen innsending, og kan
-- ikke godkjenne; lederen godkjenner (skrives på den ansatte, også fødselsnummeret) eller avviser.
-- Hentingen fra a-ordningen: bare workeren skriver, API-et leser aldri fødselsnumrene, og bare
-- Personal bestiller og flytter fødselsnummeret til en ansatt.

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
select id as u from faktura.registrer_bruker('uid-enkel-eier', 'eier-enkel@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Enkel AS', '915000355') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra) values (:'org', 'Ola', 'Enkel', 'ola-enkel@test.no', '2026-01-01') returning id as ola \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, ansatt_fra) values (:'org', 'Kari', 'Enkel', 'kari-enkel@test.no', '2026-01-01') returning id as kari \gset
-- Nye felt: pårørende og arbeidsforholdID-en (uten mellomrom, høyst 50 tegn).
update faktura.ansatte set parorende_navn = 'Mor Enkel', arbeidsforhold_id = 'AF-1' where id = :'kari';
select test.feiler(format($$update faktura.ansatte set arbeidsforhold_id = 'A B' where id = %L$$, :'kari'), '23514');
select test.feiler(format($$update faktura.ansatte set arbeidsforhold_id = repeat('x', 51) where id = %L$$, :'kari'), '23514');
select faktura.inviter_ansatt(:'org', :'ola') as t_ola \gset
select faktura.inviter_ansatt(:'org', :'kari') as t_kari \gset
select faktura.inviter_medlem(:'org', 'regn-enkel@test.no', 'regnskap') as t_regn \gset
select faktura.inviter_medlem(:'org', 'fakt-enkel@test.no', 'fakturerer') as t_fakt \gset
select id as u_ola from faktura.registrer_bruker('uid-enkel-ola', 'ola-enkel@test.no') \gset
select id as u_kari from faktura.registrer_bruker('uid-enkel-kari', 'kari-enkel@test.no') \gset
select id as u_regn from faktura.registrer_bruker('uid-enkel-regn', 'regn-enkel@test.no') \gset
select id as u_fakt from faktura.registrer_bruker('uid-enkel-fakt', 'fakt-enkel@test.no') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');
select set_config('app.bruker_id', :'u_kari', false);
select faktura.aksepter_invitasjon(:'t_kari');
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'t_regn');
select set_config('app.bruker_id', :'u_fakt', false);
select faktura.aksepter_invitasjon(:'t_fakt');

-- Den ansatte sender inn: bare de tillatte feltene (lønnen og andre felt tas bort), for seg selv.
select set_config('app.bruker_id', :'u_ola', false);
select test.er(faktura.lever_utfylling(:'org', '{"kontonr": "86011117947", "adresse": "Gata 1", "maanedslonn": "99999", "fornavn": 5}', '\x0102'::bytea), :'ola'::uuid, 'innsendt for seg selv');
select test.er((select felt from faktura.ansatt_utfylling where ansatt_id = :'ola'), '{"kontonr": "86011117947", "adresse": "Gata 1"}'::jsonb, 'bare de tillatte tekstfeltene');
select test.er((select har_fnr from faktura.ansatt_utfylling where ansatt_id = :'ola'), true, 'med fødselsnummer');
select test.feiler('select fnr_kryptert from faktura.ansatt_utfylling', '42501');
select test.feiler(format($$insert into faktura.ansatt_utfylling (org_id, ansatt_id) values (%L, %L)$$, :'org', :'kari'), '42501');
select test.feiler(format($$update faktura.ansatt_utfylling set status = 'avvist' where ansatt_id = %L$$, :'ola'), '42501');
select test.feiler(format($$select faktura.lever_utfylling(%L, '{}', null)$$, :'org'), 'FA400');
select test.feiler(format($$select faktura.godkjenn_utfylling(%L, %L)$$, :'org', :'ola'), 'FA403');
select test.feiler(format($$select faktura.avvis_utfylling(%L, %L, 'nei')$$, :'org', :'ola'), 'FA403');
-- Ny innsending uten fødselsnummer: det som er sendt, beholdes.
select faktura.lever_utfylling(:'org', '{"telefon": "123"}', null);
select test.er((select felt from faktura.ansatt_utfylling where ansatt_id = :'ola'), '{"telefon": "123"}'::jsonb, 'den nye erstatter den forrige');
select test.er((select har_fnr from faktura.ansatt_utfylling where ansatt_id = :'ola'), true, 'fødselsnummeret beholdes');
select faktura.lever_utfylling(:'org', '{"kontonr": "86011117947", "parorende_navn": "Far Enkel"}', null);
-- Kari ser ikke Olas innsending.
select set_config('app.bruker_id', :'u_kari', false);
select test.er((select count(*)::int from faktura.ansatt_utfylling), 0, 'en annen ansatt ser den ikke');
-- Regnskap ser den (som de ansatte); fakturereren ikke, og ikke andre organisasjoner.
select set_config('app.bruker_id', :'u_regn', false);
select test.er((select count(*)::int from faktura.ansatt_utfylling), 1, 'regnskap ser den');
select test.feiler(format($$select faktura.godkjenn_utfylling(%L, %L)$$, :'org', :'ola'), 'FA403');
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select count(*)::int from faktura.ansatt_utfylling), 0, 'fakturereren ser den ikke');
select test.feiler(format($$select faktura.lever_utfylling(%L, '{"telefon": "1"}', null)$$, :'org'), 'FA403');

-- Lederen avviser (fødselsnummeret fjernes), den ansatte sender på nytt, og lederen godkjenner.
select set_config('app.bruker_id', :'u', false);
select faktura.avvis_utfylling(:'org', :'ola', ' Feil konto ');
select test.er((select status || ':' || avvist_grunn || ':' || har_fnr from faktura.ansatt_utfylling where ansatt_id = :'ola'), 'avvist:Feil konto:false', 'avvist med grunn');
select test.feiler(format($$select faktura.avvis_utfylling(%L, %L, 'igjen')$$, :'org', :'ola'), 'FA404');
select test.feiler(format($$select faktura.godkjenn_utfylling(%L, %L)$$, :'org', :'ola'), 'FA404');
select set_config('app.bruker_id', :'u_ola', false);
select faktura.lever_utfylling(:'org', '{"kontonr": "86011117947", "parorende_navn": "Far Enkel", "fodselsdato": "1985-03-15"}', '\x0304'::bytea);
select set_config('app.bruker_id', :'u', false);
update faktura.ansatte set utfylling_bedt = now(), telefon = '999' where id = :'ola';
select test.er(faktura.godkjenn_utfylling(:'org', :'ola'), true, 'fødselsnummeret var med');
select test.er((select kontonr || ':' || parorende_navn || ':' || fodselsdato::text || ':' || telefon || ':' || har_fnr || ':' || (utfylling_bedt is null)
                  from faktura.ansatte where id = :'ola'), '86011117947:Far Enkel:1985-03-15:999:true:true', 'skrevet på den ansatte; tomme felt endrer ingenting');
select test.er((select count(*)::int from faktura.ansatt_utfylling), 0, 'innsendingen er fjernet');
-- Loggen sier at fødselsnummeret er endret, uten nummeret.
select test.er((select string_agg(endring ->> 'fodselsnummer', ',') from faktura.revisjonslogg where tabell = 'ansatte' and rad_id = :'ola' and handling = 'UPDATE' and endring ? 'fodselsnummer'),
               'endret', 'loggen sier at fødselsnummeret er endret');
select test.er((select count(*)::int from faktura.revisjonslogg where tabell = 'ansatte' and rad_id = :'ola' and endring::text like '%fnr_kryptert%'), 0, 'ikke nummeret');

\c :worker
select test.er((select convert_from(fnr_kryptert, 'UTF8') from faktura.ansatte where id = :'ola'), E'\x03\x04', 'fødselsnummeret fra innsendingen');

-- Hentingen fra a-ordningen: bare workeren skriver, og API-et leser ikke fødselsnumrene.
\c :api
select set_config('app.bruker_id', :'u', false);
select test.feiler(format($$insert into faktura.aordning_import (org_id, status) values (%L, 'klar')$$, :'org'), '42501');
select test.er(faktura.bestill_aordning(:'org'), true, 'bestilt');
select test.er(faktura.bestill_aordning(:'org'), false, 'ikke to ganger på to minutter');
select test.feiler('select fnr from faktura.aordning_import', '42501');
select test.feiler(format($$update faktura.aordning_import set status = 'klar' where org_id = %L$$, :'org'), '42501');
select set_config('app.bruker_id', :'u_regn', false);
select test.feiler(format($$select faktura.bestill_aordning(%L)$$, :'org'), 'FA403');
select test.er((select count(*)::int from faktura.aordning_import), 0, 'regnskap ser ikke hentingen');
select set_config('app.bruker_id', :'u_ola', false);
select test.feiler(format($$select faktura.bestill_aordning(%L)$$, :'org'), 'FA403');
select test.er((select count(*)::int from faktura.aordning_import), 0, 'den ansatte ser ikke hentingen');

\c :worker
update faktura.aordning_import
   set status = 'klar', personer = '[{"nr": 1, "fornavn": "Ny", "ansatt_id": null}, {"nr": 2, "fornavn": "Kari", "ansatt_id": null}]',
       fnr = array['\x0a'::bytea, '\x0b'::bytea]
 where org_id = :'org';

\c :api
select set_config('app.bruker_id', :'u', false);
select test.er((select jsonb_array_length(personer) from faktura.aordning_import where org_id = :'org'), 2, 'eieren ser personene');
select test.feiler(format($$select faktura.aordning_sett_fnr(%L, %L, 3)$$, :'org', :'kari'), 'FA404');
select test.feiler(format($$select faktura.aordning_sett_fnr(%L, %L, 0)$$, :'org', :'kari'), 'FA404');
select test.feiler(format($$select faktura.aordning_sett_fnr(%L, gen_random_uuid(), 2)$$, :'org'), 'FA404');
select faktura.aordning_sett_fnr(:'org', :'kari', 2);
select test.er((select personer -> 1 ->> 'ansatt_id' from faktura.aordning_import where org_id = :'org'), :'kari', 'hentingen husker hvem personen er');
select test.er((select har_fnr from faktura.ansatte where id = :'kari'), true, 'Kari har fødselsnummeret');
select set_config('app.bruker_id', :'u_regn', false);
select test.feiler(format($$select faktura.aordning_sett_fnr(%L, %L, 1)$$, :'org', :'kari'), 'FA403');

\c :worker
select test.er((select convert_from(fnr_kryptert, 'UTF8') from faktura.ansatte where id = :'kari'), E'\x0b', 'fødselsnummeret fra hentingen');

\c :migrator
drop schema test cascade;
\echo '  ok'
