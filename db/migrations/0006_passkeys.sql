-- 0006_passkeys.sql
-- Passkeys (WebAuthn). Identity Platform har ikke passkeys, så API-et verifiserer
-- dem selv og utsteder en Firebase-innlogging (custom token) etterpå.

create table faktura.passkeys (
  id text primary key,                       -- credential id (base64url)
  bruker_id uuid not null references faktura.brukere(id) on delete cascade,
  offentlig_nokkel bytea not null,
  teller bigint not null default 0,
  transporter text[] not null default '{}',
  enhetstype text,                           -- singleDevice eller multiDevice (synkronisert)
  sikkerhetskopiert boolean not null default false,
  navn text not null default 'Passkey',
  opprettet timestamptz not null default now(),
  sist_brukt timestamptz
);
create index passkeys_bruker_idx on faktura.passkeys (bruker_id);

-- Engangsutfordringer, gyldige i fem minutter.
create table faktura.passkey_utfordringer (
  id uuid primary key default gen_random_uuid(),
  bruker_id uuid references faktura.brukere(id) on delete cascade,
  type text not null check (type in ('registrering', 'innlogging')),
  utfordring text not null,
  utloper timestamptz not null default now() + interval '5 minutes'
);

alter table faktura.passkeys enable row level security;
alter table faktura.passkey_utfordringer enable row level security;

create policy passkeys_egne on faktura.passkeys for all
  using (bruker_id = faktura.bruker_id()) with check (bruker_id = faktura.bruker_id());

-- Utfordringer er tilfeldige og kortlivede; bare API-et ser dem.
create policy passkey_utfordringer_api on faktura.passkey_utfordringer for all using (true) with check (true);

grant select (id, bruker_id, transporter, enhetstype, sikkerhetskopiert, navn, opprettet, sist_brukt),
      insert, delete,
      update (navn)
  on faktura.passkeys to faktura_app;
grant select, insert, delete on faktura.passkey_utfordringer to faktura_app;

-- Henter og forbruker en utfordring (kan bare brukes én gang).
create function faktura.bruk_passkey_utfordring(_id uuid, _type text)
returns faktura.passkey_utfordringer
language plpgsql security definer set search_path = '' as $$
declare
  u faktura.passkey_utfordringer;
begin
  delete from faktura.passkey_utfordringer where utloper < now();
  delete from faktura.passkey_utfordringer where id = _id and type = _type returning * into u;
  if not found then raise exception 'Utfordringen er ugyldig eller utløpt' using errcode = 'FA400'; end if;
  return u;
end $$;

-- Innlogging skjer før vi vet hvem brukeren er, så oppslaget går utenom RLS.
create function faktura.passkey_for_innlogging(_id text)
returns table (id text, bruker_id uuid, ekstern_id text, offentlig_nokkel bytea, teller bigint, transporter text[])
language sql stable security definer set search_path = '' as $$
  select p.id, p.bruker_id, b.ekstern_id, p.offentlig_nokkel, p.teller, p.transporter
    from faktura.passkeys p join faktura.brukere b on b.id = p.bruker_id
   where p.id = _id
$$;

create function faktura.passkey_brukt(_id text, _teller bigint)
returns void
language sql security definer set search_path = '' as $$
  update faktura.passkeys set teller = greatest(teller, _teller), sist_brukt = now() where id = _id
$$;

grant execute on function
  faktura.bruk_passkey_utfordring(uuid, text),
  faktura.passkey_for_innlogging(text),
  faktura.passkey_brukt(text, bigint)
to faktura_app;
