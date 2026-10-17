-- Uten organisasjonsnummer (0119_uten_orgnr.sql): en privatperson (og et foretak som ikke har
-- lagt inn nummeret) har bare fakturaene – funksjonene i Faktura uten EHF. Personal, Lønn og
-- Regnskap krever organisasjonsnummer, og virker straks det er lagt inn (legg_inn_orgnr, eller i
-- innstillingene for et foretak som ikke er verifisert). En privatperson blir da foretak.

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
select id as u from faktura.registrer_bruker('uid-uten-orgnr', 'uten-orgnr@test.no', 'Ola Privat') \gset
select set_config('app.bruker_id', :'u', false);

-- En privatperson får fakturaene, men ikke EHF, Personal, Lønn eller Regnskap.
select id as priv from faktura.opprett_organisasjon('Ola Privat', null, 'privatperson') \gset
select test.er((select type || '|' || coalesce(orgnr, '-') from faktura.organisasjoner where id = :'priv'), 'privatperson|-', 'privatperson uten org.nr.');
select test.er((select array_agg(kode order by kode) from faktura.funksjoner f where faktura.har_funksjon(:'priv', f.kode)),
               array['ai', 'bank', 'faktura', 'flere', 'gjentakende', 'google_disk', 'import', 'paaminnelser', 'rapporter'],
               'fakturaene, uten EHF');
select test.er(faktura.har_funksjon(:'priv', 'ehf'), false, 'ikke EHF (Peppol krever org.nr.)');
select test.er(faktura.har_funksjon(:'priv', 'ansatte'), false, 'ikke ansatte');
select test.er(faktura.har_funksjon(:'priv', 'lonn'), false, 'ikke lønn');
select test.er(faktura.har_funksjon(:'priv', 'regnskap'), false, 'ikke regnskap');
select test.er(faktura.org_modulliste(:'priv'), array['faktura'], 'bare modulen Faktura');
select test.er((select moduler from faktura.mine_organisasjoner where id = :'priv'), array['faktura'], 'appen får bare Faktura');
select test.er((select personal from faktura.mine_organisasjoner where id = :'priv'), false, 'ikke personalmenyen');
-- Det som er slått på, står fortsatt (det virker når org.nr. er lagt inn).
select test.er((select count(*) from faktura.org_funksjoner where org_id = :'priv' and aktiv), (select count(*) from faktura.funksjoner where standard), 'standarden står');

-- Fakturaene virker: utstedt uten org.nr.
update faktura.organisasjoner set kontonr = '86011117947' where id = :'priv';
insert into faktura.kunder (org_id, navn) values (:'priv', 'Nabo') returning id as k \gset
insert into faktura.fakturaer (org_id, kunde_id) values (:'priv', :'k') returning id as f1 \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, enhetspris) values (:'priv', :'f1', 'Hagearbeid', 500);
select faktura.utsted(:'f1');
select test.er((select status <> 'utkast' and selger ->> 'orgnr' is null from faktura.fakturaer where id = :'f1'), true, 'utstedt uten org.nr.');

-- Typen endres ikke av appen, og org.nr. kan ikke settes rett på en privatperson.
select test.feiler(format($$update faktura.organisasjoner set type = 'foretak' where id = %L$$, :'priv'), '42501');
update faktura.organisasjoner set orgnr = '923609016' where id = :'priv';
select test.er((select orgnr from faktura.organisasjoner where id = :'priv'), null::text, 'org.nr. går bare gjennom legg_inn_orgnr');

-- Bare eier og administrator legger inn org.nr., og det må være gyldig.
select id as u2 from faktura.registrer_bruker('uid-uten-orgnr-2', 'annen-uten-orgnr@test.no', 'Anne Annen') \gset
select set_config('app.bruker_id', :'u2', false);
select test.feiler(format($$select faktura.legg_inn_orgnr(%L, '923609016')$$, :'priv'), 'FA403');
select set_config('app.bruker_id', :'u', false);
select test.feiler(format($$select faktura.legg_inn_orgnr(%L, '923609017')$$, :'priv'), 'FA400');
select test.feiler(format($$select faktura.legg_inn_orgnr(%L, null)$$, :'priv'), 'FA400');

-- Privatpersonen legger inn org.nr. og blir foretak: alt det andre virker nå.
select test.er((select type || '|' || orgnr || '|' || verifisering from faktura.legg_inn_orgnr(:'priv', '923609016')), 'foretak|923609016|ny', 'blir foretak, ikke verifisert');
select test.er(faktura.har_funksjon(:'priv', 'ehf'), true, 'EHF med org.nr.');
select test.er(faktura.har_funksjon(:'priv', 'ansatte'), true, 'ansatte med org.nr.');
select test.er(faktura.har_funksjon(:'priv', 'lonn'), true, 'lønn med org.nr.');
select test.er(faktura.har_funksjon(:'priv', 'regnskap'), true, 'regnskap med org.nr.');
select test.er(faktura.org_modulliste(:'priv'), array['faktura', 'personal', 'lonn', 'regnskap'], 'alle modulene');
-- Én gang: et foretak med org.nr. endrer det i innstillingene (til det er verifisert).
select test.feiler(format($$select faktura.legg_inn_orgnr(%L, '974760673')$$, :'priv'), 'FA409');

-- Et foretak uten org.nr. har også bare fakturaene, til nummeret er lagt inn i innstillingene.
select id as as1 from faktura.opprett_organisasjon('Uten Nummer AS') \gset
select test.er(faktura.org_modulliste(:'as1'), array['faktura'], 'foretak uten org.nr.: bare Faktura');
select test.er(faktura.har_funksjon(:'as1', 'vaktplan'), false, 'ikke vaktplan uten org.nr.');
update faktura.organisasjoner set orgnr = '974760673' where id = :'as1';
select test.er(faktura.org_modulliste(:'as1'), array['faktura', 'personal', 'lonn', 'regnskap'], 'alt når org.nr. er lagt inn');
-- … og legg_inn_orgnr virker også for et foretak uten org.nr.
select id as as2 from faktura.opprett_organisasjon('Senere AS') \gset
select test.er((select type || '|' || orgnr from faktura.legg_inn_orgnr(:'as2', '915000177')), 'foretak|915000177', 'foretaket får org.nr.');
select test.er(faktura.har_modul(:'as2', 'lonn'), true, 'og lønn');

-- Plattformadministratoren ser hvilke funksjoner som virker uten org.nr.
select set_config('app.betrodd', 'on', false);
select test.er((select jsonb_object_agg(f ->> 'kode', f -> 'uten_orgnr') from jsonb_array_elements(faktura.admin_funksjoner() -> 'funksjoner') f
                 where f ->> 'kode' in ('faktura', 'ehf', 'lonn', 'regnskap')),
               '{"faktura": true, "ehf": false, "lonn": false, "regnskap": false}'::jsonb, 'uten_orgnr i funksjonsoversikten');
-- Uten org.nr. kan ingen verifiseres.
select id as priv2 from faktura.opprett_organisasjon('Kari Privat', null, 'privatperson') \gset
select test.feiler(format($$select faktura.sett_verifisering(%L, 'verifisert', 'manuell')$$, :'priv2'), 'FA400');
select set_config('app.betrodd', '', false);

-- Typen kan ikke endres på andre måter, heller ikke av eieren av databasen (utenom
-- privatperson til foretak med org.nr.).
\c :migrator
select test.feiler(format($$update faktura.organisasjoner set type = 'regnskapsbyraa' where id = %L$$, :'priv'), 'FA400');
select test.feiler(format($$update faktura.organisasjoner set type = 'privatperson' where id = %L$$, :'priv'), 'FA400');
select test.feiler(format($$update faktura.organisasjoner set type = 'foretak' where id = %L$$, :'priv2'), 'FA400');
drop schema test cascade;
\echo '  ok'
