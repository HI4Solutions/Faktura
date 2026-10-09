-- 0087_regnskap_bilag.sql
-- Regnskapsmodulen, andre del: periodiseringer over flere måneder og år (forskuddsbetalt og påløpt
-- kostnad, uopptjent og opptjent inntekt) bokført måned for måned i bilagserie P, og manuelle bilag
-- i serie M (også inngående balanse). Hovedboken, saldobalansen og bilagsjournalen leses fra alle
-- bilagene (lønn, refusjoner fra NAV, anleggsmidler, periodiseringer og manuelle).
--
-- Beløpene regnes i API-et (server/src/periodisering.ts); databasen fører bilagene med postene og
-- kontrollerer at de henger sammen. Et bilag endres eller slettes aldri; det reverseres.

alter table faktura.bilag drop constraint bilag_kilde_check;
alter table faktura.bilag add constraint bilag_kilde_check check (kilde in ('lonn', 'nav_refusjon', 'anlegg', 'periodisering', 'manuell'));
drop policy bilag_les on faktura.bilag;
create policy bilag_les on faktura.bilag for select
  using ((kilde in ('lonn', 'nav_refusjon') and faktura.kan(org_id, 'personal_les'))
         or (kilde in ('anlegg', 'periodisering', 'manuell') and faktura.kan(org_id, 'regnskap')));

-- ---------------------------------------------------------------------------
-- Periodiseringene
-- ---------------------------------------------------------------------------

-- type: forskuddsbetalt_kostnad (betalt nå, kostnad over månedene: 1700), paalopt_kostnad (kostnad
--   over månedene før fakturaen kommer: 2960), uopptjent_inntekt (fakturert nå, inntekt over
--   månedene: 2970), opptjent_inntekt (inntekt over månedene før den faktureres: 1530).
-- fra og antall_maaneder: månedene beløpet fordeles på (likt, den siste tar resten; endres antallet,
--   fordeles det som står igjen på månedene som er igjen).
-- start: hvordan beløpet kom på balansekontoen for forskudd: ingen (alt ført der), flytt (fra
--   resultatkontoen, der fakturaen er ført) eller motkonto (bank, leverandørgjeld eller
--   kundefordringer, med mva).
create table faktura.periodiseringer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  nummer int not null check (nummer > 0),
  navn text not null check (length(btrim(navn)) between 1 and 120),
  type text not null check (type in ('forskuddsbetalt_kostnad', 'paalopt_kostnad', 'uopptjent_inntekt', 'opptjent_inntekt')),
  belop numeric(14,2) not null check (belop > 0 and belop < 1000000000000),
  fra date not null check (fra = date_trunc('month', fra)::date),
  antall_maaneder int not null check (antall_maaneder between 1 and 120),
  resultatkonto text not null check (resultatkonto ~ '^[0-9]{4,6}$'),
  balansekonto text not null check (balansekonto ~ '^[0-9]{4,6}$'),
  start text not null default 'ingen' check (start in ('ingen', 'flytt', 'motkonto')),
  tekst text check (tekst is null or length(tekst) <= 300),
  opprettet timestamptz not null default now(),
  opprettet_av uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null,
  unique (org_id, id),
  unique (org_id, nummer),
  check (resultatkonto <> balansekonto),
  check (start = 'ingen' or type in ('forskuddsbetalt_kostnad', 'uopptjent_inntekt'))
);
create trigger periodiseringer_revisjon after insert or update or delete on faktura.periodiseringer
  for each row execute function faktura.revider();

-- Det som er bokført: starten (beløpet til balansekontoen) og månedene.
create table faktura.periodiseringsposter (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  periodisering_id uuid not null,
  type text not null check (type in ('start', 'maaned')),
  maaned date check (maaned is null or maaned = date_trunc('month', maaned)::date),
  belop numeric(14,2) not null check (belop > 0),
  bilag_id uuid not null,
  reversert boolean not null default false,
  opprettet timestamptz not null default now(),
  foreign key (org_id, periodisering_id) references faktura.periodiseringer(org_id, id) on delete cascade,
  foreign key (org_id, bilag_id) references faktura.bilag(org_id, id),
  check ((type = 'maaned') = (maaned is not null))
);
create unique index periodiseringsposter_maaned on faktura.periodiseringsposter (periodisering_id, maaned) where type = 'maaned' and not reversert;
create unique index periodiseringsposter_start on faktura.periodiseringsposter (periodisering_id) where type = 'start' and not reversert;
create index periodiseringsposter_bilag on faktura.periodiseringsposter (bilag_id);

alter table faktura.periodiseringer enable row level security;
alter table faktura.periodiseringsposter enable row level security;
create policy periodiseringer_les on faktura.periodiseringer for select using (faktura.kan(org_id, 'regnskap') or faktura.er_system());
create policy periodiseringer_ny on faktura.periodiseringer for insert with check (faktura.kan(org_id, 'regnskap'));
create policy periodiseringer_endre on faktura.periodiseringer for update using (faktura.kan(org_id, 'regnskap')) with check (faktura.kan(org_id, 'regnskap'));
create policy periodiseringer_slett on faktura.periodiseringer for delete using (faktura.kan(org_id, 'regnskap'));
create policy periodiseringsposter_les on faktura.periodiseringsposter for select using (faktura.kan(org_id, 'regnskap') or faktura.er_system());
grant select on faktura.periodiseringer, faktura.periodiseringsposter to faktura_app, faktura_system;
grant insert (org_id, navn, type, belop, fra, antall_maaneder, resultatkonto, balansekonto, start, tekst),
      update (navn, type, belop, fra, antall_maaneder, resultatkonto, balansekonto, start, tekst),
      delete
  on faktura.periodiseringer to faktura_app;

-- Nummeret, og det som ikke kan endres når noe er bokført: typen, beløpet, den første måneden,
-- kontoene og starten (antallet måneder kan endres, men ikke til færre enn det som er bokført).
create function faktura.periodiseringer_foer() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  bokfort boolean;
  sist date;
begin
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('periodiseringer:' || new.org_id::text, 0));
    new.nummer := coalesce((select max(nummer) from faktura.periodiseringer where org_id = new.org_id), 0) + 1;
    return new;
  end if;
  bokfort := exists (select 1 from faktura.periodiseringsposter where periodisering_id = old.id and not reversert);
  if tg_op = 'DELETE' then
    if bokfort then
      raise exception 'Periodiseringen har bokførte bilag. Reverser dem først.' using errcode = 'FA409';
    end if;
    return old;
  end if;
  new.nummer := old.nummer;
  if bokfort and (new.type, new.belop, new.fra, new.resultatkonto, new.balansekonto, new.start)
                 is distinct from (old.type, old.belop, old.fra, old.resultatkonto, old.balansekonto, old.start) then
    raise exception 'Periodiseringen har bokførte bilag: typen, beløpet, den første måneden, kontoene og starten kan ikke endres. Reverser bilagene først.'
      using errcode = 'FA409';
  end if;
  select max(maaned) into sist from faktura.periodiseringsposter where periodisering_id = old.id and type = 'maaned' and not reversert;
  if sist is not null and (new.fra + make_interval(months => new.antall_maaneder - 1))::date < sist then
    raise exception 'Månedene som er bokført, må være med i periodiseringen' using errcode = 'FA409';
  end if;
  return new;
end $$;
create trigger periodiseringer_foer before insert or update or delete on faktura.periodiseringer
  for each row execute function faktura.periodiseringer_foer();

-- Fører et bilag for periodiseringene (serie P) med posteringene (regnet ut av API-et) og postene,
-- og kontrollerer: bilaget går i null, starten bare for forskudd, bare én gang og før månedene,
-- månedene er innenfor periodiseringen og kommer i rekkefølge, og det som er fordelt blir ikke mer
-- enn beløpet.
-- _poster: [{periodisering_id, type, maaned, belop}].
create function faktura.bokfor_periodisering(_org uuid, _dato date, _tekst text, _posteringer jsonb, _poster jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b uuid;
  x jsonb;
  p faktura.periodiseringer;
  m date;
begin
  perform faktura.krev(_org, 'regnskap');
  if _dato is null or length(btrim(coalesce(_tekst, ''))) = 0 then
    raise exception 'Bilaget mangler dato eller tekst' using errcode = 'FA400';
  end if;
  if jsonb_typeof(_poster) <> 'array' or jsonb_array_length(_poster) = 0 or jsonb_typeof(_posteringer) <> 'array' or jsonb_array_length(_posteringer) < 2 then
    raise exception 'Bilaget mangler posteringer' using errcode = 'FA400';
  end if;
  if (select sum((y->>'belop')::numeric(14,2)) from jsonb_array_elements(_posteringer) y) <> 0 then
    raise exception 'Bilaget går ikke i null' using errcode = 'FA400';
  end if;
  insert into faktura.bilag (org_id, serie, aar, nummer, dato, tekst, kilde)
  values (_org, 'P', extract(year from _dato)::int, faktura.neste_bilagsnummer(_org, 'P', extract(year from _dato)::int), _dato, left(btrim(_tekst), 300), 'periodisering')
  returning id into b;
  insert into faktura.posteringer (org_id, bilag_id, rekke, konto, belop, tekst)
  select _org, b, y.n, y.x->>'konto', (y.x->>'belop')::numeric(14,2), left(nullif(btrim(y.x->>'tekst'), ''), 200)
    from jsonb_array_elements(_posteringer) with ordinality as y(x, n);

  for x in select * from jsonb_array_elements(_poster) loop
    select * into p from faktura.periodiseringer where org_id = _org and id = (x->>'periodisering_id')::uuid for update;
    if p.id is null then raise exception 'Fant ikke periodiseringen' using errcode = 'FA404'; end if;
    m := (x->>'maaned')::date;
    if x->>'type' = 'start' then
      if p.start = 'ingen' then raise exception 'Periodisering % har ingen start å bokføre', p.nummer using errcode = 'FA409'; end if;
      if (x->>'belop')::numeric <> p.belop then raise exception 'Starten må være hele beløpet' using errcode = 'FA400'; end if;
      if exists (select 1 from faktura.periodiseringsposter y where y.periodisering_id = p.id and not y.reversert and y.type = 'start') then
        raise exception 'Starten for periodisering % er alt bokført', p.nummer using errcode = 'FA409';
      end if;
    elsif x->>'type' = 'maaned' then
      if m is null or m < p.fra or m > (p.fra + make_interval(months => p.antall_maaneder - 1))::date then
        raise exception 'Måneden er utenfor periodisering %', p.nummer using errcode = 'FA409';
      end if;
      -- Et forskudd med start fordeles først når beløpet er på balansekontoen.
      if p.start <> 'ingen' and not exists (select 1 from faktura.periodiseringsposter y where y.periodisering_id = p.id and not y.reversert and y.type = 'start') then
        raise exception 'Bokfør starten for periodisering % først', p.nummer using errcode = 'FA409';
      end if;
      if exists (select 1 from faktura.periodiseringsposter y where y.periodisering_id = p.id and not y.reversert and y.type = 'maaned' and y.maaned >= m) then
        raise exception 'Periodisering % er alt bokført for måneden (eller en senere)', p.nummer using errcode = 'FA409';
      end if;
    else
      raise exception 'Ukjent post' using errcode = 'FA400';
    end if;
    insert into faktura.periodiseringsposter (org_id, periodisering_id, type, maaned, belop, bilag_id)
    values (_org, p.id, x->>'type', m, (x->>'belop')::numeric(14,2), b);
    if (select coalesce(sum(belop), 0) from faktura.periodiseringsposter where periodisering_id = p.id and type = 'maaned' and not reversert) > p.belop then
      raise exception 'Det som er fordelt for periodisering %, blir mer enn beløpet', p.nummer using errcode = 'FA409';
    end if;
  end loop;
  return b;
end $$;
revoke execute on function faktura.bokfor_periodisering(uuid, date, text, jsonb, jsonb) from public;
grant execute on function faktura.bokfor_periodisering(uuid, date, text, jsonb, jsonb) to faktura_app;

-- Reverserer et bilag for periodiseringene: det siste først for hver periodisering (starten bare
-- når ingen måned er bokført).
create function faktura.reverser_periodisering(_org uuid, _bilag uuid, _tekst text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b faktura.bilag;
  x faktura.periodiseringsposter;
  nr int;
begin
  perform faktura.krev(_org, 'regnskap');
  select * into b from faktura.bilag where org_id = _org and id = _bilag and kilde = 'periodisering' for update;
  if b.id is null then raise exception 'Fant ikke bilaget' using errcode = 'FA404'; end if;
  if b.reverserer is not null or b.reversert_av is not null then
    raise exception 'Bilaget er reversert eller en reversering' using errcode = 'FA409';
  end if;
  for x in select * from faktura.periodiseringsposter where bilag_id = _bilag and not reversert loop
    if exists (select 1 from faktura.periodiseringsposter y
                where y.periodisering_id = x.periodisering_id and not y.reversert and y.bilag_id <> _bilag
                  and (x.type = 'start' or y.maaned > x.maaned)) then
      select nummer into nr from faktura.periodiseringer where id = x.periodisering_id;
      raise exception 'Periodisering % har senere bokføringer. Reverser dem først.', nr using errcode = 'FA409';
    end if;
  end loop;
  update faktura.periodiseringsposter set reversert = true where bilag_id = _bilag;
  return faktura.reverser_bilag(_bilag, coalesce(nullif(btrim(_tekst), ''), 'Reversert: ' || b.tekst));
end $$;
revoke execute on function faktura.reverser_periodisering(uuid, uuid, text) from public;
grant execute on function faktura.reverser_periodisering(uuid, uuid, text) to faktura_app;

-- ---------------------------------------------------------------------------
-- Manuelle bilag (serie M)
-- ---------------------------------------------------------------------------

-- Et bilag med posteringene brukeren fører (også inngående balanse): minst to linjer som går i null.
create function faktura.bokfor_manuelt(_org uuid, _dato date, _tekst text, _posteringer jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b uuid;
begin
  perform faktura.krev(_org, 'regnskap');
  if _dato is null or length(btrim(coalesce(_tekst, ''))) = 0 then
    raise exception 'Skriv dato og tekst for bilaget' using errcode = 'FA400';
  end if;
  if jsonb_typeof(_posteringer) <> 'array' or jsonb_array_length(_posteringer) < 2 or jsonb_array_length(_posteringer) > 200 then
    raise exception 'Bilaget må ha minst to linjer' using errcode = 'FA400';
  end if;
  if (select sum((y->>'belop')::numeric(14,2)) from jsonb_array_elements(_posteringer) y) <> 0 then
    raise exception 'Bilaget går ikke i null: debet og kredit må være like' using errcode = 'FA400';
  end if;
  insert into faktura.bilag (org_id, serie, aar, nummer, dato, tekst, kilde)
  values (_org, 'M', extract(year from _dato)::int, faktura.neste_bilagsnummer(_org, 'M', extract(year from _dato)::int), _dato, left(btrim(_tekst), 300), 'manuell')
  returning id into b;
  insert into faktura.posteringer (org_id, bilag_id, rekke, konto, belop, tekst)
  select _org, b, y.n, y.x->>'konto', (y.x->>'belop')::numeric(14,2), left(nullif(btrim(y.x->>'tekst'), ''), 200)
    from jsonb_array_elements(_posteringer) with ordinality as y(x, n);
  return b;
end $$;
revoke execute on function faktura.bokfor_manuelt(uuid, date, text, jsonb) from public;
grant execute on function faktura.bokfor_manuelt(uuid, date, text, jsonb) to faktura_app;

create function faktura.reverser_manuelt(_org uuid, _bilag uuid, _tekst text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b faktura.bilag;
begin
  perform faktura.krev(_org, 'regnskap');
  select * into b from faktura.bilag where org_id = _org and id = _bilag and kilde = 'manuell' for update;
  if b.id is null then raise exception 'Fant ikke bilaget' using errcode = 'FA404'; end if;
  return faktura.reverser_bilag(_bilag, coalesce(nullif(btrim(_tekst), ''), 'Reversert: ' || b.tekst));
end $$;
revoke execute on function faktura.reverser_manuelt(uuid, uuid, text) from public;
grant execute on function faktura.reverser_manuelt(uuid, uuid, text) to faktura_app;

-- Revisjonsloggen for periodiseringene er for dem som ser regnskapet.
drop policy revisjonslogg_les on faktura.revisjonslogg;
create policy revisjonslogg_les on faktura.revisjonslogg for select
  using (faktura.kan(org_id, 'les')
         and (coalesce(tabell, '') not in ('ansatte', 'ansatt_tillegg', 'fravaer', 'arbeidsplaner', 'ferie_overforinger', 'vaktbytter',
                                           'lonnskjoringer', 'lonn_inngaende', 'timebank_poster', 'avspasering_soknader',
                                           'ameldinger', 'bilag', 'lonnsendringer', 'nav_inntektsmeldinger', 'lonnstrekk',
                                           'naturalytelser', 'reiseregninger', 'nav_refusjoner')
              or faktura.kan(org_id, 'personal_les'))
         and (coalesce(tabell, '') not in ('anleggsmidler', 'regnskap_oppsett', 'saldo_satser', 'periodiseringer')
              or faktura.kan(org_id, 'regnskap'))
         and (coalesce(tabell, '') not in ('fravaer', 'ferie_overforinger', 'avspasering_soknader', 'vaktbytter', 'nav_inntektsmeldinger',
                                           'nav_refusjoner')
              or faktura.kan(org_id, 'personal')));
