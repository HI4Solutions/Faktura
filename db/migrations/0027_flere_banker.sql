-- 0027_flere_banker.sql
-- Flere banker per organisasjon (f.eks. driftskonto i DNB og husleiekonto i Storebrand).
-- Applikasjonen hos Enable Banking og den krypterte nøkkelen er felles og ligger fortsatt i
-- faktura.integrasjoner (type 'bank'). Hver bank får sin egen kobling her: egen BankID-
-- innlogging, eget samtykke (økt) med utløpsdato, egne kontoer og egen henting.

create table faktura.bankkoblinger (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  bank text not null,                       -- banken slik brukeren skrev den, siden det nøyaktige navnet hos Enable Banking
  land text not null default 'NO',
  psu_type text not null check (psu_type in ('business', 'personal')),
  -- venter: BankID er ikke fullført; aktiv: kontoene leses; feil: må kobles til på nytt
  status text not null default 'venter' check (status in ('venter', 'aktiv', 'feil')),
  maks_sek int,                             -- lengste samtykke banken tillater
  state text,                               -- BankID-innloggingen som pågår
  auth_url text,                            -- adressen til banken (laget av workeren)
  auth_tid timestamptz,
  auth_gyldig_til timestamptz,
  okt_id text,                              -- økten hos Enable Banking
  gyldig_til timestamptz,
  fullfort timestamptz,                     -- når BankID sist ble fullført (ny økt)
  kontoer jsonb not null default '[]',      -- [{ uid, kontonr, navn, valgt }]
  hent_fra date,                            -- neste henting starter fra denne datoen
  sist_hentet timestamptz,
  varslet_utlop timestamptz,
  siste_feil text,
  opprettet timestamptz not null default now(),
  oppdatert timestamptz not null default now(),
  unique (org_id, bank, psu_type)
);
create unique index bankkoblinger_state_idx on faktura.bankkoblinger (state) where state is not null;

alter table faktura.bankkoblinger enable row level security;
create policy bankkoblinger_les on faktura.bankkoblinger for select using (faktura.kan(org_id, 'les'));
create policy bankkoblinger_ny on faktura.bankkoblinger for insert with check (faktura.kan(org_id, 'admin'));
create policy bankkoblinger_endre on faktura.bankkoblinger for update
  using (faktura.kan(org_id, 'admin')) with check (faktura.kan(org_id, 'admin'));
create policy bankkoblinger_slett on faktura.bankkoblinger for delete using (faktura.kan(org_id, 'admin'));

grant select on faktura.bankkoblinger to faktura_app;
grant insert (org_id, bank, land, psu_type, status, maks_sek, state, auth_url, auth_tid, auth_gyldig_til, siste_feil),
      update (bank, status, maks_sek, state, auth_url, auth_tid, auth_gyldig_til, kontoer, siste_feil, okt_id),
      delete
  on faktura.bankkoblinger to faktura_app;
-- Workeren fullfører koblingen, henter og varsler.
grant update (gyldig_til, fullfort, hent_fra, sist_hentet, varslet_utlop) on faktura.bankkoblinger to faktura_system;

create trigger bankkoblinger_oppdatert before update on faktura.bankkoblinger
  for each row execute function faktura.sett_oppdatert();
create trigger bankkoblinger_org_id before update on faktura.bankkoblinger
  for each row execute function faktura.org_id_uendret();

-- Koblingen som allerede finnes (én bank i integrasjonens konfig), flyttes hit.
insert into faktura.bankkoblinger (org_id, bank, land, psu_type, status, maks_sek, state, auth_gyldig_til, okt_id,
                                   gyldig_til, kontoer, hent_fra, sist_hentet, varslet_utlop, siste_feil)
select i.org_id, i.konfig ->> 'bank', coalesce(i.konfig ->> 'land', 'NO'), coalesce(i.konfig ->> 'psu_type', 'business'),
       case when i.status = 'feil' then 'feil' when i.konfig ->> 'okt_id' is not null then 'aktiv' else 'venter' end,
       (i.konfig ->> 'maks_sek')::int, i.konfig ->> 'state', (i.konfig ->> 'auth_gyldig_til')::timestamptz, i.konfig ->> 'okt_id',
       (i.konfig ->> 'gyldig_til')::timestamptz, coalesce(i.konfig -> 'kontoer', '[]'::jsonb), (i.konfig ->> 'hent_fra')::date,
       (i.konfig ->> 'sist_hentet')::timestamptz, (i.konfig ->> 'varslet_utlop')::timestamptz, i.siste_feil
  from faktura.integrasjoner i
 where i.type = 'bank' and i.status <> 'frakoblet' and i.konfig ->> 'bank' is not null;

-- Det som nå ligger på koblingen, fjernes fra integrasjonen (applikasjonen og nøkkelen blir).
update faktura.integrasjoner
   set konfig = konfig - array['bank', 'land', 'psu_type', 'maks_sek', 'state', 'auth_url', 'auth_tid', 'auth_gyldig_til',
                               'okt_id', 'gyldig_til', 'kontoer', 'hent_fra', 'sist_hentet', 'varslet_utlop'],
       status = case when status = 'feil' then 'aktiv' else status end,
       siste_feil = null
 where type = 'bank';
