-- 0026_bankavstemming.sql
-- Innbetalinger lest fra organisasjonens egen bankkonto gjennom open banking (Enable
-- Banking), og koblingen til fakturaene. Koblingen til banken ligger i
-- faktura.integrasjoner (type 'bank'): applikasjonen og samtykket i konfig, den private
-- nøkkelen kryptert med Cloud KMS. API-et kan bare kryptere; workeren dekrypterer og
-- henter transaksjonene.
--
-- Hver innbetaling (penger inn på kontoen) lagres én gang. status:
--   koblet:   registrert som betaling (betaling_id) på faktura_id
--   forslag:  trolig betaling for faktura_id (f.eks. samme beløp og betaler), må bekreftes
--   uavklart: fant ingen faktura
--   ignorert: ikke en fakturabetaling (f.eks. overføring mellom egne kontoer)

create table faktura.banktransaksjoner (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  konto text not null,                     -- kontonummeret (11 siffer), ellers IBAN
  ekstern_id text not null,                -- bankens id for transaksjonen, ellers et fingeravtrykk
  dato date not null,
  belop numeric(14,2) not null check (belop > 0),
  valuta text not null default 'NOK',
  betaler text,
  betaler_konto text,
  melding text,
  referanse text,                          -- strukturert referanse (KID) når banken har den
  status text not null default 'uavklart' check (status in ('koblet', 'forslag', 'uavklart', 'ignorert')),
  faktura_id uuid,
  betaling_id uuid references faktura.betalinger(id) on delete set null,
  grunn text,                              -- hvorfor den ble koblet eller foreslått
  behandlet_av uuid references faktura.brukere(id), -- null: gjort automatisk
  behandlet timestamptz,
  opprettet timestamptz not null default now(),
  unique (org_id, konto, ekstern_id),
  foreign key (org_id, faktura_id) references faktura.fakturaer(org_id, id),
  check (status not in ('koblet', 'forslag') or faktura_id is not null)
);
create index banktransaksjoner_status_idx on faktura.banktransaksjoner (org_id, status, dato desc);
create index banktransaksjoner_faktura_idx on faktura.banktransaksjoner (faktura_id) where faktura_id is not null;

alter table faktura.banktransaksjoner enable row level security;
create policy banktransaksjoner_les on faktura.banktransaksjoner for select using (faktura.kan(org_id, 'les'));
create policy banktransaksjoner_system on faktura.banktransaksjoner for all
  using (faktura.er_system()) with check (faktura.er_system());
grant select on faktura.banktransaksjoner to faktura_app;
grant insert (org_id, konto, ekstern_id, dato, belop, valuta, betaler, betaler_konto, melding, referanse, status, faktura_id, grunn),
      update (status, faktura_id, betaling_id, grunn, behandlet_av, behandlet)
  on faktura.banktransaksjoner to faktura_system;

create trigger banktransaksjoner_org_id before update on faktura.banktransaksjoner
  for each row execute function faktura.org_id_uendret();

-- Slettes en faktura (testfakturaer, se 0014), blir innbetalingene som var koblet til
-- den, uavklarte igjen.
create function faktura.frigjor_banktransaksjoner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update faktura.banktransaksjoner
     set status = 'uavklart', faktura_id = null, betaling_id = null, grunn = null, behandlet_av = null, behandlet = null
   where faktura_id = old.id;
  return old;
end $$;
create trigger fakturaer_frigjor_bank before delete on faktura.fakturaer
  for each row execute function faktura.frigjor_banktransaksjoner();

-- Teksten på betalingen: hvem som betalte og meldingen deres.
create function faktura.banktekst(t faktura.banktransaksjoner) returns text
language sql immutable set search_path = '' as $$
  select nullif(concat_ws(': ', 'Fra ' || nullif(btrim(t.betaler), ''), nullif(btrim(t.melding), '')), '')
$$;

-- Registrerer innbetalingen som betaling på fakturaen. Brukes av workeren (automatisk,
-- med grunn) og fra appen (bekreft et forslag, eller velg fakturaen selv).
create function faktura.koble_banktransaksjon(_id uuid, _faktura uuid, _grunn text default null)
returns faktura.banktransaksjoner
language plpgsql security definer set search_path = '' as $$
declare
  t faktura.banktransaksjoner;
  b uuid;
begin
  select * into t from faktura.banktransaksjoner where id = _id for update;
  if not found then raise exception 'Fant ikke innbetalingen' using errcode = 'FA404'; end if;
  perform faktura.krev(t.org_id, 'bokfor');
  if t.status = 'koblet' then
    raise exception 'Innbetalingen er allerede registrert på en faktura' using errcode = 'FA409';
  end if;
  if t.valuta <> 'NOK' then
    raise exception 'Bare innbetalinger i norske kroner kan registreres på fakturaer' using errcode = 'FA400';
  end if;
  if not exists (select 1 from faktura.fakturaer where id = _faktura and org_id = t.org_id) then
    raise exception 'Fant ikke fakturaen' using errcode = 'FA404';
  end if;

  perform faktura.registrer_betaling(_faktura, t.belop, t.dato, faktura.banktekst(t), 'bank', t.id::text);
  select id into b from faktura.betalinger where org_id = t.org_id and kilde = 'bank' and ekstern_ref = t.id::text;

  update faktura.banktransaksjoner
     set status = 'koblet', faktura_id = _faktura, betaling_id = b,
         grunn = coalesce(_grunn, 'Koblet for hånd'),
         behandlet_av = faktura.bruker_id(), behandlet = now()
   where id = _id
  returning * into t;
  return t;
end $$;

-- Ignorer en innbetaling som ikke er en fakturabetaling (eller ta den tilbake).
create function faktura.ignorer_banktransaksjon(_id uuid, _ignorer boolean default true)
returns faktura.banktransaksjoner
language plpgsql security definer set search_path = '' as $$
declare
  t faktura.banktransaksjoner;
begin
  select * into t from faktura.banktransaksjoner where id = _id for update;
  if not found then raise exception 'Fant ikke innbetalingen' using errcode = 'FA404'; end if;
  perform faktura.krev(t.org_id, 'bokfor');
  if t.status = 'koblet' then
    raise exception 'Innbetalingen er registrert på en faktura. Angre det først.' using errcode = 'FA409';
  end if;
  update faktura.banktransaksjoner
     set status = case when _ignorer then 'ignorert' else 'uavklart' end,
         faktura_id = null, grunn = null, behandlet_av = faktura.bruker_id(), behandlet = now()
   where id = _id
  returning * into t;
  return t;
end $$;

-- Angre: en registrert betaling fjernes (fakturaen blir ubetalt igjen), eller et
-- forslag avvises. Innbetalingen blir uavklart.
create function faktura.angre_banktransaksjon(_id uuid)
returns faktura.banktransaksjoner
language plpgsql security definer set search_path = '' as $$
declare
  t faktura.banktransaksjoner;
  f faktura.fakturaer;
  b faktura.betalinger;
begin
  select * into t from faktura.banktransaksjoner where id = _id for update;
  if not found then raise exception 'Fant ikke innbetalingen' using errcode = 'FA404'; end if;
  perform faktura.krev(t.org_id, 'bokfor');

  if t.status = 'koblet' then
    select * into f from faktura.fakturaer where id = t.faktura_id for update;
    if f.status not in ('utstedt', 'betalt') then
      raise exception 'Fakturaen er kreditert, så betalingen kan ikke tas bort her' using errcode = 'FA409';
    end if;
    select * into b from faktura.betalinger where id = t.betaling_id;
    if found then
      insert into faktura.revisjonslogg (org_id, bruker_id, handling, tabell, rad_id, endring)
      values (t.org_id, faktura.bruker_id(), 'SLETTET', 'betalinger', b.id,
              jsonb_build_object('grunn', 'Innbetaling fra banken koblet fra fakturaen', 'faktura_id', b.faktura_id,
                                 'belop', b.belop, 'betalt_dato', b.betalt_dato, 'kilde', b.kilde));
      delete from faktura.betalinger where id = b.id;
      perform faktura.oppdater_betalingsstatus(t.faktura_id);
    end if;
  elsif t.status <> 'forslag' then
    raise exception 'Innbetalingen er ikke koblet til noen faktura' using errcode = 'FA409';
  end if;

  update faktura.banktransaksjoner
     set status = 'uavklart', faktura_id = null, betaling_id = null, grunn = null,
         behandlet_av = faktura.bruker_id(), behandlet = now()
   where id = _id
  returning * into t;
  return t;
end $$;

revoke all on function faktura.frigjor_banktransaksjoner(), faktura.banktekst(faktura.banktransaksjoner),
  faktura.koble_banktransaksjon(uuid, uuid, text), faktura.ignorer_banktransaksjon(uuid, boolean),
  faktura.angre_banktransaksjon(uuid) from public;
grant execute on function faktura.banktekst(faktura.banktransaksjoner), faktura.koble_banktransaksjon(uuid, uuid, text),
  faktura.ignorer_banktransaksjon(uuid, boolean), faktura.angre_banktransaksjon(uuid) to faktura_app;
