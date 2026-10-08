-- Funksjoner per organisasjon: plattformadministratoren velger hvilke organisasjoner som har
-- tilgang til hvilke funksjoner (EHF, bank, AI, ansatte og timer, vaktplan osv.). Fakturaer,
-- kunder og produkter har alle. En ny organisasjon får standarden for nye organisasjoner, som
-- administratoren også styrer; de som finnes fra før, beholder alt de har i dag.
--
-- API-et sjekker funksjonen før rutene for den (server/src/funksjoner.ts), og
-- bakgrunnsjobbene hopper over organisasjoner uten den. Appen skjuler det som ikke er slått på
-- (mine_organisasjoner.funksjoner).

create table faktura.funksjoner (
  kode text primary key check (kode ~ '^[a-z_]{2,30}$'),
  navn text not null,
  beskrivelse text not null,
  rekkefolge int not null,
  -- Bygger på en annen funksjon (f.eks. vaktplanen på ansatte og timer): virker bare når den
  -- også er slått på.
  krever text references faktura.funksjoner(kode),
  standard boolean not null default true  -- slått på for nye organisasjoner
);

insert into faktura.funksjoner (kode, navn, beskrivelse, rekkefolge, krever) values
  ('ehf', 'EHF', 'Sende fakturaer som EHF (elektronisk faktura) gjennom Peppol, og slå opp om kundene kan ta imot', 1, null),
  ('bank', 'Bank', 'Innbetalinger fra banken og avstemming mot fakturaene', 2, null),
  ('ai', 'AI', 'AI-assistent med tale, faktura fra tekst eller tale og forslag på innbetalinger', 3, null),
  ('gjentakende', 'Gjentakende fakturaer', 'Fakturaer som sendes automatisk hver periode, med indeksregulering', 4, null),
  ('flere', 'Flere fakturaer', 'Lage og sende mange fakturaer på én gang', 5, null),
  ('paaminnelser', 'Påminnelser', 'Påminnelser om fakturaer som skal sendes', 6, null),
  ('rapporter', 'Rapporter', 'Rapporter (reskontro, mva og salg) og eksport', 7, null),
  ('import', 'Import', 'Import av kunder og produkter fra andre systemer', 8, null),
  ('google_disk', 'Google Disk', 'Kopi av fakturaene i Google Disk', 9, null),
  ('ansatte', 'Ansatte og timer', 'Ansattregister, timeføring, levering og godkjenning', 10, null),
  ('vaktplan', 'Vaktplan og bemanning', 'Vaktplan, tavle, fravær, vikarer, bemanningskalender og faste arbeidsdager', 11, 'ansatte');

create table faktura.org_funksjoner (
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  kode text not null references faktura.funksjoner(kode) on delete cascade,
  aktiv boolean not null,
  endret timestamptz not null default now(),
  endret_av uuid references faktura.brukere(id) on delete set null,
  primary key (org_id, kode)
);

-- De som finnes fra før, beholder alt.
insert into faktura.org_funksjoner (org_id, kode, aktiv)
select o.id, f.kode, true from faktura.organisasjoner o cross join faktura.funksjoner f;

-- En ny organisasjon får standarden.
create function faktura.organisasjon_funksjoner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into faktura.org_funksjoner (org_id, kode, aktiv)
  select new.id, f.kode, f.standard from faktura.funksjoner f
  on conflict do nothing;
  return null;
end $$;
create trigger organisasjoner_funksjoner after insert on faktura.organisasjoner
  for each row execute function faktura.organisasjon_funksjoner();

-- Om organisasjonen har funksjonen (og den den bygger på; ett nivå).
create function faktura.har_funksjon(_org uuid, _kode text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select o.aktiv
                          and (f.krever is null
                               or coalesce((select k.aktiv from faktura.org_funksjoner k where k.org_id = _org and k.kode = f.krever), false))
                     from faktura.org_funksjoner o join faktura.funksjoner f on f.kode = o.kode
                    where o.org_id = _org and o.kode = _kode), false)
$$;

-- Feiler når organisasjonen ikke har funksjonen.
create function faktura.krev_funksjon(_org uuid, _kode text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not faktura.har_funksjon(_org, _kode) then
    raise exception '% er ikke slått på for organisasjonen', coalesce((select navn from faktura.funksjoner where kode = _kode), _kode)
      using errcode = 'FA403';
  end if;
end $$;

-- Funksjonene organisasjonen har (for appen).
create function faktura.org_funksjonsliste(_org uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(f.kode order by f.rekkefolge), '{}')
    from faktura.funksjoner f
   where faktura.har_funksjon(_org, f.kode)
$$;

revoke all on function faktura.har_funksjon(uuid, text), faktura.krev_funksjon(uuid, text), faktura.org_funksjonsliste(uuid) from public;
grant execute on function faktura.har_funksjon(uuid, text), faktura.krev_funksjon(uuid, text), faktura.org_funksjonsliste(uuid)
  to faktura_app, faktura_system;

-- Funksjonene kan alle innloggede se (navn og beskrivelse); hva en organisasjon har, ser
-- medlemmene. Endringer går bare gjennom administratorens funksjoner under.
alter table faktura.funksjoner enable row level security;
alter table faktura.org_funksjoner enable row level security;
create policy funksjoner_les on faktura.funksjoner for select using (true);
create policy org_funksjoner_les on faktura.org_funksjoner for select using (faktura.rolle(org_id) is not null or faktura.er_betrodd());
grant select on faktura.funksjoner, faktura.org_funksjoner to faktura_app, faktura_system;

-- Organisasjonene med funksjonene og standarden for nye (Administrasjon → Funksjoner).
create function faktura.admin_funksjoner() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  return jsonb_build_object(
    'funksjoner', (select coalesce(jsonb_agg(jsonb_build_object('kode', f.kode, 'navn', f.navn, 'beskrivelse', f.beskrivelse, 'krever', f.krever,
                                                                 'standard', f.standard) order by f.rekkefolge), '[]'::jsonb)
                     from faktura.funksjoner f),
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

-- Slå en funksjon av eller på for en organisasjon.
create function faktura.admin_sett_funksjon(_org uuid, _kode text, _aktiv boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  if not exists (select 1 from faktura.organisasjoner where id = _org) then raise exception 'Fant ikke organisasjonen' using errcode = 'FA404'; end if;
  if not exists (select 1 from faktura.funksjoner where kode = _kode) then raise exception 'Ukjent funksjon' using errcode = 'FA400'; end if;
  insert into faktura.org_funksjoner (org_id, kode, aktiv, endret, endret_av)
  values (_org, _kode, _aktiv, now(), faktura.bruker_id())
  on conflict (org_id, kode) do update set aktiv = excluded.aktiv, endret = excluded.endret, endret_av = excluded.endret_av
   where faktura.org_funksjoner.aktiv is distinct from excluded.aktiv;
end $$;

-- Standarden for nye organisasjoner.
create function faktura.admin_sett_standard(_kode text, _standard boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  update faktura.funksjoner set standard = _standard where kode = _kode;
  if not found then raise exception 'Ukjent funksjon' using errcode = 'FA400'; end if;
end $$;

revoke all on function faktura.admin_funksjoner(), faktura.admin_sett_funksjon(uuid, text, boolean), faktura.admin_sett_standard(text, boolean) from public;
grant execute on function faktura.admin_funksjoner(), faktura.admin_sett_funksjon(uuid, text, boolean), faktura.admin_sett_standard(text, boolean) to faktura_app;

-- Appen: funksjonene organisasjonen har, og ansatte og timer bare når funksjonen er slått på.
create or replace view faktura.mine_organisasjoner with (security_invoker = true) as
select o.id, o.type, o.navn, o.orgnr, o.verifisering,
       faktura.rolle(o.id) as rolle,
       exists (select 1 from faktura.medlemmer m
                where m.org_id = o.id and m.bruker_id = faktura.bruker_id()) as direkte_medlem,
       coalesce((select l.aktiv from faktura.lonn_oppsett l where l.org_id = o.id), false)
         and faktura.har_funksjon(o.id, 'ansatte') as personal,
       (select a.id from faktura.ansatte a where a.org_id = o.id and a.bruker_id = faktura.bruker_id()) as ansatt_id,
       faktura.org_funksjonsliste(o.id) as funksjoner
  from faktura.organisasjoner o;
