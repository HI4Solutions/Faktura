-- Vaktbytte for lederen (server/src/vaktbytte.ts, «Bytt eller gi bort» i vaktplanen): eier og
-- administrator gir en vakt (eller en fast arbeidsdag) til en annen, eller bytter den med en annen
-- ansatts vakt eller faste arbeidsdag, rett fra vaktplanen. Uten godkjenning (lederen bestemmer), og
-- med alle aktive i organisasjonen, også dem uten innlogging eller med en annen rolle. Byttet lagres
-- som et godkjent vaktbytte og gjøres av faktura.vaktbytte_utfor, som for de ansattes bytter: den
-- som får vakten, må kunne ta den (ikke borte, ansatt den dagen, ingen vakt som overlapper),
-- plassene på tavla følger med, og den som gir bort en fast arbeidsdag, får fri. Lederen kan også
-- bytte vakter som ikke er publisert ennå.

-- Byttet er gjort av lederen i vaktplanen (ikke tilbudt og tatt av de ansatte selv).
alter table faktura.vaktbytter add column av_leder boolean not null default false;

-- Lederen kan bytte vakter som ikke er publisert (utkast); ellers som før (0060_vaktbytte.sql).
create or replace function faktura.vaktbytte_utfor(_b faktura.vaktbytter) returns void
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

-- Byttene, nå med om lederen har gjort byttet (ellers som i 0060_vaktbytte.sql).
drop function faktura.vaktbytte_liste(uuid);
create function faktura.vaktbytte_liste(_org uuid)
returns table (id uuid, status text, fra_ansatt uuid, fra_navn text, til_ansatt uuid, til_navn text, tatt_av uuid, tatt_av_navn text,
               vakt_id uuid, dato date, fra text, til text, timer numeric, oppgave text,
               mot_vakt_id uuid, mot_dato date, mot_fra text, mot_til text, mot_timer numeric, mot_oppgave text,
               melding text, grunn text, opprettet timestamptz, svart_at timestamptz, behandlet_at timestamptz, behandlet_av_navn text,
               hindring text, av_leder boolean)
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
         b.av_leder
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
revoke all on function faktura.vaktbytte_liste(uuid) from public;
grant execute on function faktura.vaktbytte_liste(uuid) to faktura_app;

-- Lederen gir vakten (_vakt), eller den faste arbeidsdagen til _ansatt på _dato, til _til, eller
-- bytter den med vakten _mot eller den faste arbeidsdagen til _til på _mot_dato.
create function faktura.leder_bytt_vakt(_org uuid, _vakt uuid, _ansatt uuid, _dato date, _til uuid, _mot uuid, _mot_dato date, _melding text)
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

  insert into faktura.vaktbytter (org_id, vakt_id, fra_ansatt, til_ansatt, mot_vakt_id, tatt_av, melding, status, svart_at, behandlet_av, behandlet_at, av_leder)
  values (_org, v.id, v.ansatt_id, _til, m.id, _til, nullif(btrim(_melding), ''), 'godkjent', now(), faktura.bruker_id(), now(), true)
  returning * into b;
  perform faktura.vaktbytte_utfor(b);
  return b;
end $$;

-- Vakten (eller den faste arbeidsdagen) lederen vil bytte: id-en, den som har den, og tiden.
create function faktura.leder_vaktbytte_vakt(_org uuid, _vakt uuid, _ansatt uuid, _dato date)
returns table (vakt_id uuid, ansatt_id uuid, navn text, dato date, fra time, til time)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform faktura.krev(_org, 'personal');
  if _vakt is not null then
    return query select x.id, x.ansatt_id, a.fornavn || ' ' || a.etternavn, x.dato, x.fra, x.til
                   from faktura.vakter x join faktura.ansatte a on a.org_id = x.org_id and a.id = x.ansatt_id
                  where x.org_id = _org and x.id = _vakt;
  else
    return query select null::uuid, a.id, a.fornavn || ' ' || a.etternavn, _dato, f.fra, f.til
                   from faktura.ansatte a cross join lateral faktura.fast_dag(_org, a.id, _dato) f
                  where a.org_id = _org and a.id = _ansatt;
  end if;
end $$;

-- Hvem lederen kan gi vakten til: alle aktive i organisasjonen (med rollen), og hva som hindrer dem.
create function faktura.leder_vaktbytte_kolleger(_org uuid, _vakt uuid, _ansatt uuid, _dato date)
returns table (ansatt_id uuid, navn text, rolle text, hindring text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v record;
begin
  select * into v from faktura.leder_vaktbytte_vakt(_org, _vakt, _ansatt, _dato);
  if v.dato is null then raise exception 'Fant ikke vakten' using errcode = 'FA404'; end if;
  return query
    select a.id, a.fornavn || ' ' || a.etternavn, g.navn,
           case when h.kode is not null then faktura.vaktbytte_hindring_tekst(h.kode, a.fornavn || ' ' || a.etternavn, true) end
      from faktura.ansatte a
      left join faktura.ansattgrupper g on g.org_id = a.org_id and g.id = a.gruppe_id
      cross join lateral (select faktura.vaktbytte_hindring(_org, v.dato, v.fra, v.til, a.id, null, null) as kode) h
     where a.org_id = _org and a.aktiv and a.id <> v.ansatt_id
     order by a.fornavn, a.etternavn;
end $$;

-- Vaktene (og de faste arbeidsdagene) til _kollega fra _fra til _til som vakten kan byttes mot,
-- publisert eller ikke, og hva som hindrer byttet (for den som har vakten, eller for kollegaen).
create function faktura.leder_vaktbytte_kandidater(_org uuid, _vakt uuid, _ansatt uuid, _dato date, _kollega uuid, _fra date, _til date)
returns table (vakt_id uuid, dato date, fra text, til text, timer numeric, oppgave text, hel_dag boolean, publisert boolean, hindring text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v record;
  k record;
begin
  if _til < _fra or _til - _fra > 92 then raise exception 'Velg en periode på høyst tre måneder' using errcode = 'FA400'; end if;
  select * into v from faktura.leder_vaktbytte_vakt(_org, _vakt, _ansatt, _dato);
  if v.dato is null then raise exception 'Fant ikke vakten' using errcode = 'FA404'; end if;
  select a.id, a.fornavn || ' ' || a.etternavn as navn into k from faktura.ansatte a where a.org_id = _org and a.id = _kollega and a.aktiv;
  if k.id is null or k.id = v.ansatt_id then raise exception 'Velg en annen ansatt' using errcode = 'FA400'; end if;
  return query
    with kandidater as (
      select w.id as vakt_id, w.dato, w.fra, w.til, w.timer, w.oppgave, false as hel_dag, w.publisert_at is not null as publisert
        from faktura.vakter w
       where w.org_id = _org and w.ansatt_id = k.id and w.dato between greatest(_fra, faktura.i_dag()) and _til
         and w.id is distinct from v.vakt_id
         and not faktura.vakt_begynt(w.dato, w.fra)
         and faktura.fravaer_type(_org, k.id, w.dato) is null
         and not exists (select 1 from faktura.vakter x where x.org_id = _org and x.vikar_for = w.id)
         and not exists (select 1 from faktura.timeforinger t where t.org_id = _org and t.vakt_id = w.id)
      union all
      select null::uuid, g.d, f.fra, f.til, faktura.timer_mellom(f.fra, f.til, f.pause_min), null::text, f.hel_dag, true
        from (select x::date as d from generate_series(greatest(_fra, faktura.i_dag()), _til, interval '1 day') x) g
        cross join lateral faktura.fast_dag(_org, k.id, g.d) f
       where not faktura.vakt_begynt(g.d, f.fra)
         and faktura.fravaer_type(_org, k.id, g.d) is null
    )
    select c.vakt_id, c.dato, to_char(c.fra, 'HH24:MI'), to_char(c.til, 'HH24:MI'), c.timer, c.oppgave, c.hel_dag, c.publisert,
           case when h.eier is not null then faktura.vaktbytte_hindring_tekst(h.eier, v.navn, true)
                when h.kollega is not null then faktura.vaktbytte_hindring_tekst(h.kollega, k.navn, true) end
      from kandidater c
      cross join lateral (
        select faktura.vaktbytte_hindring(_org, c.dato, c.fra, c.til, v.ansatt_id, v.vakt_id, case when v.vakt_id is null then v.dato end) as eier,
               faktura.vaktbytte_hindring(_org, v.dato, v.fra, v.til, k.id, c.vakt_id, case when c.vakt_id is null then c.dato end) as kollega
      ) h
     order by c.dato, c.fra;
end $$;

revoke all on function faktura.leder_bytt_vakt(uuid, uuid, uuid, date, uuid, uuid, date, text), faktura.leder_vaktbytte_vakt(uuid, uuid, uuid, date),
  faktura.leder_vaktbytte_kolleger(uuid, uuid, uuid, date), faktura.leder_vaktbytte_kandidater(uuid, uuid, uuid, date, uuid, date, date) from public;
grant execute on function faktura.leder_bytt_vakt(uuid, uuid, uuid, date, uuid, uuid, date, text), faktura.leder_vaktbytte_vakt(uuid, uuid, uuid, date),
  faktura.leder_vaktbytte_kolleger(uuid, uuid, uuid, date), faktura.leder_vaktbytte_kandidater(uuid, uuid, uuid, date, uuid, date, date) to faktura_app;
