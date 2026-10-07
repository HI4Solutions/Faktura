-- Påminnelser (0032_paaminnelser.sql): de som kan fakturere, lager dem, alle i organisasjonen
-- ser dem, bare produkter fra organisasjonen, neste dato etter intervallet, og workeren tar
-- hver påminnelse én gang når tiden er inne (også etter at den har stått stille).

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

-- Datoene: samme dag i måneden (den 31. blir siste dag), en uke, eller ingen neste.
select test.er(faktura.neste_paaminnelse('2026-01-31', 'maaned', 31), '2026-02-28'::date, 'måned fra den 31.');
select test.er(faktura.neste_paaminnelse('2026-02-28', 'maaned', 31), '2026-03-31'::date, 'tilbake til den 31.');
select test.er(faktura.neste_paaminnelse('2026-11-01', 'kvartal', 1), '2027-02-01'::date, 'kvartal');
select test.er(faktura.neste_paaminnelse('2026-10-07', 'uke', 7), '2026-10-14'::date, 'uke');
select test.er(faktura.neste_paaminnelse('2026-10-07', 'en_gang', 7), null::date, 'bare én gang');

\c :api
select id as u from faktura.registrer_bruker('uid-paaminnelse', 'paaminnelse@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Påminnelse AS', '923609016') \gset
insert into faktura.kunder (org_id, navn) values (:'org', 'Kari Hansen') returning id as kari \gset
insert into faktura.produkter (org_id, navn, enhetspris, mva_sats) values (:'org', 'Strøm', null, 25) returning id as strom \gset

-- En annen organisasjon med et eget produkt.
select id as org2 from faktura.opprett_organisasjon('Annen AS', '974760673') \gset
insert into faktura.produkter (org_id, navn, enhetspris, mva_sats) values (:'org2', 'Annet', 100, 25) returning id as annet \gset

insert into faktura.paaminnelser (org_id, tekst, kunde_id, produkter, intervall, dag, neste_dato)
values (:'org', '  Send strømfaktura til Kari  ', :'kari', array[:'strom']::uuid[], 'maaned', 1, '2027-01-01')
returning id as p1, tekst as p1_tekst, opprettet_av as p1_av, klokkeslett as p1_kl, hvem as p1_hvem \gset
select test.er(:'p1_tekst', 'Send strømfaktura til Kari', 'teksten uten mellomrom rundt');
select test.er(:'p1_av'::uuid, :'u'::uuid, 'den som lagde den');
select test.er(:'p1_kl'::time, '08:00'::time, 'klokka 8 som standard');
select test.er(:'p1_hvem', 'meg', 'bare meg som standard');

-- Bare produkter fra organisasjonen, og en tekst.
select test.feiler(format($$insert into faktura.paaminnelser (org_id, tekst, produkter, dag, neste_dato) values (%L, 'X', array[%L]::uuid[], 1, '2027-01-01')$$,
                          :'org', :'annet'), 'FA400');
select test.feiler(format($$insert into faktura.paaminnelser (org_id, tekst, dag, neste_dato) values (%L, '   ', 1, '2027-01-01')$$, :'org'), '23514');
select test.feiler(format($$update faktura.paaminnelser set produkter = array[%L]::uuid[] where id = %L$$, :'annet', :'p1'), 'FA400');

-- Et medlem som bare kan lese, ser påminnelsen, men kan ikke lage eller endre.
select id as u2 from faktura.registrer_bruker('uid-paaminnelse-les', 'les-paaminnelse@test.no') \gset
select faktura.inviter_medlem(:'org', 'les-paaminnelse@test.no', 'les') as t \gset
select set_config('app.bruker_id', :'u2', false);
select faktura.aksepter_invitasjon(:'t');
select test.er((select count(*) from faktura.paaminnelser where org_id = :'org'), 1::bigint, 'leseren ser påminnelsen');
select test.feiler(format($$insert into faktura.paaminnelser (org_id, tekst, dag, neste_dato) values (%L, 'X', 1, '2027-01-01')$$, :'org'), '42501');
update faktura.paaminnelser set aktiv = false where id = :'p1';
select test.er((select aktiv from faktura.paaminnelser where id = :'p1'), true, 'leseren kan ikke stoppe den');
delete from faktura.paaminnelser where id = :'p1';
select test.er((select count(*) from faktura.paaminnelser where id = :'p1'), 1::bigint, 'leseren kan ikke slette den');

-- Andre ser ingenting, og appen kan ikke ta påminnelser selv.
select id as u3 from faktura.registrer_bruker('uid-paaminnelse-annen', 'annen-paaminnelse@test.no') \gset
select set_config('app.bruker_id', :'u3', false);
select test.er((select count(*) from faktura.paaminnelser), 0::bigint, 'andre ser ingenting');
select test.feiler('select * from faktura.ta_paaminnelser()', '42501');

-- Påminnelser som skal sendes: i dag tidligere, for tre måneder siden (workeren har stått
-- stille), én gang, senere i dag og stoppet.
select set_config('app.bruker_id', :'u', false);
insert into faktura.paaminnelser (org_id, tekst, intervall, dag, neste_dato, klokkeslett)
values (:'org', 'I dag', 'maaned', extract(day from faktura.i_dag())::int, faktura.i_dag(), '00:00') returning id as idag \gset
insert into faktura.paaminnelser (org_id, tekst, intervall, dag, neste_dato, klokkeslett)
values (:'org', 'Gammel', 'maaned', extract(day from faktura.i_dag() - 92)::int, faktura.i_dag() - 92, '09:00') returning id as gammel \gset
insert into faktura.paaminnelser (org_id, tekst, intervall, dag, neste_dato, klokkeslett, hvem, epost)
values (:'org', 'Én gang', 'en_gang', 1, faktura.i_dag() - 1, '12:00', 'alle', true) returning id as engang \gset
insert into faktura.paaminnelser (org_id, tekst, intervall, dag, neste_dato, klokkeslett)
values (:'org', 'Senere', 'uke', 1, faktura.i_dag() + 1, '00:00') returning id as senere \gset
insert into faktura.paaminnelser (org_id, tekst, intervall, dag, neste_dato, klokkeslett, aktiv)
values (:'org', 'Stoppet', 'maaned', 1, faktura.i_dag() - 1, '00:00', false) returning id as stoppet \gset

\c :worker
create temp table tatt as select * from faktura.ta_paaminnelser();
select test.er((select string_agg(tekst, ',' order by neste_dato, tekst) from tatt), 'Gammel,Én gang,I dag', 'de som skal sendes nå');
select test.er((select neste_dato from tatt where id = :'gammel'), (faktura.i_dag() - 92), 'raden har datoen den gjaldt');
select test.er((select count(*) from faktura.ta_paaminnelser()), 0::bigint, 'bare én gang');

select test.er((select neste_dato > faktura.i_dag() and neste_dato <= faktura.i_dag() + 31 from faktura.paaminnelser where id = :'gammel'), true,
               'neste dato etter i dag, ikke én for hver periode');
select test.er((select neste_dato from faktura.paaminnelser where id = :'idag'),
               faktura.neste_paaminnelse(faktura.i_dag(), 'maaned', extract(day from faktura.i_dag())::int), 'i dag: neste måned');
select test.er((select aktiv from faktura.paaminnelser where id = :'engang'), false, 'én gang: stoppet etterpå');
select test.er((select sist_varslet is not null from faktura.paaminnelser where id = :'idag'), true, 'sist varslet');
select test.er((select sist_varslet from faktura.paaminnelser where id = :'senere'), null::timestamptz, 'senere: ikke ennå');
select test.er((select sist_varslet from faktura.paaminnelser where id = :'stoppet'), null::timestamptz, 'stoppet: ikke sendt');

-- Kunden slettes: påminnelsene om kunden forsvinner med den.
\c :api
select set_config('app.bruker_id', :'u', false);
delete from faktura.kunder where id = :'kari';
select test.er((select count(*) from faktura.paaminnelser where id = :'p1'), 0::bigint, 'påminnelsen forsvinner med kunden');

\c :migrator
drop schema test cascade;
\echo '  ok'
