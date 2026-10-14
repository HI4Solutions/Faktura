-- Bekreftelsen av e-postadressen (0105_epostbekreftelse.sql): registrer_bruker husker om adressen
-- er bekreftet (et eldre token gjør den ikke ubekreftet igjen), brukeren ber om lenker innenfor
-- grensene, bare plattformadministratoren sender for andre og bekrefter for dem, bare workeren
-- henter det som skal sendes, og statusen fra Resend følger lenken.

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
-- Brukerraden uten RLS (testen sjekker hva funksjonene lagrer, ikke hvem som ser det).
create function test.bruker(_id uuid) returns faktura.brukere language sql stable security definer set search_path = '' as $$
  select * from faktura.brukere where id = _id
$$;
create function test.lenke(_id uuid) returns text language sql stable security definer set search_path = '' as $$
  select status || '/' || coalesce(detaljer, '-') from faktura.epostbekreftelser where id = _id
$$;
grant execute on all functions in schema test to public;

\c :api
-- Ny konto rett fra registreringen: ikke bekreftet. Uten opplysningen (null) står den som før.
select id as u from faktura.registrer_bruker('uid-bekreft-ny', 'Ny-Bekreft@Test.no', 'Nina Ny', false) \gset
select test.er((test.bruker(:'u')).epost_bekreftet, false, 'ny konto er ikke bekreftet');
select faktura.registrer_bruker('uid-bekreft-ny', 'ny-bekreft@test.no');
select test.er((test.bruker(:'u')).epost_bekreftet, false, 'uten opplysningen står den som før');
-- En konto fra før (null) blir bekreftet eller ubekreftet etter tokenet.
select id as gammel from faktura.registrer_bruker('uid-bekreft-gammel', 'gammel-bekreft@test.no') \gset
select test.er((test.bruker(:'gammel')).epost_bekreftet, null::boolean, 'ikke sett ennå');

-- Brukeren ber om en lenke: til adressen sin, høyst én i minuttet.
select set_config('app.bruker_id', :'u', false);
select id as l1, til from faktura.be_om_epostbekreftelse() \gset
select test.er(:'til', 'ny-bekreft@test.no', 'til adressen');
select test.feiler($$select faktura.be_om_epostbekreftelse()$$, 'FA429');
-- Tabellen leses bare gjennom funksjonene.
select test.feiler($$select count(*) from faktura.epostbekreftelser$$, '42501');
-- Bare betrodde kall (API-et) og workeren merker hvordan det gikk, og bare workeren henter det som
-- skal sendes.
select test.feiler(format($$select faktura.epostbekreftelse_sendt(%L, 'x')$$, :'l1'), 'FA403');
select test.feiler(format($$select * from faktura.epostbekreftelse_til_sending(%L)$$, :'l1'), '42501');

-- Lenken som ikke kunne lages, teller ikke mot minuttet.
select set_config('app.betrodd', 'on', false);
select faktura.epostbekreftelse_sendt(:'l1', null, 'Identity Platform svarte ikke');
select test.er(test.lenke(:'l1'), 'feilet/Identity Platform svarte ikke', 'feilet, med feilen');
select set_config('app.betrodd', '', false);
select id as l2 from faktura.be_om_epostbekreftelse() \gset

-- Plattformadministratoren: ser kontoen, med den siste lenken, og sender en ny.
select test.feiler(format($$select faktura.admin_send_epostbekreftelse(%L)$$, :'u'), 'FA403');
select test.feiler(format($$select faktura.admin_bekreft_epost(%L)$$, :'u'), 'FA403');
select id as admin from faktura.registrer_bruker('uid-bekreft-admin', 'admin-bekreft@test.no', null, true) \gset
select set_config('app.bruker_id', :'admin', false);
select set_config('app.betrodd', 'on', false);
select test.er((select epost_bekreftet from faktura.admin_kontoer_venter() where id = :'u'), false, 'venter uten bekreftet adresse');
select test.er((select bekreftelse ->> 'status' from faktura.admin_kontoer_venter() where id = :'u'), 'venter', 'den siste lenken venter');
select test.er((select (bekreftelse ->> 'antall')::int from faktura.admin_kontoer_venter() where id = :'u'), 2, 'to lenker i alt');
select id as l3 from faktura.admin_send_epostbekreftelse(:'u') \gset
select test.er((select bekreftelse ->> 'av_admin' from faktura.admin_kontoer_venter() where id = :'u'), 'true', 'sendt av administratoren');
select test.feiler($$select faktura.admin_send_epostbekreftelse(gen_random_uuid())$$, 'FA404');
select test.er((select epost_bekreftet from faktura.admin_brukere() where id = :'gammel'), null::boolean, 'brukerlista viser at den ikke er sett');
select set_config('app.betrodd', '', false);

-- Workeren henter det som skal sendes og merker den sendt. Et nytt forsøk som feiler, gjør den
-- ikke feilet.
\c :worker
select test.er((select til || '/' || navn || '/' || status from faktura.epostbekreftelse_til_sending(:'l3')), 'ny-bekreft@test.no/Nina Ny/venter', 'det som skal sendes');
select faktura.epostbekreftelse_sendt(:'l3', 're_bekreft_1');
select faktura.epostbekreftelse_sendt(:'l3', null, 'Tidsavbrudd');
select test.er(test.lenke(:'l3'), 'sendt/-', 'sendt står');

-- Statusen fra Resend (webhooken går gjennom API-et): levert, og forsinket overstyrer ikke det.
\c :api
select test.er(faktura.oppdater_epoststatus('re_bekreft_1', 'levert'), true, 'hendelsen gjelder lenken');
select test.er(faktura.oppdater_epoststatus('re_bekreft_1', 'forsinket'), true, 'forsinket etter levert');
select test.er(faktura.oppdater_epoststatus('finnes-ikke', 'levert'), false, 'ukjent e-post');
select set_config('app.bruker_id', :'admin', false);
select set_config('app.betrodd', 'on', false);
select test.er((select bekreftelse ->> 'status' from faktura.admin_kontoer_venter() where id = :'u'), 'levert', 'levert hos mottakeren');
select set_config('app.betrodd', '', false);
select faktura.oppdater_epoststatus('re_bekreft_1', 'sprett', 'Mailbox does not exist');
select set_config('app.betrodd', 'on', false);
select test.er((select bekreftelse ->> 'status' || ': ' || (bekreftelse ->> 'detaljer') from faktura.admin_kontoer_venter() where id = :'u'),
               'sprett: Mailbox does not exist', 'kom ikke fram, med grunnen');

-- Administratoren bekrefter adressen for brukeren (og husker hvem og når); en gang til endrer ikke det.
select test.er((faktura.admin_bekreft_epost(:'u')).epost_bekreftet, true, 'bekreftet av administratoren');
select test.er((test.bruker(:'u')).epost_bekreftet_av, :'admin'::uuid, 'med hvem');
select test.feiler(format($$update faktura.brukere set epost_bekreftet = true where id = %L$$, :'u'), '42501');
\c :migrator
update faktura.brukere set epost_bekreftet_at = now() - interval '1 hour' where id = :'u';
\c :api
select set_config('app.bruker_id', :'admin', false);
select set_config('app.betrodd', 'on', false);
select faktura.admin_bekreft_epost(:'u');
select test.er((test.bruker(:'u')).epost_bekreftet_at < now() - interval '59 minutes', true, 'andre gang endrer ikke tidspunktet');
select test.feiler(format($$select faktura.admin_send_epostbekreftelse(%L)$$, :'u'), 'FA409');
select set_config('app.betrodd', '', false);

-- Et eldre token (fra før bekreftelsen) gjør den ikke ubekreftet igjen; en ny adresse er ubekreftet.
select faktura.registrer_bruker('uid-bekreft-ny', 'ny-bekreft@test.no', null, false);
select test.er((test.bruker(:'u')).epost_bekreftet, true, 'eldre token');
select set_config('app.bruker_id', :'u', false);
select test.feiler($$select faktura.be_om_epostbekreftelse()$$, 'FA409');
select faktura.registrer_bruker('uid-bekreft-ny', 'ny-adresse-bekreft@test.no', null, false);
select test.er((test.bruker(:'u')).epost_bekreftet, false, 'ny adresse');
select faktura.registrer_bruker('uid-bekreft-ny', 'ny-adresse-bekreft@test.no', null, true);
select test.er((test.bruker(:'u')).epost_bekreftet, true, 'bekreftet av tokenet');

-- Høyst åtte i døgnet (de eldre enn et minutt teller også).
select id as u2 from faktura.registrer_bruker('uid-bekreft-mange', 'mange-bekreft@test.no', null, false) \gset
\c :migrator
insert into faktura.epostbekreftelser (bruker_id, til, opprettet)
select :'u2', 'mange-bekreft@test.no', now() - make_interval(mins => 5 + i) from generate_series(1, 7) i;
insert into faktura.epostbekreftelser (bruker_id, til, opprettet) values (:'u2', 'mange-bekreft@test.no', now() - interval '25 hours');
\c :api
select set_config('app.bruker_id', :'u2', false);
select faktura.be_om_epostbekreftelse();
\c :migrator
update faktura.epostbekreftelser set opprettet = now() - interval '2 minutes' where bruker_id = :'u2' and opprettet > now() - interval '1 minute';
\c :api
select set_config('app.bruker_id', :'u2', false);
select test.feiler($$select faktura.be_om_epostbekreftelse()$$, 'FA429');

\c :migrator
drop schema test cascade;
\echo '  ok'
