-- 0004_rls_og_rettigheter.sql
-- Radnivåtilgang (RLS) og rettigheter for faktura_app (API) og faktura_system (worker).
--
-- API-et sjekker tilgang selv; RLS er ekstra sikring. Kolonnerettighetene sørger
-- for at status, nummer, summer og kopiene av selger og kunde bare kan endres av
-- funksjonene i 0003, aldri med en vanlig UPDATE fra appen.

-- ---------------------------------------------------------------------------
-- Slå på RLS
-- ---------------------------------------------------------------------------

alter table faktura.brukere enable row level security;
alter table faktura.organisasjoner enable row level security;
alter table faktura.nummerserier enable row level security;
alter table faktura.medlemmer enable row level security;
alter table faktura.invitasjoner enable row level security;
alter table faktura.org_tilgang enable row level security;
alter table faktura.kunder enable row level security;
alter table faktura.produkter enable row level security;
alter table faktura.gjentakelser enable row level security;
alter table faktura.fakturaer enable row level security;
alter table faktura.faktura_linjer enable row level security;
alter table faktura.betalinger enable row level security;
alter table faktura.integrasjoner enable row level security;
alter table faktura.utboks enable row level security;
alter table faktura.revisjonslogg enable row level security;

-- ---------------------------------------------------------------------------
-- Policyer
-- ---------------------------------------------------------------------------

create policy brukere_les on faktura.brukere for select
  using (id = faktura.bruker_id() or faktura.deler_org(id) or faktura.er_system());
create policy brukere_endre on faktura.brukere for update
  using (id = faktura.bruker_id()) with check (id = faktura.bruker_id());

create policy organisasjoner_les on faktura.organisasjoner for select
  using (faktura.kan(id, 'les'));
create policy organisasjoner_endre on faktura.organisasjoner for update
  using (faktura.kan(id, 'admin')) with check (faktura.kan(id, 'admin'));

create policy nummerserier_les on faktura.nummerserier for select
  using (faktura.kan(org_id, 'les'));

create policy medlemmer_les on faktura.medlemmer for select
  using (faktura.kan(org_id, 'les'));

create policy invitasjoner_les on faktura.invitasjoner for select
  using (faktura.kan(org_id, 'admin'));

create policy org_tilgang_les on faktura.org_tilgang for select
  using (faktura.kan(klient_org_id, 'les') or faktura.kan(byraa_org_id, 'les'));

-- Kunder, produkter og gjentakelser: les for alle roller, skriv for fakturerer og opp.
create policy kunder_les on faktura.kunder for select using (faktura.kan(org_id, 'les'));
create policy kunder_ny on faktura.kunder for insert with check (faktura.kan(org_id, 'skriv'));
create policy kunder_endre on faktura.kunder for update
  using (faktura.kan(org_id, 'skriv')) with check (faktura.kan(org_id, 'skriv'));
create policy kunder_slett on faktura.kunder for delete using (faktura.kan(org_id, 'skriv'));

create policy produkter_les on faktura.produkter for select using (faktura.kan(org_id, 'les'));
create policy produkter_ny on faktura.produkter for insert with check (faktura.kan(org_id, 'skriv'));
create policy produkter_endre on faktura.produkter for update
  using (faktura.kan(org_id, 'skriv')) with check (faktura.kan(org_id, 'skriv'));
create policy produkter_slett on faktura.produkter for delete using (faktura.kan(org_id, 'skriv'));

create policy gjentakelser_les on faktura.gjentakelser for select using (faktura.kan(org_id, 'les'));
create policy gjentakelser_ny on faktura.gjentakelser for insert with check (faktura.kan(org_id, 'skriv'));
create policy gjentakelser_endre on faktura.gjentakelser for update
  using (faktura.kan(org_id, 'skriv')) with check (faktura.kan(org_id, 'skriv'));
create policy gjentakelser_slett on faktura.gjentakelser for delete using (faktura.kan(org_id, 'skriv'));

-- Fakturaer: appen kan bare lage og endre utkast.
create policy fakturaer_les on faktura.fakturaer for select using (faktura.kan(org_id, 'les'));
create policy fakturaer_ny on faktura.fakturaer for insert
  with check (faktura.kan(org_id, 'skriv') and status = 'utkast' and type = 'faktura');
create policy fakturaer_endre on faktura.fakturaer for update
  using (faktura.kan(org_id, 'skriv') and status = 'utkast')
  with check (faktura.kan(org_id, 'skriv') and status = 'utkast');
create policy fakturaer_slett on faktura.fakturaer for delete
  using (faktura.kan(org_id, 'skriv') and status = 'utkast');

create policy linjer_les on faktura.faktura_linjer for select using (faktura.kan(org_id, 'les'));
create policy linjer_ny on faktura.faktura_linjer for insert
  with check (faktura.kan(org_id, 'skriv')
              and exists (select 1 from faktura.fakturaer f where f.id = faktura_id and f.status = 'utkast'));
create policy linjer_endre on faktura.faktura_linjer for update
  using (faktura.kan(org_id, 'skriv')
         and exists (select 1 from faktura.fakturaer f where f.id = faktura_id and f.status = 'utkast'))
  with check (faktura.kan(org_id, 'skriv'));
create policy linjer_slett on faktura.faktura_linjer for delete
  using (faktura.kan(org_id, 'skriv')
         and exists (select 1 from faktura.fakturaer f where f.id = faktura_id and f.status = 'utkast'));

-- Betalinger skrives bare av funksjonene.
create policy betalinger_les on faktura.betalinger for select using (faktura.kan(org_id, 'les'));

create policy integrasjoner_les on faktura.integrasjoner for select using (faktura.kan(org_id, 'les'));
create policy integrasjoner_ny on faktura.integrasjoner for insert with check (faktura.kan(org_id, 'admin'));
create policy integrasjoner_endre on faktura.integrasjoner for update
  using (faktura.kan(org_id, 'admin')) with check (faktura.kan(org_id, 'admin'));
create policy integrasjoner_slett on faktura.integrasjoner for delete using (faktura.kan(org_id, 'admin'));

create policy utboks_system on faktura.utboks for all
  using (faktura.er_system()) with check (faktura.er_system());

create policy revisjonslogg_les on faktura.revisjonslogg for select using (faktura.kan(org_id, 'les'));

-- ---------------------------------------------------------------------------
-- Visninger
-- ---------------------------------------------------------------------------

-- Organisasjonene den innloggede har tilgang til, direkte eller som regnskapsfører.
-- Grunnlaget for byråets felles dashboard.
create view faktura.mine_organisasjoner with (security_invoker = true) as
select o.id, o.type, o.navn, o.orgnr, o.verifisering,
       faktura.rolle(o.id) as rolle,
       exists (select 1 from faktura.medlemmer m
                where m.org_id = o.id and m.bruker_id = faktura.bruker_id()) as direkte_medlem
  from faktura.organisasjoner o;

-- Én linje per betaling og refusjon, med fakturaens mva-andel. Grunnlag for
-- rapporter og eksport til regnskap.
create view faktura.innbetalinger with (security_invoker = true) as
select b.id, b.org_id, b.faktura_id, f.fakturanummer, b.type, b.belop, b.betalt_dato, b.kilde,
       case when f.sum_inkl_mva <> 0 then round(b.belop * f.mva / f.sum_inkl_mva, 2) else 0 end as mva_andel,
       case b.type when 'refusjon' then 'Refusjon faktura ' else 'Faktura ' end || f.fakturanummer as tekst
  from faktura.betalinger b
  join faktura.fakturaer f on f.id = b.faktura_id;

-- ---------------------------------------------------------------------------
-- Rettigheter
-- ---------------------------------------------------------------------------

revoke all on all tables in schema faktura from public;
revoke all on all functions in schema faktura from public;

grant select on all tables in schema faktura to faktura_app;
revoke select on faktura.utboks from faktura_app;
-- Krypterte hemmeligheter kan ikke leses av API-et, bare av workeren.
revoke select on faktura.integrasjoner from faktura_app;
grant select (id, org_id, type, status, konfig, koblet_av, siste_feil, opprettet, oppdatert)
  on faktura.integrasjoner to faktura_app;

grant update (navn, epost) on faktura.brukere to faktura_app;

grant update (navn, orgnr, mva_registrert, foretaksregisteret, adresse, postnr, poststed, land,
              epost, telefon, kontonr, logo_sti, farge, standard_forfall_dager, standard_gebyr,
              bruk_kid, standard_dager_foer_forfall)
  on faktura.organisasjoner to faktura_app;

grant insert (id, org_id, type, navn, orgnr, adresse, postnr, poststed, land, epost, telefon,
              deres_referanse, notat, aktiv),
      update (type, navn, orgnr, adresse, postnr, poststed, land, epost, telefon,
              deres_referanse, notat, aktiv),
      delete
  on faktura.kunder to faktura_app;

grant insert (id, org_id, varenummer, navn, beskrivelse, enhet, enhetspris, mva_sats, aktiv),
      update (varenummer, navn, beskrivelse, enhet, enhetspris, mva_sats, aktiv),
      delete
  on faktura.produkter to faktura_app;

grant insert (id, org_id, kunde_id, linjer, intervall, forfall_dag, neste_forfall, send_dager_foer,
              slutt_dato, aktiv, deres_referanse, opprettet_av),
      update (kunde_id, linjer, intervall, forfall_dag, neste_forfall, send_dager_foer,
              slutt_dato, aktiv, deres_referanse),
      delete
  on faktura.gjentakelser to faktura_app;

grant insert (id, org_id, kunde_id, fakturadato, forfallsdato, periode_fra, periode_til,
              gjentakelse_id, deres_referanse, var_referanse, notat, planlagt_sending, opprettet_av),
      update (kunde_id, fakturadato, forfallsdato, periode_fra, periode_til, gjentakelse_id,
              deres_referanse, var_referanse, notat, planlagt_sending),
      delete
  on faktura.fakturaer to faktura_app;

grant insert (id, org_id, faktura_id, rekke, produkt_id, beskrivelse, antall, enhet, enhetspris, mva_sats),
      update (rekke, produkt_id, beskrivelse, antall, enhet, enhetspris, mva_sats),
      delete
  on faktura.faktura_linjer to faktura_app;

grant insert (org_id, type, status, konfig, hemmelighet_kryptert, koblet_av),
      update (status, konfig, hemmelighet_kryptert, siste_feil),
      delete
  on faktura.integrasjoner to faktura_app;

-- Workeren: utboksen og de krypterte hemmelighetene.
grant select, update (publisert_at, forsok, siste_feil) on faktura.utboks to faktura_system;
grant select (hemmelighet_kryptert) on faktura.integrasjoner to faktura_system;

-- Funksjoner som appen kan kalle.
grant execute on function
  faktura.i_dag(), faktura.bruker_id(), faktura.orgnr_gyldig(text), faktura.kontonr_gyldig(text),
  faktura.kid(bigint, bigint), faktura.neste_forfall(date, text, int), faktura.periode_slutt(date, text),
  faktura.er_system(), faktura.rolle_rang(text), faktura.rolle(uuid), faktura.kan(uuid, text),
  faktura.krev(uuid, text), faktura.deler_org(uuid), faktura.logg_oppslag(uuid, text, uuid),
  faktura.registrer_bruker(text, text, text), faktura.opprett_organisasjon(text, text, text),
  faktura.sett_startnummer(uuid, bigint),
  faktura.inviter_medlem(uuid, text, text), faktura.aksepter_invitasjon(text),
  faktura.endre_rolle(uuid, uuid, text), faktura.fjern_medlem(uuid, uuid),
  faktura.opprett_tilgang(uuid, text, text, date), faktura.svar_tilgang(uuid, boolean),
  faktura.trekk_tilgang(uuid),
  faktura.utsted(uuid), faktura.krediter(uuid, jsonb),
  faktura.registrer_betaling(uuid, numeric, date, text, text, text),
  faktura.registrer_refusjon(uuid, numeric, date, text),
  faktura.marker_sendt(uuid, text, text), faktura.lag_fra_gjentakelse(uuid)
to faktura_app;

grant execute on function faktura.sett_verifisering(uuid, text, text, text) to faktura_system;
