-- 0050_feriebank.sql
-- Feriebank: hvor mange feriedager hver ansatt har i ferieåret (kalenderåret), hvor mange som er
-- avviklet og planlagt, og hvor mange som er igjen. Avviklet og planlagt regnes av fraværet med
-- typen ferie, så banken justeres av seg selv når ferie registreres, endres eller slettes.
--
-- Dagene telles i den ansattes arbeidsdager: dagene i den faste arbeidsplanen som gjelder den
-- dagen (ellers mandag til fredag), uten helligdager. Retten er organisasjonens feriedager for en
-- uke med fem arbeidsdager (standard 25, altså fem uker), regnet om etter hvor mange dager i uka
-- den ansatte jobber, og en uke ekstra fra året den ansatte fyller 60 (ferieloven § 5). Begynner
-- den ansatte etter 30. september, er retten én uke det året. Retten kan settes for den enkelte.
--
-- Den ansatte kan søke om å overføre feriedager til neste år; eier og administrator godkjenner
-- eller avslår (den skriftlige avtalen ferieloven § 7 krever). Godkjente dager trekkes fra i
-- året de overføres fra og legges til året etter. Som fraværstypen (0047) ser bare eier,
-- administrator og den ansatte selv feriebanken.

alter table faktura.lonn_oppsett
  add column ferie_dager numeric(4,1) not null default 25 check (ferie_dager >= 0 and ferie_dager <= 60);
grant insert (ferie_dager), update (ferie_dager) on faktura.lonn_oppsett to faktura_app;

-- Feriedager per år for denne ansatte (null: organisasjonens, regnet om etter arbeidsdagene).
alter table faktura.ansatte add column ferie_dager numeric(4,1) check (ferie_dager >= 0 and ferie_dager <= 60);
grant select (ferie_dager), insert (ferie_dager), update (ferie_dager) on faktura.ansatte to faktura_app;

-- ---------------------------------------------------------------------------
-- Helligdager og arbeidsdager
-- ---------------------------------------------------------------------------

-- Første påskedag (den gregorianske kalenderen, algoritmen til Meeus/Jones/Butcher).
create function faktura.paaskedag(_aar int) returns date
language plpgsql immutable set search_path = '' as $$
declare
  a int := _aar % 19;
  b int := _aar / 100;
  c int := _aar % 100;
  h int;
  l int;
  m int;
begin
  h := (19 * a + b - b / 4 - (b - (b + 8) / 25 + 1) / 3 + 15) % 30;
  l := (32 + 2 * (b % 4) + 2 * (c / 4) - h - c % 4) % 7;
  m := (a + 11 * h + 22 * l) / 451;
  return make_date(_aar, (h + l - 7 * m + 114) / 31, (h + l - 7 * m + 114) % 31 + 1);
end $$;

-- De offentlige høytidsdagene (helligdagene, 1. og 17. mai).
create function faktura.helligdager(_aar int) returns setof date
language sql immutable set search_path = '' as $$
  select make_date(_aar, 1, 1)
  union all select faktura.paaskedag(_aar) + x from unnest(array[-3, -2, 0, 1, 39, 49, 50]) x  -- skjærtorsdag til 2. pinsedag
  union all select make_date(_aar, 5, 1)
  union all select make_date(_aar, 5, 17)
  union all select make_date(_aar, 12, 25)
  union all select make_date(_aar, 12, 26)
$$;

-- Er dagen en arbeidsdag for den ansatte? Dagene i den faste planen som gjelder den dagen (uten
-- plan, eller en plan uten dager: mandag til fredag), og ikke en helligdag.
create function faktura.arbeidsdag(_org uuid, _ansatt uuid, _dato date) returns boolean
language sql stable security definer set search_path = '' as $$
  select _dato not in (select faktura.helligdager(extract(year from _dato)::int))
     and coalesce((
       select extract(isodow from _dato)::int = any (array_agg(d.ukedag))
         from faktura.arbeidsplan_dager d
        where d.plan_id = (select p.id from faktura.arbeidsplaner p
                            where p.org_id = _org and p.ansatt_id = _ansatt and p.gjelder_fra <= _dato
                            order by p.gjelder_fra desc limit 1)
       having count(*) > 0), extract(isodow from _dato) <= 5)
$$;

-- «12» og «12,5».
create function faktura.dager_tekst(_n numeric) returns text
language sql immutable set search_path = '' as $$
  select case when _n = trunc(_n) then trunc(_n)::text else replace(rtrim(_n::text, '0'), '.', ',') end
$$;

-- ---------------------------------------------------------------------------
-- Overføring til neste år
-- ---------------------------------------------------------------------------

create table faktura.ferie_overforinger (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  ansatt_id uuid not null,
  fra_aar int not null check (fra_aar between 2000 and 2100),  -- dagene overføres til året etter
  dager numeric(4,1) not null check (dager > 0 and dager <= 60 and dager * 2 = trunc(dager * 2)),
  begrunnelse text check (begrunnelse is null or length(begrunnelse) <= 500),
  status text not null default 'venter' check (status in ('venter', 'godkjent', 'avslatt')),
  svar text check (svar is null or length(svar) <= 500),
  soknad_av uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null,
  behandlet_av uuid references faktura.brukere(id) on delete set null,
  behandlet_at timestamptz,
  opprettet timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete cascade
);
create index ferie_overforinger_ansatt_idx on faktura.ferie_overforinger (org_id, ansatt_id, fra_aar);

-- Saldoen for én ansatt i ett ferieår, uten tilgangssjekk (brukes av funksjonene under).
create function faktura.ferie_saldo(_org uuid, _ansatt uuid, _aar int)
returns table (dager_per_uke int, rett numeric, egen_rett boolean, ekstra_60 boolean, sen_start boolean,
               overfort_inn numeric, overfort_ut numeric, avviklet numeric, planlagt numeric, igjen numeric, venter numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  a faktura.ansatte;
  start date := make_date(_aar, 1, 1);
  slutt date := make_date(_aar, 12, 31);
  ref date := least(greatest(faktura.i_dag(), make_date(_aar, 1, 1)), make_date(_aar, 12, 31));
  i_dag date := faktura.i_dag();
  plan uuid;
  org_dager numeric;
begin
  select * into a from faktura.ansatte where org_id = _org and id = _ansatt;
  if not found then return; end if;

  -- Arbeidsdagene i uka: planen som gjelder i dag (i et tidligere år: ved årets slutt), eller den
  -- første planen i året; uten plan fem.
  select p.id into plan from faktura.arbeidsplaner p
   where p.org_id = _org and p.ansatt_id = _ansatt and p.gjelder_fra <= slutt
   order by (p.gjelder_fra <= ref) desc, case when p.gjelder_fra <= ref then p.gjelder_fra end desc nulls last, p.gjelder_fra
   limit 1;
  dager_per_uke := coalesce(nullif((select count(*) from faktura.arbeidsplan_dager d where d.plan_id = plan), 0), 5);

  ekstra_60 := a.fodselsdato is not null and extract(year from a.fodselsdato) + 60 <= _aar;
  sen_start := a.ansatt_fra > make_date(_aar, 9, 30);
  egen_rett := a.ferie_dager is not null;
  org_dager := coalesce((select l.ferie_dager from faktura.lonn_oppsett l where l.org_id = _org), 25);
  rett := case
            when a.ferie_dager is not null then a.ferie_dager
            when sen_start then dager_per_uke
            else (round(org_dager * dager_per_uke / 5 * 2) / 2)::numeric(4,1) + case when ekstra_60 then dager_per_uke else 0 end
          end;

  select coalesce(sum(o.dager) filter (where o.fra_aar = _aar - 1 and o.status = 'godkjent'), 0),
         coalesce(sum(o.dager) filter (where o.fra_aar = _aar and o.status = 'godkjent'), 0),
         coalesce(sum(o.dager) filter (where o.fra_aar = _aar and o.status = 'venter'), 0)
    into overfort_inn, overfort_ut, venter
    from faktura.ferie_overforinger o
   where o.org_id = _org and o.ansatt_id = _ansatt and o.fra_aar in (_aar - 1, _aar);

  select count(*) filter (where g.d <= i_dag), count(*) filter (where g.d > i_dag)
    into avviklet, planlagt
    from faktura.fravaer f,
         lateral (select x::date as d from generate_series(greatest(f.fra, start), least(f.til, slutt), interval '1 day') x) g
   where f.org_id = _org and f.ansatt_id = _ansatt and f.type = 'ferie' and f.til >= start and f.fra <= slutt
     and faktura.arbeidsdag(_org, _ansatt, g.d);

  igjen := rett + overfort_inn - overfort_ut - avviklet - planlagt;
  return next;
end $$;

-- Feriebanken for ferieåret: eier og administrator ser alle som er ansatt i (deler av) året, den
-- ansatte bare seg selv.
create function faktura.feriebank(_org uuid, _aar int)
returns table (ansatt_id uuid, navn text, aktiv boolean, dager_per_uke int, rett numeric, egen_rett boolean, ekstra_60 boolean,
               sen_start boolean, overfort_inn numeric, overfort_ut numeric, avviklet numeric, planlagt numeric, igjen numeric, venter numeric)
language sql stable security definer set search_path = '' as $$
  select a.id, a.fornavn || ' ' || a.etternavn, a.aktiv, s.*
    from faktura.ansatte a, faktura.ferie_saldo(_org, a.id, _aar) s
   where a.org_id = _org and faktura.ser_fravaertype(_org, a.id)
     and a.ansatt_fra <= make_date(_aar, 12, 31) and (a.ansatt_til is null or a.ansatt_til >= make_date(_aar, 1, 1))
   order by a.etternavn, a.fornavn
$$;

-- Ferien i året for én ansatt, med arbeidsdagene hver periode teller (avviklet til og med i dag).
create function faktura.ferie_perioder(_org uuid, _ansatt uuid, _aar int)
returns table (id uuid, fra date, til date, notat text, dager int, avviklet int)
language sql stable security definer set search_path = '' as $$
  select f.id, f.fra, f.til, f.notat,
         count(*) filter (where faktura.arbeidsdag(_org, _ansatt, g.d))::int,
         count(*) filter (where faktura.arbeidsdag(_org, _ansatt, g.d) and g.d <= faktura.i_dag())::int
    from faktura.fravaer f,
         lateral (select x::date as d from generate_series(greatest(f.fra, make_date(_aar, 1, 1)), least(f.til, make_date(_aar, 12, 31)), interval '1 day') x) g
   where f.org_id = _org and f.ansatt_id = _ansatt and f.type = 'ferie'
     and f.til >= make_date(_aar, 1, 1) and f.fra <= make_date(_aar, 12, 31)
     and faktura.ser_fravaertype(_org, _ansatt)
   group by f.id
   order by f.fra
$$;

-- Søknadene kontrolleres: den ansatte søker for seg selv (fra i år eller i fjor), og bare eier
-- og administrator godkjenner og avslår. Ingen kan overføre mer enn det som er igjen.
create function faktura.ferie_overforing_foer() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  leder boolean := faktura.kan(new.org_id, 'personal');
  i_aar int := extract(year from faktura.i_dag())::int;
  s record;
  andre numeric;
  rom numeric;
begin
  if tg_op = 'UPDATE' then
    if (new.org_id, new.ansatt_id, new.fra_aar) is distinct from (old.org_id, old.ansatt_id, old.fra_aar) then
      raise exception 'Søknaden kan ikke flyttes til en annen ansatt eller et annet år' using errcode = 'FA400';
    end if;
    if old.status <> 'venter' and (new.status, new.dager) is distinct from (old.status, old.dager) then
      raise exception 'Søknaden er allerede behandlet' using errcode = 'FA409';
    end if;
  end if;
  new.begrunnelse := nullif(btrim(new.begrunnelse), '');
  new.svar := nullif(btrim(new.svar), '');
  if tg_op = 'INSERT' then
    new.soknad_av := faktura.bruker_id();
    if not leder then
      if new.status <> 'venter' then
        raise exception 'Overføringen må godkjennes av eier eller administrator' using errcode = 'FA403';
      end if;
      if new.fra_aar not in (i_aar, i_aar - 1) then
        raise exception 'Du kan søke om å overføre ferie fra i år eller fra i fjor' using errcode = 'FA400';
      end if;
    end if;
  end if;
  if new.status <> 'venter' and (tg_op = 'INSERT' or old.status = 'venter') then
    new.behandlet_av := faktura.bruker_id();
    new.behandlet_at := now();
  end if;

  if new.status in ('venter', 'godkjent') then
    select * into s from faktura.ferie_saldo(new.org_id, new.ansatt_id, new.fra_aar);
    -- En ny søknad: heller ikke det andre søknader som venter, ber om.
    andre := case when new.status = 'venter'
                  then coalesce((select sum(o.dager) from faktura.ferie_overforinger o
                                  where o.org_id = new.org_id and o.ansatt_id = new.ansatt_id and o.fra_aar = new.fra_aar
                                    and o.status = 'venter' and o.id <> new.id), 0)
                  else 0 end;
    rom := coalesce(s.igjen, 0) - andre;
    if new.dager > rom then
      raise exception '%', case when rom <= 0 then format('Det er ingen feriedager igjen å overføre fra %s', new.fra_aar)
                                else format('Det er bare %s feriedager igjen å overføre fra %s', faktura.dager_tekst(rom), new.fra_aar) end
        using errcode = 'FA400';
    end if;
  end if;
  return new;
end $$;

create trigger ferie_overforinger_foer before insert or update on faktura.ferie_overforinger
  for each row execute function faktura.ferie_overforing_foer();
create trigger ferie_overforinger_org_id before update on faktura.ferie_overforinger
  for each row execute function faktura.org_id_uendret();
create trigger ferie_overforinger_revisjon after insert or update or delete on faktura.ferie_overforinger
  for each row execute function faktura.revider();

alter table faktura.ferie_overforinger enable row level security;
create policy ferie_overforinger_les on faktura.ferie_overforinger for select
  using (faktura.ser_fravaertype(org_id, ansatt_id));
create policy ferie_overforinger_ny on faktura.ferie_overforinger for insert
  with check (faktura.kan(org_id, 'personal') or faktura.er_meg(org_id, ansatt_id));
create policy ferie_overforinger_endre on faktura.ferie_overforinger for update
  using (faktura.kan(org_id, 'personal')) with check (faktura.kan(org_id, 'personal'));
-- Den ansatte kan trekke en søknad som venter; eier og administrator kan slette alle.
create policy ferie_overforinger_slett on faktura.ferie_overforinger for delete
  using (faktura.kan(org_id, 'personal') or (faktura.er_meg(org_id, ansatt_id) and status = 'venter'));

grant select, delete, insert (org_id, ansatt_id, fra_aar, dager, begrunnelse, status), update (status, svar, dager)
  on faktura.ferie_overforinger to faktura_app;

revoke all on function faktura.paaskedag(int), faktura.helligdager(int), faktura.arbeidsdag(uuid, uuid, date), faktura.dager_tekst(numeric),
  faktura.ferie_saldo(uuid, uuid, int), faktura.feriebank(uuid, int), faktura.ferie_perioder(uuid, uuid, int) from public;
grant execute on function faktura.paaskedag(int), faktura.helligdager(int), faktura.dager_tekst(numeric),
  faktura.feriebank(uuid, int), faktura.ferie_perioder(uuid, uuid, int) to faktura_app, faktura_system;

-- Loggen for overføringene er, som for fraværet, bare for eier og administrator.
drop policy revisjonslogg_les on faktura.revisjonslogg;
create policy revisjonslogg_les on faktura.revisjonslogg for select
  using (faktura.kan(org_id, 'les')
         and (coalesce(tabell, '') not in ('ansatte', 'fravaer', 'arbeidsplaner', 'ferie_overforinger') or faktura.kan(org_id, 'personal_les'))
         and (coalesce(tabell, '') not in ('fravaer', 'ferie_overforinger') or faktura.kan(org_id, 'personal')));
