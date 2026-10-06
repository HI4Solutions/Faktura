-- 0002_tilgang_og_triggere.sql
-- Tilgangsmodell (roller og regnskapsførertilgang), låsing av utstedte fakturaer,
-- nummerserier, utboks-hendelser og revisjonslogg.
--
-- Egne feilkoder (SQLSTATE) som API-et oversetter til HTTP:
--   FA400 ugyldige data, FA403 ingen tilgang, FA404 finnes ikke,
--   FA409 konflikt / feil tilstand, FA429 grense nådd.

-- ---------------------------------------------------------------------------
-- Tilgang
-- ---------------------------------------------------------------------------

-- Workeren (Cloud Scheduler-jobber, utboks, integrasjoner) kobler til som et
-- medlem av faktura_system og kan se alle organisasjoner.
create function faktura.er_system() returns boolean
language sql stable security definer set search_path = '' as $$
  select pg_catalog.pg_has_role(session_user, 'faktura_system', 'MEMBER')
$$;

create function faktura.rolle_rang(_rolle text) returns int
language sql immutable set search_path = '' as $$
  select case _rolle when 'eier' then 5 when 'admin' then 4 when 'fakturerer' then 3
                     when 'regnskap' then 2 when 'les' then 1 else 0 end
$$;

-- Den innloggede brukerens effektive rolle i en organisasjon: direkte medlemskap,
-- eller via et regnskapsbyrå med aktiv tilgang. Den sterkeste vinner.
create function faktura.rolle(_org uuid) returns text
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
  ) r
  order by faktura.rolle_rang(r.rolle) desc
  limit 1
$$;

-- Kan den innloggede brukeren gjøre _handling i _org?
--   les     alle roller
--   skriv   kunder, produkter, utkast, gjentakelser
--   utsted  utstede, sende og kreditere
--   bokfor  registrere betaling og refusjon
--   admin   innstillinger, medlemmer, integrasjoner, regnskapsførertilgang
--   eier    slette organisasjonen, overføre eierskap
create function faktura.kan(_org uuid, _handling text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  r text;
begin
  if faktura.er_system() then return true; end if;
  if faktura.bruker_id() is null or _org is null then return false; end if;
  r := faktura.rolle(_org);
  if r is null then return false; end if;
  return case _handling
    when 'les'    then true
    when 'skriv'  then r in ('eier', 'admin', 'fakturerer')
    when 'utsted' then r in ('eier', 'admin', 'fakturerer')
    when 'bokfor' then r in ('eier', 'admin', 'fakturerer', 'regnskap')
    when 'admin'  then r in ('eier', 'admin')
    when 'eier'   then r = 'eier'
    else false
  end;
end $$;

create function faktura.krev(_org uuid, _handling text) returns void
language plpgsql stable set search_path = '' as $$
begin
  if not faktura.kan(_org, _handling) then
    raise exception 'Ingen tilgang' using errcode = 'FA403';
  end if;
end $$;

-- Deler den innloggede brukeren en organisasjon med _bruker? (for medlemslister)
create function faktura.deler_org(_bruker uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from faktura.medlemmer m
     where m.bruker_id = _bruker and faktura.kan(m.org_id, 'les')
  )
$$;

-- ---------------------------------------------------------------------------
-- Generelle triggere
-- ---------------------------------------------------------------------------

create function faktura.sett_oppdatert() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.oppdatert := now();
  return new;
end $$;

create function faktura.org_id_uendret() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.org_id is distinct from old.org_id then
    raise exception 'org_id kan ikke endres' using errcode = 'FA400';
  end if;
  return new;
end $$;

-- Revisjonslogg: hele raden ved INSERT/DELETE, bare endrede felt ved UPDATE.
create function faktura.revider() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ny jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  gammel jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  rad jsonb := coalesce(ny, gammel);
  endring jsonb;
begin
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_object('fra', gammel -> n.key, 'til', n.value))
      into endring
      from jsonb_each(ny) n
     where n.value is distinct from gammel -> n.key and n.key <> 'oppdatert';
    if endring is null then return null; end if;
  else
    endring := rad;
  end if;
  insert into faktura.revisjonslogg (org_id, bruker_id, handling, tabell, rad_id, endring)
  values (
    case when tg_table_name = 'organisasjoner' then (rad ->> 'id')::uuid else (rad ->> 'org_id')::uuid end,
    faktura.bruker_id(),
    tg_op,
    tg_table_name,
    case when rad ? 'id' then (rad ->> 'id')::uuid end,
    -- Krypterte hemmeligheter skal aldri havne i loggen.
    endring - 'hemmelighet_kryptert'
  );
  return null;
end $$;

-- Eksplisitt logging av oppslag, f.eks. når en regnskapsfører åpner en klient.
create function faktura.logg_oppslag(_org uuid, _hva text, _rad uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform faktura.krev(_org, 'les');
  insert into faktura.revisjonslogg (org_id, bruker_id, handling, tabell, rad_id, endring)
  values (_org, faktura.bruker_id(), 'OPPSLAG', _hva, _rad, null);
end $$;

-- ---------------------------------------------------------------------------
-- Organisasjoner
-- ---------------------------------------------------------------------------

create function faktura.org_foer_endring() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.orgnr is distinct from old.orgnr and old.verifisering = 'verifisert' then
    raise exception 'Organisasjonsnummeret kan ikke endres etter verifisering' using errcode = 'FA409';
  end if;
  if new.type is distinct from old.type then
    raise exception 'Organisasjonstypen kan ikke endres' using errcode = 'FA400';
  end if;
  return new;
end $$;

-- Endring av kontonummer er det mest attraktive svindelangrepet. Det gir en
-- hendelse som workeren bruker til å varsle alle eiere på e-post.
create function faktura.org_etter_endring() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kontonr is distinct from old.kontonr then
    insert into faktura.utboks (org_id, hendelse, aggregat_id, data)
    values (new.id, 'organisasjon.kontonr_endret', new.id,
            jsonb_build_object('fra', old.kontonr, 'til', new.kontonr, 'endret_av', faktura.bruker_id()));
  end if;
  return null;
end $$;

create trigger organisasjoner_foer before update on faktura.organisasjoner
  for each row execute function faktura.org_foer_endring();
create trigger organisasjoner_etter after update on faktura.organisasjoner
  for each row execute function faktura.org_etter_endring();

-- ---------------------------------------------------------------------------
-- Kunder
-- ---------------------------------------------------------------------------

create function faktura.kunde_foer() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    update faktura.nummerserier
       set neste_kundenummer = neste_kundenummer + 1
     where org_id = new.org_id
    returning neste_kundenummer - 1 into new.kundenummer;
    if new.kundenummer is null then
      raise exception 'Organisasjonen mangler nummerserie' using errcode = 'FA409';
    end if;
  elsif new.kundenummer is distinct from old.kundenummer then
    raise exception 'Kundenummeret kan ikke endres' using errcode = 'FA400';
  end if;
  return new;
end $$;

create trigger kunder_foer before insert or update on faktura.kunder
  for each row execute function faktura.kunde_foer();

-- ---------------------------------------------------------------------------
-- Låsing av utstedte fakturaer og linjer
-- ---------------------------------------------------------------------------

create function faktura.faktura_laas() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'utkast' then
      raise exception 'En utstedt faktura kan ikke slettes. Lag en kreditnota.' using errcode = 'FA409';
    end if;
    return old;
  end if;

  if old.status = 'utkast' then
    return new;
  end if;

  if new.status = 'utkast' then
    raise exception 'En utstedt faktura kan ikke bli utkast igjen' using errcode = 'FA409';
  end if;

  if (new.fakturanummer, new.kunde_id, new.type, new.kreditnota_for, new.fakturadato,
      new.forfallsdato, new.periode_fra, new.periode_til, new.kid, new.valuta,
      new.sum_eks_mva, new.mva, new.sum_inkl_mva, new.selger, new.kunde,
      new.deres_referanse, new.var_referanse, new.utstedt_at, new.utstedt_av)
     is distinct from
     (old.fakturanummer, old.kunde_id, old.type, old.kreditnota_for, old.fakturadato,
      old.forfallsdato, old.periode_fra, old.periode_til, old.kid, old.valuta,
      old.sum_eks_mva, old.mva, old.sum_inkl_mva, old.selger, old.kunde,
      old.deres_referanse, old.var_referanse, old.utstedt_at, old.utstedt_av)
  then
    raise exception 'Fakturaen er utstedt og låst. Rett feil med en kreditnota.' using errcode = 'FA409';
  end if;
  return new;
end $$;

create trigger fakturaer_laas before update or delete on faktura.fakturaer
  for each row execute function faktura.faktura_laas();

create function faktura.linjer_laas() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  st text;
begin
  select status into st from faktura.fakturaer
   where id = case when tg_op = 'DELETE' then old.faktura_id else new.faktura_id end;
  -- Linjer slettes sammen med et utkast (cascade); da finnes ikke fakturaen lenger.
  if st is not null and st <> 'utkast' then
    -- Utstedelsen setter beløpene på linjene i samme transaksjon som den låser fakturaen,
    -- men fakturaen er fortsatt utkast da. Alt annet er en endring av en låst faktura.
    raise exception 'Linjene på en utstedt faktura kan ikke endres' using errcode = 'FA409';
  end if;
  if tg_op = 'UPDATE' and new.faktura_id is distinct from old.faktura_id then
    raise exception 'En linje kan ikke flyttes til en annen faktura' using errcode = 'FA400';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create trigger faktura_linjer_laas before insert or update or delete on faktura.faktura_linjer
  for each row execute function faktura.linjer_laas();

-- ---------------------------------------------------------------------------
-- Hendelser til utboksen
-- ---------------------------------------------------------------------------

create function faktura.faktura_hendelser() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  data jsonb := jsonb_build_object(
    'faktura_id', new.id, 'fakturanummer', new.fakturanummer, 'type', new.type,
    'kunde_id', new.kunde_id, 'sum_inkl_mva', new.sum_inkl_mva, 'status', new.status);
begin
  if old.status = 'utkast' and new.status <> 'utkast' then
    insert into faktura.utboks (org_id, hendelse, aggregat_id, data)
    values (new.org_id, case new.type when 'kreditnota' then 'kreditnota.utstedt' else 'faktura.utstedt' end, new.id, data);
  end if;
  if new.status = 'betalt' and old.status <> 'betalt' then
    insert into faktura.utboks (org_id, hendelse, aggregat_id, data) values (new.org_id, 'faktura.betalt', new.id, data);
  end if;
  if new.status = 'kreditert' and old.status <> 'kreditert' then
    insert into faktura.utboks (org_id, hendelse, aggregat_id, data) values (new.org_id, 'faktura.kreditert', new.id, data);
  end if;
  return null;
end $$;

create trigger fakturaer_hendelser after update on faktura.fakturaer
  for each row execute function faktura.faktura_hendelser();

create function faktura.betaling_hendelser() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into faktura.utboks (org_id, hendelse, aggregat_id, data)
  values (new.org_id, case new.type when 'refusjon' then 'refusjon.registrert' else 'betaling.registrert' end, new.faktura_id,
          jsonb_build_object('betaling_id', new.id, 'faktura_id', new.faktura_id, 'belop', new.belop,
                             'betalt_dato', new.betalt_dato, 'kilde', new.kilde));
  return null;
end $$;

create trigger betalinger_hendelser after insert on faktura.betalinger
  for each row execute function faktura.betaling_hendelser();

-- ---------------------------------------------------------------------------
-- Koble triggere på tabellene
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['brukere', 'organisasjoner', 'kunder', 'produkter', 'gjentakelser', 'fakturaer', 'integrasjoner'] loop
    execute format('create trigger %I_oppdatert before update on faktura.%I for each row execute function faktura.sett_oppdatert()', t, t);
  end loop;

  foreach t in array array['kunder', 'produkter', 'gjentakelser', 'fakturaer', 'faktura_linjer', 'betalinger', 'integrasjoner', 'medlemmer', 'invitasjoner'] loop
    execute format('create trigger %I_org_id before update on faktura.%I for each row execute function faktura.org_id_uendret()', t, t);
  end loop;

  foreach t in array array['organisasjoner', 'medlemmer', 'kunder', 'produkter', 'gjentakelser', 'fakturaer', 'faktura_linjer', 'betalinger', 'integrasjoner'] loop
    execute format('create trigger %I_revisjon after insert or update or delete on faktura.%I for each row execute function faktura.revider()', t, t);
  end loop;
end $$;

-- org_tilgang har ikke org_id; logg den på klientorganisasjonen.
create function faktura.revider_tilgang() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into faktura.revisjonslogg (org_id, bruker_id, handling, tabell, rad_id, endring)
  values (coalesce(new.klient_org_id, old.klient_org_id), faktura.bruker_id(), tg_op, 'org_tilgang',
          coalesce(new.id, old.id), to_jsonb(coalesce(new, old)));
  return null;
end $$;

create trigger org_tilgang_revisjon after insert or update or delete on faktura.org_tilgang
  for each row execute function faktura.revider_tilgang();
