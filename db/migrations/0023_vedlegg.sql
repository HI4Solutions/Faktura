-- 0023_vedlegg.sql
-- Vedlegg på fakturaer (timelister, kvitteringer, avtaler og lignende). Filen lastes opp
-- før fakturaen lagres og står uten faktura (faktura_id er null) til utkastet lagres med
-- den. Vedlegg kan bare legges til og fjernes mens fakturaen er et utkast; etter
-- utstedelsen er de låst sammen med fakturaen. Workeren legger da en kopi i fakturabøtta
-- (som har oppbevaringsregel) og sender vedleggene med fakturaen på e-post og i EHF.
--
-- Typene er de EHF (PEPPOL BIS Billing 3.0) godtar som vedlegg.

create table faktura.vedlegg (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id),
  faktura_id uuid,
  filnavn text not null check (btrim(filnavn) <> '' and length(filnavn) <= 150),
  type text not null check (type in ('application/pdf', 'image/png', 'image/jpeg', 'text/csv',
                                     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                                     'application/vnd.oasis.opendocument.spreadsheet')),
  storrelse int not null check (storrelse between 1 and 10000000),
  sti text not null unique,  -- i filbøtta
  arkiv_sti text,            -- kopien i fakturabøtta, når fakturaen er utstedt og sendt
  rekke int not null default 0,
  opprettet timestamptz not null default now(),
  opprettet_av uuid default faktura.bruker_id() references faktura.brukere(id),
  unique (org_id, id),
  foreign key (org_id, faktura_id) references faktura.fakturaer(org_id, id) on delete cascade
);
create index vedlegg_faktura_idx on faktura.vedlegg (faktura_id, rekke) where faktura_id is not null;
create index vedlegg_uten_faktura_idx on faktura.vedlegg (org_id, opprettet) where faktura_id is null;

alter table faktura.vedlegg enable row level security;
create policy vedlegg_les on faktura.vedlegg for select using (faktura.kan(org_id, 'les'));
-- En opplastet fil står uten faktura til utkastet lagres med den.
create policy vedlegg_ny on faktura.vedlegg for insert
  with check (faktura.kan(org_id, 'skriv') and faktura_id is null);
create policy vedlegg_endre on faktura.vedlegg for update
  using (faktura.kan(org_id, 'skriv')
         and (faktura_id is null or exists (select 1 from faktura.fakturaer f where f.id = faktura_id and f.status = 'utkast')))
  with check (faktura.kan(org_id, 'skriv')
              and exists (select 1 from faktura.fakturaer f where f.id = faktura_id and f.status = 'utkast'));
create policy vedlegg_slett on faktura.vedlegg for delete
  using (faktura.kan(org_id, 'skriv')
         and (faktura_id is null or exists (select 1 from faktura.fakturaer f where f.id = faktura_id and f.status = 'utkast')));
grant select, insert (id, org_id, filnavn, type, storrelse, sti), update (faktura_id, rekke), delete
  on faktura.vedlegg to faktura_app;

-- Låsen gjelder også tabelleieren og funksjonene: vedleggene på en utstedt faktura kan
-- verken endres, flyttes eller slettes. Bare arkivkopien settes etter utstedelsen.
create function faktura.vedlegg_laas() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  st text;
begin
  if tg_op = 'UPDATE' and (to_jsonb(new) - 'arkiv_sti') = (to_jsonb(old) - 'arkiv_sti') then
    return new;
  end if;
  if tg_op <> 'INSERT' and old.faktura_id is not null then
    -- Slettes vedlegget sammen med fakturaen (cascade), finnes ikke fakturaen lenger.
    select status into st from faktura.fakturaer where id = old.faktura_id;
    if st is not null and st <> 'utkast' then
      raise exception 'Vedleggene på en utstedt faktura kan ikke endres' using errcode = 'FA409';
    end if;
  end if;
  if tg_op <> 'DELETE' and new.faktura_id is not null then
    select status into st from faktura.fakturaer where id = new.faktura_id;
    if st is distinct from 'utkast' then
      raise exception 'Vedlegg kan bare legges på utkast' using errcode = 'FA409';
    end if;
  end if;
  if tg_op = 'UPDATE' and (new.sti, new.filnavn, new.type, new.storrelse) is distinct from (old.sti, old.filnavn, old.type, old.storrelse) then
    raise exception 'Et vedlegg kan ikke endres; last det opp på nytt' using errcode = 'FA400';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create trigger vedlegg_laas before insert or update or delete on faktura.vedlegg
  for each row execute function faktura.vedlegg_laas();
create trigger vedlegg_org_id before update on faktura.vedlegg
  for each row execute function faktura.org_id_uendret();
create trigger vedlegg_revisjon after insert or update or delete on faktura.vedlegg
  for each row execute function faktura.revider();

-- ---------------------------------------------------------------------------
-- Filer som skal slettes fra filbøtta
-- ---------------------------------------------------------------------------

-- Når et vedlegg slettes (fjernet fra et utkast, utkastet slettet, eller aldri lagret på en
-- faktura), legges filen her, og workeren sletter den fra filbøtta. Kopien i fakturabøtta
-- har oppbevaringsregel og blir liggende.
create table faktura.slettede_filer (
  sti text primary key,
  opprettet timestamptz not null default now()
);
alter table faktura.slettede_filer enable row level security;
create policy slettede_filer_system on faktura.slettede_filer for all using (faktura.er_system());
grant select, delete on faktura.slettede_filer to faktura_system;

create function faktura.vedlegg_slettet() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into faktura.slettede_filer (sti) values (old.sti) on conflict do nothing;
  return null;
end $$;

create trigger vedlegg_slettet after delete on faktura.vedlegg
  for each row execute function faktura.vedlegg_slettet();

-- Opplastinger som aldri ble lagret på en faktura, slettes etter to døgn.
create function faktura.rydd_vedlegg() returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  delete from faktura.vedlegg where faktura_id is null and opprettet < now() - interval '2 days';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function faktura.rydd_vedlegg() from public;
grant execute on function faktura.rydd_vedlegg() to faktura_system;

-- Workeren setter arkivkopien (fakturabøtta) når fakturaen sendes.
create function faktura.arkiver_vedlegg(_id uuid, _sti text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update faktura.vedlegg v set arkiv_sti = _sti
   where v.id = _id and v.arkiv_sti is null
     and exists (select 1 from faktura.fakturaer f where f.id = v.faktura_id and f.status <> 'utkast');
end $$;
revoke all on function faktura.arkiver_vedlegg(uuid, text) from public;
grant execute on function faktura.arkiver_vedlegg(uuid, text) to faktura_system;
