-- Nye kontoer må godkjennes: når e-postadressen er bekreftet (og navnet skrevet inn), går en
-- forespørsel til plattformadministratorene, og brukeren kommer ikke inn før den er godkjent
-- (API-et slipper bare gjennom /meg og invitasjoner, server/src/kontoer.ts). De som har konto
-- fra før, er godkjent. Den som tar imot en invitasjon fra en organisasjon (sendt til
-- e-postadressen sin), godkjennes da; organisasjonen går god for den.

alter table faktura.brukere
  add column status text not null default 'godkjent' check (status in ('venter', 'godkjent', 'avvist')),
  add column behandlet_at timestamptz,
  add column behandlet_av uuid references faktura.brukere(id) on delete set null,
  add column avvist_grunn text,
  add column varslet_at timestamptz;  -- når administratorene fikk forespørselen
-- Nye brukere venter (de som fantes, fikk «godkjent» over).
alter table faktura.brukere alter column status set default 'venter';
create index brukere_venter_idx on faktura.brukere (opprettet) where status = 'venter';

-- Godkjenn eller avvis en konto: plattformadministratoren (betrodd kall), og API-et for
-- plattformadministratorene selv.
create function faktura.behandle_konto(_bruker uuid, _godkjent boolean, _grunn text default null)
returns faktura.brukere
language plpgsql security definer set search_path = '' as $$
declare
  b faktura.brukere;
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  update faktura.brukere
     set status = case when _godkjent then 'godkjent' else 'avvist' end,
         behandlet_at = now(),
         behandlet_av = faktura.bruker_id(),
         avvist_grunn = case when _godkjent then null else nullif(btrim(_grunn), '') end
   where id = _bruker
  returning * into b;
  if not found then raise exception 'Fant ikke brukeren' using errcode = 'FA404'; end if;
  return b;
end $$;

-- Den innloggede venter, har navn og er ikke meldt til administratorene ennå: merk den som
-- meldt (én gang). true: forespørselen skal sendes nå.
create function faktura.meld_konto() returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update faktura.brukere set varslet_at = now()
   where id = faktura.bruker_id() and status = 'venter' and varslet_at is null and length(btrim(coalesce(navn, ''))) >= 2;
  return found;
end $$;

-- Kontoene som venter på godkjenning (Administrasjon → Venter).
create function faktura.admin_kontoer_venter()
returns table (id uuid, epost text, navn text, opprettet timestamptz, varslet_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  return query
  select b.id, b.epost, b.navn, b.opprettet, b.varslet_at
    from faktura.brukere b
   where b.status = 'venter'
   order by b.opprettet;
end $$;

-- Brukerlista i administrasjonen: med status (venter, godkjent, avvist).
drop function faktura.admin_brukere();
create function faktura.admin_brukere()
returns table (
  id uuid, epost text, navn text, opprettet timestamptz,
  organisasjoner jsonb, antall_passkeys bigint, sist_passkey timestamptz, sist_aktiv timestamptz,
  status text, behandlet_at timestamptz, avvist_grunn text
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  return query
  select b.id, b.epost, b.navn, b.opprettet,
         coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'navn', o.navn, 'rolle', m.rolle, 'verifisering', o.verifisering) order by o.navn)
                     from faktura.medlemmer m join faktura.organisasjoner o on o.id = m.org_id
                    where m.bruker_id = b.id), '[]'::jsonb),
         (select count(*) from faktura.passkeys p where p.bruker_id = b.id),
         (select max(p.sist_brukt) from faktura.passkeys p where p.bruker_id = b.id),
         (select max(r.tid) from faktura.revisjonslogg r where r.bruker_id = b.id),
         b.status, b.behandlet_at, b.avvist_grunn
    from faktura.brukere b
   order by b.opprettet desc;
end $$;

revoke all on function faktura.behandle_konto(uuid, boolean, text), faktura.meld_konto(), faktura.admin_kontoer_venter(), faktura.admin_brukere() from public;
grant execute on function faktura.behandle_konto(uuid, boolean, text), faktura.admin_kontoer_venter(), faktura.admin_brukere() to faktura_app;
grant execute on function faktura.behandle_konto(uuid, boolean, text) to faktura_system;
grant execute on function faktura.meld_konto() to faktura_app;

-- Som før (0035), og den som tar imot en invitasjon til e-postadressen sin, godkjennes (en
-- avvist konto forblir avvist).
create or replace function faktura.aksepter_invitasjon(_token text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  inv faktura.invitasjoner;
  bruker faktura.brukere;
begin
  select * into bruker from faktura.brukere where id = faktura.bruker_id();
  if not found then raise exception 'Ikke innlogget' using errcode = 'FA403'; end if;

  select * into inv from faktura.invitasjoner
   where token_hash = sha256(convert_to(_token, 'UTF8')) for update;
  if not found or inv.akseptert_at is not null or inv.utloper < now() then
    raise exception 'Invitasjonen er ugyldig eller utløpt' using errcode = 'FA404';
  end if;
  if inv.epost <> bruker.epost then
    raise exception 'Invitasjonen gjelder en annen e-postadresse' using errcode = 'FA403';
  end if;
  if bruker.status = 'avvist' then
    raise exception 'Kontoen er ikke godkjent' using errcode = 'FA403';
  end if;

  insert into faktura.medlemmer (org_id, bruker_id, rolle) values (inv.org_id, bruker.id, inv.rolle)
  on conflict (org_id, bruker_id) do nothing;
  if inv.ansatt_id is not null then
    if exists (select 1 from faktura.ansatte where org_id = inv.org_id and bruker_id = bruker.id and id <> inv.ansatt_id) then
      raise exception 'Du er alt koblet til en annen ansatt i organisasjonen' using errcode = 'FA409';
    end if;
    update faktura.ansatte set bruker_id = bruker.id
     where org_id = inv.org_id and id = inv.ansatt_id and (bruker_id is null or bruker_id = bruker.id);
  end if;
  update faktura.invitasjoner set akseptert_av = bruker.id, akseptert_at = now() where id = inv.id;
  if bruker.status = 'venter' then
    update faktura.brukere set status = 'godkjent', behandlet_at = now() where id = bruker.id;
  end if;
  return inv.org_id;
end $$;
