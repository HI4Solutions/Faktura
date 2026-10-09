-- Hentingene fra bankene (server/src/bank.ts): hver henting fra en bank lagres med hva banken
-- sendte (transaksjonene, innbetalingene som er bokført og de som ikke er bokført ennå, den
-- nyeste bokføringsdatoen), hva som ble nytt (registrert, foreslått) eller feilen. Appen viser
-- de siste hentingene under Innbetalinger, så det går an å se hva de automatiske hentingene fikk.
--
-- kilde: automatisk (de faste hentetidene, uten at brukeren er til stede), manuell («Hent nå»),
-- apnet (brukeren åpnet appen, som henter av seg selv høyst hvert kvarter) eller tilkoblet
-- (rett etter BankID). Bare de automatiske teller mot bankenes grense på fire hentinger i
-- døgnet uten brukeren (PSD2).

create table faktura.bankhentinger (
  id bigint generated always as identity primary key,
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  kobling_id uuid references faktura.bankkoblinger(id) on delete set null,
  bank text not null,
  kilde text not null check (kilde in ('automatisk', 'manuell', 'apnet', 'tilkoblet')),
  tid timestamptz not null default now(),
  fra date,                                 -- hentet fra og med (bokføringsdato)
  kontoer int not null default 0,
  transaksjoner int not null default 0,     -- alle transaksjonene banken sendte
  inn int not null default 0,               -- innbetalinger som er bokført
  ventende int not null default 0,          -- innbetalinger som ikke er bokført ennå
  nye int not null default 0,               -- nye innbetalinger lagret i HI4 Faktura
  koblet int not null default 0,            -- av dem registrert som betaling
  forslag int not null default 0,           -- av dem foreslått
  nyeste date,                              -- den nyeste bokføringsdatoen banken sendte
  feil text
);
create index bankhentinger_org_idx on faktura.bankhentinger (org_id, id desc);

alter table faktura.bankhentinger enable row level security;
create policy bankhentinger_les on faktura.bankhentinger for select using (faktura.kan(org_id, 'les'));
create policy bankhentinger_system on faktura.bankhentinger for all
  using (faktura.er_system()) with check (faktura.er_system());
grant select on faktura.bankhentinger to faktura_app;
grant insert (org_id, kobling_id, bank, kilde, fra, kontoer, transaksjoner, inn, ventende, nye, koblet, forslag, nyeste, feil), delete
  on faktura.bankhentinger to faktura_system;

-- De siste 200 hentingene per organisasjon beholdes.
create function faktura.rydd_bankhentinger(_org uuid) returns void
language sql security definer set search_path = '' as $$
  delete from faktura.bankhentinger
   where org_id = _org
     and id < coalesce((select id from faktura.bankhentinger where org_id = _org order by id desc offset 199 limit 1), 0)
$$;
revoke all on function faktura.rydd_bankhentinger(uuid) from public;
grant execute on function faktura.rydd_bankhentinger(uuid) to faktura_system;
