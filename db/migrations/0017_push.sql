-- 0017_push.sql
-- Push-varsler (Web Push) til brukernes enheter: telefon, nettbrett og PC.
--
-- VAPID-nøkkelparet lages første gang det trengs. Den private nøkkelen krypteres
-- med Cloud KMS av API-et (som bare kan kryptere); bare workeren kan dekryptere og
-- sende varsler.

-- ---------------------------------------------------------------------------
-- VAPID-nøkkel (én for hele plattformen)
-- ---------------------------------------------------------------------------

create table faktura.push_nokkel (
  id int primary key default 1 check (id = 1),
  offentlig text not null,                       -- base64url, ukomprimert P-256-punkt (65 byte)
  privat_kryptert bytea not null,                -- base64url-skalar, kryptert med Cloud KMS
  opprettet timestamptz not null default now()
);
grant select (id, offentlig, opprettet), insert (offentlig, privat_kryptert) on faktura.push_nokkel to faktura_app;
grant select (privat_kryptert) on faktura.push_nokkel to faktura_system;

-- ---------------------------------------------------------------------------
-- Abonnementer: én rad per enhet og nettleser
-- ---------------------------------------------------------------------------

create table faktura.push_abonnementer (
  id uuid primary key default gen_random_uuid(),
  bruker_id uuid not null references faktura.brukere(id) on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://' and length(endpoint) <= 1000),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{16,32}$'),
  enhet text check (length(enhet) <= 120),
  opprettet timestamptz not null default now(),
  sist_sendt timestamptz,
  feil int not null default 0
);
create index push_abonnementer_bruker_idx on faktura.push_abonnementer (bruker_id);

alter table faktura.push_abonnementer enable row level security;
create policy push_abonnementer_egne on faktura.push_abonnementer for all
  using (bruker_id = faktura.bruker_id() or faktura.er_system())
  with check (bruker_id = faktura.bruker_id() or faktura.er_system());
grant select (id, bruker_id, endpoint, enhet, opprettet, sist_sendt), delete on faktura.push_abonnementer to faktura_app;
grant select, update (sist_sendt, feil), delete on faktura.push_abonnementer to faktura_system;

-- Registrer denne enheten for innlogget bruker. Et endepunkt hører til én bruker;
-- logger noen andre inn på samme enhet, flyttes abonnementet til dem. Endepunktet er
-- en hemmelig adresse som bare enheten selv kjenner.
create function faktura.registrer_push(_endpoint text, _p256dh text, _auth text, _enhet text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  bruker uuid := faktura.bruker_id();
  ny uuid;
begin
  if bruker is null then raise exception 'Ikke innlogget' using errcode = 'FA403'; end if;
  delete from faktura.push_abonnementer where endpoint = _endpoint;
  insert into faktura.push_abonnementer (bruker_id, endpoint, p256dh, auth, enhet)
  values (bruker, _endpoint, _p256dh, _auth, nullif(btrim(_enhet), ''))
  returning id into ny;
  -- Høyst 20 enheter per bruker; de eldste faller bort.
  delete from faktura.push_abonnementer
   where bruker_id = bruker
     and id not in (select id from faktura.push_abonnementer where bruker_id = bruker order by opprettet desc limit 20);
  return ny;
end $$;
revoke all on function faktura.registrer_push(text, text, text, text) from public;
grant execute on function faktura.registrer_push(text, text, text, text) to faktura_app;

-- ---------------------------------------------------------------------------
-- Hvilke varsler brukeren vil ha (gjelder alle enhetene). Mangler en nøkkel, er
-- varselet på.
-- ---------------------------------------------------------------------------

create table faktura.push_valg (
  bruker_id uuid primary key references faktura.brukere(id) on delete cascade,
  valg jsonb not null default '{}' check (jsonb_typeof(valg) = 'object'),
  oppdatert timestamptz not null default now()
);

alter table faktura.push_valg enable row level security;
create policy push_valg_egne on faktura.push_valg for all
  using (bruker_id = faktura.bruker_id() or faktura.er_system())
  with check (bruker_id = faktura.bruker_id() or faktura.er_system());
grant select, insert (bruker_id, valg), update (valg, oppdatert) on faktura.push_valg to faktura_app;

-- ---------------------------------------------------------------------------
-- Engangsnøkler, så samme varsel ikke sendes to ganger (Pub/Sub og jobber kan
-- levere/kjøre mer enn én gang).
-- ---------------------------------------------------------------------------

create table faktura.varsel_sendt (
  nokkel text primary key,
  sendt timestamptz not null default now()
);

create function faktura.varsle_en_gang(_nokkel text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  ny boolean;
begin
  if not faktura.er_system() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  insert into faktura.varsel_sendt (nokkel) values (_nokkel) on conflict do nothing returning true into ny;
  delete from faktura.varsel_sendt where sendt < now() - interval '120 days';
  return coalesce(ny, false);
end $$;
revoke all on function faktura.varsle_en_gang(text) from public;
grant execute on function faktura.varsle_en_gang(text) to faktura_system;
