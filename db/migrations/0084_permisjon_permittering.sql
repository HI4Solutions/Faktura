-- 0084_permisjon_permittering.sql
-- Permisjoner og permittering (lønn, fase I). En permisjon får arten den rapporteres med i
-- a-meldingen (foreldrepermisjon, militærtjeneste, utdanning lovfestet og ikke lovfestet, andre
-- lovfestede og andre permisjoner), og permittering er en egen art. Prosenten er andelen av
-- stillingen (null er 100 %), slutt_ukjent at sluttdatoen ikke er bestemt (fraværet står til
-- til-datoen, som kan forlenges), og for permitteringen datoen varselet ble gitt og den siste dagen
-- med lønnsplikt (arbeidsgiveren betaler lønnen de første dagene).
--
-- Delvis permisjon og permittering (under 100 %) gjør ikke den ansatte borte: den ansatte jobber
-- resten og kan ha annet fravær (ferie, sykdom) i perioden. Den teller ikke i fravaer_type eller i
-- planen (fravaer_plan, vaktplanen, tavla og bemanningskalenderen), men gir trekk i lønnen og
-- rapporteres i a-meldingen. To permisjoner kan ikke overlappe.
--
-- En permisjon kan vare i tre år (foreldrepermisjon med 80 % dekning og utdanningspermisjon kan
-- vare over ett år); annet fravær fortsatt i ett.

alter table faktura.fravaer
  add column permisjon_art text check (permisjon_art in ('annen', 'lovfestet', 'foreldre', 'utdanning_lovfestet', 'utdanning', 'militaer', 'permittering')),
  add column prosent smallint check (prosent between 1 and 99),
  add column slutt_ukjent boolean not null default false,
  add column varslet date,
  add column lonnsplikt_til date,
  add constraint fravaer_permisjon check ((permisjon_art is null and prosent is null and not slutt_ukjent) or type = 'permisjon'),
  add constraint fravaer_permittering check ((varslet is null and lonnsplikt_til is null) or permisjon_art = 'permittering'),
  add constraint fravaer_permittering_betalt check (not (betalt and permisjon_art is not distinct from 'permittering')),
  add constraint fravaer_varslet check (varslet is null or varslet <= fra),
  add constraint fravaer_lonnsplikt check (lonnsplikt_til is null or lonnsplikt_til >= fra);

alter table faktura.fravaer drop constraint fravaer_check;
alter table faktura.fravaer add constraint fravaer_lengde
  check (til >= fra and (til - fra <= 366 or (type = 'permisjon' and til - fra <= 1096)));

grant insert (permisjon_art, prosent, slutt_ukjent, varslet, lonnsplikt_til),
      update (permisjon_art, prosent, slutt_ukjent, varslet, lonnsplikt_til) on faktura.fravaer to faktura_app;

-- Som 0071, med lengden for permisjon, feltene for permisjon og permittering (de andre typene får
-- dem ikke; permittering er aldri med lønn), og overlappingen: delvis permisjon kan overlappe annet
-- fravær, men ikke en annen permisjon.
create or replace function faktura.fravaer_foer() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a faktura.ansatte;
  ny_dok boolean;
  annen text;
begin
  if tg_op = 'UPDATE' and new.ansatt_id is distinct from old.ansatt_id then
    raise exception 'Fraværet kan ikke flyttes til en annen ansatt' using errcode = 'FA400';
  end if;
  if not faktura.kan(new.org_id, 'personal') then
    if new.type not in ('syk', 'sykt_barn') then
      raise exception 'Du kan bare melde sykdom selv' using errcode = 'FA403';
    end if;
    ny_dok := new.dokumentasjon is distinct from (case when tg_op = 'UPDATE' then old.dokumentasjon end);
    if ny_dok then
      if new.dokumentasjon is distinct from 'egenmelding' or (tg_op = 'UPDATE' and old.dokumentasjon is not null) then
        raise exception 'Sykmelding fra lege registreres av lederen din' using errcode = 'FA403';
      end if;
      if new.til < faktura.i_dag() - 16 then
        raise exception 'Egenmelding kan sendes for sykdom de siste 16 dagene. Snakk med lederen din om eldre fravær.' using errcode = 'FA400';
      end if;
      if new.fra > faktura.i_dag() + 1 then
        raise exception 'Egenmelding kan ikke sendes for dager fram i tid' using errcode = 'FA400';
      end if;
    end if;
    if tg_op = 'INSERT' and new.fra < faktura.i_dag() - (case when new.dokumentasjon = 'egenmelding' then 16 else 1 end) then
      raise exception '%', (case when new.dokumentasjon = 'egenmelding' then 'Egenmelding kan sendes for sykdom de siste 16 dagene'
                                 else 'Sykdom kan meldes fra og med i går' end) using errcode = 'FA400';
    end if;
    if tg_op = 'UPDATE' and (new.fra <> old.fra or new.type <> old.type) then
      raise exception 'Du kan bare endre sluttdatoen' using errcode = 'FA403';
    end if;
  end if;
  if new.til < new.fra then raise exception 'Sluttdatoen er før startdatoen' using errcode = 'FA400'; end if;
  if new.type = 'permisjon' and new.til - new.fra > 1096 then
    raise exception 'En permisjon kan være høyst tre år om gangen' using errcode = 'FA400';
  end if;
  if new.type <> 'permisjon' and new.til - new.fra > 366 then
    raise exception 'Fraværet kan være høyst ett år om gangen' using errcode = 'FA400';
  end if;
  new.notat := nullif(btrim(new.notat), '');
  if new.type not in ('syk', 'sykt_barn') then
    new.dokumentasjon := null;
    new.arbeidsrelatert := null;
  end if;
  if new.type <> 'permisjon' then
    new.permisjon_art := null;
    new.prosent := null;
    new.slutt_ukjent := false;
  end if;
  if new.prosent = 100 then new.prosent := null; end if;
  if new.permisjon_art is distinct from 'permittering' then
    new.varslet := null;
    new.lonnsplikt_til := null;
  else
    new.betalt := false;
    new.timer := null;
  end if;
  select * into a from faktura.ansatte where org_id = new.org_id and id = new.ansatt_id;
  if found and (new.fra < a.ansatt_fra or (a.ansatt_til is not null and new.til > a.ansatt_til)) then
    raise exception 'Fraværet er utenfor ansettelsen (%–%)', to_char(a.ansatt_fra, 'DD.MM.YYYY'),
      coalesce(to_char(a.ansatt_til, 'DD.MM.YYYY'), '') using errcode = 'FA400';
  end if;
  select f.type into annen from faktura.fravaer f
   where f.org_id = new.org_id and f.ansatt_id = new.ansatt_id and f.id <> new.id
     and daterange(f.fra, f.til, '[]') && daterange(new.fra, new.til, '[]')
     and ((f.type = 'permisjon' and new.type = 'permisjon') or (f.prosent is null and new.prosent is null))
   limit 1;
  if found then
    raise exception '%', case when annen = 'permisjon' and new.type = 'permisjon' then 'Den ansatte har allerede permisjon eller permittering i perioden'
                              else 'Den ansatte har allerede fravær i perioden' end using errcode = 'FA409';
  end if;
  return new;
end $$;

-- Er den ansatte borte denne dagen? Typen, eller null. Delvis permisjon teller ikke.
create or replace function faktura.fravaer_type(_org uuid, _ansatt uuid, _dato date) returns text
language sql stable security definer set search_path = '' as $$
  select f.type from faktura.fravaer f
   where f.org_id = _org and f.ansatt_id = _ansatt and _dato between f.fra and f.til and f.prosent is null
   limit 1
$$;

-- Planen (0063) viser ikke delvis permisjon: den ansatte er på jobb.
create or replace view faktura.fravaer_plan with (security_barrier) as
select f.id, f.org_id, f.ansatt_id, f.fra, f.til,
       faktura.fravaer_type(f.org_id, f.ansatt_id, f.type) as type,
       case when faktura.ser_fravaertype(f.org_id, f.ansatt_id) then f.notat end as notat
  from faktura.fravaer f
 where (faktura.kan(f.org_id, 'plan') or faktura.er_meg(f.org_id, f.ansatt_id)) and f.prosent is null;
