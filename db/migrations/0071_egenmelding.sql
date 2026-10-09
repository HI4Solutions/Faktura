-- Egenmelding (server/src/fravaer.ts, «Meld deg syk» og «Send egenmelding» under Mine vakter):
-- den ansatte erklærer selv at fraværet skyldes egen sykdom eller sykt barn, og reglene sjekkes
-- her:
--   egen sykdom: inntil 3 kalenderdager per gang og 4 ganger i løpet av 12 måneder
--   (folketrygdloven § 8-24), etter to måneder i jobben. Arbeidsgiveren kan gi mer (f.eks.
--   IA-ordningen: 8 dager per gang og 24 dager i løpet av 12 måneder), aldri mindre: det loven
--   gir, gjelder alltid.
--   sykt barn: inntil 3 kalenderdager per gang (deretter kan arbeidsgiveren kreve
--   legeerklæring), eller flere om arbeidsgiveren godtar det; telles ikke med i de fire gangene.
-- Fravær med egenmelding som henger sammen (dagen etter), er samme tilfelle.
--
-- fravaer.dokumentasjon: egenmelding (sendt av den ansatte, eller registrert av lederen for en
-- egenmelding på papir) eller sykmelding (legeerklæring for sykt barn), som lederen registrerer.
-- Den ansatte kan sende egenmelding for sykdom de siste 16 dagene, og kan ikke endre eller fjerne
-- dokumentasjonen etterpå.

alter table faktura.lonn_oppsett
  add column egenmelding_dager int not null default 3 check (egenmelding_dager between 3 and 16),
  add column egenmelding_ganger int default 4 check (egenmelding_ganger is null or egenmelding_ganger between 4 and 52),
  add column egenmelding_dager_aar int check (egenmelding_dager_aar is null or egenmelding_dager_aar between 12 and 366),
  add column egenmelding_barn_dager int not null default 3 check (egenmelding_barn_dager between 3 and 30);
grant insert (egenmelding_dager, egenmelding_ganger, egenmelding_dager_aar, egenmelding_barn_dager),
      update (egenmelding_dager, egenmelding_ganger, egenmelding_dager_aar, egenmelding_barn_dager)
  on faktura.lonn_oppsett to faktura_app;

alter table faktura.fravaer
  add column dokumentasjon text check (dokumentasjon in ('egenmelding', 'sykmelding')),
  add column arbeidsrelatert boolean,                  -- den ansattes svar: har fraværet sammenheng med arbeidet?
  add column egenmeldt timestamptz,                    -- når egenmeldingen kom
  add column egenmeldt_av uuid references faktura.brukere(id) on delete set null,
  add constraint fravaer_dokumentasjon_type check (dokumentasjon is null or type in ('syk', 'sykt_barn')),
  add constraint fravaer_egenmeldt check ((dokumentasjon is not distinct from 'egenmelding') = (egenmeldt is not null));

grant insert (dokumentasjon, arbeidsrelatert), update (dokumentasjon, arbeidsrelatert) on faktura.fravaer to faktura_app;

-- Tilfellene med egenmelding for en ansatt (egen sykdom eller sykt barn): fravær som henger
-- sammen (dagen etter eller overlapper), slått sammen. Med _fra og _til: som om fraværet _id
-- hadde de datoene (og egenmelding), og med = tilfellet det hører til.
create function faktura.egenmelding_tilfeller(_org uuid, _ansatt uuid, _type text, _id uuid default null, _fra date default null, _til date default null)
returns table (fra date, til date, med boolean)
language sql stable set search_path = '' as $$
  with e as (
    select f.id, f.fra, f.til from faktura.fravaer f
     where f.org_id = _org and f.ansatt_id = _ansatt and f.type = _type and f.dokumentasjon = 'egenmelding'
       and f.id is distinct from _id
    union all
    select _id, _fra, _til where _fra is not null
  ), m as (
    select e.*, max(e.til) over (order by e.fra, e.til rows between unbounded preceding and 1 preceding) as forrige from e
  ), k as (
    select m.*, count(*) filter (where m.forrige is null or m.fra > m.forrige + 1) over (order by m.fra, m.til rows unbounded preceding) as kjede from m
  )
  select min(k.fra), max(k.til), bool_or(_fra is not null and k.id is not distinct from _id) from k group by k.kjede order by 1
$$;

-- Reglene i organisasjonen (lovens når den ikke har lagt inn noe).
create function faktura.egenmelding_regler(_org uuid)
returns table (dager int, ganger int, dager_aar int, barn_dager int)
language sql stable security definer set search_path = '' as $$
  select coalesce(o.egenmelding_dager, 3), case when o.org_id is null then 4 else o.egenmelding_ganger end,
         o.egenmelding_dager_aar, coalesce(o.egenmelding_barn_dager, 3)
    from (select 1) x left join faktura.lonn_oppsett o on o.org_id = _org
$$;

-- Egenmelding de siste 12 månedene fram til _til (egen sykdom): hvor mange tilfeller og dager.
create function faktura.egenmelding_brukt(_org uuid, _ansatt uuid, _til date, _id uuid default null, _fra date default null, _ny_til date default null)
returns table (ganger int, dager int)
language sql stable set search_path = '' as $$
  select count(*)::int, coalesce(sum(least(x.til, _til) - greatest(x.fra, (_til - interval '12 months')::date + 1) + 1), 0)::int
    from faktura.egenmelding_tilfeller(_org, _ansatt, 'syk', _id, _fra, _ny_til) x
   where x.til > (_til - interval '12 months')::date and x.fra <= _til
$$;

-- Den ansatte selv: bare sykdom, fra og med i går (egenmelding for de siste 16 dagene), og
-- deretter bare sluttdatoen. Dokumentasjonen: den ansatte kan sende egenmelding, men ikke endre
-- eller fjerne dokumentasjonen etterpå (sykmeldingen registrerer lederen).
create or replace function faktura.fravaer_foer() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a faktura.ansatte;
  ny_dok boolean;
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
  if new.til - new.fra > 366 then raise exception 'Fraværet kan være høyst ett år om gangen' using errcode = 'FA400'; end if;
  new.notat := nullif(btrim(new.notat), '');
  if new.type not in ('syk', 'sykt_barn') then
    new.dokumentasjon := null;
    new.arbeidsrelatert := null;
  end if;
  select * into a from faktura.ansatte where org_id = new.org_id and id = new.ansatt_id;
  if found and (new.fra < a.ansatt_fra or (a.ansatt_til is not null and new.til > a.ansatt_til)) then
    raise exception 'Fraværet er utenfor ansettelsen (%–%)', to_char(a.ansatt_fra, 'DD.MM.YYYY'),
      coalesce(to_char(a.ansatt_til, 'DD.MM.YYYY'), '') using errcode = 'FA400';
  end if;
  if exists (select 1 from faktura.fravaer f
              where f.org_id = new.org_id and f.ansatt_id = new.ansatt_id and f.id <> new.id
                and daterange(f.fra, f.til, '[]') && daterange(new.fra, new.til, '[]')) then
    raise exception 'Den ansatte har allerede fravær i perioden' using errcode = 'FA409';
  end if;
  return new;
end $$;

-- Egenmeldingen: hvem som sendte den og når, og reglene (etter fravaer_foer, som sjekker datoene).
create function faktura.fravaer_egenmelding() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  a faktura.ansatte;
  t record;
  b record;
  lengde int;
  opptjent date;
begin
  if new.dokumentasjon is distinct from 'egenmelding' then
    new.egenmeldt := null;
    new.egenmeldt_av := null;
    return new;
  end if;
  if tg_op = 'INSERT' or old.dokumentasjon is distinct from 'egenmelding' then
    new.egenmeldt := now();
    new.egenmeldt_av := faktura.bruker_id();
  elsif new.fra = old.fra and new.til = old.til and new.type = old.type then
    return new; -- samme datoer: reglene er sjekket
  else
    new.egenmeldt := old.egenmeldt;
    new.egenmeldt_av := old.egenmeldt_av;
  end if;
  select * into r from faktura.egenmelding_regler(new.org_id);
  select * into a from faktura.ansatte where org_id = new.org_id and id = new.ansatt_id;
  select x.fra, x.til into t from faktura.egenmelding_tilfeller(new.org_id, new.ansatt_id, new.type, new.id, new.fra, new.til) x where x.med;
  lengde := t.til - t.fra + 1;

  if new.type = 'sykt_barn' then
    if lengde > r.barn_dager then
      raise exception 'Egenmelding for sykt barn kan gjelde høyst % dager på rad (kalenderdager, også helg). Lengre fravær trenger legeerklæring.', r.barn_dager
        using errcode = 'FA400';
    end if;
    return new;
  end if;

  -- Egen sykdom: etter to måneder i jobben.
  opptjent := (a.ansatt_fra + interval '2 months')::date;
  if t.fra < opptjent then
    raise exception 'Egenmelding kan brukes etter to måneder i jobben (fra %). Før det trengs sykmelding fra lege.', to_char(opptjent, 'DD.MM.YYYY')
      using errcode = 'FA400';
  end if;
  select * into b from faktura.egenmelding_brukt(new.org_id, new.ansatt_id, t.til, new.id, new.fra, new.til);
  -- Loven gjelder alltid (3 dager, 4 ganger); arbeidsgiverens ordning kan gi mer.
  if (lengde <= 3 and b.ganger <= 4)
     or (lengde <= r.dager and (r.ganger is null or b.ganger <= r.ganger) and (r.dager_aar is null or b.dager <= r.dager_aar)) then
    return new;
  end if;
  if lengde > greatest(3, r.dager) then
    raise exception 'En egenmelding kan gjelde høyst % dager på rad (kalenderdager, også helg). Lengre sykefravær trenger sykmelding fra lege.', greatest(3, r.dager)
      using errcode = 'FA400';
  elsif r.dager_aar is not null and b.dager > r.dager_aar then
    raise exception 'Med denne blir det % dager med egenmelding i løpet av 12 måneder, og det er høyst %. Nå trengs sykmelding fra lege.', b.dager, r.dager_aar
      using errcode = 'FA400';
  else
    raise exception 'Dette blir egenmelding nummer % i løpet av 12 måneder, og det er høyst %. Nå trengs sykmelding fra lege.', b.ganger, greatest(4, coalesce(r.ganger, 4))
      using errcode = 'FA400';
  end if;
end $$;

create trigger fravaer_foer_egenmelding before insert or update on faktura.fravaer
  for each row execute function faktura.fravaer_egenmelding();

revoke all on function faktura.egenmelding_tilfeller(uuid, uuid, text, uuid, date, date), faktura.egenmelding_regler(uuid),
  faktura.egenmelding_brukt(uuid, uuid, date, uuid, date, date) from public;
grant execute on function faktura.egenmelding_tilfeller(uuid, uuid, text, uuid, date, date), faktura.egenmelding_regler(uuid),
  faktura.egenmelding_brukt(uuid, uuid, date, uuid, date, date) to faktura_app, faktura_system;
