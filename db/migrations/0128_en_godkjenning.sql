-- Én godkjenning for nye kontoer som er registrert som organisasjon. Til nå godkjente
-- plattformadministratoren først kontoen (0043_kontogodkjenning.sql), og så måtte brukeren
-- verifisere organisasjonen under Verifisering (0007_verifisering.sql), ofte med en ny, manuell
-- godkjenning fra den samme administratoren. Når kontoen godkjennes, ser administratoren allerede
-- organisasjonen brukeren registrerte (navnet i Enhetsregisteret og organisasjonsnummeret,
-- 0126_registrering.sql), og går god for den: organisasjonsnummeret lagres på kontoen
-- (godkjent_orgnr), og organisasjonen brukeren lager med det nummeret, er verifisert med en gang
-- (metoden «kontogodkjenning»). Administratoren kan la være (_verifiser_org = false); da gjelder
-- den vanlige verifiseringen. Kontoer som er godkjent ved en invitasjon, har ikke vært hos
-- administratoren og får ikke dette.

alter table faktura.brukere
  add column godkjent_orgnr text check (godkjent_orgnr is null or faktura.orgnr_gyldig(godkjent_orgnr));
comment on column faktura.brukere.godkjent_orgnr is
  'Organisasjonsnummeret plattformadministratoren gikk god for da kontoen ble godkjent: organisasjonen brukeren lager med det, er verifisert';

-- Verifiserer organisasjonen brukeren har laget med organisasjonsnummeret plattformadministratoren
-- gikk god for (den eldste, om det er flere; bare én kan være verifisert per nummer). Er nummeret
-- alt verifisert hos en annen organisasjon, skjer ingenting: da verifiseres den som før, manuelt.
-- _org: bare den organisasjonen. Gir antallet som ble verifisert (0 eller 1). Kalles fra
-- behandle_konto, opprett_organisasjon og legg_inn_orgnr, ikke fra appen.
create function faktura.verifiser_godkjent_orgnr(_bruker uuid, _org uuid default null) returns int
language plpgsql security definer set search_path = '' as $$
declare
  _orgnr text := (select godkjent_orgnr from faktura.brukere where id = _bruker and status = 'godkjent');
  _forrige text := current_setting('app.betrodd', true);
  _id uuid;
begin
  if _orgnr is null then return 0; end if;
  select a.id into _id
    from faktura.organisasjoner a
   where a.orgnr = _orgnr and a.verifisering = 'ny' and a.slettet_at is null and a.opprettet_av = _bruker
     and (_org is null or a.id = _org)
     and not exists (select 1 from faktura.organisasjoner b where b.orgnr = a.orgnr and b.id <> a.id and b.verifisering = 'verifisert')
   order by a.opprettet
   limit 1;
  if _id is null then return 0; end if;
  -- sett_verifisering krever et betrodd kall; verdien settes tilbake etterpå, så resten av
  -- transaksjonen er som før.
  perform set_config('app.betrodd', 'on', true);
  perform faktura.sett_verifisering(_id, 'verifisert', 'kontogodkjenning');
  perform set_config('app.betrodd', coalesce(_forrige, ''), true);
  return 1;
end $$;

-- Som i 0044, med _verifiser_org (standard): godkjennes en konto som er registrert som
-- organisasjon, lagres organisasjonsnummeret som godkjent, og en organisasjon brukeren alt har
-- laget med det, verifiseres. Uten (_verifiser_org = false), ved avvisning og for andre kontoer
-- fjernes det.
drop function faktura.behandle_konto(uuid, boolean, text, text[]);
create function faktura.behandle_konto(_bruker uuid, _godkjent boolean, _grunn text default null, _moduler text[] default null,
                                       _verifiser_org boolean default true)
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
         avvist_grunn = case when _godkjent then null else nullif(btrim(_grunn), '') end,
         godkjent_orgnr = case when _godkjent and coalesce(_verifiser_org, true) and registrert_som = 'organisasjon' then oppgitt_orgnr end
   where id = _bruker
  returning * into b;
  if not found then raise exception 'Fant ikke brukeren' using errcode = 'FA404'; end if;
  if _godkjent and _moduler is not null then perform faktura.sett_bruker_moduler(_bruker, _moduler); end if;
  if b.godkjent_orgnr is not null then perform faktura.verifiser_godkjent_orgnr(_bruker); end if;
  return b;
end $$;

-- Som i 0003, og organisasjonen er verifisert med en gang når den har organisasjonsnummeret
-- plattformadministratoren gikk god for da kontoen ble godkjent.
create or replace function faktura.opprett_organisasjon(_navn text, _orgnr text default null, _type text default 'foretak')
returns faktura.organisasjoner
language plpgsql security definer set search_path = '' as $$
declare
  o faktura.organisasjoner;
  bruker uuid := faktura.bruker_id();
begin
  if bruker is null then raise exception 'Ikke innlogget' using errcode = 'FA403'; end if;
  if _orgnr is not null and not faktura.orgnr_gyldig(_orgnr) then
    raise exception 'Ugyldig organisasjonsnummer' using errcode = 'FA400';
  end if;
  -- Misbruksvern: maks fem uverifiserte organisasjoner per bruker.
  if (select count(*) from faktura.organisasjoner
       where opprettet_av = bruker and verifisering = 'ny') >= 5 then
    raise exception 'Du har for mange uverifiserte organisasjoner' using errcode = 'FA429';
  end if;

  insert into faktura.organisasjoner (navn, orgnr, type, opprettet_av)
  values (btrim(_navn), _orgnr, _type, bruker)
  returning * into o;
  insert into faktura.nummerserier (org_id) values (o.id);
  insert into faktura.medlemmer (org_id, bruker_id, rolle) values (o.id, bruker, 'eier');
  if o.orgnr is not null and faktura.verifiser_godkjent_orgnr(bruker, o.id) > 0 then
    select * into o from faktura.organisasjoner where id = o.id;
  end if;
  return o;
end $$;

-- Som i 0119, og det samme når organisasjonsnummeret legges inn senere: er det nummeret
-- plattformadministratoren gikk god for hos den som laget organisasjonen, er den verifisert.
create or replace function faktura.legg_inn_orgnr(_org uuid, _orgnr text) returns faktura.organisasjoner
language plpgsql security definer set search_path = '' as $$
declare
  o faktura.organisasjoner;
begin
  perform faktura.krev(_org, 'admin');
  if _orgnr is null or not faktura.orgnr_gyldig(_orgnr) then
    raise exception 'Ugyldig organisasjonsnummer' using errcode = 'FA400';
  end if;
  select * into o from faktura.organisasjoner where id = _org and slettet_at is null for update;
  if o.id is null then
    raise exception 'Fant ikke organisasjonen' using errcode = 'FA404';
  end if;
  if o.orgnr is not null then
    raise exception 'Organisasjonen har organisasjonsnummer fra før' using errcode = 'FA409';
  end if;
  update faktura.organisasjoner
     set type = case when type = 'privatperson' then 'foretak' else type end,
         orgnr = _orgnr
   where id = _org
  returning * into o;
  if o.opprettet_av is not null and faktura.verifiser_godkjent_orgnr(o.opprettet_av, o.id) > 0 then
    select * into o from faktura.organisasjoner where id = o.id;
  end if;
  return o;
end $$;

-- Kontoer plattformadministratoren alt har godkjent som organisasjon, får det samme: de gikk god
-- for organisasjonen da. Organisasjoner som venter på verifisering (også de som har bedt om
-- manuell godkjenning), verifiseres nå.
update faktura.brukere
   set godkjent_orgnr = oppgitt_orgnr
 where status = 'godkjent' and behandlet_av is not null and registrert_som = 'organisasjon' and oppgitt_orgnr is not null;
do $$
begin
  perform faktura.verifiser_godkjent_orgnr(id) from faktura.brukere where godkjent_orgnr is not null;
end $$;

revoke all on function faktura.verifiser_godkjent_orgnr(uuid, uuid), faktura.behandle_konto(uuid, boolean, text, text[], boolean) from public;
grant execute on function faktura.behandle_konto(uuid, boolean, text, text[], boolean) to faktura_app, faktura_system;
