-- 0074_vaktbytte_fridag.sql
-- Fridagen ved vaktbytte: den som gir bort en fast arbeidsdag (eller vakten på en fast arbeidsdag)
-- uten å få en vakt igjen, har fri den dagen (arbeidsplan_fri, 0060). Organisasjonen kan be den
-- ansatte velge hva fridagen tas fra (lonn_oppsett.vaktbytte_fridag, standard ja): en feriedag,
-- timer fra timebanken (0073), eller betalt fravær (permisjon med lønn) som lederen godkjenner.
-- Med timelønn kan dagen også være fri uten lønn (standard for dem); med fastlønn må den tas fra
-- noe. Feriedagene som er igjen og timene i banken sjekkes når vakten tilbys, og det som er valgt
-- i bytter som venter, regnes som brukt.
--
-- Fraværet registreres når byttet går gjennom (vaktbytte_utfor): ferie, avspasering med timene
-- vakten var på, eller permisjon med lønn (fravaer.betalt) med grunnen. Det er fravær lederen
-- ellers registrerer, så et slikt bytte må alltid godkjennes av eier eller administrator, også
-- når vaktbytte ellers går uten godkjenning. Lederen kan også velge fridagen selv når de gir bort
-- en ansatts faste arbeidsdag i vaktplanen (0072), og da gjelder den med en gang.
--
-- Permisjon med lønn: med fastlønn går lønnen som vanlig; med timelønn lønnes timene
-- (fravaer.timer) i lønnskjøringen, som avspasering.

alter table faktura.lonn_oppsett add column vaktbytte_fridag boolean not null default true;
grant insert (vaktbytte_fridag), update (vaktbytte_fridag) on faktura.lonn_oppsett to faktura_app;

create function faktura.vaktbytte_fridag_paa(_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select l.vaktbytte_fridag from faktura.lonn_oppsett l where l.org_id = _org), true)
$$;

-- ---------------------------------------------------------------------------
-- Permisjon med lønn
-- ---------------------------------------------------------------------------

-- betalt: permisjon med lønn, med timene som lønnes (for timelønn). Avspasering har timene den tar
-- fra timebanken; annet fravær har ikke timer.
alter table faktura.fravaer add column betalt boolean not null default false;
alter table faktura.fravaer drop constraint fravaer_avspasering_timer;
alter table faktura.fravaer
  add constraint fravaer_betalt check (not betalt or type = 'permisjon'),
  add constraint fravaer_timer check ((timer is not null) = (type = 'avspasering' or betalt));
grant insert (betalt), update (betalt) on faktura.fravaer to faktura_app;

-- Annet fravær har ikke timer og er ikke betalt permisjon; avspasering og permisjon med lønn må ha
-- timene, og avspasering kan bare registreres når timebanken er på (ellers som i 0073_timebank.sql).
create or replace function faktura.fravaer_timebank() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.betalt := coalesce(new.betalt, false) and new.type = 'permisjon';
  if new.type <> 'avspasering' and not new.betalt then
    new.timer := null;
    return new;
  end if;
  if new.timer is null then
    raise exception '%', case when new.betalt then 'Skriv hvor mange timer permisjonen med lønn gjelder'
                              else 'Skriv hvor mange timer avspaseringen tar fra timebanken' end using errcode = 'FA400';
  end if;
  if new.type = 'avspasering' and (tg_op = 'INSERT' or old.type <> 'avspasering') and not faktura.timebank_paa(new.org_id) then
    raise exception 'Timebanken er ikke slått på (Innstillinger → Ansatte og timer)' using errcode = 'FA400';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Valget på vaktbyttet
-- ---------------------------------------------------------------------------

-- fri: hva den som gir bort vakten, tar fridagen fra (null: ikke en fridag på en fast
-- arbeidsdag, et bytte, eller ikke spurt). fri_timer: timene vakten var på (avspasering og
-- betalt fravær). fri_grunn: hva det betalte fraværet gjelder. fravaer_id: fraværet som ble
-- registrert da byttet gikk gjennom.
alter table faktura.vaktbytter
  add column fri text check (fri in ('ferie', 'avspasering', 'betalt', 'uten_lonn')),
  add column fri_timer numeric(5,2) check (fri_timer is null or fri_timer > 0),
  add column fri_grunn text check (fri_grunn is null or length(fri_grunn) <= 300),
  add column fravaer_id uuid,
  add constraint vaktbytter_fri_bytte check (fri is null or mot_vakt_id is null),
  add constraint vaktbytter_fravaer_fk foreign key (org_id, fravaer_id) references faktura.fravaer(org_id, id) on delete set null (fravaer_id);

-- Får _ansatt fri på en fast arbeidsdag når vakten (_vakt; uten: den faste arbeidsdagen) på
-- _dato gis bort? Som i vaktbytte_utfor: dagen er i den faste planen, og de har ingen annen vakt.
create function faktura.gir_fridag(_org uuid, _ansatt uuid, _vakt uuid, _dato date) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from faktura.plan_dag(_org, _ansatt, _dato))
     and not exists (select 1 from faktura.vakter x
                      where x.org_id = _org and x.ansatt_id = _ansatt and x.dato = _dato and x.id is distinct from _vakt)
$$;

-- Feriedagene _ansatt har valgt i vaktbytter som venter (en arbeidsdag hver), i ferieåret _aar,
-- uten vakten _unntatt.
create function faktura.ferie_i_vaktbytter(_org uuid, _ansatt uuid, _aar int, _unntatt uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select count(*)::numeric
    from faktura.vaktbytter x
    join faktura.vakter w on w.org_id = x.org_id and w.id = x.vakt_id
   where x.org_id = _org and x.fra_ansatt = _ansatt and x.fri = 'ferie' and x.status in ('tilbudt', 'akseptert')
     and x.vakt_id is distinct from _unntatt
     and extract(year from w.dato) = _aar and not faktura.vakt_begynt(w.dato, w.fra)
$$;

-- Timebanken: det som er søkt om, tar også med timene som er valgt i vaktbytter som venter (ellers
-- som i 0073_timebank.sql).
create or replace function faktura.timebank_saldo(_org uuid, _ansatt uuid)
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
    select coalesce(sum(x.timer), 0)
           + coalesce((select sum(b.fri_timer)
                         from faktura.vaktbytter b join faktura.vakter w on w.org_id = b.org_id and w.id = b.vakt_id
                        where b.org_id = _org and b.fra_ansatt = _ansatt and b.fri = 'avspasering' and b.status in ('tilbudt', 'akseptert')
                          and not faktura.vakt_begynt(w.dato, w.fra)), 0) as sokt
      from faktura.avspasering_soknader x where x.org_id = _org and x.ansatt_id = _ansatt and x.status = 'venter'
  )
  select t.inn, t.venter, f.timer + p.avspasert, p.utbetalt, p.justert, t.inn - f.timer - p.avspasert - p.utbetalt + p.justert, s.sokt,
         faktura.dag_timer(_org, _ansatt)
    from t, f, p, s
$$;

-- Sjekk valget for fridagen og gi det tilbake. Den ansatte selv (_leder false): med fastlønn må
-- fridagen tas fra ferien, timebanken eller som betalt fravær (med timelønn er standarden fri uten
-- lønn); feriedagene og timene må finnes, og betalt fravær trenger en grunn. Lederen (_leder true)
-- velger fritt, også ingenting (null), og kan gå forbi saldoene.
create function faktura.sjekk_fridag(_org uuid, _ansatt uuid, _vakt uuid, _dato date, _timer numeric, _fri text, _grunn text, _leder boolean)
returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  a faktura.ansatte;
  aar int := extract(year from _dato)::int;
  igjen numeric;
  ventende numeric;
  s record;
begin
  if _fri is not null and _fri not in ('ferie', 'avspasering', 'betalt', 'uten_lonn') then
    raise exception 'Velg hva fridagen tas fra' using errcode = 'FA400';
  end if;
  if length(btrim(_grunn)) > 300 then raise exception 'Grunnen kan ha høyst 300 tegn' using errcode = 'FA400'; end if;
  if _fri = 'avspasering' and not faktura.timebank_paa(_org) then
    raise exception 'Timebanken er ikke slått på (Innstillinger → Ansatte og timer)' using errcode = 'FA400';
  end if;
  if _leder then
    return nullif(_fri, 'uten_lonn');
  end if;

  select * into a from faktura.ansatte where org_id = _org and id = _ansatt;
  if _fri is null then
    if a.lonnstype = 'time' then return 'uten_lonn'; end if;
    raise exception 'Velg hva du tar fridagen fra: en feriedag, timebanken eller betalt fravær' using errcode = 'FA400';
  end if;
  if _fri = 'uten_lonn' and a.lonnstype <> 'time' then
    raise exception 'Med fastlønn tas fridagen fra ferien, timebanken eller som betalt fravær' using errcode = 'FA400';
  end if;
  if _fri = 'ferie' then
    ventende := faktura.ferie_i_vaktbytter(_org, _ansatt, aar, _vakt);
    igjen := coalesce((select x.igjen from faktura.ferie_saldo(_org, _ansatt, aar) x), 0) - ventende;
    if igjen < 1 then
      raise exception '%', case when igjen <= 0 then format('Du har ingen feriedager igjen i %s', aar)
                                else format('Du har bare %s feriedager igjen i %s', faktura.dager_tekst(igjen), aar) end
                           || case when ventende > 0 then format(' (utenom %s du har valgt i andre vaktbytter)', faktura.dager_tekst(ventende)) else '' end
        using errcode = 'FA400';
    end if;
  elsif _fri = 'avspasering' then
    select * into s from faktura.timebank_saldo(_org, _ansatt);
    igjen := greatest(s.saldo - s.sokt, 0);
    if round(_timer, 2) > igjen then
      raise exception 'Vakten er % t, og du har % t i timebanken%', faktura.dager_tekst(round(_timer, 2)), faktura.dager_tekst(igjen),
        case when s.sokt > 0 then format(' (utenom %s t du har søkt om fra før)', faktura.dager_tekst(s.sokt)) else '' end
        using errcode = 'FA400';
    end if;
  elsif _fri = 'betalt' and nullif(btrim(_grunn), '') is null then
    raise exception 'Skriv hva det betalte fraværet gjelder' using errcode = 'FA400';
  end if;
  return _fri;
end $$;

-- Fridagen når vakten (_vakt), eller den faste arbeidsdagen på _dato, gis bort: om _ansatt får
-- fri på en fast arbeidsdag (fridag) og om de spørres (sporres), timene, lønnstypen, feriedagene
-- som er igjen det året og timene i timebanken (utenom det som er søkt om og valgt i bytter som
-- venter). For den ansatte selv og for eier og administrator.
create function faktura.vaktbytte_fridag(_org uuid, _ansatt uuid, _vakt uuid, _dato date)
returns table (fridag boolean, sporres boolean, timer numeric, lonnstype text, ferie_aar int, ferie_igjen numeric,
               timebank boolean, timebank_igjen numeric)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v record;
  a faktura.ansatte;
begin
  if not (faktura.er_meg(_org, _ansatt) or faktura.kan(_org, 'personal')) then
    raise exception 'Fant ikke den ansatte' using errcode = 'FA404';
  end if;
  select * into a from faktura.ansatte x where x.org_id = _org and x.id = _ansatt;
  if _vakt is not null then
    select x.id, x.dato, x.timer into v from faktura.vakter x where x.org_id = _org and x.id = _vakt and x.ansatt_id = _ansatt;
  else
    select null::uuid as id, _dato as dato, faktura.timer_mellom(f.fra, f.til, coalesce(f.pause_min, 0)) as timer
      into v from faktura.fast_dag(_org, _ansatt, _dato) f;
  end if;
  if v.dato is null then raise exception 'Fant ikke vakten' using errcode = 'FA404'; end if;
  fridag := faktura.gir_fridag(_org, _ansatt, v.id, v.dato);
  sporres := fridag and faktura.vaktbytte_fridag_paa(_org);
  timer := v.timer;
  lonnstype := a.lonnstype;
  ferie_aar := extract(year from v.dato)::int;
  ferie_igjen := coalesce((select s.igjen from faktura.ferie_saldo(_org, _ansatt, extract(year from v.dato)::int) s), 0)
                 - faktura.ferie_i_vaktbytter(_org, _ansatt, extract(year from v.dato)::int, v.id);
  timebank := faktura.timebank_paa(_org);
  timebank_igjen := case when faktura.timebank_paa(_org) then (select greatest(s.saldo - s.sokt, 0) from faktura.timebank_saldo(_org, _ansatt) s) end;
  return next;
end $$;

-- ---------------------------------------------------------------------------
-- Tilby, svare og gjøre byttet
-- ---------------------------------------------------------------------------

-- Gi bort (eller bytt) en egen vakt eller en fast arbeidsdag, nå med fridagen (_fri, _fri_grunn)
-- når den ansatte gir bort en fast arbeidsdag uten å få en vakt igjen (ellers som i
-- 0060_vaktbytte.sql).
drop function faktura.tilby_vaktbytte(uuid, uuid, date, uuid, uuid, date, text);
create function faktura.tilby_vaktbytte(_org uuid, _vakt uuid, _dato date, _til uuid, _mot uuid, _mot_dato date, _melding text,
                                        _fri text default null, _fri_grunn text default null)
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

  -- Fridagen: hva den tas fra, når organisasjonen spør (ellers, og ved et bytte, ingenting).
  if m.id is null and faktura.vaktbytte_fridag_paa(_org) and faktura.gir_fridag(_org, meg, v.id, v.dato) then
    _fri := faktura.sjekk_fridag(_org, meg, v.id, v.dato, v.timer, _fri, _fri_grunn, false);
  else
    _fri := null;
  end if;

  insert into faktura.vaktbytter (org_id, vakt_id, fra_ansatt, til_ansatt, mot_vakt_id, melding, fri, fri_timer, fri_grunn)
  values (_org, v.id, meg, _til, m.id, nullif(btrim(_melding), ''), _fri,
          case when _fri in ('avspasering', 'betalt') then v.timer end,
          case when _fri = 'betalt' then nullif(btrim(_fri_grunn), '') end)
  returning * into b;
  return b;
end $$;

-- Svar på et tilbud (som i 0060_vaktbytte.sql). Uten godkjenning går byttet gjennom med en gang,
-- unntatt når fridagen tas fra ferien, timebanken eller som betalt fravær: det godkjenner eier eller
-- administrator.
create or replace function faktura.svar_vaktbytte(_org uuid, _bytte uuid, _ja boolean) returns faktura.vaktbytter
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
     set tatt_av = meg, svart_at = now(),
         status = case when modus = 'fritt' and coalesce(b.fri, 'uten_lonn') = 'uten_lonn' then 'godkjent' else 'akseptert' end
   where id = b.id
  returning * into b;
  if b.status = 'godkjent' then perform faktura.vaktbytte_utfor(b); end if;
  return b;
end $$;

-- Gjør byttet (som i 0072_vaktbytte_leder.sql), og registrer fraværet for fridagen: ferie,
-- avspasering med timene, eller permisjon med lønn, når den som ga bort vakten, fikk fri.
create or replace function faktura.vaktbytte_utfor(_b faktura.vaktbytter) returns void
language plpgsql security definer set search_path = '' as $$
declare
  leder boolean := faktura.kan(_b.org_id, 'personal');
  meg uuid := faktura.min_ansatt(_b.org_id);
  v faktura.vakter;
  m faktura.vakter;
  kode text;
  fid uuid;
  fra_navn text := (select a.fornavn || ' ' || a.etternavn from faktura.ansatte a where a.org_id = _b.org_id and a.id = _b.fra_ansatt);
  tar_navn text := (select a.fornavn || ' ' || a.etternavn from faktura.ansatte a where a.org_id = _b.org_id and a.id = _b.tatt_av);
begin
  select * into v from faktura.vakter where org_id = _b.org_id and id = _b.vakt_id for update;
  if not found or v.ansatt_id is distinct from _b.fra_ansatt or (v.publisert_at is null and not leder) then
    raise exception 'Vakten er endret i vaktplanen, så byttet gjelder ikke lenger' using errcode = 'FA409';
  end if;
  if faktura.vakt_begynt(v.dato, v.fra) then raise exception 'Vakten har begynt' using errcode = 'FA409'; end if;
  if _b.mot_vakt_id is not null then
    select * into m from faktura.vakter where org_id = _b.org_id and id = _b.mot_vakt_id for update;
    if not found or m.ansatt_id is distinct from _b.tatt_av or (m.publisert_at is null and not leder) then
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

    -- Fridagen tas fra ferien, timebanken eller som permisjon med lønn.
    if _b.fri in ('ferie', 'avspasering', 'betalt') and m.id is null then
      insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, notat, timer, betalt)
      values (_b.org_id, _b.fra_ansatt, case _b.fri when 'betalt' then 'permisjon' else _b.fri end, v.dato, v.dato,
              left(concat_ws(' · ', nullif(btrim(_b.fri_grunn), ''), format('Vaktbytte: %s tok vakten', tar_navn)), 500),
              case when _b.fri in ('avspasering', 'betalt') then coalesce(_b.fri_timer, v.timer) end,
              _b.fri = 'betalt')
      returning id into fid;
      update faktura.vaktbytter set fravaer_id = fid where id = _b.id;
    end if;
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

-- Byttene, nå med fridagen (ellers som i 0072_vaktbytte_leder.sql). Valget ser bare den som ga bort
-- vakten, og eier og administrator (som fraværet: faktura.ser_fravaertype).
drop function faktura.vaktbytte_liste(uuid);
create function faktura.vaktbytte_liste(_org uuid)
returns table (id uuid, status text, fra_ansatt uuid, fra_navn text, til_ansatt uuid, til_navn text, tatt_av uuid, tatt_av_navn text,
               vakt_id uuid, dato date, fra text, til text, timer numeric, oppgave text,
               mot_vakt_id uuid, mot_dato date, mot_fra text, mot_til text, mot_timer numeric, mot_oppgave text,
               melding text, grunn text, opprettet timestamptz, svart_at timestamptz, behandlet_at timestamptz, behandlet_av_navn text,
               hindring text, av_leder boolean, fri text, fri_timer numeric, fri_grunn text, fravaer_id uuid)
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
              then faktura.vaktbytte_hindring(_org, v.dato, v.fra, v.til, meg.id, b.mot_vakt_id, null) end,
         b.av_leder,
         case when s.ser then b.fri end, case when s.ser then b.fri_timer end, case when s.ser then b.fri_grunn end,
         case when s.ser then b.fravaer_id end
    from faktura.vaktbytter b
    cross join meg
    cross join lateral (select faktura.ser_fravaertype(b.org_id, b.fra_ansatt) as ser) s
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

-- Lederen gir bort eller bytter (som i 0072_vaktbytte_leder.sql), nå med fridagen når en fast
-- arbeidsdag gis bort: ferie, avspasering eller permisjon med lønn (null: ikke noe fravær).
drop function faktura.leder_bytt_vakt(uuid, uuid, uuid, date, uuid, uuid, date, text);
create function faktura.leder_bytt_vakt(_org uuid, _vakt uuid, _ansatt uuid, _dato date, _til uuid, _mot uuid, _mot_dato date, _melding text,
                                        _fri text default null, _fri_grunn text default null)
returns faktura.vaktbytter
language plpgsql security definer set search_path = '' as $$
declare
  v faktura.vakter;
  m faktura.vakter;
  b faktura.vaktbytter;
begin
  perform faktura.krev(_org, 'personal');
  if (_vakt is null) = (_dato is null) or (_dato is not null and _ansatt is null) then
    raise exception 'Velg vakten som skal byttes' using errcode = 'FA400';
  end if;
  if _mot is not null and _mot_dato is not null then raise exception 'Velg én vakt å bytte mot' using errcode = 'FA400'; end if;
  if _til is null then raise exception 'Velg hvem vakten skal til' using errcode = 'FA400'; end if;
  if not exists (select 1 from faktura.ansatte a where a.org_id = _org and a.id = _til) then
    raise exception 'Fant ikke den ansatte' using errcode = 'FA404';
  end if;
  if _dato < faktura.i_dag() or _mot_dato < faktura.i_dag() then raise exception 'Vakten er passert' using errcode = 'FA409'; end if;

  if _vakt is null then
    if _til = _ansatt then raise exception 'Velg en annen enn den som har vakten' using errcode = 'FA400'; end if;
    _vakt := faktura.vakt_fra_plan(_org, _ansatt, _dato);
  end if;
  select * into v from faktura.vakter where org_id = _org and id = _vakt for update;
  if not found then raise exception 'Fant ikke vakten' using errcode = 'FA404'; end if;
  if v.ansatt_id is null then raise exception 'Vakten er ledig. Velg hvem som skal ha den i vakten.' using errcode = 'FA400'; end if;
  if v.ansatt_id = _til then raise exception 'Velg en annen enn den som har vakten' using errcode = 'FA400'; end if;
  if exists (select 1 from faktura.timeforinger t where t.org_id = _org and t.vakt_id = v.id) then
    raise exception 'Timene for vakten er ført, så den kan ikke byttes' using errcode = 'FA409';
  end if;

  if _mot_dato is not null then _mot := faktura.vakt_fra_plan(_org, _til, _mot_dato); end if;
  if _mot is not null then
    select * into m from faktura.vakter where org_id = _org and id = _mot for update;
    if not found or m.ansatt_id is distinct from _til then
      raise exception 'Fant ikke vakten det byttes mot' using errcode = 'FA404';
    end if;
    if m.id = v.id then raise exception 'Velg en annen vakt å bytte mot' using errcode = 'FA400'; end if;
    if exists (select 1 from faktura.timeforinger t where t.org_id = _org and t.vakt_id = m.id) then
      raise exception 'Timene for vakten det byttes mot, er ført' using errcode = 'FA409';
    end if;
  end if;

  -- Fridagen for den som har vakten, når en fast arbeidsdag gis bort (lederen velger).
  if m.id is null and faktura.gir_fridag(_org, v.ansatt_id, v.id, v.dato) then
    _fri := faktura.sjekk_fridag(_org, v.ansatt_id, v.id, v.dato, v.timer, _fri, _fri_grunn, true);
  else
    _fri := null;
  end if;

  insert into faktura.vaktbytter (org_id, vakt_id, fra_ansatt, til_ansatt, mot_vakt_id, tatt_av, melding, status, svart_at, behandlet_av, behandlet_at, av_leder,
                                  fri, fri_timer, fri_grunn)
  values (_org, v.id, v.ansatt_id, _til, m.id, _til, nullif(btrim(_melding), ''), 'godkjent', now(), faktura.bruker_id(), now(), true,
          _fri, case when _fri in ('avspasering', 'betalt') then v.timer end, case when _fri = 'betalt' then nullif(btrim(_fri_grunn), '') end)
  returning * into b;
  perform faktura.vaktbytte_utfor(b);
  return b;
end $$;

-- Fridagen på et bytte, for varselet til eier og administrator når en kollega tar vakten (API-et
-- sender det som system; kollegaen ser ikke valget).
create function faktura.vaktbytte_fri(_org uuid, _bytte uuid)
returns table (fri text, fri_timer numeric, fri_grunn text)
language sql stable security definer set search_path = '' as $$
  select b.fri, b.fri_timer, b.fri_grunn from faktura.vaktbytter b where b.org_id = _org and b.id = _bytte
$$;

-- Revisjonsloggen for vaktbyttene har nå fridagen (og grunnen til betalt fravær), så den er, som
-- fraværet, bare for eier og administrator.
drop policy revisjonslogg_les on faktura.revisjonslogg;
create policy revisjonslogg_les on faktura.revisjonslogg for select
  using (faktura.kan(org_id, 'les')
         and (coalesce(tabell, '') not in ('ansatte', 'ansatt_tillegg', 'fravaer', 'arbeidsplaner', 'ferie_overforinger', 'vaktbytter',
                                           'lonnskjoringer', 'lonn_inngaende', 'timebank_poster', 'avspasering_soknader')
              or faktura.kan(org_id, 'personal_les'))
         and (coalesce(tabell, '') not in ('fravaer', 'ferie_overforinger', 'avspasering_soknader', 'vaktbytter') or faktura.kan(org_id, 'personal')));

revoke all on function faktura.vaktbytte_fridag_paa(uuid), faktura.gir_fridag(uuid, uuid, uuid, date),
  faktura.ferie_i_vaktbytter(uuid, uuid, int, uuid), faktura.sjekk_fridag(uuid, uuid, uuid, date, numeric, text, text, boolean),
  faktura.vaktbytte_fridag(uuid, uuid, uuid, date),
  faktura.tilby_vaktbytte(uuid, uuid, date, uuid, uuid, date, text, text, text),
  faktura.leder_bytt_vakt(uuid, uuid, uuid, date, uuid, uuid, date, text, text, text),
  faktura.vaktbytte_liste(uuid) from public;
grant execute on function faktura.vaktbytte_fridag(uuid, uuid, uuid, date),
  faktura.tilby_vaktbytte(uuid, uuid, date, uuid, uuid, date, text, text, text),
  faktura.leder_bytt_vakt(uuid, uuid, uuid, date, uuid, uuid, date, text, text, text),
  faktura.vaktbytte_liste(uuid) to faktura_app;
revoke all on function faktura.vaktbytte_fri(uuid, uuid) from public;
grant execute on function faktura.vaktbytte_fri(uuid, uuid) to faktura_system;
