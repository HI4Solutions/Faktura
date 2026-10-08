-- Bemanningskalenderen (måneden med datoene nedover og de ansatte bortover): de ansatte
-- kan deles i grupper (f.eks. sekretærer og leger), hver med hvor mange som trengs på jobb
-- per dag, så bemanningen i gruppene kan ses opp mot hverandre. Og kurs som egen
-- fraværstype.

create table faktura.ansattgrupper (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  navn text not null check (length(navn) between 1 and 40),
  kort text check (kort is null or length(kort) between 1 and 8),  -- forkortelsen i oppsummeringen («Sek.»)
  behov int check (behov is null or behov between 0 and 500),    -- hvor mange som trengs på jobb per dag
  rekkefolge int not null default 0,
  opprettet timestamptz not null default now(),
  unique (org_id, id)
);
create trigger ansattgrupper_org_id before update on faktura.ansattgrupper
  for each row execute function faktura.org_id_uendret();

-- Slettes gruppen, står de ansatte uten gruppe.
alter table faktura.ansatte add column gruppe_id uuid;
alter table faktura.ansatte add constraint ansatte_gruppe_fk foreign key (org_id, gruppe_id)
  references faktura.ansattgrupper(org_id, id) on delete set null (gruppe_id);
create index ansatte_gruppe_idx on faktura.ansatte (org_id, gruppe_id);

-- Gruppene ser de som ser de ansatte; personal styrer dem.
alter table faktura.ansattgrupper enable row level security;
create policy ansattgrupper_les on faktura.ansattgrupper for select using (faktura.kan(org_id, 'personal_les'));
create policy ansattgrupper_ny on faktura.ansattgrupper for insert with check (faktura.kan(org_id, 'personal'));
create policy ansattgrupper_endre on faktura.ansattgrupper for update
  using (faktura.kan(org_id, 'personal')) with check (faktura.kan(org_id, 'personal'));
create policy ansattgrupper_slett on faktura.ansattgrupper for delete using (faktura.kan(org_id, 'personal'));

grant select, delete, insert (org_id, navn, kort, behov, rekkefolge), update (navn, kort, behov, rekkefolge)
  on faktura.ansattgrupper to faktura_app;
grant select (gruppe_id), insert (gruppe_id), update (gruppe_id) on faktura.ansatte to faktura_app;

-- Kurs som egen fraværstype (eier og administrator registrerer det, som ferie).
alter table faktura.fravaer drop constraint fravaer_type_check;
alter table faktura.fravaer add constraint fravaer_type_check
  check (type in ('syk', 'sykt_barn', 'ferie', 'permisjon', 'kurs', 'annet'));

create or replace function faktura.tavle_plassering_foer() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a faktura.ansatte;
  borte text;
begin
  select * into a from faktura.ansatte where org_id = new.org_id and id = new.ansatt_id;
  if not found then return new; end if;
  if not a.aktiv or new.dato < a.ansatt_fra or (a.ansatt_til is not null and new.dato > a.ansatt_til) then
    raise exception '% % er ikke ansatt denne dagen', a.fornavn, a.etternavn using errcode = 'FA400';
  end if;
  borte := faktura.fravaer_type(new.org_id, new.ansatt_id, new.dato);
  if borte is not null then
    raise exception '% % er borte denne dagen (%)', a.fornavn, a.etternavn,
      case borte when 'syk' then 'syk' when 'sykt_barn' then 'sykt barn' when 'ferie' then 'ferie'
                 when 'permisjon' then 'permisjon' when 'kurs' then 'kurs' else 'fravær' end using errcode = 'FA409';
  end if;
  return new;
end $$;
