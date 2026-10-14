-- 0111_tilgangsroller.sql
-- Egne roller i organisasjonen (tilgangsroller): bedriftsadministratoren (eier og administrator)
-- lager roller som «Daglig leder», «Økonomiansvarlig» og «Personalansvarlig», og velger modulene
-- hver av dem gir tilgang til: Faktura, Personal, Lønn og Regnskap (0110_moduler.sql; Lønn bygger
-- på Personal). Den som har en slik rolle, har rollen «tilpasset» i medlemmer, med tilgangsrollen
-- ved siden av. De faste rollene (eier, administrator, fakturerer, regnskap, les og ansatt) er som
-- før.
--
-- Tilgangen håndheves i faktura.kan, som for de faste rollene. Innenfor en modul har rollen det
-- administratoren har, bortsett fra administrasjonen (innstillingene, brukerne og rollene), som
-- bare eier og administrator har:
--   - Faktura: lese, skrive og utstede fakturaer, kunder og produkter, og bokføre innbetalinger.
--   - Regnskap: regnskapet, og lese fakturaene (som regnskapsføreren).
--   - Personal: de ansatte, timene, vaktplanen, fraværet og ferien.
--   - Lønn: lønnen. Lønnsdataene deler tilgangen (personal og personal_les) med personalet, så
--     API-et sier hvilken modul forespørselen gjelder (app.modul, server/src/funksjoner.ts): i
--     lønnsrutene er det Lønn som gir den tilgangen, ellers Personal. En personalansvarlig uten
--     Lønn ser da ikke lønnskjøringene, og ellers bare sin egen lønn. I regnskapsrutene gir
--     Regnskap også lesetilgangen, så lønnsbilagene er med i regnskapet.
-- En rolle uten moduler er som rollen ansatt: bare sitt eget.

-- ---------------------------------------------------------------------------
-- Rollene
-- ---------------------------------------------------------------------------

create table faktura.tilgangsroller (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  navn text not null check (length(btrim(navn)) between 2 and 60),
  beskrivelse text check (beskrivelse is null or length(beskrivelse) <= 300),
  moduler text[] not null default '{}'
    check (moduler <@ array['faktura', 'personal', 'lonn', 'regnskap']::text[]
           and (not 'lonn' = any (moduler) or 'personal' = any (moduler))),
  opprettet timestamptz not null default now(),
  endret timestamptz not null default now(),
  unique (org_id, id)
);
create unique index tilgangsroller_navn on faktura.tilgangsroller (org_id, lower(btrim(navn)));

alter table faktura.tilgangsroller enable row level security;
-- Alle i organisasjonen ser rollene (navnet og modulene); de endres bare gjennom funksjonene under.
create policy tilgangsroller_les on faktura.tilgangsroller for select using (faktura.kan(org_id, 'medlem'));
grant select on faktura.tilgangsroller to faktura_app, faktura_system;

alter table faktura.medlemmer drop constraint medlemmer_rolle_check;
alter table faktura.medlemmer add constraint medlemmer_rolle_check
  check (rolle in ('eier', 'admin', 'fakturerer', 'regnskap', 'les', 'ansatt', 'tilpasset'));
alter table faktura.medlemmer add column tilgangsrolle_id uuid;
alter table faktura.medlemmer add constraint medlemmer_tilgangsrolle_fk
  foreign key (org_id, tilgangsrolle_id) references faktura.tilgangsroller (org_id, id);
alter table faktura.medlemmer add constraint medlemmer_tilpasset check ((rolle = 'tilpasset') = (tilgangsrolle_id is not null));
create index medlemmer_tilgangsrolle on faktura.medlemmer (org_id, tilgangsrolle_id) where tilgangsrolle_id is not null;

alter table faktura.invitasjoner drop constraint invitasjoner_rolle_check;
alter table faktura.invitasjoner add constraint invitasjoner_rolle_check
  check (rolle in ('admin', 'fakturerer', 'regnskap', 'les', 'ansatt', 'tilpasset'));
alter table faktura.invitasjoner add column tilgangsrolle_id uuid;
-- Brukte og utløpte invitasjoner forsvinner med rollen (en rolle som venter på en invitasjon,
-- kan ikke slettes, se slett_tilgangsrolle).
alter table faktura.invitasjoner add constraint invitasjoner_tilgangsrolle_fk
  foreign key (org_id, tilgangsrolle_id) references faktura.tilgangsroller (org_id, id) on delete cascade;
alter table faktura.invitasjoner add constraint invitasjoner_tilpasset check ((rolle = 'tilpasset') = (tilgangsrolle_id is not null));

-- Rangeringen (den høyeste rollen vinner når man både er medlem og har tilgang gjennom et byrå):
-- en egen rolle mellom fakturerer og regnskap.
create or replace function faktura.rolle_rang(_rolle text) returns integer
language sql immutable set search_path = '' as $$
  select case _rolle when 'eier' then 6 when 'admin' then 5 when 'fakturerer' then 4 when 'tilpasset' then 3
                     when 'regnskap' then 2 when 'les' then 1 else 0 end
$$;

-- Modulene den innloggede har gjennom sin egen rolle i organisasjonen (null uten en slik rolle).
create function faktura.rollemoduler(_org uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select t.moduler
    from faktura.medlemmer m join faktura.tilgangsroller t on t.org_id = m.org_id and t.id = m.tilgangsrolle_id
   where m.org_id = _org and m.bruker_id = faktura.bruker_id()
$$;

-- Om en bruker har modulen gjennom sin egen rolle (for varslene: hvem som skal ha dem).
create function faktura.tilpasset_har(_org uuid, _bruker uuid, _modul text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from faktura.medlemmer m join faktura.tilgangsroller t on t.org_id = m.org_id and t.id = m.tilgangsrolle_id
                  where m.org_id = _org and m.bruker_id = _bruker and m.rolle = 'tilpasset' and _modul = any (t.moduler))
$$;

revoke all on function faktura.rollemoduler(uuid), faktura.tilpasset_har(uuid, uuid, text) from public;
grant execute on function faktura.rollemoduler(uuid), faktura.tilpasset_har(uuid, uuid, text) to faktura_app, faktura_system;

-- ---------------------------------------------------------------------------
-- Tilgangen
-- ---------------------------------------------------------------------------

-- Som i 0086, med de egne rollene: modulene i rollen, og modulen forespørselen gjelder
-- (app.modul, satt av API-et): i lønnsrutene gir Lønn tilgangen til personaldataene, i
-- regnskapsrutene gir Regnskap lesetilgangen (lønnsbilagene), ellers er det Personal.
create or replace function faktura.kan(_org uuid, _handling text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  r text;
  m text[];
  k text;
  p boolean;
begin
  if faktura.er_system() then return true; end if;
  if faktura.bruker_id() is null or _org is null then return false; end if;
  r := faktura.rolle(_org);
  if r is null then return false; end if;
  if r = 'tilpasset' then
    m := coalesce(faktura.rollemoduler(_org), '{}');
    k := coalesce(current_setting('app.modul', true), '');
    -- Personaldataene: Lønn i lønnsrutene, ellers Personal.
    p := case when k = 'lonn' then 'lonn' = any (m) else 'personal' = any (m) end;
    return case _handling
      when 'les'          then 'faktura' = any (m) or 'regnskap' = any (m) or (k = 'lonn' and 'lonn' = any (m))
      when 'skriv'        then 'faktura' = any (m)
      when 'utsted'       then 'faktura' = any (m)
      when 'bokfor'       then 'faktura' = any (m) or 'regnskap' = any (m)
      when 'regnskap'     then 'regnskap' = any (m)
      when 'personal'     then p
      when 'personal_les' then p or (k = 'regnskap' and 'regnskap' = any (m))
      when 'plan'         then p or faktura.min_ansatt(_org) is not null
      when 'medlem'       then true
      else false  -- admin og eier
    end;
  end if;
  return case _handling
    when 'les'          then r <> 'ansatt'
    when 'skriv'        then r in ('eier', 'admin', 'fakturerer')
    when 'utsted'       then r in ('eier', 'admin', 'fakturerer')
    when 'bokfor'       then r in ('eier', 'admin', 'fakturerer', 'regnskap')
    when 'admin'        then r in ('eier', 'admin')
    when 'eier'         then r = 'eier'
    when 'personal'     then r in ('eier', 'admin')
    when 'personal_les' then r in ('eier', 'admin', 'regnskap')
    when 'regnskap'     then r in ('eier', 'admin', 'regnskap')
    when 'plan'         then r in ('eier', 'admin', 'regnskap') or faktura.min_ansatt(_org) is not null
    when 'medlem'       then true
    else false
  end;
end $$;

-- Tilgangen i en bestemt modul (rapportlista: hver rapport etter modulen sin), uten å endre
-- modulen for resten av forespørselen.
create function faktura.kan_i_modul(_org uuid, _handling text, _modul text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  forrige text := coalesce(current_setting('app.modul', true), '');
  svar boolean;
begin
  perform set_config('app.modul', coalesce(_modul, ''), true);
  svar := faktura.kan(_org, _handling);
  perform set_config('app.modul', forrige, true);
  return svar;
end $$;
revoke all on function faktura.kan_i_modul(uuid, text, text) from public;
grant execute on function faktura.kan_i_modul(uuid, text, text) to faktura_app, faktura_system;

-- Som i 0035, men et byrås ansatte med en egen rolle kommer bare inn hos klientene når rollen har
-- Regnskap.
create or replace function faktura.rolle(_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select r.rolle from (
    select m.rolle
      from faktura.medlemmer m
     where m.org_id = _org and m.bruker_id = faktura.bruker_id()
    union all
    select case when bm.rolle = 'les' or t.rolle = 'les' then 'les' else 'regnskap' end
      from faktura.org_tilgang t
      join faktura.medlemmer bm on bm.org_id = t.byraa_org_id and bm.bruker_id = faktura.bruker_id()
     where t.klient_org_id = _org
       and t.status = 'aktiv'
       and (t.utloper is null or t.utloper >= faktura.i_dag())
       and bm.rolle <> 'ansatt'
       and (bm.rolle <> 'tilpasset' or faktura.tilpasset_har(bm.org_id, bm.bruker_id, 'regnskap'))
  ) r
  order by faktura.rolle_rang(r.rolle) desc
  limit 1
$$;

-- Varsler om fakturaene (workeren): de som kan lese dem. Med en egen rolle: Faktura eller
-- Regnskap.
create or replace function faktura.bruker_kan_lese(_bruker uuid, _org uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if not faktura.er_system() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  return exists (
    select 1 from faktura.medlemmer m
     where m.org_id = _org and m.bruker_id = _bruker and m.rolle <> 'ansatt'
       and (m.rolle <> 'tilpasset' or faktura.tilpasset_har(_org, _bruker, 'faktura') or faktura.tilpasset_har(_org, _bruker, 'regnskap'))
    union all
    select 1 from faktura.org_tilgang t join faktura.medlemmer bm on bm.org_id = t.byraa_org_id and bm.bruker_id = _bruker
     where t.klient_org_id = _org and t.status = 'aktiv' and (t.utloper is null or t.utloper >= faktura.i_dag())
       and bm.rolle <> 'ansatt'
       and (bm.rolle <> 'tilpasset' or faktura.tilpasset_har(bm.org_id, _bruker, 'regnskap'))
  );
end $$;

-- ---------------------------------------------------------------------------
-- Lage, endre og slette roller (eier og administrator)
-- ---------------------------------------------------------------------------

-- Ny rolle (uten _id) eller endring. Modulene må være slått på for organisasjonen; Lønn tar med
-- Personal.
create function faktura.lagre_tilgangsrolle(_org uuid, _id uuid, _navn text, _beskrivelse text, _moduler text[])
returns faktura.tilgangsroller
language plpgsql security definer set search_path = '' as $$
declare
  t faktura.tilgangsroller;
  mod text[];
  gamle text[];
begin
  perform faktura.krev(_org, 'admin');
  _navn := btrim(coalesce(_navn, ''));
  if length(_navn) < 2 then raise exception 'Skriv et navn på rollen' using errcode = 'FA400'; end if;
  if length(_navn) > 60 then raise exception 'Navnet kan ha høyst 60 tegn' using errcode = 'FA400'; end if;
  if exists (select 1 from unnest(coalesce(_moduler, '{}')) x where x not in ('faktura', 'personal', 'lonn', 'regnskap')) then
    raise exception 'Ukjent modul' using errcode = 'FA400';
  end if;
  mod := array(select distinct x from unnest(coalesce(_moduler, '{}') || case when 'lonn' = any (_moduler) then array['personal'] else '{}'::text[] end) x);
  -- En modul som ikke er på, kan ikke gis; har rollen den fra før (modulen er slått av siden),
  -- blir den stående, så den er der igjen når modulen slås på.
  if _id is not null then
    select moduler into gamle from faktura.tilgangsroller where org_id = _org and id = _id;
  end if;
  if exists (select 1 from unnest(mod) x where not faktura.har_modul(_org, x) and not x = any (coalesce(gamle, '{}'))) then
    raise exception '% er ikke slått på for organisasjonen',
      (select string_agg(m.navn, ' og ' order by m.rekkefolge) from faktura.moduler m
        where m.kode = any (mod) and not faktura.har_modul(_org, m.kode) and not m.kode = any (coalesce(gamle, '{}')))
      using errcode = 'FA400';
  end if;
  mod := array(select m.kode from faktura.moduler m where m.kode = any (mod) order by m.rekkefolge);
  if exists (select 1 from faktura.tilgangsroller where org_id = _org and lower(btrim(navn)) = lower(_navn) and id is distinct from _id) then
    raise exception 'Det finnes alt en rolle som heter %', _navn using errcode = 'FA409';
  end if;
  if _id is null then
    insert into faktura.tilgangsroller (org_id, navn, beskrivelse, moduler)
    values (_org, _navn, nullif(btrim(_beskrivelse), ''), mod)
    returning * into t;
  else
    update faktura.tilgangsroller
       set navn = _navn, beskrivelse = nullif(btrim(_beskrivelse), ''), moduler = mod, endret = now()
     where org_id = _org and id = _id
    returning * into t;
    if not found then raise exception 'Fant ikke rollen' using errcode = 'FA404'; end if;
  end if;
  return t;
end $$;

-- Slett en rolle: ikke mens noen har den eller er invitert med den.
create function faktura.slett_tilgangsrolle(_org uuid, _id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  perform faktura.krev(_org, 'admin');
  select count(*) into n from faktura.medlemmer where org_id = _org and tilgangsrolle_id = _id;
  if n > 0 then
    raise exception '% har rollen. Gi % en annen rolle først.', case when n = 1 then '1 bruker' else n || ' brukere' end,
      case when n = 1 then 'brukeren' else 'dem' end using errcode = 'FA409';
  end if;
  if exists (select 1 from faktura.invitasjoner where org_id = _org and tilgangsrolle_id = _id and akseptert_at is null and utloper > now()) then
    raise exception 'Noen er invitert med rollen. Vent til invitasjonen er brukt eller utløpt.' using errcode = 'FA409';
  end if;
  delete from faktura.tilgangsroller where org_id = _org and id = _id;
  if not found then raise exception 'Fant ikke rollen' using errcode = 'FA404'; end if;
end $$;

revoke all on function faktura.lagre_tilgangsrolle(uuid, uuid, text, text, text[]), faktura.slett_tilgangsrolle(uuid, uuid) from public;
grant execute on function faktura.lagre_tilgangsrolle(uuid, uuid, text, text, text[]), faktura.slett_tilgangsrolle(uuid, uuid) to faktura_app;

-- ---------------------------------------------------------------------------
-- Invitere, bytte rolle og ta imot invitasjonen
-- ---------------------------------------------------------------------------

-- Rollen tilpasset krever en av organisasjonens egne roller (og bare den).
create function faktura.sjekk_tilgangsrolle(_org uuid, _rolle text, _tilgangsrolle uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if _rolle = 'tilpasset' and _tilgangsrolle is null then
    raise exception 'Velg en rolle' using errcode = 'FA400';
  end if;
  if _rolle <> 'tilpasset' and _tilgangsrolle is not null then
    raise exception 'Bare de egne rollene har en tilgangsrolle' using errcode = 'FA400';
  end if;
  if _tilgangsrolle is not null and not exists (select 1 from faktura.tilgangsroller where org_id = _org and id = _tilgangsrolle) then
    raise exception 'Fant ikke rollen' using errcode = 'FA404';
  end if;
end $$;
revoke all on function faktura.sjekk_tilgangsrolle(uuid, text, uuid) from public;

drop function faktura.inviter_medlem(uuid, text, text);
create function faktura.inviter_medlem(_org uuid, _epost text, _rolle text, _tilgangsrolle uuid default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  token text := encode(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()), 'hex');
begin
  perform faktura.krev(_org, 'admin');
  perform faktura.sjekk_tilgangsrolle(_org, _rolle, _tilgangsrolle);
  insert into faktura.invitasjoner (org_id, epost, rolle, tilgangsrolle_id, token_hash, invitert_av)
  values (_org, lower(btrim(_epost)), _rolle, _tilgangsrolle, sha256(convert_to(token, 'UTF8')), faktura.bruker_id());
  return token;
end $$;
revoke all on function faktura.inviter_medlem(uuid, text, text, uuid) from public;
grant execute on function faktura.inviter_medlem(uuid, text, text, uuid) to faktura_app;

drop function faktura.endre_rolle(uuid, uuid, text);
create function faktura.endre_rolle(_org uuid, _bruker uuid, _rolle text, _tilgangsrolle uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform faktura.krev(_org, 'admin');
  perform faktura.sjekk_tilgangsrolle(_org, _rolle, _tilgangsrolle);
  if (_rolle = 'eier' or exists (select 1 from faktura.medlemmer
                                  where org_id = _org and bruker_id = _bruker and rolle = 'eier'))
     and not faktura.kan(_org, 'eier') then
    raise exception 'Bare en eier kan gi eller ta eierrollen' using errcode = 'FA403';
  end if;
  update faktura.medlemmer set rolle = _rolle, tilgangsrolle_id = _tilgangsrolle where org_id = _org and bruker_id = _bruker;
  if not found then raise exception 'Fant ikke medlemmet' using errcode = 'FA404'; end if;
  if not exists (select 1 from faktura.medlemmer where org_id = _org and rolle = 'eier') then
    raise exception 'Organisasjonen må ha minst én eier' using errcode = 'FA409';
  end if;
end $$;
revoke all on function faktura.endre_rolle(uuid, uuid, text, uuid) from public;
grant execute on function faktura.endre_rolle(uuid, uuid, text, uuid) to faktura_app;

-- Som i 0035, med tilgangsrollen fra invitasjonen.
create or replace function faktura.aksepter_invitasjon(_token text) returns uuid
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

  insert into faktura.medlemmer (org_id, bruker_id, rolle, tilgangsrolle_id) values (inv.org_id, bruker.id, inv.rolle, inv.tilgangsrolle_id)
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

-- ---------------------------------------------------------------------------
-- Appen og plattformadministrasjonen
-- ---------------------------------------------------------------------------

-- Som i 0108, med modulene organisasjonen har, og for den med en egen rolle: rollen og modulene
-- den gir (de som er slått på).
create or replace view faktura.mine_organisasjoner with (security_invoker = true) as
select o.id, o.type, o.navn, o.orgnr, o.verifisering,
       faktura.rolle(o.id) as rolle,
       exists (select 1 from faktura.medlemmer m
                where m.org_id = o.id and m.bruker_id = faktura.bruker_id()) as direkte_medlem,
       coalesce((select l.aktiv from faktura.lonn_oppsett l where l.org_id = o.id), false)
         and faktura.har_funksjon(o.id, 'ansatte') as personal,
       (select a.id from faktura.ansatte a where a.org_id = o.id and a.bruker_id = faktura.bruker_id()) as ansatt_id,
       faktura.org_funksjonsliste(o.id) as funksjoner,
       faktura.kan(o.id, 'plan') as ser_planen,
       coalesce((select l.helg from faktura.lonn_oppsett l where l.org_id = o.id), true) as helg,
       faktura.timebank_paa(o.id) as timebank,
       coalesce((select l.vaktbytte from faktura.lonn_oppsett l where l.org_id = o.id), 'godkjenning') as vaktbytte,
       faktura.org_modulliste(o.id) as moduler,
       (select t.navn from faktura.medlemmer m join faktura.tilgangsroller t on t.org_id = m.org_id and t.id = m.tilgangsrolle_id
         where m.org_id = o.id and m.bruker_id = faktura.bruker_id()) as tilgangsrolle,
       (select array(select x from unnest(t.moduler) x where faktura.har_modul(o.id, x))
          from faktura.medlemmer m join faktura.tilgangsroller t on t.org_id = m.org_id and t.id = m.tilgangsrolle_id
         where m.org_id = o.id and m.bruker_id = faktura.bruker_id()) as rollemoduler
  from faktura.organisasjoner o;

-- Detaljene for én organisasjon (som i 0046): brukerne med den egne rollen, og funksjonene med
-- modulen de hører til.
create or replace function faktura.admin_organisasjon(_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  o faktura.organisasjoner;
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  select * into o from faktura.organisasjoner where id = _id;
  if not found then return null; end if;
  return jsonb_build_object(
    'id', o.id, 'navn', o.navn, 'orgnr', o.orgnr, 'type', o.type, 'verifisering', o.verifisering,
    'verifisert_metode', o.verifisert_metode, 'verifisert_at', o.verifisert_at, 'sperret_grunn', o.sperret_grunn,
    'opprettet', o.opprettet, 'epost', o.epost, 'telefon', o.telefon, 'kontonr', o.kontonr, 'mva_registrert', o.mva_registrert,
    'adresse', nullif(concat_ws(', ', nullif(o.adresse, ''), nullif(concat_ws(' ', o.postnr, o.poststed), '')), ''),
    'medlemmer', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'navn', b.navn, 'epost', b.epost, 'rolle', m.rolle, 'tilgangsrolle', t.navn, 'siden', m.opprettet,
                 'sist_aktiv', (select max(r.tid) from faktura.revisjonslogg r where r.org_id = o.id and r.bruker_id = b.id))
               order by faktura.rolle_rang(m.rolle) desc, b.epost)
          from faktura.medlemmer m join faktura.brukere b on b.id = m.bruker_id
          left join faktura.tilgangsroller t on t.org_id = m.org_id and t.id = m.tilgangsrolle_id
         where m.org_id = o.id), '[]'::jsonb),
    'antall', jsonb_build_object(
        'kunder', (select count(*) from faktura.kunder k where k.org_id = o.id),
        'produkter', (select count(*) from faktura.produkter p where p.org_id = o.id),
        'fakturaer', (select count(*) from faktura.fakturaer f where f.org_id = o.id and f.type = 'faktura' and f.status <> 'utkast'),
        'epost', (select count(*) from faktura.fakturaer f where f.org_id = o.id and f.type = 'faktura' and f.status <> 'utkast' and faktura.sendt_som_epost(f.id)),
        'ehf', (select count(*) from faktura.fakturaer f where f.org_id = o.id and f.type = 'faktura' and f.status <> 'utkast' and faktura.sendt_som_ehf(f.id)),
        'kreditnotaer', (select count(*) from faktura.fakturaer f where f.org_id = o.id and f.type = 'kreditnota' and f.status <> 'utkast'),
        'utkast', (select count(*) from faktura.fakturaer f where f.org_id = o.id and f.status = 'utkast'),
        'gjentakelser', (select count(*) from faktura.gjentakelser g where g.org_id = o.id and g.aktiv)),
    'siste_faktura', (select max(f.utstedt_at) from faktura.fakturaer f where f.org_id = o.id and f.status <> 'utkast'),
    -- Funksjonene organisasjonen har tilgang til (0041_funksjoner.sql), med modulen (0110).
    'funksjoner', coalesce((
        select jsonb_agg(jsonb_build_object('kode', f.kode, 'navn', f.navn, 'beskrivelse', f.beskrivelse, 'krever', f.krever, 'modul', f.modul,
                                            'aktiv', coalesce(x.aktiv, false)) order by md.rekkefolge, f.rekkefolge)
          from faktura.funksjoner f
          join faktura.moduler md on md.kode = f.modul
          left join faktura.org_funksjoner x on x.org_id = o.id and x.kode = f.kode), '[]'::jsonb),
    'integrasjoner', coalesce((
        select jsonb_agg(jsonb_build_object('type', i.type, 'status', i.status, 'siste_feil', i.siste_feil, 'oppdatert', i.oppdatert) order by i.type)
          from faktura.integrasjoner i where i.org_id = o.id and i.status <> 'frakoblet'), '[]'::jsonb),
    'banker', coalesce((
        select jsonb_agg(jsonb_build_object('bank', k.bank, 'status', k.status, 'gyldig_til', k.gyldig_til, 'sist_hentet', k.sist_hentet, 'siste_feil', k.siste_feil)
                         order by k.opprettet)
          from faktura.bankkoblinger k where k.org_id = o.id), '[]'::jsonb),
    -- Endring av kontonummer er det mest attraktive svindelangrepet.
    'kontonr_endringer', coalesce((
        select jsonb_agg(jsonb_build_object('tid', r.tid, 'fra', r.endring -> 'kontonr' ->> 'fra', 'til', r.endring -> 'kontonr' ->> 'til', 'av', b.epost)
                         order by r.tid desc)
          from (select * from faktura.revisjonslogg r
                 where r.org_id = o.id and r.tabell = 'organisasjoner' and r.handling = 'UPDATE' and r.endring ? 'kontonr'
                 order by r.tid desc limit 5) r
          left join faktura.brukere b on b.id = r.bruker_id), '[]'::jsonb),
    'verifiseringer', coalesce((
        select jsonb_agg(jsonb_build_object('metode', v.metode, 'status', v.status, 'tid', v.opprettet, 'notat', v.notat, 'sendt_til', v.sendt_til)
                         order by v.opprettet desc)
          from (select * from faktura.verifiseringer v where v.org_id = o.id order by v.opprettet desc limit 10) v), '[]'::jsonb),
    'sist_aktiv', (select max(r.tid) from faktura.revisjonslogg r where r.org_id = o.id),
    -- Siste endringer (hvilke felt, ikke verdiene), uten fakturalinjene.
    'aktivitet', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'tid', r.tid, 'handling', r.handling, 'tabell', r.tabell, 'av', b.epost,
                 'felt', case when r.handling = 'UPDATE' and jsonb_typeof(r.endring) = 'object'
                              then (select jsonb_agg(k order by k) from jsonb_object_keys(r.endring) k) end,
                 'status', case when r.handling = 'UPDATE' then r.endring -> 'status' ->> 'til' end)
               order by r.tid desc)
          from (select * from faktura.revisjonslogg r
                 where r.org_id = o.id and r.tabell is distinct from 'faktura_linjer'
                 order by r.tid desc limit 15) r
          left join faktura.brukere b on b.id = r.bruker_id), '[]'::jsonb)
  );
end $$;
