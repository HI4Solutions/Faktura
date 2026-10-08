-- 0062_beskjeder.sql
-- Beskjeder: alle i organisasjonen kan legge en beskjed til én eller flere roller (f.eks. legene og
-- sekretærene), eller til alle, eventuelt med push-varsel til dem det gjelder. En beskjed til
-- roller ses av de aktive med rollene, av den som skrev den, og av eier, administrator og regnskap
-- (som ser de ansatte); en beskjed til alle ses av alle i organisasjonen. Den som skrev den, og eier
-- og administrator, kan slette den. Hver bruker har en tid for når de sist så beskjedene
-- (beskjed_lest), så appen kan vise hvor mange som er nye.

create table faktura.beskjeder (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  tekst text not null check (char_length(tekst) between 1 and 2000),
  roller uuid[] not null default '{}',             -- rollene (ansattgrupper) den er til; tom: alle
  push boolean not null default false,             -- push-varsel til dem det gjelder
  forfatter uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null,
  forfatter_navn text not null default '',         -- navnet da den ble skrevet (den ansatte, ellers brukeren)
  opprettet timestamptz not null default now(),
  unique (org_id, id)
);
create index beskjeder_org_idx on faktura.beskjeder (org_id, opprettet desc);

-- Teksten uten mellomrom i endene, rollene finnes i organisasjonen (hver én gang), og den som
-- skrev den, er den innloggede (med navnet fra ansattregisteret, ellers fra innloggingen).
create function faktura.beskjed_foer() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.tekst := btrim(new.tekst);
  if new.tekst = '' then raise exception 'Skriv en beskjed' using errcode = 'FA400'; end if;
  new.roller := coalesce((select array_agg(distinct r) from unnest(new.roller) r), '{}');
  if exists (select 1 from unnest(new.roller) r
              where not exists (select 1 from faktura.ansattgrupper g where g.org_id = new.org_id and g.id = r)) then
    raise exception 'Fant ikke rollen' using errcode = 'FA404';
  end if;
  new.forfatter := faktura.bruker_id();
  new.forfatter_navn := coalesce(
    (select a.fornavn || ' ' || a.etternavn from faktura.ansatte a
      where a.org_id = new.org_id and a.bruker_id = new.forfatter order by a.aktiv desc limit 1),
    (select coalesce(nullif(btrim(b.navn), ''), b.epost) from faktura.brukere b where b.id = new.forfatter),
    '');
  return new;
end $$;
create trigger beskjeder_foer before insert on faktura.beskjeder
  for each row execute function faktura.beskjed_foer();

-- Ser den innloggede beskjeden?
create function faktura.ser_beskjed(_org uuid, _roller uuid[], _forfatter uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select faktura.kan(_org, 'medlem')
     and (cardinality(_roller) = 0
          or _forfatter = faktura.bruker_id()
          or faktura.kan(_org, 'personal_les')
          or exists (select 1 from faktura.ansatte a
                      where a.org_id = _org and a.bruker_id = faktura.bruker_id() and a.aktiv and a.gruppe_id = any (_roller)))
$$;

alter table faktura.beskjeder enable row level security;
create policy beskjeder_les on faktura.beskjeder for select using (faktura.ser_beskjed(org_id, roller, forfatter));
create policy beskjeder_ny on faktura.beskjeder for insert with check (faktura.kan(org_id, 'medlem'));
create policy beskjeder_slett on faktura.beskjeder for delete
  using (forfatter = faktura.bruker_id() or faktura.kan(org_id, 'personal'));
grant select, delete, insert (org_id, tekst, roller, push) on faktura.beskjeder to faktura_app;

-- Når brukeren sist så beskjedene i organisasjonen (bare sin egen).
create table faktura.beskjed_lest (
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  bruker_id uuid not null references faktura.brukere(id) on delete cascade,
  lest timestamptz not null default now(),
  primary key (org_id, bruker_id)
);
alter table faktura.beskjed_lest enable row level security;
create policy beskjed_lest_egen on faktura.beskjed_lest for all
  using (bruker_id = faktura.bruker_id())
  with check (bruker_id = faktura.bruker_id() and faktura.kan(org_id, 'medlem'));
grant select, insert (org_id, bruker_id, lest), update (lest) on faktura.beskjed_lest to faktura_app;

-- Rollene en beskjed kan sendes til (navnene ser alle i organisasjonen; ellers ser bare de som ser de
-- ansatte, rollene).
create function faktura.beskjed_roller(_org uuid) returns table (id uuid, navn text)
language sql stable security definer set search_path = '' as $$
  select g.id, g.navn from faktura.ansattgrupper g
   where g.org_id = _org and faktura.kan(_org, 'medlem')
   order by g.rekkefolge, g.navn
$$;

revoke all on function faktura.beskjed_foer(), faktura.ser_beskjed(uuid, uuid[], uuid), faktura.beskjed_roller(uuid) from public;
grant execute on function faktura.ser_beskjed(uuid, uuid[], uuid), faktura.beskjed_roller(uuid) to faktura_app;
