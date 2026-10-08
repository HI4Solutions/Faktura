-- 0049_makstak.sql
-- Makstak: en avtale om at kunden aldri faktureres mer enn et beløp å betale (inkl. mva) på én
-- faktura, uansett hvilke produkter som står på den. Alle produktene står på fakturaen som
-- vanlig, og er summen over makstaket, får fakturaen et fratrekk som tar den ned til makstaket.
-- Fratrekket er egne linjer (én per mva-sats, fordelt etter hvor mye hver sats utgjør av
-- summen), så mva, PDF, EHF, mva-rapporten og kreditnotaer stemmer.
--
-- Makstaket kan stå på kunden. Da får nye fakturaer og gjentakelser til kunden det med seg
-- (API-et fyller det inn), og det kan fjernes eller endres på den enkelte fakturaen. Endres
-- kundens makstak, følger utkast og gjentakelser som hadde det gamle, med.
--
-- Fratrekket regnes når fakturaen utstedes; for utkast regnes det bare for visning. Krediteres
-- en del av fakturaen, regnes fratrekket på nytt for det som står igjen, og kreditnotaen tar
-- med forskjellen.

alter table faktura.kunder add column makstak numeric(14,2) check (makstak > 0);
alter table faktura.gjentakelser add column makstak numeric(14,2) check (makstak > 0);
alter table faktura.fakturaer
  add column makstak numeric(14,2) check (makstak > 0),
  add constraint fakturaer_makstak_bare_faktura check (makstak is null or type = 'faktura');
-- Linjen er fratrekket for makstaket. Settes bare av databasen (utstedelse og kreditering).
alter table faktura.faktura_linjer add column makstak boolean not null default false;

grant insert (makstak), update (makstak) on faktura.kunder to faktura_app;
grant insert (makstak), update (makstak) on faktura.gjentakelser to faktura_app;
grant insert (makstak), update (makstak) on faktura.fakturaer to faktura_app;

-- «70 000» og «70 000,50»: beløpet slik det står i teksten på fratrekket.
create function faktura.kr_tekst(_belop numeric) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(trunc(abs(_belop))::text, '(\d)(?=(\d{3})+$)', '\1 ', 'g')
         || case when abs(_belop) <> trunc(abs(_belop))
                 then ',' || lpad(round((abs(_belop) - trunc(abs(_belop))) * 100)::text, 2, '0') else '' end
$$;

-- Fordeler fratrekket som tar summen ned til makstaket på mva-satsene, etter hvor mye hver sats
-- utgjør av summen inkl. mva (_satser og _inkl: summen inkl. mva per sats). Gir beløpet eks. mva
-- og mvaen per sats (negative). Én sats tar øreavrundingen: 0 % når den er stor nok (der går alt
-- opp på øret), ellers den største. Går det ikke opp på øret der (mvaen rundes av), blir summen
-- ett øre under makstaket, aldri over.
create function faktura.makstak_fordel(_tak numeric, _satser numeric[], _inkl numeric[])
returns table (mva_sats numeric, belop_eks numeric, mva_belop numeric)
language plpgsql immutable set search_path = '' as $$
declare
  n int := coalesce(cardinality(_satser), 0);
  total numeric := 0;
  positiv numeric := 0;
  rest numeric;
  trukket numeric := 0;
  siste int;
  i int;
  r numeric;
  e numeric;
  m numeric;
  best numeric;
begin
  if _tak is null or n = 0 then return; end if;
  for i in 1..n loop
    total := total + _inkl[i];
    if _inkl[i] > 0 then positiv := positiv + _inkl[i]; end if;
  end loop;
  if total <= _tak then return; end if;
  rest := total - _tak;

  -- Satser med negativ sum (f.eks. bare rabatt) får ikke noe fratrekk.
  for i in 1..n loop
    continue when _inkl[i] <= 0;
    if siste is null or _inkl[i] > _inkl[siste] then siste := i; end if;
  end loop;
  for i in 1..n loop
    if _inkl[i] > 0 and _satser[i] = 0 and rest * _inkl[i] / positiv >= 1 then siste := i; end if;
  end loop;

  for i in 1..n loop
    continue when _inkl[i] <= 0 or i = siste;
    r := round(rest * _inkl[i] / positiv, 2);
    e := round(r / (1 + _satser[i] / 100), 2);
    m := round(e * _satser[i] / 100, 2);
    trukket := trukket + e + m;
    continue when e = 0 and m = 0;
    mva_sats := _satser[i];
    belop_eks := -e;
    mva_belop := -m;
    return next;
  end loop;

  -- Resten på den siste satsen: det minste beløpet eks. mva som med mvaen tar minst resten.
  r := rest - trukket;
  e := round(r / (1 + _satser[siste] / 100), 2);
  best := null;
  for i in -3..3 loop
    if (e + i * 0.01) + round((e + i * 0.01) * _satser[siste] / 100, 2) >= r and (best is null or e + i * 0.01 < best) then
      best := e + i * 0.01;
    end if;
  end loop;
  e := greatest(best, 0);
  m := round(e * _satser[siste] / 100, 2);
  if e <> 0 or m <> 0 then
    mva_sats := _satser[siste];
    belop_eks := -e;
    mva_belop := -m;
    return next;
  end if;
end $$;

-- Fratrekket for makstaket på en faktura, regnet av linjene slik de står (uten fratrekket).
-- Brukes når fakturaen utstedes, og for å vise utkast.
create function faktura.makstak_fratrekk(_faktura uuid)
returns table (mva_sats numeric, belop_eks numeric, mva_belop numeric, beskrivelse text)
language sql stable set search_path = '' as $$
  with f as (select id, makstak from faktura.fakturaer where id = _faktura and type = 'faktura' and makstak is not null),
       g as (select l.mva_sats,
                    sum(round(faktura.linje_netto(l.antall, l.enhetspris, l.rabatt_prosent, l.rabatt_belop), 2)
                        + round(faktura.linje_netto(l.antall, l.enhetspris, l.rabatt_prosent, l.rabatt_belop) * l.mva_sats / 100, 2)) as inkl
               from faktura.faktura_linjer l join f on f.id = l.faktura_id
              where not l.makstak
              group by l.mva_sats)
  select x.mva_sats, x.belop_eks, x.mva_belop, 'Fratrekk etter avtalt makstak (' || faktura.kr_tekst(f.makstak) || ' kr)'
    from f,
         faktura.makstak_fordel(f.makstak, (select array_agg(g.mva_sats order by g.mva_sats desc) from g),
                                (select array_agg(g.inkl order by g.mva_sats desc) from g)) x
   order by x.mva_sats desc
$$;

-- Summen å betale for et utkast, med fratrekket for makstaket (utstedte fakturaer har summen lagret).
create function faktura.utkast_sum(_faktura uuid) returns numeric
language sql stable set search_path = '' as $$
  select sum(round(faktura.linje_netto(l.antall, l.enhetspris, l.rabatt_prosent, l.rabatt_belop), 2)
             + round(faktura.linje_netto(l.antall, l.enhetspris, l.rabatt_prosent, l.rabatt_belop) * l.mva_sats / 100, 2))
         + coalesce((select sum(x.belop_eks + x.mva_belop) from faktura.makstak_fratrekk(_faktura) x), 0)
    from faktura.faktura_linjer l
   where l.faktura_id = _faktura and not l.makstak
$$;

revoke all on function faktura.kr_tekst(numeric), faktura.makstak_fordel(numeric, numeric[], numeric[]),
  faktura.makstak_fratrekk(uuid), faktura.utkast_sum(uuid) from public;
grant execute on function faktura.kr_tekst(numeric), faktura.makstak_fordel(numeric, numeric[], numeric[]),
  faktura.makstak_fratrekk(uuid), faktura.utkast_sum(uuid) to faktura_app, faktura_system;

-- ---------------------------------------------------------------------------
-- Utstedelse: fratrekket blir egne linjer før summene regnes
-- ---------------------------------------------------------------------------

create or replace function faktura.utsted(_id uuid)
returns faktura.fakturaer
language plpgsql security definer set search_path = '' as $$
declare
  f faktura.fakturaer;
  o faktura.organisasjoner;
  k faktura.kunder;
  nr bigint;
  dato date;
  s_eks numeric(14,2);
  s_mva numeric(14,2);
  mnd_antall int;
  mnd_belop numeric;
begin
  select * into f from faktura.fakturaer where id = _id for update;
  if not found then raise exception 'Fant ikke fakturaen' using errcode = 'FA404'; end if;
  perform faktura.krev(f.org_id, 'utsted');
  if f.status <> 'utkast' then return f; end if;

  if not exists (select 1 from faktura.faktura_linjer where faktura_id = _id and not makstak) then
    raise exception 'Fakturaen må ha minst én linje' using errcode = 'FA400';
  end if;

  -- Lås organisasjonen: serialiserer utstedelser og grensesjekken per organisasjon.
  select * into o from faktura.organisasjoner where id = f.org_id for update;
  if o.verifisering = 'sperret' then
    raise exception 'Organisasjonen er sperret' using errcode = 'FA403';
  end if;
  if o.kontonr is null then
    raise exception 'Organisasjonen mangler kontonummer' using errcode = 'FA400';
  end if;

  -- Makstak: fratrekket blir egne linjer sist på fakturaen (én per mva-sats). En kreditnota har
  -- fått sitt fratrekk fra faktura.krediter.
  if f.type = 'faktura' then
    delete from faktura.faktura_linjer where faktura_id = _id and makstak;
    insert into faktura.faktura_linjer (org_id, faktura_id, rekke, beskrivelse, antall, enhet, enhetspris, mva_sats, makstak)
    select f.org_id, _id,
           (select coalesce(max(l.rekke), 0) from faktura.faktura_linjer l where l.faktura_id = _id) + row_number() over (order by x.mva_sats desc),
           x.beskrivelse, -1, 'stk', -x.belop_eks, x.mva_sats, true
      from faktura.makstak_fratrekk(_id) x;
  end if;

  update faktura.faktura_linjer
     set belop_eks = round(faktura.linje_netto(antall, enhetspris, rabatt_prosent, rabatt_belop), 2),
         mva_belop = round(faktura.linje_netto(antall, enhetspris, rabatt_prosent, rabatt_belop) * mva_sats / 100, 2)
   where faktura_id = _id;
  select coalesce(sum(belop_eks), 0), coalesce(sum(mva_belop), 0) into s_eks, s_mva
    from faktura.faktura_linjer where faktura_id = _id;

  if f.type = 'faktura' and s_eks + s_mva < 0 then
    raise exception 'En faktura kan ikke ha negativ sum. Bruk kreditnota.' using errcode = 'FA400';
  end if;

  dato := coalesce(f.fakturadato, faktura.i_dag());

  -- Grenser for organisasjoner som ikke er verifisert ennå.
  if f.type = 'faktura' and (o.maks_fakturaer_mnd is not null or o.maks_belop_mnd is not null) then
    select count(*), coalesce(sum(sum_inkl_mva), 0) into mnd_antall, mnd_belop
      from faktura.fakturaer
     where org_id = f.org_id and type = 'faktura' and status <> 'utkast'
       and fakturadato >= date_trunc('month', dato)::date
       and fakturadato < (date_trunc('month', dato) + interval '1 month')::date;
    if o.maks_fakturaer_mnd is not null and mnd_antall >= o.maks_fakturaer_mnd then
      raise exception 'Grensen på % fakturaer per måned er nådd. Verifiser organisasjonen for å fjerne den.', o.maks_fakturaer_mnd
        using errcode = 'FA429';
    end if;
    if o.maks_belop_mnd is not null and mnd_belop + s_eks + s_mva > o.maks_belop_mnd then
      raise exception 'Grensen på % kr per måned er nådd. Verifiser organisasjonen for å fjerne den.', o.maks_belop_mnd
        using errcode = 'FA429';
    end if;
  end if;

  update faktura.nummerserier
     set neste_fakturanummer = neste_fakturanummer + 1
   where org_id = f.org_id
  returning neste_fakturanummer - 1 into nr;

  select * into k from faktura.kunder where id = f.kunde_id;

  update faktura.fakturaer
     set fakturanummer = nr,
         status = 'utstedt',
         fakturadato = dato,
         forfallsdato = coalesce(f.forfallsdato, dato + o.standard_forfall_dager),
         sum_eks_mva = s_eks,
         mva = s_mva,
         sum_inkl_mva = s_eks + s_mva,
         deres_referanse = coalesce(f.deres_referanse, k.deres_referanse),
         kid = case when o.bruk_kid then faktura.kid(k.kundenummer, nr) end,
         selger = jsonb_build_object(
           'navn', o.navn, 'orgnr', o.orgnr, 'mva_registrert', o.mva_registrert,
           'foretaksregisteret', o.foretaksregisteret, 'adresse', o.adresse, 'postnr', o.postnr,
           'poststed', o.poststed, 'land', o.land, 'telefon', o.telefon, 'epost', o.epost,
           'kontonr', o.kontonr, 'logo_sti', o.logo_sti, 'farge', o.farge),
         kunde = jsonb_build_object(
           'kundenummer', k.kundenummer, 'type', k.type, 'navn', k.navn, 'orgnr', k.orgnr,
           'adresse', k.adresse, 'postnr', k.postnr, 'poststed', k.poststed, 'land', k.land,
           'epost', k.epost),
         utstedt_at = now(),
         utstedt_av = faktura.bruker_id()
   where id = _id
  returning * into f;
  return f;
end $$;

-- Makstaket låses ved utstedelse som resten av innholdet.
create or replace function faktura.faktura_laas() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'utkast' and not (
      coalesce(current_setting('faktura.sletter', true), '') = 'on'
      and current_user = (select r.rolname from pg_catalog.pg_class c join pg_catalog.pg_roles r on r.oid = c.relowner
                           where c.oid = 'faktura.fakturaer'::regclass)
    ) then
      raise exception 'En utstedt faktura kan ikke slettes. Lag en kreditnota.' using errcode = 'FA409';
    end if;
    return old;
  end if;

  if old.status = 'utkast' then
    return new;
  end if;

  if new.status = 'utkast' then
    raise exception 'En utstedt faktura kan ikke bli utkast igjen' using errcode = 'FA409';
  end if;

  if (new.fakturanummer, new.kunde_id, new.type, new.kreditnota_for, new.fakturadato,
      new.forfallsdato, new.periode_fra, new.periode_til, new.kid, new.valuta,
      new.sum_eks_mva, new.mva, new.sum_inkl_mva, new.selger, new.kunde,
      new.deres_referanse, new.var_referanse, new.kommentar, new.makstak, new.utstedt_at, new.utstedt_av)
     is distinct from
     (old.fakturanummer, old.kunde_id, old.type, old.kreditnota_for, old.fakturadato,
      old.forfallsdato, old.periode_fra, old.periode_til, old.kid, old.valuta,
      old.sum_eks_mva, old.mva, old.sum_inkl_mva, old.selger, old.kunde,
      old.deres_referanse, old.var_referanse, old.kommentar, old.makstak, old.utstedt_at, old.utstedt_av)
  then
    raise exception 'Fakturaen er utstedt og låst. Rett feil med en kreditnota.' using errcode = 'FA409';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Kreditering: fratrekket regnes på nytt for det som står igjen
-- ---------------------------------------------------------------------------

create or replace function faktura.krediter(_id uuid, _linjer jsonb default null)
returns faktura.fakturaer
language plpgsql security definer set search_path = '' as $$
declare
  f faktura.fakturaer;
  kn faktura.fakturaer;
  l record;
  x record;
  q numeric;
  rb numeric;
  n int := 0;
  helt_kreditert boolean := true;
begin
  select * into f from faktura.fakturaer where id = _id for update;
  if not found then raise exception 'Fant ikke fakturaen' using errcode = 'FA404'; end if;
  perform faktura.krev(f.org_id, 'utsted');
  if f.type <> 'faktura' or f.status not in ('utstedt', 'betalt') then
    raise exception 'Bare utstedte fakturaer kan krediteres' using errcode = 'FA409';
  end if;

  if _linjer is not null then
    if jsonb_typeof(_linjer) <> 'array' or jsonb_array_length(_linjer) = 0 then
      raise exception 'Linjene må være en liste' using errcode = 'FA400';
    end if;
    -- Fratrekket for makstaket krediteres ikke for seg; det regnes på nytt nedenfor.
    if exists (select 1 from jsonb_array_elements(_linjer) e
                where not exists (select 1 from faktura.faktura_linjer
                                   where faktura_id = _id and id = (e ->> 'linje_id')::uuid and not makstak)) then
      raise exception 'En av linjene hører ikke til fakturaen' using errcode = 'FA400';
    end if;
  end if;

  insert into faktura.fakturaer (org_id, kunde_id, type, kreditnota_for, fakturadato, forfallsdato,
                                 periode_fra, periode_til, deres_referanse, opprettet_av)
  values (f.org_id, f.kunde_id, 'kreditnota', f.id, faktura.i_dag(), faktura.i_dag(),
          f.periode_fra, f.periode_til, f.deres_referanse, faktura.bruker_id())
  returning * into kn;

  for l in
    select ol.*, ol.antall + coalesce((
             select sum(c.antall) from faktura.faktura_linjer c
               join faktura.fakturaer cf on cf.id = c.faktura_id
              where c.kreditert_linje_id = ol.id and cf.status <> 'utkast'), 0) as rest
      from faktura.faktura_linjer ol
     where ol.faktura_id = _id and not ol.makstak
     order by ol.rekke, ol.opprettet
  loop
    if _linjer is null then
      q := l.rest;
    else
      select (e ->> 'antall')::numeric into q
        from jsonb_array_elements(_linjer) e where (e ->> 'linje_id')::uuid = l.id;
      if q is not null and (sign(q) <> sign(l.antall) or abs(q) > abs(l.rest)) then
        raise exception 'Kan ikke kreditere % av «%»; % gjenstår', q, l.beskrivelse, l.rest using errcode = 'FA400';
      end if;
      q := coalesce(q, 0);
    end if;

    if l.rest - q <> 0 then helt_kreditert := false; end if;
    continue when q = 0;

    -- Rabatt i prosent følger med; rabatt i kroner krediteres forholdsmessig, og det
    -- som krediteres sist på linjen, tar resten (så summen går opp i øret).
    rb := case
            when l.rabatt_belop is null then null
            when q = l.rest then -(l.rabatt_belop + coalesce((
                   select sum(c.rabatt_belop) from faktura.faktura_linjer c
                     join faktura.fakturaer cf on cf.id = c.faktura_id
                    where c.kreditert_linje_id = l.id and cf.status <> 'utkast'), 0))
            else round(-l.rabatt_belop * q / l.antall, 2)
          end;

    n := n + 1;
    insert into faktura.faktura_linjer (org_id, faktura_id, rekke, produkt_id, beskrivelse, antall,
                                        enhet, enhetspris, mva_sats, rabatt_prosent, rabatt_belop, kreditert_linje_id)
    values (f.org_id, kn.id, n, l.produkt_id, l.beskrivelse, -q, l.enhet, l.enhetspris, l.mva_sats,
            l.rabatt_prosent, nullif(rb, 0), l.id);
  end loop;

  if n = 0 then
    raise exception 'Det er ingenting igjen å kreditere' using errcode = 'FA409';
  end if;

  -- Makstak: fratrekket regnes på nytt for det som står igjen etter kreditnotaen (og de
  -- tidligere), og kreditnotaen tar med forskjellen per mva-sats. Krediteres alt, går hele
  -- fratrekket tilbake.
  if f.makstak is not null and exists (select 1 from faktura.faktura_linjer where faktura_id = _id and makstak) then
    for x in
      with notaer as (
        select c.id from faktura.fakturaer c where c.kreditnota_for = _id and c.status <> 'utkast'
      ),
      igjen as (
        select l2.mva_sats,
               sum(round(faktura.linje_netto(l2.antall, l2.enhetspris, l2.rabatt_prosent, l2.rabatt_belop), 2)
                   + round(faktura.linje_netto(l2.antall, l2.enhetspris, l2.rabatt_prosent, l2.rabatt_belop) * l2.mva_sats / 100, 2)) as inkl
          from faktura.faktura_linjer l2
         where not l2.makstak
           and (l2.faktura_id = _id or l2.faktura_id = kn.id or l2.faktura_id in (select id from notaer))
         group by l2.mva_sats
      ),
      ny as (
        select y.mva_sats, y.belop_eks
          from faktura.makstak_fordel(f.makstak, (select array_agg(i.mva_sats order by i.mva_sats desc) from igjen i),
                                      (select array_agg(i.inkl order by i.mva_sats desc) from igjen i)) y
      ),
      naa as (
        select l2.mva_sats, sum(round(faktura.linje_netto(l2.antall, l2.enhetspris, l2.rabatt_prosent, l2.rabatt_belop), 2)) as belop_eks
          from faktura.faktura_linjer l2
         where l2.makstak and (l2.faktura_id = _id or l2.faktura_id in (select id from notaer))
         group by l2.mva_sats
      )
      select coalesce(ny.mva_sats, naa.mva_sats) as mva_sats,
             coalesce(ny.belop_eks, 0) - coalesce(naa.belop_eks, 0) as endring   -- positiv: mindre fratrekk
        from ny full join naa on naa.mva_sats = ny.mva_sats
       order by 1 desc
    loop
      continue when x.endring = 0;
      n := n + 1;
      insert into faktura.faktura_linjer (org_id, faktura_id, rekke, beskrivelse, antall, enhet, enhetspris, mva_sats, makstak)
      values (f.org_id, kn.id, n, 'Fratrekk etter avtalt makstak (' || faktura.kr_tekst(f.makstak) || ' kr), regnet på nytt',
              sign(x.endring), 'stk', abs(x.endring), x.mva_sats, true);
    end loop;
  end if;

  kn := faktura.utsted(kn.id);

  if kn.sum_inkl_mva = 0 then
    raise exception 'Kreditnotaen blir på 0 kr: summen er fortsatt over makstaket på % kr. Krediter mer, eller hele fakturaen.',
      faktura.kr_tekst(f.makstak) using errcode = 'FA400';
  end if;

  update faktura.fakturaer
     set kreditert_belop = kreditert_belop - kn.sum_inkl_mva,
         status = case when helt_kreditert then 'kreditert' else status end
   where id = _id;
  perform faktura.oppdater_betalingsstatus(_id);
  return kn;
end $$;

-- ---------------------------------------------------------------------------
-- Gjentakelser har makstaket med seg
-- ---------------------------------------------------------------------------

create or replace function faktura.lag_fra_gjentakelse(_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  g faktura.gjentakelser;
  k faktura.kunder;
  f_id uuid;
  i_dag date := faktura.i_dag();
  linje jsonb;
  n int := 0;
begin
  select * into g from faktura.gjentakelser where id = _id for update;
  if not found then raise exception 'Fant ikke gjentakelsen' using errcode = 'FA404'; end if;
  perform faktura.krev(g.org_id, 'utsted');
  if not g.aktiv then return null; end if;

  select * into k from faktura.kunder where id = g.kunde_id;
  if (g.slutt_dato is not null and g.neste_forfall > g.slutt_dato) or not k.aktiv then
    update faktura.gjentakelser set aktiv = false where id = _id;
    return null;
  end if;

  insert into faktura.fakturaer (org_id, kunde_id, fakturadato, forfallsdato, periode_fra, periode_til,
                                 gjentakelse_id, deres_referanse, makstak, opprettet_av)
  values (g.org_id, g.kunde_id, i_dag, greatest(g.neste_forfall, i_dag), i_dag,
          faktura.periode_slutt(i_dag, g.intervall), g.id, g.deres_referanse, g.makstak, faktura.bruker_id())
  returning id into f_id;

  for linje in select * from jsonb_array_elements(g.linjer) loop
    n := n + 1;
    insert into faktura.faktura_linjer (org_id, faktura_id, rekke, produkt_id, beskrivelse, antall, enhet, enhetspris, mva_sats,
                                        rabatt_prosent, rabatt_belop)
    values (g.org_id, f_id, n,
            (linje ->> 'produkt_id')::uuid,
            linje ->> 'beskrivelse',
            coalesce((linje ->> 'antall')::numeric, 1),
            coalesce(linje ->> 'enhet', 'stk'),
            (linje ->> 'enhetspris')::numeric,
            coalesce((linje ->> 'mva_sats')::numeric, 25),
            (linje ->> 'rabatt_prosent')::numeric,
            (linje ->> 'rabatt_belop')::numeric);
  end loop;

  update faktura.gjentakelser
     set neste_forfall = faktura.neste_forfall(neste_forfall, intervall, forfall_dag),
         siste_faktura_id = f_id
   where id = _id;
  return f_id;
end $$;

-- En faktura som gjøres gjentakende, gir gjentakelsen makstaket og linjene uten fratrekket
-- (hver ny faktura får sitt eget fratrekk).
create or replace function faktura.faktura_gjenta() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  neste date;
  dager int;
  g_id uuid;
begin
  if not (old.status = 'utkast' and new.status <> 'utkast' and new.type = 'faktura'
          and new.gjenta is not null and new.gjentakelse_id is null) then
    return new;
  end if;

  neste := coalesce((new.gjenta ->> 'neste_forfall')::date,
                    faktura.neste_forfall(new.forfallsdato, new.gjenta ->> 'intervall', extract(day from new.forfallsdato)::int));
  -- Ellers ville gjentakelsen lage en ny faktura for samme periode med en gang.
  if neste <= new.forfallsdato then
    raise exception 'Neste forfall for gjentakelsen må være etter forfallsdatoen på fakturaen (%)', to_char(new.forfallsdato, 'DD.MM.YYYY')
      using errcode = 'FA400';
  end if;
  if (new.gjenta ->> 'slutt_dato')::date < neste then
    raise exception 'Sluttdatoen for gjentakelsen er før neste forfall' using errcode = 'FA400';
  end if;
  dager := coalesce((new.gjenta ->> 'send_dager_foer')::int,
                    (select o.standard_dager_foer_forfall from faktura.organisasjoner o where o.id = new.org_id), 14);

  insert into faktura.gjentakelser (org_id, kunde_id, linjer, intervall, forfall_dag, neste_forfall, send_dager_foer,
                                    slutt_dato, aktiv, deres_referanse, konto_id, avsender, kopi_til, kommentar, makstak, opprettet_av)
  values (new.org_id, new.kunde_id,
          (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                    'produkt_id', l.produkt_id, 'beskrivelse', l.beskrivelse, 'antall', l.antall, 'enhet', l.enhet,
                    'enhetspris', l.enhetspris, 'mva_sats', l.mva_sats,
                    'rabatt_prosent', l.rabatt_prosent, 'rabatt_belop', l.rabatt_belop)) order by l.rekke, l.opprettet)
             from faktura.faktura_linjer l where l.faktura_id = new.id and not l.makstak),
          new.gjenta ->> 'intervall',
          -- Forfallsdagen holdes: forfall den 31. gir den 30. i april, men den 31. i juli.
          case when new.gjenta ? 'neste_forfall' and new.gjenta ->> 'neste_forfall' is not null
               then extract(day from neste) else extract(day from new.forfallsdato) end::int,
          neste, dager,
          (new.gjenta ->> 'slutt_dato')::date, true,
          -- Referansen fra utkastet (ikke kundens standard, som brukes når den mangler)
          old.deres_referanse, new.konto_id, new.avsender, new.kopi_til, new.kommentar, new.makstak,
          coalesce(faktura.bruker_id(), new.opprettet_av))
  returning id into g_id;
  new.gjentakelse_id := g_id;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Kundens makstak følger med til utkast og gjentakelser
-- ---------------------------------------------------------------------------

-- Utkast og gjentakelser til kunden som hadde det gamle makstaket (eller ikke noe, når kunden
-- ikke hadde), får det nye. De som har fått et annet makstak eller fått det fjernet, beholder sitt.
create function faktura.kunde_makstak() returns trigger
language plpgsql set search_path = '' as $$
begin
  update faktura.fakturaer set makstak = new.makstak
   where org_id = new.org_id and kunde_id = new.id and status = 'utkast' and type = 'faktura'
     and makstak is not distinct from old.makstak;
  update faktura.gjentakelser set makstak = new.makstak
   where org_id = new.org_id and kunde_id = new.id and makstak is not distinct from old.makstak;
  return null;
end $$;

create trigger kunder_makstak after update of makstak on faktura.kunder
  for each row when (old.makstak is distinct from new.makstak) execute function faktura.kunde_makstak();
