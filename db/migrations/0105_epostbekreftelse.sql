-- Bekreftelsen av e-postadressen til nye kontoer. Identity Platform sendte lenken selv, fra sin
-- egen avsender (noreply@<prosjekt>.firebaseapp.com). Hos noen kom den ikke fram eller havnet i
-- søppelposten, og ingen kunne se det. Nå lager API-et lenken (firebase-admin), og workeren sender
-- den fra Admin Konsoll gjennom Resend, så den spores (levert, sprett, klage) som de andre
-- e-postene. Plattformadministratoren ser om en ny konto har bekreftet adressen og hvordan det
-- gikk med lenken, og kan sende en ny eller bekrefte adressen selv
-- (server/src/epostbekreftelse.ts).

-- Om e-postadressen er bekreftet, slik tokenet sist sa (null: ikke sett ennå), og hvilken
-- plattformadministrator som bekreftet den for brukeren, og når.
alter table faktura.brukere
  add column epost_bekreftet boolean,
  add column epost_bekreftet_av uuid references faktura.brukere(id) on delete set null,
  add column epost_bekreftet_at timestamptz;
-- De som er meldt til administratorene, hadde bekreftet adressen.
update faktura.brukere set epost_bekreftet = true where varslet_at is not null;

-- Lenkene som er sendt, med status fra Resend.
create table faktura.epostbekreftelser (
  id uuid primary key default gen_random_uuid(),
  bruker_id uuid not null references faktura.brukere(id) on delete cascade,
  til text not null,
  -- Plattformadministratoren som sendte den; null: brukeren ba om den selv.
  sendt_av uuid references faktura.brukere(id) on delete set null,
  ekstern_id text unique,                 -- id hos Resend
  status text not null default 'venter'
    check (status in ('venter', 'sendt', 'levert', 'forsinket', 'sprett', 'klage', 'feilet')),
  detaljer text,
  siste_hendelse_at timestamptz,
  opprettet timestamptz not null default now()
);
create index epostbekreftelser_bruker_idx on faktura.epostbekreftelser (bruker_id, opprettet desc);
-- Ingen leser tabellen direkte; funksjonene under gjør det.
alter table faktura.epostbekreftelser enable row level security;

-- Som før (0003), og om e-postadressen er bekreftet (fra tokenet). Et eldre token fra før
-- bekreftelsen gjør ikke en bekreftet adresse ubekreftet igjen; en ny adresse er ubekreftet til
-- tokenet sier noe annet.
drop function faktura.registrer_bruker(text, text, text);
create function faktura.registrer_bruker(_ekstern_id text, _epost text, _navn text default null, _epost_bekreftet boolean default null)
returns faktura.brukere
language plpgsql security definer set search_path = '' as $$
declare
  b faktura.brukere;
begin
  insert into faktura.brukere (ekstern_id, epost, navn, epost_bekreftet)
  values (_ekstern_id, lower(btrim(_epost)), _navn, _epost_bekreftet)
  on conflict (ekstern_id) do update
     set epost = excluded.epost,
         navn = coalesce(excluded.navn, faktura.brukere.navn),
         epost_bekreftet = case
           when excluded.epost_bekreftet is null then faktura.brukere.epost_bekreftet
           when excluded.epost_bekreftet or excluded.epost <> faktura.brukere.epost then excluded.epost_bekreftet
           else coalesce(faktura.brukere.epost_bekreftet, false)
         end
  returning * into b;
  return b;
end $$;

-- Den innloggede ber om en lenke (den første kommer rett fra registreringen): høyst én i minuttet
-- (de som feilet, teller ikke) og åtte i døgnet. Workeren sender den.
create function faktura.be_om_epostbekreftelse() returns faktura.epostbekreftelser
language plpgsql security definer set search_path = '' as $$
declare
  b faktura.brukere;
  e faktura.epostbekreftelser;
begin
  select * into b from faktura.brukere where id = faktura.bruker_id() for update;
  if not found then raise exception 'Ikke innlogget' using errcode = 'FA403'; end if;
  if b.epost_bekreftet then raise exception 'E-postadressen er alt bekreftet' using errcode = 'FA409'; end if;
  if exists (select 1 from faktura.epostbekreftelser x
              where x.bruker_id = b.id and x.sendt_av is null and x.status <> 'feilet' and x.opprettet > now() - interval '1 minute') then
    raise exception 'Vi sendte en lenke for under ett minutt siden. Vent litt før du ber om en ny.' using errcode = 'FA429';
  end if;
  if (select count(*) from faktura.epostbekreftelser x
       where x.bruker_id = b.id and x.sendt_av is null and x.opprettet > now() - interval '1 day') >= 8 then
    raise exception 'Du har bedt om mange lenker i dag. Prøv igjen i morgen, eller ta kontakt med Admin Konsoll.' using errcode = 'FA429';
  end if;
  insert into faktura.epostbekreftelser (bruker_id, til) values (b.id, b.epost) returning * into e;
  return e;
end $$;

-- Plattformadministratoren sender en ny lenke til brukeren (uten grensene over).
create function faktura.admin_send_epostbekreftelse(_bruker uuid) returns faktura.epostbekreftelser
language plpgsql security definer set search_path = '' as $$
declare
  b faktura.brukere;
  e faktura.epostbekreftelser;
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  select * into b from faktura.brukere where id = _bruker;
  if not found then raise exception 'Fant ikke brukeren' using errcode = 'FA404'; end if;
  if b.epost_bekreftet then raise exception 'E-postadressen er alt bekreftet' using errcode = 'FA409'; end if;
  insert into faktura.epostbekreftelser (bruker_id, til, sendt_av) values (b.id, b.epost, faktura.bruker_id()) returning * into e;
  return e;
end $$;

-- Plattformadministratoren bekrefter e-postadressen for brukeren (når hen vet at den er riktig).
-- API-et merker den som bekreftet i Identity Platform i samme transaksjon.
create function faktura.admin_bekreft_epost(_bruker uuid) returns faktura.brukere
language plpgsql security definer set search_path = '' as $$
declare
  b faktura.brukere;
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  update faktura.brukere
     set epost_bekreftet = true,
         epost_bekreftet_av = case when epost_bekreftet then epost_bekreftet_av else faktura.bruker_id() end,
         epost_bekreftet_at = case when epost_bekreftet then epost_bekreftet_at else now() end
   where id = _bruker
  returning * into b;
  if not found then raise exception 'Fant ikke brukeren' using errcode = 'FA404'; end if;
  return b;
end $$;

-- Workeren: det som trengs for å sende lenken.
create function faktura.epostbekreftelse_til_sending(_id uuid)
returns table (til text, navn text, status text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not faktura.er_system() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  return query
  select e.til, b.navn, e.status
    from faktura.epostbekreftelser e join faktura.brukere b on b.id = e.bruker_id
   where e.id = _id;
end $$;

-- Hvordan det gikk: sendt (med id-en hos Resend) eller feilet (med feilen, fra workeren eller fra
-- API-et når lenken ikke kunne lages). Et nytt forsøk som feiler, gjør ikke en sendt lenke feilet.
create function faktura.epostbekreftelse_sendt(_id uuid, _ekstern_id text, _feil text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  if _feil is null then
    update faktura.epostbekreftelser
       set status = case when status in ('venter', 'feilet') then 'sendt' else status end,
           ekstern_id = coalesce(ekstern_id, _ekstern_id),
           detaljer = case when status in ('venter', 'feilet') then null else detaljer end,
           siste_hendelse_at = now()
     where id = _id;
  else
    update faktura.epostbekreftelser
       set status = 'feilet', detaljer = left(_feil, 500), siste_hendelse_at = now()
     where id = _id and status in ('venter', 'feilet');
  end if;
end $$;

-- Som før (0009), og hendelsene for lenkene over. Retur og klage vinner alltid; «forsinket»
-- overstyrer ikke «levert».
create or replace function faktura.oppdater_epoststatus(_ekstern_id text, _status text, _detaljer text default null)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  e faktura.eposter;
  l faktura.epostbekreftelser;
begin
  select * into e from faktura.eposter where ekstern_id = _ekstern_id for update;
  if not found then
    select * into l from faktura.epostbekreftelser where ekstern_id = _ekstern_id for update;
    if not found then return false; end if;
    if l.status in ('sprett', 'klage') or (_status = 'forsinket' and l.status = 'levert') then return true; end if;
    update faktura.epostbekreftelser
       set status = _status, detaljer = coalesce(_detaljer, detaljer), siste_hendelse_at = now()
     where id = l.id;
    return true;
  end if;
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

-- Kontoene som venter (som i 0044), med om e-postadressen er bekreftet og den siste lenken som er
-- sendt (når, status, detaljene fra Resend, om administratoren sendte den, og hvor mange i alt).
drop function faktura.admin_kontoer_venter();
create function faktura.admin_kontoer_venter()
returns table (id uuid, epost text, navn text, opprettet timestamptz, varslet_at timestamptz, moduler text[],
               epost_bekreftet boolean, bekreftelse jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  return query
  select b.id, b.epost, b.navn, b.opprettet, b.varslet_at, faktura.bruker_modulliste(b.id),
         coalesce(b.epost_bekreftet, false),
         (select jsonb_build_object('opprettet', e.opprettet, 'status', e.status, 'detaljer', e.detaljer,
                                    'av_admin', e.sendt_av is not null, 'antall', count(*) over ())
            from faktura.epostbekreftelser e
           where e.bruker_id = b.id
           order by e.opprettet desc
           limit 1)
    from faktura.brukere b
   where b.status = 'venter'
   order by b.opprettet;
end $$;

-- Brukerlista i administrasjonen (som i 0044), med om e-postadressen er bekreftet.
drop function faktura.admin_brukere();
create function faktura.admin_brukere()
returns table (
  id uuid, epost text, navn text, opprettet timestamptz,
  organisasjoner jsonb, antall_passkeys bigint, sist_passkey timestamptz, sist_aktiv timestamptz,
  status text, behandlet_at timestamptz, avvist_grunn text, moduler text[], epost_bekreftet boolean
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
         b.status, b.behandlet_at, b.avvist_grunn, faktura.bruker_modulliste(b.id), b.epost_bekreftet
    from faktura.brukere b
   order by b.opprettet desc;
end $$;

revoke all on function
  faktura.registrer_bruker(text, text, text, boolean), faktura.be_om_epostbekreftelse(), faktura.admin_send_epostbekreftelse(uuid),
  faktura.admin_bekreft_epost(uuid), faktura.epostbekreftelse_til_sending(uuid), faktura.epostbekreftelse_sendt(uuid, text, text),
  faktura.admin_kontoer_venter(), faktura.admin_brukere()
from public;
grant execute on function
  faktura.registrer_bruker(text, text, text, boolean), faktura.be_om_epostbekreftelse(), faktura.admin_send_epostbekreftelse(uuid),
  faktura.admin_bekreft_epost(uuid), faktura.epostbekreftelse_sendt(uuid, text, text), faktura.admin_kontoer_venter(), faktura.admin_brukere()
to faktura_app;
grant execute on function faktura.epostbekreftelse_til_sending(uuid) to faktura_system;
