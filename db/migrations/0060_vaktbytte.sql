-- 0060_vaktbytte.sql
-- Vaktbytte: den ansatte kan gi bort en vakt, til en bestemt kollega eller til alle med samme
-- rolle (de ser den blant de ledige vaktene), eller bytte den mot en vakt en kollega har. En fast
-- arbeidsdag etter arbeidsplanen (0040) kan byttes på samme måte; den blir da en vakt med de
-- samme tidene. Kollegaen tar vakten (den første som tar et åpent tilbud, får det), bytter eller
-- sier nei takk. Organisasjonen velger om eier eller administrator må godkjenne byttet (standard),
-- om det går gjennom med en gang, eller om vaktbytte er slått av.
--
-- Når byttet går gjennom, får den andre vakten (ved bytte går den andre vakten motsatt vei), og
-- plassene på tavla følger med: den nye tar over plassene den forrige hadde i fasene vakten
-- dekker, også den faste oppgaven (0059), som en vikar (0037). Den som tar vakten, må være aktiv,
-- ansatt den dagen, ikke borte, og ikke ha en annen vakt eller en fast arbeidsdag som overlapper.
-- En fast arbeidsdag samme dag blir en vakt først, så den ikke forsvinner. Hviletid og overtid er
-- advarsler for den som godkjenner, som i vaktplanen ellers.
--
-- Den som gir bort en vakt på en fast arbeidsdag, har fri den dagen (arbeidsplan_fri), så den faste
-- dagen ikke kommer tilbake. Ved et bytte flyttes timene i planen til dagen de får igjen, så et
-- bytte ikke blir ekstratimer (server/src/arbeidsplan.ts).
--
-- En vakt den ansatte er borte fra, eller som har vikar, kan ikke byttes: den står i planen (for
-- sykepengene), og lederen setter inn vikar. Endrer eller flytter lederen en vakt som er tilbudt
-- (dag, tid eller ansatt), faller tilbudet bort (utgått); slettes vakten, slettes tilbudet.

alter table faktura.lonn_oppsett
  add column vaktbytte text not null default 'godkjenning' check (vaktbytte in ('av', 'godkjenning', 'fritt'));
grant insert (vaktbytte), update (vaktbytte) on faktura.lonn_oppsett to faktura_app;

-- ---------------------------------------------------------------------------
-- Hjelpefunksjoner
-- ---------------------------------------------------------------------------

-- Har vakten begynt (norsk tid)?
create function faktura.vakt_begynt(_dato date, _fra time) returns boolean
language sql stable set search_path = '' as $$
  select _dato + _fra <= (now() at time zone 'Europe/Oslo')
$$;

-- Timene fra–til (over midnatt når til er før fra) minus pausen, som for vaktene.
create function faktura.timer_mellom(_fra time, _til time, _pause int) returns numeric
language sql immutable set search_path = '' as $$
  select round((extract(epoch from (_til - _fra)) / 60 + case when _til <= _fra then 1440 else 0 end - _pause) / 60.0, 2)
$$;

-- Overlapper vakten fasen på tavla? Som iFasen i appen: en fase uten tidsrom gjelder hele dagen,
-- og et tidsrom over midnatt går inn i dagen etter.
create function faktura.i_fasen(_vfra time, _vtil time, _ffra time, _ftil time) returns boolean
language sql immutable set search_path = '' as $$
  select _ffra is null or _ftil is null or _vfra is null or _vtil is null
      or (extract(epoch from _vfra) < extract(epoch from _ftil) + case when _ftil <= _ffra then 86400 else 0 end
          and extract(epoch from _ffra) < extract(epoch from _vtil) + case when _vtil <= _vfra then 86400 else 0 end)
$$;

-- ---------------------------------------------------------------------------
-- Fri på en fast arbeidsdag
-- ---------------------------------------------------------------------------

-- Den faste dagen gjelder ikke (vakten er gitt bort). byttet_til: dagen timene i planen er flyttet
-- til (vakten den ansatte fikk igjen), så de ikke blir ekstratimer der.
create table faktura.arbeidsplan_fri (
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  ansatt_id uuid not null,
  dato date not null,
  byttet_til date,
  vaktbytte_id uuid,
  opprettet timestamptz not null default now(),
  primary key (org_id, ansatt_id, dato),
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete cascade
);

alter table faktura.arbeidsplan_fri enable row level security;
create policy arbeidsplan_fri_les on faktura.arbeidsplan_fri for select
  using (faktura.kan(org_id, 'personal_les') or faktura.er_meg(org_id, ansatt_id));
create policy arbeidsplan_fri_slett on faktura.arbeidsplan_fri for delete using (faktura.kan(org_id, 'personal'));
grant select, delete on faktura.arbeidsplan_fri to faktura_app;

-- Dagen etter arbeidsplanen (0040), som bemanningen regner den (server/src/arbeidsplan.ts): planen
-- som gjelder dagen, ukedagen i den, ikke en helligdag, og den ansatte er aktiv og ansatt. En hel
-- dag begynner kl. 08 og varer en femtedel av arbeidstiden i full stilling (som når en vikar
-- settes inn for en fast dag).
create function faktura.plan_dag(_org uuid, _ansatt uuid, _dato date)
returns table (fra time, til time, pause_min int, hel_dag boolean)
language sql stable security definer set search_path = '' as $$
  select coalesce(d.fra, time '08:00'),
         coalesce(d.til, time '08:00' + make_interval(mins => round(round(a.ukentlig_arbeidstid / 5, 2) * 60)::int)),
         d.pause_min,
         d.fra is null
    from faktura.ansatte a
    join lateral (select p.id from faktura.arbeidsplaner p
                   where p.org_id = a.org_id and p.ansatt_id = a.id and p.gjelder_fra <= _dato
                   order by p.gjelder_fra desc limit 1) p on true
    join faktura.arbeidsplan_dager d on d.org_id = a.org_id and d.plan_id = p.id and d.ukedag = extract(isodow from _dato)::int
   where a.org_id = _org and a.id = _ansatt and a.aktiv
     and _dato >= a.ansatt_fra and (a.ansatt_til is null or _dato <= a.ansatt_til)
     and _dato not in (select faktura.helligdager(extract(year from _dato)::int))
$$;

-- Den faste arbeidsdagen som gjelder: dagen i planen, uten en vakt den dagen (vakten gjelder da i
-- stedet) og uten fri.
create function faktura.fast_dag(_org uuid, _ansatt uuid, _dato date)
returns table (fra time, til time, pause_min int, hel_dag boolean)
language sql stable security definer set search_path = '' as $$
  select p.fra, p.til, p.pause_min, p.hel_dag
    from faktura.plan_dag(_org, _ansatt, _dato) p
   where not exists (select 1 from faktura.vakter v where v.org_id = _org and v.ansatt_id = _ansatt and v.dato = _dato)
     and not exists (select 1 from faktura.arbeidsplan_fri f where f.org_id = _org and f.ansatt_id = _ansatt and f.dato = _dato)
$$;

-- Den faste arbeidsdagen blir en publisert vakt med de samme tidene (som den var i planen).
create function faktura.vakt_fra_plan(_org uuid, _ansatt uuid, _dato date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  d record;
  ny uuid;
begin
  select * into d from faktura.fast_dag(_org, _ansatt, _dato);
  if not found then raise exception 'Det er ingen fast arbeidsdag denne dagen' using errcode = 'FA400'; end if;
  insert into faktura.vakter (org_id, ansatt_id, dato, fra, til, pause_min, publisert_at)
  values (_org, _ansatt, _dato, d.fra, d.til, d.pause_min, now())
  returning id into ny;
  return ny;
end $$;

-- ---------------------------------------------------------------------------
-- Hvem kan ta vakten?
-- ---------------------------------------------------------------------------

-- Kan _annen ta over vakter fra _ansatt? En annen aktiv person i organisasjonen med innlogging,
-- med samme rolle (uten rolle: alle).
create function faktura.vaktbytte_kollega(_org uuid, _ansatt uuid, _annen uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from faktura.ansatte a
      join faktura.ansatte b on b.org_id = a.org_id and b.id = _annen
      join faktura.medlemmer m on m.org_id = b.org_id and m.bruker_id = b.bruker_id
     where a.org_id = _org and a.id = _ansatt and b.id <> a.id and b.aktiv
       and (a.gruppe_id is null or b.gruppe_id = a.gruppe_id))
$$;

-- Hva hindrer _ansatt i å ta en vakt (_dato, _fra–_til)? null: ingenting; ellers 'ikke_aktiv',
-- 'ikke_ansatt', 'borte' eller 'overlapp' (en annen vakt eller en fast arbeidsdag overlapper, også
-- over midnatt). _unntatt er vakten, og _fri dagen med den faste arbeidsdagen, de selv gir fra seg i
-- et bytte.
create function faktura.vaktbytte_hindring(_org uuid, _dato date, _fra time, _til time, _ansatt uuid, _unntatt uuid, _fri date)
returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  a faktura.ansatte;
  tid tsrange := faktura.vakt_tid(_dato, _fra, _til);
  d date;
begin
  select * into a from faktura.ansatte where org_id = _org and id = _ansatt;
  if not found or not a.aktiv then return 'ikke_aktiv'; end if;
  if _dato < a.ansatt_fra or (a.ansatt_til is not null and _dato > a.ansatt_til) then return 'ikke_ansatt'; end if;
  if faktura.fravaer_type(_org, _ansatt, _dato) is not null then return 'borte'; end if;
  if exists (select 1 from faktura.vakter o
              where o.org_id = _org and o.ansatt_id = _ansatt and o.id is distinct from _unntatt
                and o.dato between _dato - 1 and _dato + 1
                and faktura.vakt_tid(o.dato, o.fra, o.til) && tid) then
    return 'overlapp';
  end if;
  for d in select x::date from generate_series(_dato - 1, _dato + 1, interval '1 day') x loop
    continue when d = _fri;
    if exists (select 1 from faktura.fast_dag(_org, _ansatt, d) f where faktura.vakt_tid(d, f.fra, f.til) && tid) then
      return 'overlapp';
    end if;
  end loop;
  return null;
end $$;

-- Hindringen som tekst. Om en annen enn en selv sier den bare at det er en annen vakt, ellers ikke
-- hvorfor (fraværet er bare for eier, administrator og den ansatte selv), unntatt for eier og
-- administrator (_detaljer).
create function faktura.vaktbytte_hindring_tekst(_kode text, _navn text, _detaljer boolean) returns text
language sql immutable set search_path = '' as $$
  select case
    when _navn is null then
      case _kode
        when 'overlapp' then 'Du har en annen vakt som overlapper'
        when 'borte' then 'Du er borte denne dagen'
        when 'ikke_ansatt' then 'Du er ikke ansatt denne dagen'
        else 'Du er ikke aktiv'
      end
    when _kode = 'overlapp' then _navn || ' har en annen vakt som overlapper'
    when not _detaljer then _navn || ' kan ikke ta vakten denne dagen'
    when _kode = 'borte' then _navn || ' er borte denne dagen'
    when _kode = 'ikke_ansatt' then _navn || ' er ikke ansatt denne dagen'
    else _navn || ' er ikke aktiv'
  end
$$;

-- ---------------------------------------------------------------------------
-- Vaktbyttene
-- ---------------------------------------------------------------------------

-- tilbudt: venter på kollegaen; akseptert: tatt, venter på godkjenning; godkjent: byttet er gjort;
-- avslatt: kollegaen sa nei takk; avvist: ikke godkjent; trukket: trukket tilbake; utgatt: vakten
-- ble endret i vaktplanen. Et tilbud som ikke er besvart når vakten begynner, vises som utgått.
create table faktura.vaktbytter (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  vakt_id uuid not null,                 -- vakten som gis bort
  fra_ansatt uuid not null,              -- den som gir den bort
  til_ansatt uuid,                       -- en bestemt kollega (null: alle med samme rolle)
  mot_vakt_id uuid,                      -- et bytte: vakten fra_ansatt får igjen (til_ansatt sin)
  tatt_av uuid,                          -- den som tok vakten
  melding text check (melding is null or length(melding) <= 300),
  status text not null default 'tilbudt'
    check (status in ('tilbudt', 'akseptert', 'godkjent', 'avslatt', 'avvist', 'trukket', 'utgatt')),
  grunn text check (grunn is null or length(grunn) <= 300),  -- hvorfor byttet ikke ble godkjent
  opprettet_av uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null,
  opprettet timestamptz not null default now(),
  svart_at timestamptz,
  behandlet_av uuid references faktura.brukere(id) on delete set null,
  behandlet_at timestamptz,
  unique (org_id, id),
  foreign key (org_id, vakt_id) references faktura.vakter(org_id, id) on delete cascade,
  foreign key (org_id, mot_vakt_id) references faktura.vakter(org_id, id) on delete cascade,
  foreign key (org_id, fra_ansatt) references faktura.ansatte(org_id, id) on delete cascade,
  foreign key (org_id, til_ansatt) references faktura.ansatte(org_id, id) on delete cascade,
  foreign key (org_id, tatt_av) references faktura.ansatte(org_id, id) on delete cascade,
  check (mot_vakt_id is null or til_ansatt is not null),
  check (til_ansatt is distinct from fra_ansatt),
  check (mot_vakt_id is distinct from vakt_id)
);
-- Ett åpent tilbud per vakt.
create unique index vaktbytter_aapne_idx on faktura.vaktbytter (org_id, vakt_id) where status in ('tilbudt', 'akseptert');
create index vaktbytter_mot_idx on faktura.vaktbytter (org_id, mot_vakt_id) where mot_vakt_id is not null;
create index vaktbytter_fra_idx on faktura.vaktbytter (org_id, fra_ansatt);
create index vaktbytter_til_idx on faktura.vaktbytter (org_id, til_ansatt) where til_ansatt is not null;

alter table faktura.arbeidsplan_fri add constraint arbeidsplan_fri_bytte_fk
  foreign key (vaktbytte_id) references faktura.vaktbytter(id) on delete set null;

create trigger vaktbytter_org_id before update on faktura.vaktbytter
  for each row execute function faktura.org_id_uendret();
create trigger vaktbytter_revisjon after insert or update or delete on faktura.vaktbytter
  for each row execute function faktura.revider();

-- Eier, administrator og regnskap ser alle; den ansatte de byttene de er med i. Åpne tilbud til
-- kollegaene, med vaktene, leses gjennom vaktbytte_liste. Alt annet skjer gjennom funksjonene under.
alter table faktura.vaktbytter enable row level security;
create policy vaktbytter_les on faktura.vaktbytter for select
  using (faktura.kan(org_id, 'personal_les') or faktura.er_meg(org_id, fra_ansatt)
         or faktura.er_meg(org_id, til_ansatt) or faktura.er_meg(org_id, tatt_av));
grant select on faktura.vaktbytter to faktura_app;

-- En vakt med et åpent tilbud endres i vaktplanen (dag, tid eller ansatt): tilbudet gjelder ikke
-- lenger. (Når byttet selv flytter vakten, er det allerede godkjent.)
create function faktura.vakt_bytte_utgatt() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.ansatt_id, new.dato, new.fra, new.til) is distinct from (old.ansatt_id, old.dato, old.fra, old.til) then
    update faktura.vaktbytter set status = 'utgatt', behandlet_at = now()
     where org_id = new.org_id and (vakt_id = new.id or mot_vakt_id = new.id) and status in ('tilbudt', 'akseptert');
  end if;
  return null;
end $$;
create trigger vakter_bytte_utgatt after update on faktura.vakter
  for each row execute function faktura.vakt_bytte_utgatt();

-- ---------------------------------------------------------------------------
-- Tavla
-- ---------------------------------------------------------------------------

-- Plassene følger vakten (_dato, _fra–_til) fra _gammel til _ny: i fasene vakten dekker, der
-- _gammel ikke lenger er på jobb (en annen vakt samme dag), tar _ny over plassen. Har _ny alt en
-- plass i fasen, står den, og den forriges forsvinner. Uten plass i fasen hadde _gammel den faste
-- oppgaven (0059) der, og den tar _ny over. Står ikke _ny på tavla (rollen), forsvinner plassene.
create function faktura.vaktbytte_tavle(_org uuid, _dato date, _fra time, _til time, _gammel uuid, _ny uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  f record;
  fast uuid;
  paa_tavla boolean;
begin
  select t.oppgave_id into fast from faktura.tavle_fast_oppgave t where t.org_id = _org and t.ansatt_id = _gammel;
  paa_tavla := not exists (select 1 from faktura.ansatte a join faktura.ansattgrupper g on g.org_id = a.org_id and g.id = a.gruppe_id
                            where a.org_id = _org and a.id = _ny and not g.tavle);
  for f in select x.id, x.fra, x.til from faktura.tavle_faser x where x.org_id = _org loop
    continue when not faktura.i_fasen(_fra, _til, f.fra, f.til);
    continue when exists (select 1 from faktura.vakter v
                           where v.org_id = _org and v.ansatt_id = _gammel and v.dato = _dato and faktura.i_fasen(v.fra, v.til, f.fra, f.til));
    if not paa_tavla or exists (select 1 from faktura.tavle_plasseringer p
                                 where p.org_id = _org and p.dato = _dato and p.fase_id = f.id and p.ansatt_id = _ny) then
      delete from faktura.tavle_plasseringer where org_id = _org and dato = _dato and fase_id = f.id and ansatt_id = _gammel;
    elsif exists (select 1 from faktura.tavle_plasseringer p
                   where p.org_id = _org and p.dato = _dato and p.fase_id = f.id and p.ansatt_id = _gammel) then
      update faktura.tavle_plasseringer set ansatt_id = _ny
       where org_id = _org and dato = _dato and fase_id = f.id and ansatt_id = _gammel;
    elsif fast is not null
          and coalesce((select b.antall from faktura.tavle_behov b where b.org_id = _org and b.fase_id = f.id and b.oppgave_id = fast),
                       (select o.behov from faktura.tavle_oppgaver o where o.org_id = _org and o.id = fast)) is distinct from 0 then
      insert into faktura.tavle_plasseringer (org_id, dato, fase_id, oppgave_id, ansatt_id) values (_org, _dato, f.id, fast, _ny);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Selve byttet
-- ---------------------------------------------------------------------------

-- Flytt vakten (og ved bytte den andre vakten). Alt sjekkes på nytt, siden planen kan ha endret
-- seg siden tilbudet. Kalles med byttet allerede satt til godkjent.
create function faktura.vaktbytte_utfor(_b faktura.vaktbytter) returns void
language plpgsql security definer set search_path = '' as $$
declare
  leder boolean := faktura.kan(_b.org_id, 'personal');
  meg uuid := faktura.min_ansatt(_b.org_id);
  v faktura.vakter;
  m faktura.vakter;
  kode text;
  fra_navn text := (select a.fornavn || ' ' || a.etternavn from faktura.ansatte a where a.org_id = _b.org_id and a.id = _b.fra_ansatt);
  tar_navn text := (select a.fornavn || ' ' || a.etternavn from faktura.ansatte a where a.org_id = _b.org_id and a.id = _b.tatt_av);
begin
  select * into v from faktura.vakter where org_id = _b.org_id and id = _b.vakt_id for update;
  if not found or v.ansatt_id is distinct from _b.fra_ansatt or v.publisert_at is null then
    raise exception 'Vakten er endret i vaktplanen, så byttet gjelder ikke lenger' using errcode = 'FA409';
  end if;
  if faktura.vakt_begynt(v.dato, v.fra) then raise exception 'Vakten har begynt' using errcode = 'FA409'; end if;
  if _b.mot_vakt_id is not null then
    select * into m from faktura.vakter where org_id = _b.org_id and id = _b.mot_vakt_id for update;
    if not found or m.ansatt_id is distinct from _b.tatt_av or m.publisert_at is null then
      raise exception 'Vakten det byttes mot, er endret i vaktplanen, så byttet gjelder ikke lenger' using errcode = 'FA409';
    end if;
    if faktura.vakt_begynt(m.dato, m.fra) then raise exception 'Vakten det byttes mot, har begynt' using errcode = 'FA409'; end if;
  end if;

  -- Den som gir bort en vakt, må være på jobb den dagen (vakten de er borte fra, står for
  -- sykepengene) og vakten kan ikke ha vikar.
  if faktura.fravaer_type(_b.org_id, _b.fra_ansatt, v.dato) is not null
     or exists (select 1 from faktura.vakter x where x.org_id = _b.org_id and x.vikar_for = v.id) then
    raise exception '%', case when leder or meg = _b.fra_ansatt then format('%s er borte denne dagen eller har vikar, så vakten kan ikke byttes', fra_navn)
                              else 'Vakten kan ikke byttes nå' end using errcode = 'FA409';
  end if;
  if m.id is not null and (faktura.fravaer_type(_b.org_id, _b.tatt_av, m.dato) is not null
                           or exists (select 1 from faktura.vakter x where x.org_id = _b.org_id and x.vikar_for = m.id)) then
    raise exception '%', case when leder or meg = _b.tatt_av then format('%s er borte denne dagen eller har vikar, så vakten kan ikke byttes', tar_navn)
                              else 'Vakten det byttes mot, kan ikke byttes nå' end using errcode = 'FA409';
  end if;

  kode := faktura.vaktbytte_hindring(_b.org_id, v.dato, v.fra, v.til, _b.tatt_av, m.id, null);
  if kode is not null then
    raise exception '%', faktura.vaktbytte_hindring_tekst(kode, case when meg = _b.tatt_av then null else tar_navn end, leder) using errcode = 'FA409';
  end if;
  if m.id is not null then
    kode := faktura.vaktbytte_hindring(_b.org_id, m.dato, m.fra, m.til, _b.fra_ansatt, v.id, null);
    if kode is not null then
      raise exception '%', faktura.vaktbytte_hindring_tekst(kode, case when meg = _b.fra_ansatt then null else fra_navn end, leder) using errcode = 'FA409';
    end if;
  end if;

  -- En fast arbeidsdag samme dag hos den som får en vakt, blir en vakt, så den ikke forsvinner.
  if exists (select 1 from faktura.fast_dag(_b.org_id, _b.tatt_av, v.dato)) then
    perform faktura.vakt_fra_plan(_b.org_id, _b.tatt_av, v.dato);
  end if;
  if m.id is not null and exists (select 1 from faktura.fast_dag(_b.org_id, _b.fra_ansatt, m.dato)) then
    perform faktura.vakt_fra_plan(_b.org_id, _b.fra_ansatt, m.dato);
  end if;

  update faktura.vakter set ansatt_id = _b.tatt_av where org_id = _b.org_id and id = v.id;
  if m.id is not null then
    update faktura.vakter set ansatt_id = _b.fra_ansatt where org_id = _b.org_id and id = m.id;
  end if;

  -- Den som ga bort vakten på en fast arbeidsdag, har fri den dagen (uten en annen vakt samme dag).
  if exists (select 1 from faktura.plan_dag(_b.org_id, _b.fra_ansatt, v.dato))
     and not exists (select 1 from faktura.vakter x where x.org_id = _b.org_id and x.ansatt_id = _b.fra_ansatt and x.dato = v.dato) then
    insert into faktura.arbeidsplan_fri (org_id, ansatt_id, dato, byttet_til, vaktbytte_id)
    values (_b.org_id, _b.fra_ansatt, v.dato, m.dato, _b.id)
    on conflict (org_id, ansatt_id, dato) do update set byttet_til = excluded.byttet_til, vaktbytte_id = excluded.vaktbytte_id;
  end if;
  if m.id is not null and exists (select 1 from faktura.plan_dag(_b.org_id, _b.tatt_av, m.dato))
     and not exists (select 1 from faktura.vakter x where x.org_id = _b.org_id and x.ansatt_id = _b.tatt_av and x.dato = m.dato) then
    insert into faktura.arbeidsplan_fri (org_id, ansatt_id, dato, byttet_til, vaktbytte_id)
    values (_b.org_id, _b.tatt_av, m.dato, v.dato, _b.id)
    on conflict (org_id, ansatt_id, dato) do update set byttet_til = excluded.byttet_til, vaktbytte_id = excluded.vaktbytte_id;
  end if;

  perform faktura.vaktbytte_tavle(_b.org_id, v.dato, v.fra, v.til, _b.fra_ansatt, _b.tatt_av);
  if m.id is not null then
    perform faktura.vaktbytte_tavle(_b.org_id, m.dato, m.fra, m.til, _b.tatt_av, _b.fra_ansatt);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Tilby, svare, godkjenne og trekke tilbake
-- ---------------------------------------------------------------------------

create function faktura.vaktbytte_modus(_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select l.vaktbytte from faktura.lonn_oppsett l where l.org_id = _org), 'godkjenning')
$$;

-- Gi bort (eller bytt) en egen vakt (_vakt) eller en fast arbeidsdag (_dato): til en kollega
-- (_til), eller til alle med samme rolle. Et bytte (_mot, eller kollegaens faste arbeidsdag
-- _mot_dato) går til en bestemt kollega.
create function faktura.tilby_vaktbytte(_org uuid, _vakt uuid, _dato date, _til uuid, _mot uuid, _mot_dato date, _melding text)
returns faktura.vaktbytter
language plpgsql security definer set search_path = '' as $$
declare
  meg uuid := faktura.min_ansatt(_org);
  v faktura.vakter;
  m faktura.vakter;
  b faktura.vaktbytter;
  kode text;
begin
  if meg is null then raise exception 'Du er ikke registrert som aktiv ansatt her' using errcode = 'FA403'; end if;
  if faktura.vaktbytte_modus(_org) = 'av' then
    raise exception 'Vaktbytte er ikke slått på i organisasjonen' using errcode = 'FA403';
  end if;
  if (_vakt is null) = (_dato is null) then raise exception 'Velg vakten du vil bytte' using errcode = 'FA400'; end if;
  if _mot is not null and _mot_dato is not null then raise exception 'Velg én vakt å bytte mot' using errcode = 'FA400'; end if;
  if (_mot is not null or _mot_dato is not null) and _til is null then
    raise exception 'Velg hvem du vil bytte med' using errcode = 'FA400';
  end if;
  if _til = meg then raise exception 'Velg en annen enn deg selv' using errcode = 'FA400'; end if;
  if _til is not null and not faktura.vaktbytte_kollega(_org, meg, _til) then
    raise exception 'Du kan bare bytte med kolleger med samme rolle' using errcode = 'FA400';
  end if;
  if _dato < faktura.i_dag() or _mot_dato < faktura.i_dag() then
    raise exception 'Vakten er passert' using errcode = 'FA409';
  end if;

  -- Vakten (en fast arbeidsdag blir en vakt med de samme tidene).
  if _vakt is null then _vakt := faktura.vakt_fra_plan(_org, meg, _dato); end if;
  select * into v from faktura.vakter where org_id = _org and id = _vakt for update;
  if not found or v.ansatt_id is distinct from meg or v.publisert_at is null then
    raise exception 'Fant ikke vakten' using errcode = 'FA404';
  end if;
  if faktura.vakt_begynt(v.dato, v.fra) then raise exception 'Vakten har begynt' using errcode = 'FA409'; end if;
  if faktura.fravaer_type(_org, meg, v.dato) is not null
     or exists (select 1 from faktura.vakter x where x.org_id = _org and x.vikar_for = v.id) then
    raise exception 'Du er borte denne dagen, eller vakten har vikar. Lederen setter inn vikar.' using errcode = 'FA409';
  end if;
  if exists (select 1 from faktura.timeforinger t where t.org_id = _org and t.vakt_id = v.id) then
    raise exception 'Timene for vakten er ført' using errcode = 'FA409';
  end if;
  if exists (select 1 from faktura.vaktbytter x where x.org_id = _org and x.vakt_id = v.id and x.status in ('tilbudt', 'akseptert')) then
    raise exception 'Vakten er allerede tilbudt. Trekk tilbake tilbudet først.' using errcode = 'FA409';
  end if;

  -- Vakten du får igjen.
  if _mot_dato is not null then _mot := faktura.vakt_fra_plan(_org, _til, _mot_dato); end if;
  if _mot is not null then
    select * into m from faktura.vakter where org_id = _org and id = _mot for update;
    if not found or m.ansatt_id is distinct from _til or m.publisert_at is null then
      raise exception 'Fant ikke vakten du vil bytte mot' using errcode = 'FA404';
    end if;
    if faktura.vakt_begynt(m.dato, m.fra) then raise exception 'Vakten du vil bytte mot, har begynt' using errcode = 'FA409'; end if;
    if faktura.fravaer_type(_org, _til, m.dato) is not null
       or exists (select 1 from faktura.vakter x where x.org_id = _org and x.vikar_for = m.id)
       or exists (select 1 from faktura.timeforinger t where t.org_id = _org and t.vakt_id = m.id)
       or exists (select 1 from faktura.vaktbytter x where x.org_id = _org and x.vakt_id = m.id and x.status in ('tilbudt', 'akseptert')) then
      raise exception 'Den vakten kan ikke byttes nå' using errcode = 'FA409';
    end if;
    kode := faktura.vaktbytte_hindring(_org, m.dato, m.fra, m.til, meg, v.id, null);
    if kode is not null then raise exception '%', faktura.vaktbytte_hindring_tekst(kode, null, false) using errcode = 'FA409'; end if;
  end if;

  -- En bestemt kollega må kunne ta vakten.
  if _til is not null then
    kode := faktura.vaktbytte_hindring(_org, v.dato, v.fra, v.til, _til, m.id, null);
    if kode is not null then
      raise exception '%', faktura.vaktbytte_hindring_tekst(kode,
        (select a.fornavn || ' ' || a.etternavn from faktura.ansatte a where a.org_id = _org and a.id = _til), false) using errcode = 'FA409';
    end if;
  end if;

  insert into faktura.vaktbytter (org_id, vakt_id, fra_ansatt, til_ansatt, mot_vakt_id, melding)
  values (_org, v.id, meg, _til, m.id, nullif(btrim(_melding), ''))
  returning * into b;
  return b;
end $$;

-- Svar på et tilbud: ta vakten (eller bytt), eller nei takk. Uten godkjenning går byttet gjennom
-- med en gang; ellers venter det på eier eller administrator. Nei takk etter at vakten er tatt
-- (mens den venter på godkjenning) angrer: et åpent tilbud blir åpent igjen.
create function faktura.svar_vaktbytte(_org uuid, _bytte uuid, _ja boolean) returns faktura.vaktbytter
language plpgsql security definer set search_path = '' as $$
declare
  meg uuid := faktura.min_ansatt(_org);
  modus text := faktura.vaktbytte_modus(_org);
  b faktura.vaktbytter;
  v faktura.vakter;
  m faktura.vakter;
  kode text;
begin
  if meg is null then raise exception 'Du er ikke registrert som aktiv ansatt her' using errcode = 'FA403'; end if;
  select * into b from faktura.vaktbytter where org_id = _org and id = _bytte for update;
  if not found or b.fra_ansatt = meg
     or (b.til_ansatt is not null and b.til_ansatt <> meg)
     or (b.til_ansatt is null and not faktura.vaktbytte_kollega(_org, b.fra_ansatt, meg)) then
    raise exception 'Fant ikke tilbudet' using errcode = 'FA404';
  end if;

  if not _ja then
    if b.status = 'akseptert' and b.tatt_av = meg then
      if b.til_ansatt is null then
        update faktura.vaktbytter set status = 'tilbudt', tatt_av = null, svart_at = null where id = b.id returning * into b;
      else
        update faktura.vaktbytter set status = 'avslatt', svart_at = now() where id = b.id returning * into b;
      end if;
      return b;
    end if;
    if b.status <> 'tilbudt' then raise exception 'Tilbudet gjelder ikke lenger' using errcode = 'FA409'; end if;
    if b.til_ansatt is null then raise exception 'Et åpent tilbud trenger ikke svar' using errcode = 'FA400'; end if;
    update faktura.vaktbytter set status = 'avslatt', svart_at = now() where id = b.id returning * into b;
    return b;
  end if;

  if b.status in ('akseptert', 'godkjent') then raise exception 'Vakten er allerede tatt' using errcode = 'FA409'; end if;
  if b.status <> 'tilbudt' then
    raise exception '%', case b.status when 'trukket' then 'Tilbudet er trukket tilbake' else 'Tilbudet gjelder ikke lenger' end using errcode = 'FA409';
  end if;
  if modus = 'av' then raise exception 'Vaktbytte er ikke slått på i organisasjonen' using errcode = 'FA403'; end if;
  select * into v from faktura.vakter where org_id = _org and id = b.vakt_id;
  if faktura.vakt_begynt(v.dato, v.fra) then raise exception 'Vakten har begynt' using errcode = 'FA409'; end if;
  kode := faktura.vaktbytte_hindring(_org, v.dato, v.fra, v.til, meg, b.mot_vakt_id, null);
  if kode is not null then raise exception '%', faktura.vaktbytte_hindring_tekst(kode, null, false) using errcode = 'FA409'; end if;
  if b.mot_vakt_id is not null then
    select * into m from faktura.vakter where org_id = _org and id = b.mot_vakt_id;
    if faktura.vakt_begynt(m.dato, m.fra) then raise exception 'Vakten din har begynt' using errcode = 'FA409'; end if;
    kode := faktura.vaktbytte_hindring(_org, m.dato, m.fra, m.til, b.fra_ansatt, v.id, null);
    if kode is not null then
      raise exception '%', faktura.vaktbytte_hindring_tekst(kode,
        (select a.fornavn || ' ' || a.etternavn from faktura.ansatte a where a.org_id = _org and a.id = b.fra_ansatt), false) using errcode = 'FA409';
    end if;
  end if;

  update faktura.vaktbytter
     set tatt_av = meg, svart_at = now(), status = case when modus = 'fritt' then 'godkjent' else 'akseptert' end
   where id = b.id
  returning * into b;
  if b.status = 'godkjent' then perform faktura.vaktbytte_utfor(b); end if;
  return b;
end $$;

-- Godkjenn eller avvis et bytte som venter (eier og administrator).
create function faktura.behandle_vaktbytte(_org uuid, _bytte uuid, _godkjenn boolean, _grunn text) returns faktura.vaktbytter
language plpgsql security definer set search_path = '' as $$
declare
  b faktura.vaktbytter;
begin
  perform faktura.krev(_org, 'personal');
  select * into b from faktura.vaktbytter where org_id = _org and id = _bytte for update;
  if not found then raise exception 'Fant ikke vaktbyttet' using errcode = 'FA404'; end if;
  if b.status <> 'akseptert' then raise exception 'Vaktbyttet venter ikke på godkjenning' using errcode = 'FA409'; end if;
  if _grunn is not null and length(btrim(_grunn)) > 300 then raise exception 'Grunnen kan ha høyst 300 tegn' using errcode = 'FA400'; end if;
  update faktura.vaktbytter
     set status = case when _godkjenn then 'godkjent' else 'avvist' end,
         grunn = case when _godkjenn then null else nullif(btrim(_grunn), '') end,
         behandlet_av = faktura.bruker_id(), behandlet_at = now()
   where id = b.id
  returning * into b;
  if _godkjenn then perform faktura.vaktbytte_utfor(b); end if;
  return b;
end $$;

-- Trekk tilbake et tilbud som ikke er gjennomført (den som tilbød, eller eier og administrator).
create function faktura.trekk_vaktbytte(_org uuid, _bytte uuid) returns faktura.vaktbytter
language plpgsql security definer set search_path = '' as $$
declare
  b faktura.vaktbytter;
begin
  select * into b from faktura.vaktbytter where org_id = _org and id = _bytte for update;
  if not found or not (faktura.er_meg(_org, b.fra_ansatt) or faktura.kan(_org, 'personal')) then
    raise exception 'Fant ikke tilbudet' using errcode = 'FA404';
  end if;
  if b.status not in ('tilbudt', 'akseptert') then raise exception 'Tilbudet er ikke åpent lenger' using errcode = 'FA409'; end if;
  update faktura.vaktbytter set status = 'trukket', behandlet_av = faktura.bruker_id(), behandlet_at = now()
   where id = b.id
  returning * into b;
  return b;
end $$;

-- ---------------------------------------------------------------------------
-- Oversikten
-- ---------------------------------------------------------------------------

-- Byttene den innloggede ser: eier, administrator og regnskap alle; den ansatte sine egne, de som
-- er til dem, og de åpne tilbudene fra kolleger med samme rolle. Åpne bytter og de som ble avsluttet
-- de siste 30 dagene. hindring: hva som hindrer den innloggede i å ta vakten (et tilbud de kan
-- svare på).
create function faktura.vaktbytte_liste(_org uuid)
returns table (id uuid, status text, fra_ansatt uuid, fra_navn text, til_ansatt uuid, til_navn text, tatt_av uuid, tatt_av_navn text,
               vakt_id uuid, dato date, fra text, til text, timer numeric, oppgave text,
               mot_vakt_id uuid, mot_dato date, mot_fra text, mot_til text, mot_timer numeric, mot_oppgave text,
               melding text, grunn text, opprettet timestamptz, svart_at timestamptz, behandlet_at timestamptz, behandlet_av_navn text,
               hindring text)
language sql stable security definer set search_path = '' as $$
  with meg as (select faktura.min_ansatt(_org) as id, faktura.kan(_org, 'personal_les') as leder)
  select b.id,
         case when b.status in ('tilbudt', 'akseptert')
                   and (faktura.vakt_begynt(v.dato, v.fra) or (m.id is not null and faktura.vakt_begynt(m.dato, m.fra))) then 'utgatt'
              else b.status end,
         b.fra_ansatt, fa.fornavn || ' ' || fa.etternavn,
         b.til_ansatt, ta.fornavn || ' ' || ta.etternavn,
         b.tatt_av, xa.fornavn || ' ' || xa.etternavn,
         v.id, v.dato, to_char(v.fra, 'HH24:MI'), to_char(v.til, 'HH24:MI'), v.timer, v.oppgave,
         m.id, m.dato, to_char(m.fra, 'HH24:MI'), to_char(m.til, 'HH24:MI'), m.timer, m.oppgave,
         b.melding, b.grunn, b.opprettet, b.svart_at, b.behandlet_at, coalesce(bb.navn, bb.epost),
         case when b.status = 'tilbudt' and meg.id is not null and meg.id <> b.fra_ansatt
                   and (b.til_ansatt = meg.id or (b.til_ansatt is null and faktura.vaktbytte_kollega(_org, b.fra_ansatt, meg.id)))
              then faktura.vaktbytte_hindring(_org, v.dato, v.fra, v.til, meg.id, b.mot_vakt_id, null) end
    from faktura.vaktbytter b
    cross join meg
    join faktura.vakter v on v.org_id = b.org_id and v.id = b.vakt_id
    left join faktura.vakter m on m.org_id = b.org_id and m.id = b.mot_vakt_id
    join faktura.ansatte fa on fa.org_id = b.org_id and fa.id = b.fra_ansatt
    left join faktura.ansatte ta on ta.org_id = b.org_id and ta.id = b.til_ansatt
    left join faktura.ansatte xa on xa.org_id = b.org_id and xa.id = b.tatt_av
    left join faktura.brukere bb on bb.id = b.behandlet_av
   where b.org_id = _org
     and (meg.leder
          or (meg.id is not null
              and (b.fra_ansatt = meg.id or b.til_ansatt = meg.id or b.tatt_av = meg.id
                   or (b.til_ansatt is null and b.status = 'tilbudt' and faktura.vaktbytte_kollega(_org, b.fra_ansatt, meg.id)))))
     and (b.status in ('tilbudt', 'akseptert') or coalesce(b.behandlet_at, b.svart_at, b.opprettet) > now() - interval '30 days')
   order by v.dato, v.fra, b.opprettet
$$;

-- Kollegaene den innloggede kan gi vakten (_vakt) eller den faste arbeidsdagen (_dato) til, og hva
-- som hindrer dem.
create function faktura.vaktbytte_kolleger(_org uuid, _vakt uuid, _dato date)
returns table (ansatt_id uuid, navn text, hindring text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  meg uuid := faktura.min_ansatt(_org);
  v record;
begin
  if meg is null then raise exception 'Du er ikke registrert som aktiv ansatt her' using errcode = 'FA403'; end if;
  if _vakt is not null then
    select x.id, x.dato, x.fra, x.til into v from faktura.vakter x where x.org_id = _org and x.id = _vakt and x.ansatt_id = meg;
  else
    select null::uuid as id, _dato as dato, f.fra, f.til into v from faktura.fast_dag(_org, meg, _dato) f;
  end if;
  if v.dato is null then raise exception 'Fant ikke vakten' using errcode = 'FA404'; end if;
  return query
    select a.id, a.fornavn || ' ' || a.etternavn, faktura.vaktbytte_hindring(_org, v.dato, v.fra, v.til, a.id, null, null)
      from faktura.ansatte a
     where a.org_id = _org and faktura.vaktbytte_kollega(_org, meg, a.id)
     order by a.fornavn, a.etternavn;
end $$;

-- Vaktene (og de faste arbeidsdagene) til kollegaene som den innloggedes vakt (_vakt) eller faste
-- arbeidsdag (_dato) kan byttes mot, fra _fra til _til, og hva som hindrer byttet: den innloggede
-- (hindring_meg) eller kollegaen (hindring_annen).
create function faktura.vaktbytte_kandidater(_org uuid, _vakt uuid, _dato date, _fra date, _til date)
returns table (vakt_id uuid, ansatt_id uuid, navn text, dato date, fra text, til text, timer numeric, oppgave text, hel_dag boolean,
               hindring_meg text, hindring_annen text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  meg uuid := faktura.min_ansatt(_org);
  v record;
begin
  if meg is null then raise exception 'Du er ikke registrert som aktiv ansatt her' using errcode = 'FA403'; end if;
  if _til < _fra or _til - _fra > 92 then raise exception 'Velg en periode på høyst tre måneder' using errcode = 'FA400'; end if;
  if _vakt is not null then
    select x.id, x.dato, x.fra, x.til into v from faktura.vakter x where x.org_id = _org and x.id = _vakt and x.ansatt_id = meg;
  else
    select null::uuid as id, _dato as dato, f.fra, f.til into v from faktura.fast_dag(_org, meg, _dato) f;
  end if;
  if v.dato is null then raise exception 'Fant ikke vakten' using errcode = 'FA404'; end if;
  return query
    with kolleger as (
      select a.id, a.fornavn || ' ' || a.etternavn as navn
        from faktura.ansatte a
       where a.org_id = _org and faktura.vaktbytte_kollega(_org, meg, a.id)
    ), kandidater as (
      select w.id as vakt_id, k.id as ansatt_id, k.navn, w.dato, w.fra, w.til, w.timer, w.oppgave, false as hel_dag
        from kolleger k
        join faktura.vakter w on w.org_id = _org and w.ansatt_id = k.id
       where w.dato between greatest(_fra, faktura.i_dag()) and _til and w.publisert_at is not null
         and not faktura.vakt_begynt(w.dato, w.fra)
         and faktura.fravaer_type(_org, k.id, w.dato) is null
         and not exists (select 1 from faktura.vakter x where x.org_id = _org and x.vikar_for = w.id)
         and not exists (select 1 from faktura.timeforinger t where t.org_id = _org and t.vakt_id = w.id)
         and not exists (select 1 from faktura.vaktbytter x where x.org_id = _org and x.vakt_id = w.id and x.status in ('tilbudt', 'akseptert'))
      union all
      select null::uuid, k.id, k.navn, g.d, f.fra, f.til, faktura.timer_mellom(f.fra, f.til, f.pause_min), null::text, f.hel_dag
        from kolleger k
        cross join lateral (select x::date as d from generate_series(greatest(_fra, faktura.i_dag()), _til, interval '1 day') x) g
        cross join lateral faktura.fast_dag(_org, k.id, g.d) f
       where not faktura.vakt_begynt(g.d, f.fra)
         and faktura.fravaer_type(_org, k.id, g.d) is null
    )
    select c.vakt_id, c.ansatt_id, c.navn, c.dato, to_char(c.fra, 'HH24:MI'), to_char(c.til, 'HH24:MI'), c.timer, c.oppgave, c.hel_dag,
           faktura.vaktbytte_hindring(_org, c.dato, c.fra, c.til, meg, v.id, case when v.id is null then v.dato end),
           faktura.vaktbytte_hindring(_org, v.dato, v.fra, v.til, c.ansatt_id, c.vakt_id, case when c.vakt_id is null then c.dato end)
      from kandidater c
     order by c.dato, c.fra, c.navn;
end $$;

-- Loggen for vaktbyttene (med meldingene) er, som for de ansatte, bare for dem som ser de ansatte.
drop policy revisjonslogg_les on faktura.revisjonslogg;
create policy revisjonslogg_les on faktura.revisjonslogg for select
  using (faktura.kan(org_id, 'les')
         and (coalesce(tabell, '') not in ('ansatte', 'ansatt_tillegg', 'fravaer', 'arbeidsplaner', 'ferie_overforinger', 'vaktbytter')
              or faktura.kan(org_id, 'personal_les'))
         and (coalesce(tabell, '') not in ('fravaer', 'ferie_overforinger') or faktura.kan(org_id, 'personal')));

-- ---------------------------------------------------------------------------
-- Tilgang til funksjonene
-- ---------------------------------------------------------------------------

revoke all on function faktura.vakt_begynt(date, time), faktura.timer_mellom(time, time, int), faktura.i_fasen(time, time, time, time),
  faktura.plan_dag(uuid, uuid, date), faktura.fast_dag(uuid, uuid, date), faktura.vakt_fra_plan(uuid, uuid, date),
  faktura.vaktbytte_kollega(uuid, uuid, uuid), faktura.vaktbytte_hindring(uuid, date, time, time, uuid, uuid, date),
  faktura.vaktbytte_hindring_tekst(text, text, boolean), faktura.vakt_bytte_utgatt(), faktura.vaktbytte_tavle(uuid, date, time, time, uuid, uuid),
  faktura.vaktbytte_utfor(faktura.vaktbytter), faktura.vaktbytte_modus(uuid),
  faktura.tilby_vaktbytte(uuid, uuid, date, uuid, uuid, date, text), faktura.svar_vaktbytte(uuid, uuid, boolean),
  faktura.behandle_vaktbytte(uuid, uuid, boolean, text), faktura.trekk_vaktbytte(uuid, uuid),
  faktura.vaktbytte_liste(uuid), faktura.vaktbytte_kolleger(uuid, uuid, date), faktura.vaktbytte_kandidater(uuid, uuid, date, date, date)
  from public;
grant execute on function faktura.tilby_vaktbytte(uuid, uuid, date, uuid, uuid, date, text), faktura.svar_vaktbytte(uuid, uuid, boolean),
  faktura.behandle_vaktbytte(uuid, uuid, boolean, text), faktura.trekk_vaktbytte(uuid, uuid),
  faktura.vaktbytte_liste(uuid), faktura.vaktbytte_kolleger(uuid, uuid, date), faktura.vaktbytte_kandidater(uuid, uuid, date, date, date)
  to faktura_app;
-- Varslene om åpne tilbud går til kollegaene som kan ta vakten (API-et regner det ut som system).
grant execute on function faktura.vaktbytte_kollega(uuid, uuid, uuid), faktura.vaktbytte_hindring(uuid, date, time, time, uuid, uuid, date)
  to faktura_system;
