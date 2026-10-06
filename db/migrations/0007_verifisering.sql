-- 0007_verifisering.sql
-- Verifisering av at brukeren kan representere foretaket, og plattformadministrasjon.
--
-- «Betrodd» betyr at API-et selv har sjekket noe databasen ikke kan sjekke (e-postdomenet
-- mot Enhetsregisteret, eller at brukeren er plattformadministrator) og setter
-- app.betrodd = 'on' i den transaksjonen. API-et er like betrodd som når det setter
-- app.bruker_id; RLS er ekstra sikring, ikke den eneste.

create function faktura.er_betrodd() returns boolean
language sql stable set search_path = '' as $$
  select faktura.er_system() or coalesce(current_setting('app.betrodd', true), '') = 'on'
$$;

create or replace function faktura.sett_verifisering(_org uuid, _status text, _metode text default null, _grunn text default null)
returns faktura.organisasjoner
language plpgsql security definer set search_path = '' as $$
declare
  o faktura.organisasjoner;
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  if _status = 'verifisert' and (select orgnr from faktura.organisasjoner where id = _org) is null then
    raise exception 'Organisasjonen mangler organisasjonsnummer' using errcode = 'FA400';
  end if;
  if _status = 'verifisert' and exists (
       select 1 from faktura.organisasjoner a join faktura.organisasjoner b on b.orgnr = a.orgnr
        where a.id = _org and b.id <> _org and b.verifisering = 'verifisert') then
    raise exception 'Organisasjonsnummeret er allerede verifisert hos en annen konto. Kontakt support.' using errcode = 'FA409';
  end if;
  update faktura.organisasjoner
     set verifisering = _status,
         verifisert_at = case when _status = 'verifisert' then now() else verifisert_at end,
         verifisert_metode = case when _status = 'verifisert' then _metode else verifisert_metode end,
         sperret_grunn = case when _status = 'sperret' then _grunn end,
         -- Verifiserte får grensene fjernet; tilbake til «ny» gir standardgrensene igjen.
         maks_fakturaer_mnd = case _status when 'verifisert' then null when 'ny' then 20 else maks_fakturaer_mnd end,
         maks_belop_mnd = case _status when 'verifisert' then null when 'ny' then 50000 else maks_belop_mnd end
   where id = _org
  returning * into o;
  if not found then raise exception 'Fant ikke organisasjonen' using errcode = 'FA404'; end if;
  update faktura.verifiseringer
     set status = case when _status = 'verifisert' then 'godkjent' else 'avvist' end,
         behandlet_av = faktura.bruker_id(), behandlet_at = now()
   where org_id = _org and status = 'venter' and _status in ('verifisert', 'sperret');
  return o;
end $$;

create table faktura.verifiseringer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  bruker_id uuid references faktura.brukere(id),
  metode text not null check (metode in ('epostdomene', 'brreg_epost', 'manuell')),
  status text not null default 'venter' check (status in ('venter', 'godkjent', 'avvist', 'utlopt')),
  kode_hash bytea,
  sendt_til text,
  forsok int not null default 0,
  utloper timestamptz,
  notat text,
  opprettet timestamptz not null default now(),
  behandlet_av uuid references faktura.brukere(id),
  behandlet_at timestamptz
);
create index verifiseringer_org_idx on faktura.verifiseringer (org_id, opprettet desc);
create index verifiseringer_venter_idx on faktura.verifiseringer (opprettet) where status = 'venter' and metode = 'manuell';

alter table faktura.verifiseringer enable row level security;
create policy verifiseringer_les on faktura.verifiseringer for select using (faktura.kan(org_id, 'admin'));
-- Kodens hash er aldri lesbar for appen; den sjekkes i funksjonen under.
grant select (id, org_id, bruker_id, metode, status, sendt_til, forsok, utloper, notat, opprettet, behandlet_at)
  on faktura.verifiseringer to faktura_app;

create trigger verifiseringer_revisjon after insert or update on faktura.verifiseringer
  for each row execute function faktura.revider();

-- Lagrer en engangskode (som hash) sendt til foretakets e-post i Enhetsregisteret.
create function faktura.start_verifiseringskode(_org uuid, _sendt_til text, _kode text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  id uuid;
begin
  perform faktura.krev(_org, 'admin');
  if (select count(*) from faktura.verifiseringer
       where org_id = _org and metode = 'brreg_epost' and opprettet > now() - interval '1 hour') >= 5 then
    raise exception 'For mange koder sendt. Prøv igjen om en time.' using errcode = 'FA429';
  end if;
  update faktura.verifiseringer set status = 'utlopt'
   where org_id = _org and metode = 'brreg_epost' and status = 'venter';
  insert into faktura.verifiseringer (org_id, bruker_id, metode, kode_hash, sendt_til, utloper)
  values (_org, faktura.bruker_id(), 'brreg_epost', sha256(convert_to(_kode, 'UTF8')), _sendt_til, now() + interval '30 minutes')
  returning verifiseringer.id into id;
  return id;
end $$;

-- Sjekker koden. Fem feil forsøk gjør koden ugyldig.
create function faktura.sjekk_verifiseringskode(_org uuid, _kode text)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v faktura.verifiseringer;
begin
  perform faktura.krev(_org, 'admin');
  select * into v from faktura.verifiseringer
   where org_id = _org and metode = 'brreg_epost' and status = 'venter'
   order by opprettet desc limit 1 for update;
  if not found or v.utloper < now() then
    raise exception 'Ingen gyldig kode. Be om en ny.' using errcode = 'FA409';
  end if;
  if v.kode_hash <> sha256(convert_to(btrim(_kode), 'UTF8')) then
    update faktura.verifiseringer
       set forsok = forsok + 1, status = case when forsok + 1 >= 5 then 'utlopt' else status end
     where id = v.id;
    return false;
  end if;
  update faktura.verifiseringer set status = 'godkjent', behandlet_at = now() where id = v.id;
  set local app.betrodd = 'on';
  perform faktura.sett_verifisering(_org, 'verifisert', 'brreg_epost');
  set local app.betrodd = 'off';
  return true;
end $$;

-- Automatisk verifisering når API-et har sjekket at e-postdomenet hører til foretaket.
create function faktura.verifiser_epostdomene(_org uuid, _epost text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  perform faktura.krev(_org, 'admin');
  insert into faktura.verifiseringer (org_id, bruker_id, metode, status, sendt_til, behandlet_at)
  values (_org, faktura.bruker_id(), 'epostdomene', 'godkjent', _epost, now());
  perform faktura.sett_verifisering(_org, 'verifisert', 'epostdomene');
end $$;

-- Ber plattformadministrator om manuell godkjenning.
create function faktura.be_om_manuell_verifisering(_org uuid, _notat text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  id uuid;
begin
  perform faktura.krev(_org, 'admin');
  select v.id into id from faktura.verifiseringer v where v.org_id = _org and v.metode = 'manuell' and v.status = 'venter';
  if found then return id; end if;
  insert into faktura.verifiseringer (org_id, bruker_id, metode, notat)
  values (_org, faktura.bruker_id(), 'manuell', _notat)
  returning verifiseringer.id into id;
  return id;
end $$;

-- Plattformadministrasjon: alle organisasjoner med eier, bruk og ventende forespørsler.
create function faktura.admin_organisasjoner()
returns table (
  id uuid, navn text, orgnr text, type text, verifisering text, verifisert_metode text, sperret_grunn text,
  opprettet timestamptz, eier_epost text, antall_fakturaer bigint, sum_fakturert numeric,
  venter_manuell boolean, notat text
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  return query
  select o.id, o.navn, o.orgnr, o.type, o.verifisering, o.verifisert_metode, o.sperret_grunn, o.opprettet,
         (select string_agg(b.epost, ', ') from faktura.medlemmer m join faktura.brukere b on b.id = m.bruker_id
           where m.org_id = o.id and m.rolle = 'eier'),
         (select count(*) from faktura.fakturaer f where f.org_id = o.id and f.status <> 'utkast'),
         (select coalesce(sum(f.sum_inkl_mva), 0) from faktura.fakturaer f where f.org_id = o.id and f.status <> 'utkast' and f.type = 'faktura'),
         exists (select 1 from faktura.verifiseringer v where v.org_id = o.id and v.metode = 'manuell' and v.status = 'venter'),
         (select v.notat from faktura.verifiseringer v where v.org_id = o.id and v.metode = 'manuell' and v.status = 'venter' limit 1)
    from faktura.organisasjoner o
   order by 12 desc, o.opprettet desc;
end $$;

grant execute on function
  faktura.er_betrodd(),
  faktura.sett_verifisering(uuid, text, text, text),
  faktura.start_verifiseringskode(uuid, text, text),
  faktura.sjekk_verifiseringskode(uuid, text),
  faktura.be_om_manuell_verifisering(uuid, text),
  faktura.verifiser_epostdomene(uuid, text),
  faktura.admin_organisasjoner()
to faktura_app;
