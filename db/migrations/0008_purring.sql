-- 0008_purring.sql
-- Betalingspåminnelse og inkassovarsel etter inkassoloven § 9:
--   * påminnelse tidligst etter forfall, med minst 14 dagers ny frist
--   * inkassovarsel tidligst når fristen i påminnelsen er ute, igjen med 14 dager
--   * purregebyr (satt av organisasjonen, innenfor inkassoforskriftens grense) én gang per faktura

alter table faktura.organisasjoner
  add column purring_auto boolean not null default false,
  add column purring_dager int not null default 7 check (purring_dager between 0 and 60),
  add column purregebyr numeric(10,2) not null default 0 check (purregebyr between 0 and 200);

grant update (purring_auto, purring_dager, purregebyr) on faktura.organisasjoner to faktura_app;

create table faktura.purringer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  faktura_id uuid not null,
  nummer int not null,
  type text not null check (type in ('paaminnelse', 'inkassovarsel')),
  utestaende numeric(14,2) not null,          -- det som gjensto av fakturaen da purringen ble laget
  gebyr numeric(10,2) not null default 0,
  ny_frist date not null,
  automatisk boolean not null default false,
  sendt_til text,
  sendt_at timestamptz,
  opprettet timestamptz not null default now(),
  opprettet_av uuid references faktura.brukere(id),
  foreign key (org_id, faktura_id) references faktura.fakturaer(org_id, id),
  unique (faktura_id, nummer)
);
create index purringer_faktura_idx on faktura.purringer (faktura_id);

alter table faktura.purringer enable row level security;
create policy purringer_les on faktura.purringer for select using (faktura.kan(org_id, 'les'));
grant select on faktura.purringer to faktura_app;

create trigger purringer_revisjon after insert or update on faktura.purringer
  for each row execute function faktura.revider();

create function faktura.lag_purring(_id uuid, _type text, _automatisk boolean default false)
returns faktura.purringer
language plpgsql security definer set search_path = '' as $$
declare
  f faktura.fakturaer;
  o faktura.organisasjoner;
  p faktura.purringer;
  forrige faktura.purringer;
  i_dag date := faktura.i_dag();
  nytt_gebyr numeric(10,2) := 0;
begin
  select * into f from faktura.fakturaer where id = _id for update;
  if not found then raise exception 'Fant ikke fakturaen' using errcode = 'FA404'; end if;
  perform faktura.krev(f.org_id, 'utsted');
  if f.type <> 'faktura' or f.status <> 'utstedt' then
    raise exception 'Bare ubetalte fakturaer kan purres' using errcode = 'FA409';
  end if;
  if f.forfallsdato >= i_dag then
    raise exception 'Fakturaen har ikke forfalt ennå' using errcode = 'FA409';
  end if;
  select * into o from faktura.organisasjoner where id = f.org_id;
  select * into forrige from faktura.purringer where faktura_id = _id order by nummer desc limit 1;

  if forrige.id is not null and forrige.ny_frist >= i_dag then
    raise exception 'Fristen i forrige purring (%) er ikke ute ennå', to_char(forrige.ny_frist, 'DD.MM.YYYY') using errcode = 'FA409';
  end if;
  if _type = 'inkassovarsel' and not exists (select 1 from faktura.purringer where faktura_id = _id and type = 'paaminnelse') then
    raise exception 'Send en betalingspåminnelse før inkassovarsel' using errcode = 'FA409';
  end if;
  if _type = 'paaminnelse' and not exists (select 1 from faktura.purringer where faktura_id = _id and purringer.gebyr > 0) then
    nytt_gebyr := o.purregebyr;
  end if;

  insert into faktura.purringer (org_id, faktura_id, nummer, type, utestaende, gebyr, ny_frist, automatisk, opprettet_av)
  values (f.org_id, _id, coalesce(forrige.nummer, 0) + 1, _type,
          f.sum_inkl_mva - f.kreditert_belop - f.betalt_belop, nytt_gebyr, i_dag + 14, _automatisk, faktura.bruker_id())
  returning * into p;

  insert into faktura.utboks (org_id, hendelse, aggregat_id, data)
  values (f.org_id, 'faktura.purret', f.id,
          jsonb_build_object('faktura_id', f.id, 'purring_id', p.id, 'type', p.type, 'gebyr', p.gebyr, 'ny_frist', p.ny_frist));
  return p;
end $$;

create function faktura.marker_purring_sendt(_id uuid, _til text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  p faktura.purringer;
begin
  select * into p from faktura.purringer where id = _id;
  if not found then raise exception 'Fant ikke purringen' using errcode = 'FA404'; end if;
  perform faktura.krev(p.org_id, 'utsted');
  update faktura.purringer set sendt_til = _til, sendt_at = now() where id = _id;
end $$;

grant execute on function
  faktura.lag_purring(uuid, text, boolean),
  faktura.marker_purring_sendt(uuid, text)
to faktura_app;
