-- 0016_avsender_og_kontoer.sql
-- 1. Enkeltpersonforetak kan sende faktura med innehaverens navn eller firmanavnet.
-- 2. Fakturering som privatperson (uten organisasjonsnummer og mva).
-- 3. Flere kontonumre per organisasjon; velges per faktura og per gjentakelse.

-- ---------------------------------------------------------------------------
-- Organisasjonen
-- ---------------------------------------------------------------------------

alter table faktura.organisasjoner drop constraint organisasjoner_type_check;
alter table faktura.organisasjoner
  add constraint organisasjoner_type_check check (type in ('foretak', 'regnskapsbyraa', 'privatperson')),
  add column innehaver text check (innehaver is null or btrim(innehaver) <> ''),
  add column standard_avsender text not null default 'firma' check (standard_avsender in ('firma', 'innehaver')),
  add constraint organisasjoner_avsender_innehaver check (standard_avsender = 'firma' or innehaver is not null);

-- En privatperson har ikke organisasjonsnummer og er ikke mva-registrert.
create function faktura.privatperson_foer() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.type = 'privatperson' then
    new.orgnr := null;
    new.mva_registrert := false;
    new.foretaksregisteret := false;
  end if;
  return new;
end $$;
create trigger organisasjoner_privatperson before insert or update on faktura.organisasjoner
  for each row execute function faktura.privatperson_foer();

grant update (innehaver, standard_avsender) on faktura.organisasjoner to faktura_app;

-- ---------------------------------------------------------------------------
-- Kontonumre
-- ---------------------------------------------------------------------------

create table faktura.kontoer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  navn text not null check (btrim(navn) <> ''),
  kontonr text not null check (faktura.kontonr_gyldig(kontonr)),
  opprettet timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, kontonr)
);

alter table faktura.kontoer enable row level security;
create policy kontoer_les on faktura.kontoer for select using (faktura.kan(org_id, 'les'));
create policy kontoer_ny on faktura.kontoer for insert with check (faktura.kan(org_id, 'admin'));
create policy kontoer_endre on faktura.kontoer for update using (faktura.kan(org_id, 'admin')) with check (faktura.kan(org_id, 'admin'));
create policy kontoer_slett on faktura.kontoer for delete using (faktura.kan(org_id, 'admin'));
grant select, insert (org_id, navn, kontonr), update (navn, kontonr), delete on faktura.kontoer to faktura_app;

create trigger kontoer_revisjon after insert or update or delete on faktura.kontoer
  for each row execute function faktura.revider();

-- ---------------------------------------------------------------------------
-- Valg per faktura og gjentakelse (null = organisasjonens standard)
-- ---------------------------------------------------------------------------

alter table faktura.fakturaer
  add column konto_id uuid,
  add column avsender text check (avsender in ('firma', 'innehaver')),
  add foreign key (org_id, konto_id) references faktura.kontoer(org_id, id) on delete set null (konto_id);
alter table faktura.gjentakelser
  add column konto_id uuid,
  add column avsender text check (avsender in ('firma', 'innehaver')),
  add foreign key (org_id, konto_id) references faktura.kontoer(org_id, id) on delete set null (konto_id);

grant insert (konto_id, avsender), update (konto_id, avsender) on faktura.fakturaer to faktura_app;
grant insert (konto_id, avsender), update (konto_id, avsender) on faktura.gjentakelser to faktura_app;

-- Selgeren slik den står på fakturaen. Brukes ved utstedelse og i forhåndsvisning.
create function faktura.selger_for(_org uuid, _konto uuid, _avsender text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
           'navn', case when coalesce(_avsender, o.standard_avsender) = 'innehaver' and o.innehaver is not null
                        then o.innehaver else o.navn end,
           'firmanavn', o.navn,
           'orgnr', o.orgnr, 'mva_registrert', o.mva_registrert,
           'foretaksregisteret', o.foretaksregisteret, 'adresse', o.adresse, 'postnr', o.postnr,
           'poststed', o.poststed, 'land', o.land, 'telefon', o.telefon, 'epost', o.epost,
           'kontonr', coalesce((select k.kontonr from faktura.kontoer k where k.id = _konto and k.org_id = o.id), o.kontonr),
           'logo_sti', o.logo_sti, 'farge', o.farge)
    from faktura.organisasjoner o
   where o.id = _org and faktura.kan(o.id, 'les')
$$;
grant execute on function faktura.selger_for(uuid, uuid, text) to faktura_app;

-- Ny faktura fra en gjentakelse arver konto og avsender; en kreditnota arver fra fakturaen.
create function faktura.faktura_arv() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kreditnota_for is not null then
    select f.konto_id, f.avsender into new.konto_id, new.avsender from faktura.fakturaer f where f.id = new.kreditnota_for;
  elsif new.gjentakelse_id is not null and new.konto_id is null and new.avsender is null then
    select g.konto_id, g.avsender into new.konto_id, new.avsender from faktura.gjentakelser g where g.id = new.gjentakelse_id;
  end if;
  return new;
end $$;
create trigger fakturaer_arv before insert on faktura.fakturaer
  for each row execute function faktura.faktura_arv();

-- Ved utstedelse settes selgeren ut fra valgt konto og avsender.
create function faktura.faktura_selger() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'utkast' and new.status <> 'utkast' then
    new.selger := faktura.selger_for(new.org_id, new.konto_id, new.avsender);
  end if;
  return new;
end $$;
-- Navnet sorterer etter fakturaer_laas, så låsen ser fakturaen som utkast først.
create trigger fakturaer_selger before update on faktura.fakturaer
  for each row execute function faktura.faktura_selger();
