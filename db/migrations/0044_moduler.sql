-- Moduler: de store delene av plattformen, som en kunde trenger hver for seg (foreløpig
-- Faktura og Bemanning). Hver funksjon (0041) hører til en modul. Den som lager en konto,
-- krysser av for modulene den trenger, og valget kommer med i forespørselen til
-- plattformadministratorene (0043), som godkjenner kontoen med de modulene (og kan endre dem).
-- Organisasjonene brukeren lager etterpå, får bare funksjonene i de godkjente modulene (av
-- standarden for nye organisasjoner). Brukere uten moduler (de som hadde konto fra før, og de
-- som er godkjent av en invitasjon uten å ha valgt) får standarden som før.
--
-- En ny modul er en rad her og funksjonene dens (med modulen satt); da kommer den med i
-- registreringen, forespørselen, godkjenningen og administrasjonen uten flere endringer.

create table faktura.moduler (
  kode text primary key check (kode ~ '^[a-z_]{2,30}$'),
  navn text not null,
  beskrivelse text not null,
  rekkefolge int not null
);

insert into faktura.moduler (kode, navn, beskrivelse, rekkefolge) values
  ('faktura', 'Faktura', 'Fakturaer og kreditnotaer, kunder og produkter, EHF, innbetalinger fra banken, gjentakende fakturaer, påminnelser og rapporter', 1),
  ('bemanning', 'Bemanning', 'Ansatte og timeføring, vaktplan, tavle, fravær og vikarer, bemanningskalender og faste arbeidsdager', 2);

alter table faktura.funksjoner add column modul text references faktura.moduler(kode);
update faktura.funksjoner set modul = case when kode in ('ansatte', 'vaktplan') then 'bemanning' else 'faktura' end;
alter table faktura.funksjoner alter column modul set not null;

-- Modulene alle kan se (også før innloggingen, i registreringen).
alter table faktura.moduler enable row level security;
create policy moduler_les on faktura.moduler for select using (true);
grant select on faktura.moduler to faktura_app, faktura_system;

-- Modulene brukeren har bedt om; når kontoen er godkjent, modulene administratoren godkjente.
create table faktura.bruker_moduler (
  bruker_id uuid not null references faktura.brukere(id) on delete cascade,
  modul text not null references faktura.moduler(kode) on delete cascade,
  primary key (bruker_id, modul)
);
alter table faktura.bruker_moduler enable row level security;
create policy bruker_moduler_les on faktura.bruker_moduler for select using (bruker_id = faktura.bruker_id() or faktura.er_betrodd());
grant select on faktura.bruker_moduler to faktura_app;

-- Modulene til en bruker, i rekkefølgen modulene har.
create function faktura.bruker_modulliste(_bruker uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(m.kode order by m.rekkefolge), '{}')
    from faktura.bruker_moduler b join faktura.moduler m on m.kode = b.modul
   where b.bruker_id = _bruker
$$;

-- Bytter ut modulene til en bruker (minst én, og bare kjente).
create function faktura.sett_bruker_moduler(_bruker uuid, _moduler text[]) returns text[]
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(cardinality(_moduler), 0) = 0 then raise exception 'Velg minst én modul' using errcode = 'FA400'; end if;
  if exists (select 1 from unnest(_moduler) k where k not in (select kode from faktura.moduler)) then
    raise exception 'Ukjent modul' using errcode = 'FA400';
  end if;
  delete from faktura.bruker_moduler where bruker_id = _bruker and modul <> all (_moduler);
  insert into faktura.bruker_moduler (bruker_id, modul) select _bruker, k from unnest(_moduler) k on conflict do nothing;
  return faktura.bruker_modulliste(_bruker);
end $$;
revoke all on function faktura.bruker_modulliste(uuid), faktura.sett_bruker_moduler(uuid, text[]) from public;

-- Den innloggede velger modulene sine mens kontoen venter (ved registreringen, eller etterpå
-- til den er godkjent). Etter godkjenningen er det administratoren som endrer.
create function faktura.velg_moduler(_moduler text[]) returns text[]
language plpgsql security definer set search_path = '' as $$
declare
  _status text := (select status from faktura.brukere where id = faktura.bruker_id());
begin
  if _status is null then raise exception 'Ikke innlogget' using errcode = 'FA403'; end if;
  if _status <> 'venter' then raise exception 'Kontoen er alt behandlet' using errcode = 'FA403'; end if;
  return faktura.sett_bruker_moduler(faktura.bruker_id(), _moduler);
end $$;

-- Som før (0043), men forespørselen meldes først når brukeren også har valgt moduler.
create or replace function faktura.meld_konto() returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update faktura.brukere b set varslet_at = now()
   where b.id = faktura.bruker_id() and b.status = 'venter' and b.varslet_at is null and length(btrim(coalesce(b.navn, ''))) >= 2
     and exists (select 1 from faktura.bruker_moduler m where m.bruker_id = b.id);
  return found;
end $$;

-- Godkjenn eller avvis en konto som før (0043). Med moduler godkjennes kontoen med dem (i stedet
-- for dem brukeren ba om).
drop function faktura.behandle_konto(uuid, boolean, text);
create function faktura.behandle_konto(_bruker uuid, _godkjent boolean, _grunn text default null, _moduler text[] default null)
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
  if _godkjent and _moduler is not null then perform faktura.sett_bruker_moduler(_bruker, _moduler); end if;
  return b;
end $$;

-- Kontoene som venter, med modulene de har bedt om.
drop function faktura.admin_kontoer_venter();
create function faktura.admin_kontoer_venter()
returns table (id uuid, epost text, navn text, opprettet timestamptz, varslet_at timestamptz, moduler text[])
language plpgsql stable security definer set search_path = '' as $$
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  return query
  select b.id, b.epost, b.navn, b.opprettet, b.varslet_at, faktura.bruker_modulliste(b.id)
    from faktura.brukere b
   where b.status = 'venter'
   order by b.opprettet;
end $$;

-- Brukerlista i administrasjonen: med modulene.
drop function faktura.admin_brukere();
create function faktura.admin_brukere()
returns table (
  id uuid, epost text, navn text, opprettet timestamptz,
  organisasjoner jsonb, antall_passkeys bigint, sist_passkey timestamptz, sist_aktiv timestamptz,
  status text, behandlet_at timestamptz, avvist_grunn text, moduler text[]
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
         b.status, b.behandlet_at, b.avvist_grunn, faktura.bruker_modulliste(b.id)
    from faktura.brukere b
   order by b.opprettet desc;
end $$;

-- Funksjonsoversikten i administrasjonen (som i 0041): med modulene, og funksjonene modul for
-- modul.
create or replace function faktura.admin_funksjoner() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  return jsonb_build_object(
    'moduler', (select coalesce(jsonb_agg(jsonb_build_object('kode', m.kode, 'navn', m.navn, 'beskrivelse', m.beskrivelse) order by m.rekkefolge), '[]'::jsonb)
                  from faktura.moduler m),
    'funksjoner', (select coalesce(jsonb_agg(jsonb_build_object('kode', f.kode, 'navn', f.navn, 'beskrivelse', f.beskrivelse, 'krever', f.krever,
                                                                 'standard', f.standard, 'modul', f.modul) order by m.rekkefolge, f.rekkefolge), '[]'::jsonb)
                     from faktura.funksjoner f join faktura.moduler m on m.kode = f.modul),
    'organisasjoner', (select coalesce(jsonb_agg(jsonb_build_object(
                                 'id', o.id, 'navn', o.navn, 'orgnr', o.orgnr, 'type', o.type, 'verifisering', o.verifisering,
                                 'aktive', (select coalesce(jsonb_agg(x.kode order by f.rekkefolge), '[]'::jsonb)
                                              from faktura.org_funksjoner x join faktura.funksjoner f on f.kode = x.kode
                                             where x.org_id = o.id and x.aktiv),
                                 'endret', (select max(x.endret) from faktura.org_funksjoner x where x.org_id = o.id and x.endret_av is not null))
                               order by o.navn), '[]'::jsonb)
                         from faktura.organisasjoner o)
  );
end $$;

-- En ny organisasjon får standarden (0041), men bare i modulene brukeren som lager den, har
-- (når brukeren har moduler). Har brukeren bedt om (og fått) ansatte og timer, er det slått på
-- fra start; ellers slås det på under Innstillinger → Ansatte og timer.
create or replace function faktura.organisasjon_funksjoner() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  _moduler text[] := faktura.bruker_modulliste(faktura.bruker_id());
begin
  insert into faktura.org_funksjoner (org_id, kode, aktiv)
  select new.id, f.kode, f.standard and (cardinality(_moduler) = 0 or f.modul = any (_moduler))
    from faktura.funksjoner f
  on conflict do nothing;
  if cardinality(_moduler) > 0 and exists (select 1 from faktura.org_funksjoner where org_id = new.id and kode = 'ansatte' and aktiv) then
    insert into faktura.lonn_oppsett (org_id, aktiv) values (new.id, true) on conflict do nothing;
  end if;
  return null;
end $$;

revoke all on function faktura.velg_moduler(text[]), faktura.behandle_konto(uuid, boolean, text, text[]), faktura.admin_kontoer_venter(),
  faktura.admin_brukere() from public;
grant execute on function faktura.velg_moduler(text[]), faktura.behandle_konto(uuid, boolean, text, text[]), faktura.admin_kontoer_venter(),
  faktura.admin_brukere() to faktura_app;
grant execute on function faktura.behandle_konto(uuid, boolean, text, text[]) to faktura_system;
