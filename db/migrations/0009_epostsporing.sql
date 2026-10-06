-- 0009_epostsporing.sql
-- Logg over e-post sendt for fakturaer og purringer, med status fra Resend (webhook).

create table faktura.eposter (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  faktura_id uuid references faktura.fakturaer(id),
  purring_id uuid references faktura.purringer(id),
  ekstern_id text unique,                 -- id hos Resend
  til text not null,
  emne text,
  status text not null default 'sendt' check (status in ('sendt', 'levert', 'forsinket', 'sprett', 'klage')),
  detaljer text,
  siste_hendelse_at timestamptz,
  opprettet timestamptz not null default now()
);
create index eposter_faktura_idx on faktura.eposter (faktura_id, opprettet desc);

alter table faktura.eposter enable row level security;
create policy eposter_les on faktura.eposter for select using (faktura.kan(org_id, 'les'));
grant select on faktura.eposter to faktura_app;

-- Workeren logger hver sending.
create function faktura.logg_epost(_org uuid, _faktura uuid, _purring uuid, _ekstern_id text, _til text, _emne text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not faktura.er_system() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  insert into faktura.eposter (org_id, faktura_id, purring_id, ekstern_id, til, emne)
  values (_org, _faktura, _purring, _ekstern_id, _til, _emne)
  on conflict (ekstern_id) do nothing;
end $$;

-- Kalles av API-et når Resend melder en hendelse (signaturen er sjekket i API-et).
-- Retur og klage vinner alltid; «forsinket» overstyrer ikke «levert».
create function faktura.oppdater_epoststatus(_ekstern_id text, _status text, _detaljer text default null)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  e faktura.eposter;
begin
  select * into e from faktura.eposter where ekstern_id = _ekstern_id for update;
  if not found then return false; end if;
  if e.status in ('sprett', 'klage') then return true; end if;
  if _status = 'forsinket' and e.status = 'levert' then return true; end if;
  update faktura.eposter
     set status = _status, detaljer = coalesce(_detaljer, detaljer), siste_hendelse_at = now()
   where id = e.id;
  if _status in ('sprett', 'klage') then
    insert into faktura.utboks (org_id, hendelse, aggregat_id, data)
    values (e.org_id, case _status when 'sprett' then 'epost.sprett' else 'epost.klage' end, coalesce(e.faktura_id, e.id),
            jsonb_build_object('faktura_id', e.faktura_id, 'til', e.til, 'detaljer', _detaljer));
  end if;
  return true;
end $$;

grant execute on function faktura.logg_epost(uuid, uuid, uuid, text, text, text) to faktura_system;
grant execute on function faktura.oppdater_epoststatus(text, text, text) to faktura_app;
