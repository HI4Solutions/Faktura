-- 0021_rabatt_notat_og_faste_valg.sql
-- 1. Rabatt på fakturalinjer, i prosent eller kroner.
-- 2. Produkter uten fast pris: prisen skrives inn når produktet brukes på en faktura.
-- 3. Notat på fakturaen som kunden ser (det interne notatet vises fortsatt ikke).
-- 4. Fast avsender og konto på produkter: velges på fakturaen når produktet brukes.

-- ---------------------------------------------------------------------------
-- 1. Rabatt
-- ---------------------------------------------------------------------------

-- Rabatt i prosent av linjebeløpet, eller et beløp i kroner for hele linjen. Kreditnotaer
-- har negativt kronebeløp (som antallet).
alter table faktura.faktura_linjer
  add column rabatt_prosent numeric(5,2) check (rabatt_prosent > 0 and rabatt_prosent <= 100),
  add column rabatt_belop numeric(14,2) check (rabatt_belop <> 0),
  add constraint faktura_linjer_en_rabatt check (rabatt_prosent is null or rabatt_belop is null);

grant insert (rabatt_prosent, rabatt_belop), update (rabatt_prosent, rabatt_belop) on faktura.faktura_linjer to faktura_app;

-- Linjebeløpet eks. mva etter rabatt, før avrunding. Mva regnes av dette beløpet.
create function faktura.linje_netto(_antall numeric, _pris numeric, _prosent numeric, _belop numeric) returns numeric
language sql immutable set search_path = '' as $$
  select _antall * _pris - coalesce(_belop, round(_antall * _pris * _prosent / 100, 2), 0)
$$;
grant execute on function faktura.linje_netto(numeric, numeric, numeric, numeric) to faktura_app;

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

  if not exists (select 1 from faktura.faktura_linjer where faktura_id = _id) then
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

create or replace function faktura.krediter(_id uuid, _linjer jsonb default null)
returns faktura.fakturaer
language plpgsql security definer set search_path = '' as $$
declare
  f faktura.fakturaer;
  kn faktura.fakturaer;
  l record;
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
    if exists (select 1 from jsonb_array_elements(_linjer) e
                where not exists (select 1 from faktura.faktura_linjer
                                   where faktura_id = _id and id = (e ->> 'linje_id')::uuid)) then
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
     where ol.faktura_id = _id
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

  kn := faktura.utsted(kn.id);

  update faktura.fakturaer
     set kreditert_belop = kreditert_belop - kn.sum_inkl_mva,
         status = case when helt_kreditert then 'kreditert' else status end
   where id = _id;
  perform faktura.oppdater_betalingsstatus(_id);
  return kn;
end $$;

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
                                 gjentakelse_id, deres_referanse, opprettet_av)
  values (g.org_id, g.kunde_id, i_dag, greatest(g.neste_forfall, i_dag), i_dag,
          faktura.periode_slutt(i_dag, g.intervall), g.id, g.deres_referanse, faktura.bruker_id())
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

-- ---------------------------------------------------------------------------
-- 2. Produkter uten fast pris
-- ---------------------------------------------------------------------------

alter table faktura.produkter
  alter column enhetspris drop not null,
  alter column enhetspris drop default,
  -- Indeksregulering trenger en pris å regulere.
  add constraint produkter_indeks_krever_pris check (not indeks_aktiv or enhetspris is not null);

-- ---------------------------------------------------------------------------
-- 3. Notat på fakturaen
-- ---------------------------------------------------------------------------

alter table faktura.fakturaer add column kommentar text check (btrim(kommentar) <> '');
alter table faktura.gjentakelser add column kommentar text check (btrim(kommentar) <> '');
grant insert (kommentar), update (kommentar) on faktura.fakturaer to faktura_app;
grant insert (kommentar), update (kommentar) on faktura.gjentakelser to faktura_app;

-- Notatet står på fakturaen og låses ved utstedelse som resten av innholdet.
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
      new.deres_referanse, new.var_referanse, new.kommentar, new.utstedt_at, new.utstedt_av)
     is distinct from
     (old.fakturanummer, old.kunde_id, old.type, old.kreditnota_for, old.fakturadato,
      old.forfallsdato, old.periode_fra, old.periode_til, old.kid, old.valuta,
      old.sum_eks_mva, old.mva, old.sum_inkl_mva, old.selger, old.kunde,
      old.deres_referanse, old.var_referanse, old.kommentar, old.utstedt_at, old.utstedt_av)
  then
    raise exception 'Fakturaen er utstedt og låst. Rett feil med en kreditnota.' using errcode = 'FA409';
  end if;
  return new;
end $$;

-- Fakturaer fra en gjentakelse arver notatet.
create or replace function faktura.faktura_arv() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kreditnota_for is not null then
    select f.konto_id, f.avsender, f.kopi_til into new.konto_id, new.avsender, new.kopi_til
      from faktura.fakturaer f where f.id = new.kreditnota_for;
  elsif new.gjentakelse_id is not null then
    if new.konto_id is null and new.avsender is null then
      select g.konto_id, g.avsender into new.konto_id, new.avsender from faktura.gjentakelser g where g.id = new.gjentakelse_id;
    end if;
    if cardinality(new.kopi_til) = 0 then
      select g.kopi_til into new.kopi_til from faktura.gjentakelser g where g.id = new.gjentakelse_id;
    end if;
    if new.kommentar is null then
      select g.kommentar into new.kommentar from faktura.gjentakelser g where g.id = new.gjentakelse_id;
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Fast avsender og konto på produkter
-- ---------------------------------------------------------------------------

alter table faktura.produkter
  add column avsender text check (avsender in ('firma', 'innehaver')),
  add column konto_id uuid,
  add foreign key (org_id, konto_id) references faktura.kontoer(org_id, id) on delete set null (konto_id);
grant insert (avsender, konto_id), update (avsender, konto_id) on faktura.produkter to faktura_app;
