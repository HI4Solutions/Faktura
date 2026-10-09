-- Innbetalinger som er reservert i banken, men ikke bokført ennå (server/src/bank.ts). Nettbanken
-- viser dem med en gang (DNB bokfører innbetalinger fra andre banker gjerne morgenen etter), og
-- appen viser dem under Innbetalinger med fakturaen de trolig gjelder. De registreres ikke som
-- betaling: en reservasjon kan ennå endres eller slettes. Når banken har bokført innbetalingen,
-- hentes den som vanlig (banktransaksjoner) og registreres. Hver henting fra en konto erstatter
-- kontoens reserverte med det banken sender nå, så de som er bokført eller slettet, forsvinner.
-- Den automatiske betalingspåminnelsen venter mens en reservert innbetaling trolig gjelder
-- fakturaen.

create table faktura.reserverte_innbetalinger (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  konto text not null,                      -- kontonummeret (11 siffer), ellers IBAN
  ekstern_id text not null,                 -- bankens id for transaksjonen, ellers et fingeravtrykk
  dato date not null,
  belop numeric(14,2) not null check (belop > 0),
  valuta text not null default 'NOK',
  betaler text,
  betaler_konto text,
  melding text,
  referanse text,                           -- strukturert referanse (KID) når banken har den
  faktura_id uuid,                          -- fakturaen innbetalingen trolig gjelder
  grunn text,                               -- hvorfor (KID, fakturanummer, samme beløp …)
  sett timestamptz not null default now(),  -- første gang banken sendte den
  sist_sett timestamptz not null default now(),
  unique (org_id, konto, ekstern_id),
  foreign key (org_id, faktura_id) references faktura.fakturaer(org_id, id) on delete set null (faktura_id)
);
create index reserverte_innbetalinger_faktura_idx on faktura.reserverte_innbetalinger (faktura_id) where faktura_id is not null;

alter table faktura.reserverte_innbetalinger enable row level security;
create policy reserverte_innbetalinger_les on faktura.reserverte_innbetalinger for select using (faktura.kan(org_id, 'les'));
create policy reserverte_innbetalinger_system on faktura.reserverte_innbetalinger for all
  using (faktura.er_system()) with check (faktura.er_system());
grant select on faktura.reserverte_innbetalinger to faktura_app;
grant insert (org_id, konto, ekstern_id, dato, belop, valuta, betaler, betaler_konto, melding, referanse, faktura_id, grunn),
      update (dato, belop, valuta, betaler, betaler_konto, melding, referanse, faktura_id, grunn, sist_sett),
      delete
  on faktura.reserverte_innbetalinger to faktura_system;

create trigger reserverte_innbetalinger_org_id before update on faktura.reserverte_innbetalinger
  for each row execute function faktura.org_id_uendret();
