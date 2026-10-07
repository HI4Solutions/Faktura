-- 0032_paaminnelser.sql
-- Påminnelser: et push-varsel (og e-post om man vil) på datoer man velger, om fakturaer som
-- må lages for hånd. Det passer når beløpet varierer fra gang til gang (strøm, timer,
-- forbruk), så en gjentakende faktura ikke kan sendes av seg selv. Varselet åpner en ny
-- faktura med kunden og produktene fylt inn; beløpet fyller man inn selv.

create table faktura.paaminnelser (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  tekst text not null check (btrim(tekst) <> '' and char_length(tekst) <= 200),
  kunde_id uuid,
  produkter uuid[] not null default '{}' check (cardinality(produkter) <= 10),
  intervall text not null default 'maaned' check (intervall in ('maaned', 'kvartal', 'aar', 'uke', 'en_gang')),
  dag int not null check (dag between 1 and 31),            -- dagen i måneden datoene følger (31: siste dag)
  neste_dato date not null,
  klokkeslett time not null default '08:00',                -- norsk tid
  hvem text not null default 'meg' check (hvem in ('meg', 'alle')), -- den som lagde den, eller alle som kan fakturere
  epost boolean not null default false,
  aktiv boolean not null default true,
  sist_varslet timestamptz,
  opprettet timestamptz not null default now(),
  opprettet_av uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null,
  oppdatert timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, kunde_id) references faktura.kunder(org_id, id) on delete cascade
);
create index paaminnelser_neste_idx on faktura.paaminnelser (neste_dato) where aktiv;
create index paaminnelser_org_idx on faktura.paaminnelser (org_id);

-- Teksten uten mellomrom rundt, og bare produkter fra organisasjonen (de som legges til; et
-- produkt som er slettet etterpå, hoppes over når fakturaen fylles ut).
create function faktura.paaminnelse_sjekk() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.tekst := btrim(new.tekst);
  if exists (select 1 from unnest(new.produkter) x
              where x <> all (case when tg_op = 'UPDATE' then old.produkter else '{}'::uuid[] end)
                and not exists (select 1 from faktura.produkter p where p.id = x and p.org_id = new.org_id)) then
    raise exception 'Fant ikke produktet' using errcode = 'FA400';
  end if;
  if tg_op = 'UPDATE' then new.oppdatert := now(); end if;
  return new;
end $$;
create trigger paaminnelser_sjekk before insert or update on faktura.paaminnelser
  for each row execute function faktura.paaminnelse_sjekk();

alter table faktura.paaminnelser enable row level security;
create policy paaminnelser_les on faktura.paaminnelser for select using (faktura.kan(org_id, 'les'));
create policy paaminnelser_ny on faktura.paaminnelser for insert with check (faktura.kan(org_id, 'skriv'));
create policy paaminnelser_endre on faktura.paaminnelser for update
  using (faktura.kan(org_id, 'skriv')) with check (faktura.kan(org_id, 'skriv'));
create policy paaminnelser_slett on faktura.paaminnelser for delete using (faktura.kan(org_id, 'skriv'));

grant select, delete on faktura.paaminnelser to faktura_app;
grant insert (org_id, tekst, kunde_id, produkter, intervall, dag, neste_dato, klokkeslett, hvem, epost, aktiv),
      update (tekst, kunde_id, produkter, intervall, dag, neste_dato, klokkeslett, hvem, epost, aktiv)
  on faktura.paaminnelser to faktura_app;
grant select, update (neste_dato, aktiv, sist_varslet) on faktura.paaminnelser to faktura_system;

-- Datoen etter _dato: en uke, eller én periode med samme dag i måneden (den 31. blir siste
-- dag i korte måneder). Null for en påminnelse som bare skal sendes én gang.
create function faktura.neste_paaminnelse(_dato date, _intervall text, _dag int) returns date
language sql immutable set search_path = '' as $$
  select case _intervall
    when 'uke' then _dato + 7
    when 'en_gang' then null
    else faktura.neste_forfall(_dato, _intervall, _dag)
  end
$$;

-- Workeren: påminnelsene som skal sendes nå. Hver flyttes med en gang til neste dato etter i
-- dag (eller stoppes, om den bare skulle sendes én gang), så den ikke sendes to ganger, og
-- ikke én gang for hver periode om workeren har stått stille. Raden kommer tilbake med
-- datoen den gjaldt.
create function faktura.ta_paaminnelser(_grense int default 100) returns setof faktura.paaminnelser
language plpgsql set search_path = '' as $$
declare
  p faktura.paaminnelser;
  neste date;
begin
  if not faktura.er_system() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  for p in
    select * from faktura.paaminnelser
     where aktiv and neste_dato <= faktura.i_dag()
       and (neste_dato + klokkeslett) at time zone 'Europe/Oslo' <= now()
     order by neste_dato, klokkeslett
     limit _grense
     for update skip locked
  loop
    neste := p.neste_dato;
    if p.intervall <> 'en_gang' then
      loop
        neste := faktura.neste_paaminnelse(neste, p.intervall, p.dag);
        exit when neste > faktura.i_dag();
      end loop;
    end if;
    update faktura.paaminnelser
       set neste_dato = neste, aktiv = p.intervall <> 'en_gang', sist_varslet = now()
     where id = p.id;
    return next p;
  end loop;
end $$;
revoke all on function faktura.paaminnelse_sjekk(), faktura.neste_paaminnelse(date, text, int), faktura.ta_paaminnelser(int) from public;
grant execute on function faktura.neste_paaminnelse(date, text, int) to faktura_app;
grant execute on function faktura.ta_paaminnelser(int) to faktura_system;
