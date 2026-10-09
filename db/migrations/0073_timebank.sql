-- Timebank (server/src/timebank.ts): timer den ansatte har jobbet utover det avtalte, som tas ut
-- som fri (avspasering) senere i stedet for å lønnes nå. Slås på under Innstillinger → Ansatte og
-- timer (lonn_oppsett.timebank).
--
-- Inn: overtid og ekstratimer (uten overtid) som føres «til timebanken» (timeforinger.timebank),
-- når de er godkjent. Timene lønnes ikke nå; for overtid utbetales overtidstillegget likevel
-- (arbeidsmiljøloven § 10-6: overtidstimene kan avspaseres etter skriftlig avtale, men tillegget
-- skal utbetales). Eier og administrator kan også legge til eller trekke fra timer for hånd
-- (justering, f.eks. en dag for jobb på en fridag, eller saldoen fra før).
--
-- Ut: avspasering i hele dager (fraværstypen avspasering, med timene den tar fra banken), eller
-- noen timer én dag (en post i timebanken, uten fravær), og utbetaling av timer fra banken i neste
-- lønnskjøring. Den ansatte søker om avspasering, og eier eller administrator godkjenner eller
-- avslår (avspasering er ikke en rett; tidspunktet avtales). Lederen kan også registrere den selv.
--
-- Saldoen regnes av det som finnes (som feriebanken), så den stemmer når timer godkjennes eller
-- avvises og fravær endres. Lønnskjøringen (server/src/lonnsberegning.ts) lønner ikke timene i
-- banken, betaler avspasering for dem med timelønn, og betaler ut timer fra banken.

alter table faktura.lonn_oppsett add column timebank boolean not null default false;
grant insert (timebank), update (timebank) on faktura.lonn_oppsett to faktura_app;

-- Om timebanken er slått på i organisasjonen.
create function faktura.timebank_paa(_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select l.timebank from faktura.lonn_oppsett l where l.org_id = _org), false)
$$;

-- ---------------------------------------------------------------------------
-- Inn: overtid og ekstratimer til timebanken
-- ---------------------------------------------------------------------------

alter table faktura.timeforinger
  add column timebank boolean not null default false,
  add constraint timeforinger_timebank check (not timebank or overtid_prosent is not null or uten_overtid);
grant insert (timebank), update (timebank) on faktura.timeforinger to faktura_app;

create function faktura.timer_timebank() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.timebank and new.overtid_prosent is null and not new.uten_overtid then
    raise exception 'Bare overtid og ekstratimer (uten overtid) kan settes i timebanken' using errcode = 'FA400';
  end if;
  if new.timebank and (tg_op = 'INSERT' or not old.timebank) and not faktura.timebank_paa(new.org_id) then
    raise exception 'Timebanken er ikke slått på (Innstillinger → Ansatte og timer)' using errcode = 'FA400';
  end if;
  return new;
end $$;
create trigger timeforinger_timebank before insert or update on faktura.timeforinger
  for each row execute function faktura.timer_timebank();

-- Som før (0069), og valget om timebanken kan heller ikke endres når timene er lønnet.
create or replace function faktura.timer_lonnet() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.lonnskjoring_id is null or not exists (select 1 from faktura.organisasjoner where id = old.org_id) then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Timene er lønnet og kan ikke slettes. Åpne lønnskjøringen igjen først.' using errcode = 'FA409';
  end if;
  if new.lonnskjoring_id is not distinct from old.lonnskjoring_id
     and (new.dato, new.timer, new.overtid_prosent, new.uten_overtid, new.timebank, new.status)
         is distinct from (old.dato, old.timer, old.overtid_prosent, old.uten_overtid, old.timebank, old.status) then
    raise exception 'Timene er lønnet og kan ikke endres. Åpne lønnskjøringen igjen først.' using errcode = 'FA409';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Ut: avspasering i hele dager (fravær)
-- ---------------------------------------------------------------------------

alter table faktura.fravaer drop constraint fravaer_type_check;
alter table faktura.fravaer add constraint fravaer_type_check
  check (type in ('syk', 'sykt_barn', 'ferie', 'permisjon', 'kurs', 'avspasering', 'annet'));
-- Timene avspaseringen tar fra timebanken (bare for avspasering).
alter table faktura.fravaer
  add column timer numeric(6,2) check (timer is null or (timer > 0 and timer <= 2000)),
  add constraint fravaer_avspasering_timer check ((type = 'avspasering') = (timer is not null));
grant insert (timer), update (timer) on faktura.fravaer to faktura_app;

-- Annet fravær har ikke timer; avspasering må ha dem, og kan bare registreres når timebanken er på.
create function faktura.fravaer_timebank() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.type <> 'avspasering' then
    new.timer := null;
    return new;
  end if;
  if new.timer is null then
    raise exception 'Skriv hvor mange timer avspaseringen tar fra timebanken' using errcode = 'FA400';
  end if;
  if (tg_op = 'INSERT' or old.type <> 'avspasering') and not faktura.timebank_paa(new.org_id) then
    raise exception 'Timebanken er ikke slått på (Innstillinger → Ansatte og timer)' using errcode = 'FA400';
  end if;
  return new;
end $$;
create trigger fravaer_timebank before insert or update on faktura.fravaer
  for each row execute function faktura.fravaer_timebank();

-- ---------------------------------------------------------------------------
-- Postene: justering, avspasering i timer og utbetaling
-- ---------------------------------------------------------------------------

-- justering: lagt til eller trukket fra for hånd (med en grunn). avspasering: noen timer fri én
-- dag (uten fravær). utbetaling: timer som lønnes i neste lønnskjøring (lonnskjoring_id settes når
-- kjøringen godkjennes). Avspasering og utbetaling er negative.
create table faktura.timebank_poster (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  ansatt_id uuid not null,
  dato date not null,
  type text not null check (type in ('justering', 'avspasering', 'utbetaling')),
  timer numeric(7,2) not null check (timer <> 0 and abs(timer) <= 2000),
  tekst text check (tekst is null or length(tekst) <= 300),
  lonnskjoring_id uuid references faktura.lonnskjoringer(id) on delete set null,
  opprettet_av uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null,
  opprettet timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete cascade,
  check (type = 'justering' or timer < 0),
  check (lonnskjoring_id is null or type = 'utbetaling')
);
create index timebank_poster_ansatt_idx on faktura.timebank_poster (org_id, ansatt_id, dato);
create index timebank_poster_ulonnet_idx on faktura.timebank_poster (org_id, dato) where type = 'utbetaling' and lonnskjoring_id is null;

create function faktura.timebank_post_foer() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a faktura.ansatte;
begin
  if tg_op = 'DELETE' then
    if old.lonnskjoring_id is not null and exists (select 1 from faktura.organisasjoner where id = old.org_id) then
      raise exception 'Utbetalingen er lønnet og kan ikke slettes. Åpne lønnskjøringen igjen først.' using errcode = 'FA409';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if (new.org_id, new.ansatt_id, new.type) is distinct from (old.org_id, old.ansatt_id, old.type) then
      raise exception 'Posten kan ikke flyttes eller få en annen type' using errcode = 'FA400';
    end if;
    if old.lonnskjoring_id is not null and new.lonnskjoring_id is not distinct from old.lonnskjoring_id
       and (new.dato, new.timer, new.tekst) is distinct from (old.dato, old.timer, old.tekst) then
      raise exception 'Utbetalingen er lønnet og kan ikke endres. Åpne lønnskjøringen igjen først.' using errcode = 'FA409';
    end if;
  elsif not faktura.timebank_paa(new.org_id) then
    raise exception 'Timebanken er ikke slått på (Innstillinger → Ansatte og timer)' using errcode = 'FA400';
  end if;
  new.tekst := nullif(btrim(new.tekst), '');
  -- Uttak lagres som negative timer.
  if new.type <> 'justering' and new.timer > 0 then new.timer := -new.timer; end if;
  if new.type = 'justering' and new.tekst is null then
    raise exception 'Skriv hvorfor timebanken justeres' using errcode = 'FA400';
  end if;
  select * into a from faktura.ansatte where org_id = new.org_id and id = new.ansatt_id;
  if new.type = 'avspasering' and (new.dato < a.ansatt_fra or (a.ansatt_til is not null and new.dato > a.ansatt_til)) then
    raise exception 'Datoen er utenfor ansettelsen (%–%)', to_char(a.ansatt_fra, 'DD.MM.YYYY'),
      coalesce(to_char(a.ansatt_til, 'DD.MM.YYYY'), '') using errcode = 'FA400';
  end if;
  return new;
end $$;
create trigger timebank_poster_foer before insert or update or delete on faktura.timebank_poster
  for each row execute function faktura.timebank_post_foer();
create trigger timebank_poster_org_id before update on faktura.timebank_poster
  for each row execute function faktura.org_id_uendret();
create trigger timebank_poster_revisjon after insert or update or delete on faktura.timebank_poster
  for each row execute function faktura.revider();

alter table faktura.timebank_poster enable row level security;
create policy timebank_poster_les on faktura.timebank_poster for select
  using (faktura.kan(org_id, 'personal_les') or faktura.er_meg(org_id, ansatt_id));
create policy timebank_poster_ny on faktura.timebank_poster for insert with check (faktura.kan(org_id, 'personal'));
create policy timebank_poster_endre on faktura.timebank_poster for update
  using (faktura.kan(org_id, 'personal')) with check (faktura.kan(org_id, 'personal'));
create policy timebank_poster_slett on faktura.timebank_poster for delete using (faktura.kan(org_id, 'personal'));
grant select, delete, insert (org_id, ansatt_id, dato, type, timer, tekst), update (dato, timer, tekst)
  on faktura.timebank_poster to faktura_app;

-- ---------------------------------------------------------------------------
-- Søknad om avspasering
-- ---------------------------------------------------------------------------

-- hele_dager: fri fra og med til og med (blir fravær når den godkjennes); ellers noen timer én dag
-- (blir en post). Lederen kan endre timene når søknaden godkjennes.
create table faktura.avspasering_soknader (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  ansatt_id uuid not null,
  fra date not null,
  til date not null,
  timer numeric(6,2) not null check (timer > 0 and timer <= 2000),
  hele_dager boolean not null default true,
  melding text check (melding is null or length(melding) <= 300),
  status text not null default 'venter' check (status in ('venter', 'godkjent', 'avslatt', 'trukket')),
  svar text check (svar is null or length(svar) <= 300),
  fravaer_id uuid,
  post_id uuid,
  soknad_av uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null,
  behandlet_av uuid references faktura.brukere(id) on delete set null,
  behandlet_at timestamptz,
  opprettet timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete cascade,
  foreign key (org_id, fravaer_id) references faktura.fravaer(org_id, id) on delete set null (fravaer_id),
  foreign key (org_id, post_id) references faktura.timebank_poster(org_id, id) on delete set null (post_id),
  check (til >= fra and til - fra <= 92),
  check (hele_dager or fra = til)
);
create index avspasering_soknader_ansatt_idx on faktura.avspasering_soknader (org_id, ansatt_id, fra);
create index avspasering_soknader_venter_idx on faktura.avspasering_soknader (org_id) where status = 'venter';
create trigger avspasering_soknader_revisjon after insert or update or delete on faktura.avspasering_soknader
  for each row execute function faktura.revider();

-- Søknadene lages og behandles bare gjennom funksjonene under.
alter table faktura.avspasering_soknader enable row level security;
create policy avspasering_soknader_les on faktura.avspasering_soknader for select
  using (faktura.kan(org_id, 'personal') or faktura.er_meg(org_id, ansatt_id));
grant select on faktura.avspasering_soknader to faktura_app;

-- ---------------------------------------------------------------------------
-- Saldoen
-- ---------------------------------------------------------------------------

-- Timene i en vanlig arbeidsdag for den ansatte: den avtalte arbeidstiden i uka delt på
-- arbeidsdagene (dagene i planen som gjelder i dag, ellers fem). Til å vise timene som dager.
create function faktura.dag_timer(_org uuid, _ansatt uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select round(a.ukentlig_arbeidstid * a.stillingsprosent / 100
               / coalesce(nullif((select count(*) from faktura.arbeidsplan_dager d
                                   where d.plan_id = (select p.id from faktura.arbeidsplaner p
                                                       where p.org_id = _org and p.ansatt_id = _ansatt and p.gjelder_fra <= faktura.i_dag()
                                                       order by p.gjelder_fra desc limit 1)), 0), 5), 2)
    from faktura.ansatte a
   where a.org_id = _org and a.id = _ansatt
$$;

-- Saldoen for én ansatt, uten tilgangssjekk (brukes av funksjonene under). inn: godkjente timer i
-- banken; venter_inn: levert, men ikke godkjent ennå; avspasert: fravær og timer tatt ut som fri
-- (også planlagt fram i tid); sokt: søknader som venter.
create function faktura.timebank_saldo(_org uuid, _ansatt uuid)
returns table (inn numeric, venter_inn numeric, avspasert numeric, utbetalt numeric, justert numeric, saldo numeric, sokt numeric, dag_timer numeric)
language sql stable security definer set search_path = '' as $$
  with t as (
    select coalesce(sum(x.timer) filter (where x.status = 'godkjent'), 0) as inn,
           coalesce(sum(x.timer) filter (where x.status = 'levert'), 0) as venter
      from faktura.timeforinger x where x.org_id = _org and x.ansatt_id = _ansatt and x.timebank
  ), f as (
    select coalesce(sum(x.timer), 0) as timer from faktura.fravaer x where x.org_id = _org and x.ansatt_id = _ansatt and x.type = 'avspasering'
  ), p as (
    select coalesce(-sum(x.timer) filter (where x.type = 'avspasering'), 0) as avspasert,
           coalesce(-sum(x.timer) filter (where x.type = 'utbetaling'), 0) as utbetalt,
           coalesce(sum(x.timer) filter (where x.type = 'justering'), 0) as justert
      from faktura.timebank_poster x where x.org_id = _org and x.ansatt_id = _ansatt
  ), s as (
    select coalesce(sum(x.timer), 0) as sokt from faktura.avspasering_soknader x where x.org_id = _org and x.ansatt_id = _ansatt and x.status = 'venter'
  )
  select t.inn, t.venter, f.timer + p.avspasert, p.utbetalt, p.justert, t.inn - f.timer - p.avspasert - p.utbetalt + p.justert, s.sokt,
         faktura.dag_timer(_org, _ansatt)
    from t, f, p, s
$$;

-- Timebanken: eier, administrator og regnskap ser alle som er ansatt (aktive, eller med noe i
-- banken), den ansatte bare seg selv. sats: timelønnen, eller timesatsen for dem med fastlønn
-- (til verdien av saldoen; bare for dem som ser de ansatte).
create function faktura.timebank(_org uuid)
returns table (ansatt_id uuid, navn text, aktiv boolean, lonnstype text, sats numeric,
               inn numeric, venter_inn numeric, avspasert numeric, utbetalt numeric, justert numeric, saldo numeric, sokt numeric, dag_timer numeric)
language sql stable security definer set search_path = '' as $$
  select a.id, a.fornavn || ' ' || a.etternavn, a.aktiv, a.lonnstype,
         case when faktura.kan(_org, 'personal_les') then
           case when a.lonnstype = 'time' then a.timelonn
                when a.maanedslonn is not null and a.ukentlig_arbeidstid > 0 and a.stillingsprosent > 0
                  then round(a.maanedslonn * 12 / (a.ukentlig_arbeidstid * a.stillingsprosent / 100) / 52, 4) end
         end,
         s.*
    from faktura.ansatte a, faktura.timebank_saldo(_org, a.id) s
   where a.org_id = _org
     and (faktura.kan(_org, 'personal_les') or faktura.er_meg(_org, a.id))
     and ((a.aktiv and a.arbeidstaker) or s.inn <> 0 or s.venter_inn <> 0 or s.avspasert <> 0 or s.utbetalt <> 0 or s.justert <> 0 or s.sokt <> 0)
   order by a.fornavn, a.etternavn
$$;

-- Forslag til timene en avspasering tar: de planlagte timene i perioden (vakter og faste dager),
-- ellers en vanlig arbeidsdag for hver arbeidsdag.
create function faktura.avspasering_forslag(_org uuid, _ansatt uuid, _fra date, _til date) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare
  planlagt numeric;
  dager int;
begin
  if not (faktura.kan(_org, 'personal') or faktura.er_meg(_org, _ansatt)) then
    raise exception 'Ingen tilgang' using errcode = 'FA403';
  end if;
  if _fra is null or _til is null or _til < _fra or _til - _fra > 92 then
    raise exception 'Velg en periode på høyst tre måneder' using errcode = 'FA400';
  end if;
  select coalesce(sum(coalesce(v.timer, case when fd.fra is not null then faktura.timer_mellom(fd.fra, fd.til, fd.pause_min) end)), 0)
    into planlagt
    from generate_series(_fra, _til, interval '1 day') g(d)
    left join lateral (select sum(x.timer) as timer from faktura.vakter x
                        where x.org_id = _org and x.ansatt_id = _ansatt and x.dato = g.d::date) v on true
    left join lateral (select * from faktura.fast_dag(_org, _ansatt, g.d::date) limit 1) fd on true;
  if planlagt > 0 then return planlagt; end if;
  select count(*) into dager from generate_series(_fra, _til, interval '1 day') g(d) where faktura.arbeidsdag(_org, _ansatt, g.d::date);
  return round(dager * coalesce(faktura.dag_timer(_org, _ansatt), 0), 2);
end $$;

-- ---------------------------------------------------------------------------
-- Søke, behandle og trekke søknader
-- ---------------------------------------------------------------------------

-- Den ansatte søker for seg selv, om høyst det som er igjen i banken (utenom det som er søkt om
-- fra før). Fra en uke tilbake (f.eks. timer en gikk tidligere), og innenfor ansettelsen.
create function faktura.sok_avspasering(_org uuid, _fra date, _til date, _timer numeric, _hele_dager boolean, _melding text)
returns faktura.avspasering_soknader
language plpgsql security definer set search_path = '' as $$
declare
  meg uuid := faktura.min_ansatt(_org);
  a faktura.ansatte;
  s record;
  igjen numeric;
  ny faktura.avspasering_soknader;
begin
  if meg is null then raise exception 'Du er ikke registrert som ansatt her' using errcode = 'FA403'; end if;
  if not faktura.timebank_paa(_org) then raise exception 'Timebanken er ikke slått på' using errcode = 'FA400'; end if;
  if _fra is null or _til is null then raise exception 'Velg dagen eller dagene' using errcode = 'FA400'; end if;
  if _til < _fra then raise exception 'Sluttdatoen er før startdatoen' using errcode = 'FA400'; end if;
  if _til - _fra > 92 then raise exception 'Søk om høyst tre måneder om gangen' using errcode = 'FA400'; end if;
  if not coalesce(_hele_dager, true) and _til <> _fra then raise exception 'Noen timer gjelder én dag' using errcode = 'FA400'; end if;
  if _timer is null or _timer <= 0 then raise exception 'Skriv hvor mange timer du vil avspasere' using errcode = 'FA400'; end if;
  if _timer > 2000 then raise exception 'For mange timer' using errcode = 'FA400'; end if;
  if _fra < faktura.i_dag() - 7 then raise exception 'Avspasering kan søkes om fra en uke tilbake' using errcode = 'FA400'; end if;
  if length(_melding) > 300 then raise exception 'Meldingen kan ha høyst 300 tegn' using errcode = 'FA400'; end if;
  select * into a from faktura.ansatte where org_id = _org and id = meg;
  if _fra < a.ansatt_fra or (a.ansatt_til is not null and _til > a.ansatt_til) then
    raise exception 'Datoene er utenfor ansettelsen din' using errcode = 'FA400';
  end if;
  select * into s from faktura.timebank_saldo(_org, meg);
  igjen := greatest(s.saldo - s.sokt, 0);
  if round(_timer, 2) > igjen then
    raise exception 'Du har % t i timebanken%', faktura.dager_tekst(igjen),
      case when s.sokt > 0 then format(' (utenom %s t du har søkt om fra før)', faktura.dager_tekst(s.sokt)) else '' end
      using errcode = 'FA400';
  end if;
  if coalesce(_hele_dager, true) and exists (select 1 from faktura.fravaer f where f.org_id = _org and f.ansatt_id = meg
                                              and daterange(f.fra, f.til, '[]') && daterange(_fra, _til, '[]')) then
    raise exception 'Du har allerede fravær i perioden' using errcode = 'FA409';
  end if;
  if exists (select 1 from faktura.avspasering_soknader x where x.org_id = _org and x.ansatt_id = meg and x.status = 'venter'
              and daterange(x.fra, x.til, '[]') && daterange(_fra, _til, '[]')) then
    raise exception 'Du har allerede søkt om avspasering i perioden' using errcode = 'FA409';
  end if;
  insert into faktura.avspasering_soknader (org_id, ansatt_id, fra, til, timer, hele_dager, melding)
  values (_org, meg, _fra, _til, round(_timer, 2), coalesce(_hele_dager, true), nullif(btrim(_melding), ''))
  returning * into ny;
  return ny;
end $$;

-- Eier og administrator godkjenner (hele dager blir fravær, noen timer en post) eller avslår
-- med en grunn. Timene kan endres når søknaden godkjennes.
create function faktura.behandle_avspasering(_org uuid, _soknad uuid, _godkjenn boolean, _svar text, _timer numeric)
returns faktura.avspasering_soknader
language plpgsql security definer set search_path = '' as $$
declare
  s faktura.avspasering_soknader;
  t numeric;
  f uuid;
  p uuid;
begin
  perform faktura.krev(_org, 'personal');
  select * into s from faktura.avspasering_soknader where org_id = _org and id = _soknad for update;
  if not found then raise exception 'Fant ikke søknaden' using errcode = 'FA404'; end if;
  if s.status <> 'venter' then raise exception 'Søknaden er allerede behandlet' using errcode = 'FA409'; end if;
  if length(_svar) > 300 then raise exception 'Svaret kan ha høyst 300 tegn' using errcode = 'FA400'; end if;
  if _godkjenn then
    t := round(coalesce(_timer, s.timer), 2);
    if t <= 0 or t > 2000 then raise exception 'Skriv hvor mange timer avspaseringen tar' using errcode = 'FA400'; end if;
    if s.hele_dager then
      insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, timer, notat)
      values (_org, s.ansatt_id, 'avspasering', s.fra, s.til, t, s.melding) returning id into f;
    else
      insert into faktura.timebank_poster (org_id, ansatt_id, dato, type, timer, tekst)
      values (_org, s.ansatt_id, s.fra, 'avspasering', -t, coalesce(s.melding, 'Avspasering')) returning id into p;
    end if;
    update faktura.avspasering_soknader
       set status = 'godkjent', timer = t, svar = nullif(btrim(_svar), ''), fravaer_id = f, post_id = p,
           behandlet_av = faktura.bruker_id(), behandlet_at = now()
     where id = s.id returning * into s;
  else
    update faktura.avspasering_soknader
       set status = 'avslatt', svar = nullif(btrim(_svar), ''), behandlet_av = faktura.bruker_id(), behandlet_at = now()
     where id = s.id returning * into s;
  end if;
  return s;
end $$;

-- Den ansatte (eller lederen) trekker en søknad som venter.
create function faktura.trekk_avspasering(_org uuid, _soknad uuid) returns faktura.avspasering_soknader
language plpgsql security definer set search_path = '' as $$
declare
  s faktura.avspasering_soknader;
begin
  select * into s from faktura.avspasering_soknader where org_id = _org and id = _soknad for update;
  if not found or not (faktura.er_meg(_org, s.ansatt_id) or faktura.kan(_org, 'personal')) then
    raise exception 'Fant ikke søknaden' using errcode = 'FA404';
  end if;
  if s.status <> 'venter' then raise exception 'Søknaden er allerede behandlet' using errcode = 'FA409'; end if;
  update faktura.avspasering_soknader set status = 'trukket', behandlet_av = faktura.bruker_id(), behandlet_at = now()
   where id = s.id returning * into s;
  return s;
end $$;

-- ---------------------------------------------------------------------------
-- Lønnskjøringen: utbetaling fra timebanken
-- ---------------------------------------------------------------------------

-- Utbetalingene fra timebanken som lønnes på slippen (merkes når kjøringen godkjennes).
alter table faktura.lonnsslipper add column timebank_poster uuid[] not null default '{}';
grant insert (timebank_poster), update (timebank_poster) on faktura.lonnsslipper to faktura_app;

-- Som før (0065), og utbetalingene fra timebanken på slippene merkes som lønnet.
create or replace function faktura.lonn_godkjenn(_kjoring uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  k faktura.lonnskjoringer;
  ider uuid[];
  n int;
begin
  select * into k from faktura.lonnskjoringer where id = _kjoring for update;
  if k.id is null then raise exception 'Fant ikke lønnskjøringen' using errcode = 'FA404'; end if;
  perform faktura.krev(k.org_id, 'personal');
  if k.status <> 'utkast' then raise exception 'Lønnskjøringen er alt godkjent' using errcode = 'FA409'; end if;
  if not exists (select 1 from faktura.lonnsslipper where kjoring_id = k.id) then
    raise exception 'Lønnskjøringen har ingen lønnsslipper' using errcode = 'FA400';
  end if;
  update faktura.lonnsslipper s set kontonr = a.kontonr
    from faktura.ansatte a
   where s.kjoring_id = k.id and a.org_id = s.org_id and a.id = s.ansatt_id;
  ider := array(select distinct x from faktura.lonnsslipper s, unnest(s.timeforinger) x where s.kjoring_id = k.id);
  update faktura.timeforinger set lonnskjoring_id = k.id
   where org_id = k.org_id and id = any(ider) and status = 'godkjent' and lonnskjoring_id is null;
  get diagnostics n = row_count;
  if n <> coalesce(cardinality(ider), 0) then
    raise exception 'Noen av timene er endret eller lønnet i en annen kjøring. Regn ut lønnen på nytt.' using errcode = 'FA409';
  end if;
  ider := array(select distinct x from faktura.lonnsslipper s, unnest(s.timebank_poster) x where s.kjoring_id = k.id);
  update faktura.timebank_poster set lonnskjoring_id = k.id
   where org_id = k.org_id and id = any(ider) and type = 'utbetaling' and lonnskjoring_id is null;
  get diagnostics n = row_count;
  if n <> coalesce(cardinality(ider), 0) then
    raise exception 'Noen av utbetalingene fra timebanken er endret eller lønnet i en annen kjøring. Regn ut lønnen på nytt.' using errcode = 'FA409';
  end if;
  update faktura.lonnskjoringer set status = 'godkjent', godkjent_at = now(), godkjent_av = faktura.bruker_id() where id = k.id;
end $$;

-- Som før (0065): timene og utbetalingene fra timebanken er ikke lenger lønnet.
create or replace function faktura.lonn_gjenapne(_kjoring uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  k faktura.lonnskjoringer;
begin
  select * into k from faktura.lonnskjoringer where id = _kjoring for update;
  if k.id is null then raise exception 'Fant ikke lønnskjøringen' using errcode = 'FA404'; end if;
  perform faktura.krev(k.org_id, 'personal');
  if k.status <> 'godkjent' then raise exception 'Lønnskjøringen er ikke godkjent' using errcode = 'FA409'; end if;
  update faktura.timeforinger set lonnskjoring_id = null where lonnskjoring_id = k.id;
  update faktura.timebank_poster set lonnskjoring_id = null where lonnskjoring_id = k.id;
  update faktura.lonnskjoringer set status = 'utkast', godkjent_at = null, godkjent_av = null where id = k.id;
  -- Kontonummeret settes på nytt når kjøringen godkjennes.
  update faktura.lonnsslipper set kontonr = null where kjoring_id = k.id;
end $$;

-- ---------------------------------------------------------------------------
-- Appen og revisjonsloggen
-- ---------------------------------------------------------------------------

-- Appen: om timebanken er slått på (ellers som i 0064).
create or replace view faktura.mine_organisasjoner with (security_invoker = true) as
select o.id, o.type, o.navn, o.orgnr, o.verifisering,
       faktura.rolle(o.id) as rolle,
       exists (select 1 from faktura.medlemmer m
                where m.org_id = o.id and m.bruker_id = faktura.bruker_id()) as direkte_medlem,
       coalesce((select l.aktiv from faktura.lonn_oppsett l where l.org_id = o.id), false)
         and faktura.har_funksjon(o.id, 'ansatte') as personal,
       (select a.id from faktura.ansatte a where a.org_id = o.id and a.bruker_id = faktura.bruker_id()) as ansatt_id,
       faktura.org_funksjonsliste(o.id) as funksjoner,
       faktura.kan(o.id, 'plan') as ser_planen,
       coalesce((select l.helg from faktura.lonn_oppsett l where l.org_id = o.id), true) as helg,
       faktura.timebank_paa(o.id) as timebank
  from faktura.organisasjoner o;

-- Timebanken er, som timene og lønnen, for dem som ser de ansatte; søknadene om avspasering, som
-- fraværet, bare for eier og administrator.
drop policy revisjonslogg_les on faktura.revisjonslogg;
create policy revisjonslogg_les on faktura.revisjonslogg for select
  using (faktura.kan(org_id, 'les')
         and (coalesce(tabell, '') not in ('ansatte', 'ansatt_tillegg', 'fravaer', 'arbeidsplaner', 'ferie_overforinger', 'vaktbytter',
                                           'lonnskjoringer', 'lonn_inngaende', 'timebank_poster', 'avspasering_soknader')
              or faktura.kan(org_id, 'personal_les'))
         and (coalesce(tabell, '') not in ('fravaer', 'ferie_overforinger', 'avspasering_soknader') or faktura.kan(org_id, 'personal')));

revoke all on function faktura.timebank_paa(uuid), faktura.timer_timebank(), faktura.fravaer_timebank(), faktura.timebank_post_foer(),
  faktura.dag_timer(uuid, uuid), faktura.timebank_saldo(uuid, uuid), faktura.timebank(uuid),
  faktura.avspasering_forslag(uuid, uuid, date, date), faktura.sok_avspasering(uuid, date, date, numeric, boolean, text),
  faktura.behandle_avspasering(uuid, uuid, boolean, text, numeric), faktura.trekk_avspasering(uuid, uuid) from public;
grant execute on function faktura.timebank_paa(uuid), faktura.timebank(uuid), faktura.avspasering_forslag(uuid, uuid, date, date),
  faktura.sok_avspasering(uuid, date, date, numeric, boolean, text), faktura.behandle_avspasering(uuid, uuid, boolean, text, numeric),
  faktura.trekk_avspasering(uuid, uuid) to faktura_app;
grant execute on function faktura.timebank_paa(uuid), faktura.timebank_saldo(uuid, uuid), faktura.dag_timer(uuid, uuid) to faktura_system;
