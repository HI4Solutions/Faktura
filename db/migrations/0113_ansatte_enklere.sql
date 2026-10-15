-- 0113_ansatte_enklere.sql
-- Enklere å legge inn ansatte (docs/ansatte.md):
--
-- 1. Den ansatte fyller ut selv. Lederen ber om det (utfylling_bedt, med e-post og invitasjon),
--    den ansatte sender inn opplysningene sine fra Min side (ansatt_utfylling: navn, adresse,
--    telefon, fødselsnummer, kontonummer og nærmeste pårørende), og lederen godkjenner dem (de
--    skrives på den ansatte) eller avviser dem med en grunn den ansatte ser. Den ansatte endrer
--    aldri ansattraden selv, og fødselsnummeret ligger kryptert (bare workeren leser det).
-- 2. Hentet fra a-ordningen (aordning_import). Workeren henter avstemmingsrapporten fra
--    Skatteetaten (det som er rapportert i a-meldingene) med systembrukeren i Altinn, og lederen
--    velger hvem som legges inn eller oppdateres. Fødselsnumrene ligger kryptert i en kolonne
--    bare workeren leser, og settes på den ansatte med aordning_sett_fnr. ArbeidsforholdID-en fra
--    det forrige lønnssystemet tas vare på, så a-meldingen fortsetter det samme arbeidsforholdet.

-- ---------------------------------------------------------------------------
-- Nye felt på den ansatte
-- ---------------------------------------------------------------------------

alter table faktura.ansatte
  add column parorende_navn text check (parorende_navn is null or length(parorende_navn) <= 100),
  add column parorende_telefon text check (parorende_telefon is null or length(parorende_telefon) <= 30),
  -- Når lederen sist ba den ansatte fylle ut opplysningene sine (null når de er godkjent).
  add column utfylling_bedt timestamptz,
  -- ArbeidsforholdID-en i a-meldingen (null: ansattnummeret). Fra det forrige lønnssystemet, så
  -- arbeidsforholdet ikke avsluttes og startes på nytt når Admin Konsoll tar over.
  add column arbeidsforhold_id text check (arbeidsforhold_id is null or (length(arbeidsforhold_id) between 1 and 50 and arbeidsforhold_id !~ '\s'));

grant select (parorende_navn, parorende_telefon, utfylling_bedt, arbeidsforhold_id),
      insert (parorende_navn, parorende_telefon, utfylling_bedt, arbeidsforhold_id),
      update (parorende_navn, parorende_telefon, utfylling_bedt, arbeidsforhold_id)
  on faktura.ansatte to faktura_app;

-- ---------------------------------------------------------------------------
-- Den ansatte fyller ut selv
-- ---------------------------------------------------------------------------

-- Det den ansatte har sendt inn (én innsending per ansatt; en ny erstatter den forrige). felt:
-- tekstene som skal skrives på den ansatte (bare feltene i utfylling_felt). Avvist: grunnen står
-- til den ansatte sender på nytt, og fødselsnummeret er fjernet.
create table faktura.ansatt_utfylling (
  org_id uuid not null,
  ansatt_id uuid not null,
  felt jsonb not null default '{}' check (jsonb_typeof(felt) = 'object' and length(felt::text) <= 4000),
  fnr_kryptert bytea,
  har_fnr boolean generated always as (fnr_kryptert is not null) stored,
  status text not null default 'levert' check (status in ('levert', 'avvist')),
  avvist_grunn text check (avvist_grunn is null or length(avvist_grunn) <= 500),
  levert timestamptz not null default now(),
  levert_av uuid references faktura.brukere(id) on delete set null,
  behandlet timestamptz,
  behandlet_av uuid references faktura.brukere(id) on delete set null,
  primary key (org_id, ansatt_id),
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete cascade
);

alter table faktura.ansatt_utfylling enable row level security;
create policy ansatt_utfylling_les on faktura.ansatt_utfylling for select
  using (faktura.kan(org_id, 'personal_les') or faktura.er_meg(org_id, ansatt_id));
-- Bare lesing; innsending, godkjenning og avslag går gjennom funksjonene under.
grant select (org_id, ansatt_id, felt, har_fnr, status, avvist_grunn, levert, levert_av, behandlet, behandlet_av)
  on faktura.ansatt_utfylling to faktura_app;

-- Feltene den ansatte kan fylle ut (fødselsdatoen følger fødselsnummeret, eller fylles ut uten).
create function faktura.utfylling_felt() returns text[]
language sql immutable set search_path = '' as $$
  select array['fornavn', 'etternavn', 'telefon', 'adresse', 'postnr', 'poststed', 'fodselsdato', 'kontonr',
               'parorende_navn', 'parorende_telefon']
$$;

-- Den ansatte sender inn opplysningene sine (API-et har sjekket dem). Uten nytt fødselsnummer
-- beholdes det som alt er sendt og ikke avvist. Gir id-en til den ansatte.
create function faktura.lever_utfylling(_org uuid, _felt jsonb, _fnr_kryptert bytea) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  meg uuid := faktura.min_ansatt(_org);
  f jsonb;
begin
  if meg is null then raise exception 'Du er ikke registrert som ansatt i organisasjonen' using errcode = 'FA403'; end if;
  select coalesce(jsonb_object_agg(e.key, e.value), '{}') into f
    from jsonb_each(coalesce(_felt, '{}')) e
   where e.key = any (faktura.utfylling_felt()) and jsonb_typeof(e.value) = 'string';
  if f = '{}' and _fnr_kryptert is null then raise exception 'Fyll ut minst ett felt' using errcode = 'FA400'; end if;
  insert into faktura.ansatt_utfylling as u (org_id, ansatt_id, felt, fnr_kryptert, levert_av)
  values (_org, meg, f, _fnr_kryptert, faktura.bruker_id())
  on conflict (org_id, ansatt_id) do update
     set felt = excluded.felt,
         fnr_kryptert = coalesce(excluded.fnr_kryptert, u.fnr_kryptert),
         status = 'levert', avvist_grunn = null, levert = now(), levert_av = excluded.levert_av,
         behandlet = null, behandlet_av = null;
  return meg;
end $$;

-- Lederen godkjenner: opplysningene skrives på den ansatte (tomme felt endrer ingenting), og
-- innsendingen fjernes. Gir om fødselsnummeret var med (da hentes skattekortet).
create function faktura.godkjenn_utfylling(_org uuid, _ansatt uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  u faktura.ansatt_utfylling;
begin
  perform faktura.krev(_org, 'personal');
  select * into u from faktura.ansatt_utfylling
   where org_id = _org and ansatt_id = _ansatt and status = 'levert' for update;
  if not found then raise exception 'Fant ingen opplysninger som venter på godkjenning' using errcode = 'FA404'; end if;
  update faktura.ansatte a
     set fornavn = coalesce(u.felt ->> 'fornavn', a.fornavn),
         etternavn = coalesce(u.felt ->> 'etternavn', a.etternavn),
         telefon = coalesce(u.felt ->> 'telefon', a.telefon),
         adresse = coalesce(u.felt ->> 'adresse', a.adresse),
         postnr = coalesce(u.felt ->> 'postnr', a.postnr),
         poststed = coalesce(u.felt ->> 'poststed', a.poststed),
         fodselsdato = coalesce((u.felt ->> 'fodselsdato')::date, a.fodselsdato),
         kontonr = coalesce(u.felt ->> 'kontonr', a.kontonr),
         parorende_navn = coalesce(u.felt ->> 'parorende_navn', a.parorende_navn),
         parorende_telefon = coalesce(u.felt ->> 'parorende_telefon', a.parorende_telefon),
         fnr_kryptert = coalesce(u.fnr_kryptert, a.fnr_kryptert),
         utfylling_bedt = null
   where a.org_id = _org and a.id = _ansatt;
  delete from faktura.ansatt_utfylling where org_id = _org and ansatt_id = _ansatt;
  return u.fnr_kryptert is not null;
end $$;

-- Lederen avviser med en grunn (den ansatte ser den og kan sende på nytt). Fødselsnummeret i
-- innsendingen fjernes.
create function faktura.avvis_utfylling(_org uuid, _ansatt uuid, _grunn text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform faktura.krev(_org, 'personal');
  update faktura.ansatt_utfylling
     set status = 'avvist', avvist_grunn = nullif(btrim(_grunn), ''), fnr_kryptert = null,
         behandlet = now(), behandlet_av = faktura.bruker_id()
   where org_id = _org and ansatt_id = _ansatt and status = 'levert';
  if not found then raise exception 'Fant ingen opplysninger som venter på godkjenning' using errcode = 'FA404'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- Ansatte fra a-ordningen
-- ---------------------------------------------------------------------------

-- Siste henting per organisasjon. personer: [{nr, navn, fødselsdato, arbeidsforholdet, lønnen,
-- ansatt_id (samme fødselsnummer), forslag_id (samme navn, uten fødselsnummer)}] (aordning.ts);
-- fnr: fødselsnumrene kryptert, i samme rekkefølge (nr 1 er fnr[1]), som bare workeren leser.
create table faktura.aordning_import (
  org_id uuid primary key references faktura.organisasjoner(id) on delete cascade,
  status text not null check (status in ('bestilt', 'klar', 'feil')),
  bestilt timestamptz not null default now(),
  bestilt_av uuid references faktura.brukere(id) on delete set null,
  hentet timestamptz,
  periode_fra text check (periode_fra is null or periode_fra ~ '^\d{4}-\d{2}$'),
  periode_til text check (periode_til is null or periode_til ~ '^\d{4}-\d{2}$'),
  personer jsonb check (personer is null or jsonb_typeof(personer) = 'array'),
  fnr bytea[],
  feil text check (feil is null or length(feil) <= 2000)
);

alter table faktura.aordning_import enable row level security;
create policy aordning_import_les on faktura.aordning_import for select using (faktura.kan(org_id, 'personal'));
create policy aordning_import_system on faktura.aordning_import for all using (faktura.er_system()) with check (faktura.er_system());
grant select (org_id, status, bestilt, bestilt_av, hentet, periode_fra, periode_til, personer, feil)
  on faktura.aordning_import to faktura_app;
grant select, insert, update, delete on faktura.aordning_import to faktura_system;

-- Lederen ber om en ny henting. Gir false når en henting alt er bestilt de siste to minuttene
-- (da legges ingen ny oppgave i køen).
create function faktura.bestill_aordning(_org uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform faktura.krev(_org, 'personal');
  if exists (select 1 from faktura.aordning_import
              where org_id = _org and status = 'bestilt' and bestilt > now() - interval '2 minutes') then
    return false;
  end if;
  insert into faktura.aordning_import (org_id, status, bestilt, bestilt_av)
  values (_org, 'bestilt', now(), faktura.bruker_id())
  on conflict (org_id) do update set status = 'bestilt', bestilt = now(), bestilt_av = excluded.bestilt_av, feil = null;
  return true;
end $$;

-- Fødselsnummeret til person nr. _nr i hentingen settes på den ansatte (lagt inn eller koblet
-- til fra hentingen), og hentingen husker hvem personen er (så den ikke legges inn to ganger).
create function faktura.aordning_sett_fnr(_org uuid, _ansatt uuid, _nr int) returns void
language plpgsql security definer set search_path = '' as $$
declare
  f bytea;
begin
  perform faktura.krev(_org, 'personal');
  select i.fnr[_nr] into f from faktura.aordning_import i
   where i.org_id = _org and i.status = 'klar' and _nr between 1 and jsonb_array_length(i.personer)
     for update;
  if f is null then raise exception 'Fant ikke personen i hentingen fra a-ordningen' using errcode = 'FA404'; end if;
  update faktura.ansatte set fnr_kryptert = f where org_id = _org and id = _ansatt;
  if not found then raise exception 'Fant ikke den ansatte' using errcode = 'FA404'; end if;
  update faktura.aordning_import
     set personer = jsonb_set(personer, array[(_nr - 1)::text, 'ansatt_id'], to_jsonb(_ansatt))
   where org_id = _org;
end $$;

revoke all on function faktura.utfylling_felt(), faktura.lever_utfylling(uuid, jsonb, bytea),
  faktura.godkjenn_utfylling(uuid, uuid), faktura.avvis_utfylling(uuid, uuid, text),
  faktura.bestill_aordning(uuid), faktura.aordning_sett_fnr(uuid, uuid, int) from public;
grant execute on function faktura.utfylling_felt(), faktura.lever_utfylling(uuid, jsonb, bytea),
  faktura.godkjenn_utfylling(uuid, uuid), faktura.avvis_utfylling(uuid, uuid, text),
  faktura.bestill_aordning(uuid), faktura.aordning_sett_fnr(uuid, uuid, int) to faktura_app;
