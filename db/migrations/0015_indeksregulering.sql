-- 0015_indeksregulering.sql
-- Automatisk indeksregulering (KPI) av produkter, f.eks. husleie og parkeringsleie.
--
-- Én gang i året (valgt måned) får produktet ny pris etter endringen i
-- konsumprisindeksen fra SSB siden forrige regulering (husleieloven § 4-2).
-- Reguleringen planlegges inntil 60 dager før, og kundene med gjentakende
-- fakturaer for produktet varsles på e-post minst én måned før ny pris gjelder.
-- Gjentakende fakturaer med forfall fra og med datoen får ny pris; har kunden
-- en egen pris på linjen, reguleres den med samme faktor.

-- ---------------------------------------------------------------------------
-- KPI fra SSB (tabell 03013, totalindeks, 2015=100)
-- ---------------------------------------------------------------------------

create table faktura.kpi (
  maaned date primary key check (extract(day from maaned) = 1),
  verdi numeric(8,1) not null check (verdi > 0),
  hentet timestamptz not null default now()
);
grant select on faktura.kpi to faktura_app;

-- Workeren lagrer verdiene: [{"maaned": "2026-08-01", "verdi": 137.2}, ...]
create function faktura.lagre_kpi(_verdier jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  if not faktura.er_system() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  insert into faktura.kpi (maaned, verdi)
  select (v ->> 'maaned')::date, (v ->> 'verdi')::numeric from jsonb_array_elements(_verdier) v
  on conflict (maaned) do update set verdi = excluded.verdi, hentet = now()
   where faktura.kpi.verdi is distinct from excluded.verdi;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function faktura.lagre_kpi(jsonb) from public;
grant execute on function faktura.lagre_kpi(jsonb) to faktura_system;

-- ---------------------------------------------------------------------------
-- Innstillinger per produkt
-- ---------------------------------------------------------------------------

alter table faktura.produkter
  add column indeks_aktiv boolean not null default false,
  add column indeks_maaned int check (indeks_maaned between 1 and 12),       -- måneden ny pris gjelder fra
  add column indeks_basis date check (extract(day from indeks_basis) = 1),   -- KPI-måneden prisen bygger på
  add column indeks_andel numeric(5,2) not null default 100 check (indeks_andel > 0 and indeks_andel <= 100),
  add column indeks_bare_okning boolean not null default true,
  add column indeks_hele_kroner boolean not null default true,
  add column indeks_varsle boolean not null default true,
  add constraint produkter_indeks_komplett check (not indeks_aktiv or (indeks_maaned is not null and indeks_basis is not null));

grant insert (indeks_aktiv, indeks_maaned, indeks_basis, indeks_andel, indeks_bare_okning, indeks_hele_kroner, indeks_varsle),
      update (indeks_aktiv, indeks_maaned, indeks_basis, indeks_andel, indeks_bare_okning, indeks_hele_kroner, indeks_varsle)
  on faktura.produkter to faktura_app;

-- ---------------------------------------------------------------------------
-- Reguleringene
-- ---------------------------------------------------------------------------

create table faktura.prisreguleringer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  produkt_id uuid not null,
  aar int not null,                               -- året reguleringen gjelder
  status text not null default 'planlagt' check (status in ('planlagt', 'gjennomfort', 'avbrutt', 'uendret')),
  gjelder_fra date not null,
  gammel_pris numeric(14,2) not null,
  ny_pris numeric(14,2) not null,
  faktor numeric(12,8) not null,
  hele_kroner boolean not null,
  kpi_fra date not null,
  kpi_fra_verdi numeric(8,1) not null,
  kpi_til date not null,
  kpi_til_verdi numeric(8,1) not null,
  andel numeric(5,2) not null,
  varslet int not null default 0,                 -- antall kunder som fikk varsel
  opprettet timestamptz not null default now(),
  gjennomfort_at timestamptz,
  avbrutt_av uuid references faktura.brukere(id),
  unique (produkt_id, aar),
  foreign key (org_id, produkt_id) references faktura.produkter(org_id, id) on delete cascade
);
create unique index prisreguleringer_planlagt_idx on faktura.prisreguleringer (produkt_id) where status = 'planlagt';

-- Hvilke gjentakelser som har fått ny pris, så ingen reguleres to ganger.
-- Bare gjentakelser som fantes da reguleringen ble planlagt, reguleres; en ny avtale
-- er allerede inngått med dagens pris.
create table faktura.prisregulering_gjentakelser (
  regulering_id uuid not null references faktura.prisreguleringer(id) on delete cascade,
  gjentakelse_id uuid not null references faktura.gjentakelser(id) on delete cascade,
  gamle_linjer jsonb not null,                    -- så en avbrutt regulering kan settes tilbake nøyaktig
  regulert timestamptz not null default now(),
  primary key (regulering_id, gjentakelse_id)
);

alter table faktura.prisreguleringer enable row level security;
create policy prisreguleringer_les on faktura.prisreguleringer for select using (faktura.kan(org_id, 'les'));
grant select on faktura.prisreguleringer to faktura_app;

alter table faktura.prisregulering_gjentakelser enable row level security;
create policy prisregulering_gjentakelser_les on faktura.prisregulering_gjentakelser for select
  using (exists (select 1 from faktura.prisreguleringer r where r.id = regulering_id));
grant select on faktura.prisregulering_gjentakelser to faktura_app;

create trigger prisreguleringer_revisjon after insert or update or delete on faktura.prisreguleringer
  for each row execute function faktura.revider();

create function faktura.indeks_pris(_pris numeric, _faktor numeric, _hele_kroner boolean) returns numeric
language sql immutable set search_path = '' as $$
  select round(_pris * _faktor, case when _hele_kroner then 0 else 2 end)
$$;

-- Første dag i reguleringsmåneden som ikke har passert.
create function faktura.neste_reguleringsdato(_maaned int, _fra date) returns date
language sql immutable set search_path = '' as $$
  select case when make_date(extract(year from _fra)::int, _maaned, 1) > _fra
              then make_date(extract(year from _fra)::int, _maaned, 1)
              else make_date(extract(year from _fra)::int + 1, _maaned, 1) end
$$;

-- Hva en regulering ville gitt nå (for visning før den planlegges).
create function faktura.beregn_indeksregulering(_produkt uuid)
returns table (kpi_fra date, kpi_fra_verdi numeric, kpi_til date, kpi_til_verdi numeric, faktor numeric, ny_pris numeric, gjelder_fra date)
language plpgsql stable set search_path = '' as $$
declare
  p faktura.produkter;
begin
  select * into p from faktura.produkter where id = _produkt;   -- RLS gjelder
  if not found or p.indeks_basis is null or p.indeks_maaned is null then return; end if;
  return query
    select p.indeks_basis, f.verdi, t.maaned, t.verdi,
           1 + p.indeks_andel / 100 * (t.verdi / f.verdi - 1),
           faktura.indeks_pris(p.enhetspris, 1 + p.indeks_andel / 100 * (t.verdi / f.verdi - 1), p.indeks_hele_kroner),
           faktura.neste_reguleringsdato(p.indeks_maaned, faktura.i_dag())
      from faktura.kpi f, (select * from faktura.kpi order by maaned desc limit 1) t
     where f.maaned = p.indeks_basis;
end $$;
grant execute on function faktura.beregn_indeksregulering(uuid) to faktura_app;

-- Daglig (worker): planlegg reguleringer som nærmer seg. Returnerer de nye.
create function faktura.planlegg_indeksreguleringer() returns setof faktura.prisreguleringer
language plpgsql security definer set search_path = '' as $$
declare
  p faktura.produkter;
  i_dag date := faktura.i_dag();
  dato date;
  fra faktura.kpi;
  til faktura.kpi;
  f numeric;
  ny faktura.prisreguleringer;
begin
  if not faktura.er_system() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  select * into til from faktura.kpi order by maaned desc limit 1;
  if not found then return; end if;

  for p in
    select * from faktura.produkter x
     where x.indeks_aktiv
       and not exists (select 1 from faktura.prisreguleringer r where r.produkt_id = x.id and r.status = 'planlagt')
     for update
  loop
    dato := faktura.neste_reguleringsdato(p.indeks_maaned, i_dag);
    continue when dato - 60 > i_dag;
    -- Allerede behandlet i år (også avbrutt eller uendret)?
    continue when exists (select 1 from faktura.prisreguleringer r where r.produkt_id = p.id and r.aar = extract(year from dato));
    -- Høyst én regulering per år.
    continue when exists (select 1 from faktura.prisreguleringer r where r.produkt_id = p.id and r.status = 'gjennomfort'
                                                                    and r.gjelder_fra > dato - interval '1 year');
    select * into fra from faktura.kpi where maaned = p.indeks_basis;
    continue when not found or til.maaned <= p.indeks_basis;

    -- Kundene skal ha varsel minst én måned før ny pris gjelder.
    if p.indeks_varsle and dato < i_dag + 31 then
      dato := (date_trunc('month', i_dag + 31) + interval '1 month')::date;
    end if;

    f := 1 + p.indeks_andel / 100 * (til.verdi / fra.verdi - 1);
    insert into faktura.prisreguleringer (org_id, produkt_id, aar, status, gjelder_fra, gammel_pris, ny_pris, faktor,
                                          hele_kroner, kpi_fra, kpi_fra_verdi, kpi_til, kpi_til_verdi, andel)
    values (p.org_id, p.id, extract(year from faktura.neste_reguleringsdato(p.indeks_maaned, i_dag)),
            case when p.indeks_bare_okning and f <= 1 then 'uendret' else 'planlagt' end,
            dato, p.enhetspris, case when p.indeks_bare_okning and f <= 1 then p.enhetspris else faktura.indeks_pris(p.enhetspris, f, p.indeks_hele_kroner) end,
            f, p.indeks_hele_kroner, fra.maaned, fra.verdi, til.maaned, til.verdi, p.indeks_andel)
    returning * into ny;
    if ny.status = 'planlagt' then return next ny; end if;
  end loop;
end $$;
revoke all on function faktura.planlegg_indeksreguleringer() from public;
grant execute on function faktura.planlegg_indeksreguleringer() to faktura_system;

-- Daglig (worker), før gjentakende fakturaer lages:
--  1. Gjentakelser med forfall fra og med reguleringsdatoen får ny pris på linjene for produktet.
--  2. På reguleringsdatoen får produktet ny pris, og KPI-månedene flyttes fram.
create function faktura.anvend_indeksreguleringer() returns int
language plpgsql security definer set search_path = '' as $$
declare
  r faktura.prisreguleringer;
  g faktura.gjentakelser;
  i_dag date := faktura.i_dag();
  n int := 0;
begin
  if not faktura.er_system() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;

  for r in select * from faktura.prisreguleringer
            where status in ('planlagt', 'gjennomfort') and gjelder_fra > i_dag - 400 and faktor <> 1
  loop
    for g in
      select * from faktura.gjentakelser x
       where x.org_id = r.org_id and x.aktiv and x.opprettet < r.opprettet
         and (x.neste_forfall >= r.gjelder_fra or r.status = 'gjennomfort')
         and exists (select 1 from jsonb_array_elements(x.linjer) l where l ->> 'produkt_id' = r.produkt_id::text)
         and not exists (select 1 from faktura.prisregulering_gjentakelser pg where pg.regulering_id = r.id and pg.gjentakelse_id = x.id)
       for update
    loop
      update faktura.gjentakelser
         set linjer = (select jsonb_agg(case when l ->> 'produkt_id' = r.produkt_id::text
                                             then jsonb_set(l, '{enhetspris}', to_jsonb(faktura.indeks_pris((l ->> 'enhetspris')::numeric, r.faktor, r.hele_kroner)))
                                             else l end order by o)
                         from jsonb_array_elements(g.linjer) with ordinality as e(l, o))
       where id = g.id;
      insert into faktura.prisregulering_gjentakelser (regulering_id, gjentakelse_id, gamle_linjer) values (r.id, g.id, g.linjer);
      n := n + 1;
    end loop;
  end loop;

  for r in select * from faktura.prisreguleringer where status = 'planlagt' and gjelder_fra <= i_dag for update loop
    update faktura.produkter set enhetspris = r.ny_pris, indeks_basis = r.kpi_til where id = r.produkt_id;
    update faktura.prisreguleringer set status = 'gjennomfort', gjennomfort_at = now() where id = r.id;
    n := n + 1;
  end loop;

  -- Uendret (KPI gikk ned og bare økning er valgt): neste år sammenlignes fortsatt med samme grunnlag.
  return n;
end $$;
revoke all on function faktura.anvend_indeksreguleringer() from public;
grant execute on function faktura.anvend_indeksreguleringer() to faktura_system;

create function faktura.marker_regulering_varslet(_id uuid, _antall int) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not faktura.er_system() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  update faktura.prisreguleringer set varslet = _antall where id = _id;
end $$;
revoke all on function faktura.marker_regulering_varslet(uuid, int) from public;
grant execute on function faktura.marker_regulering_varslet(uuid, int) to faktura_system;

-- Avbryt en planlagt regulering (før den gjelder). Gjentakelser som allerede har fått
-- ny pris, settes tilbake.
create function faktura.avbryt_indeksregulering(_org uuid, _id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r faktura.prisreguleringer;
begin
  perform faktura.krev(_org, 'skriv');
  select * into r from faktura.prisreguleringer where id = _id and org_id = _org for update;
  if not found then raise exception 'Fant ikke reguleringen' using errcode = 'FA404'; end if;
  if r.status <> 'planlagt' then raise exception 'Bare planlagte reguleringer kan avbrytes' using errcode = 'FA409'; end if;

  -- Er linjene endret av brukeren siden reguleringen, settes bare prisen på produktlinjene
  -- tilbake (samme posisjon og produkt); ellers hele linjesettet slik det var.
  update faktura.gjentakelser x
     set linjer = (select jsonb_agg(case when l ->> 'produkt_id' = r.produkt_id::text and gl ->> 'produkt_id' = r.produkt_id::text
                                         then jsonb_set(l, '{enhetspris}', gl -> 'enhetspris')
                                         else l end order by o)
                     from jsonb_array_elements(x.linjer) with ordinality as e(l, o)
                     left join jsonb_array_elements(pg.gamle_linjer) with ordinality as e2(gl, o2) on o2 = o)
    from faktura.prisregulering_gjentakelser pg
   where pg.regulering_id = r.id and pg.gjentakelse_id = x.id;
  delete from faktura.prisregulering_gjentakelser where regulering_id = r.id;
  update faktura.prisreguleringer set status = 'avbrutt', avbrutt_av = faktura.bruker_id() where id = r.id;
end $$;
grant execute on function faktura.avbryt_indeksregulering(uuid, uuid) to faktura_app;
