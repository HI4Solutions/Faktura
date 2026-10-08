-- 0056_roller.sql
-- Roller i stedet for tilknytning: organisasjonen lager rollene selv, f.eks. lege og sekretær,
-- med det navnet rollen faktisk har hos dem. Rollene er de samme som gruppene i
-- bemanningskalenderen (0039_bemanning.sql), så legene kan ses opp mot sekretærene. En rolle
-- kan være for dem som ikke er ansatt (f.eks. leger som er aksjonærer eller selvstendige): de er
-- med i vaktplanen, på tavla, i bemanningskalenderen og i fraværet som de andre, men ikke i
-- lønn, feriebank, ekstratimer eller arbeidsmiljølovens advarsler. Det er rollen som vises, ikke
-- «eier eller aksjonær»: tilknytningen på hver person (0054_tilknytning.sql) erstattes.

alter table faktura.ansattgrupper add column ikke_ansatt boolean not null default false;
grant insert (ikke_ansatt), update (ikke_ansatt) on faktura.ansattgrupper to faktura_app;

-- Om personen er ansatt, følger rollen (holdes oppdatert av triggerne under; API-et kan ikke
-- sette det selv).
alter table faktura.ansatte add column arbeidstaker boolean not null default true;
grant select (arbeidstaker) on faktura.ansatte to faktura_app;

-- De som var registrert som ikke ansatt, får en rolle for dem som ikke er ansatt: rollen de har,
-- når ingen i den er ansatt; ellers en ny rolle ved siden av («Leger (ikke ansatt)», eller
-- «Ikke ansatt» for dem uten rolle), som kan få et annet navn etterpå.
update faktura.ansattgrupper g set ikke_ansatt = true
 where exists (select 1 from faktura.ansatte a where a.org_id = g.org_id and a.gruppe_id = g.id and a.tilknytning <> 'ansatt')
   and not exists (select 1 from faktura.ansatte a where a.org_id = g.org_id and a.gruppe_id = g.id and a.tilknytning = 'ansatt');

do $$
declare
  r record;
  ny uuid;
begin
  for r in
    select a.org_id, g.id as gruppe, min(g.navn) as navn, min(g.rekkefolge) as rekkefolge
      from faktura.ansatte a left join faktura.ansattgrupper g on g.org_id = a.org_id and g.id = a.gruppe_id
     where a.tilknytning <> 'ansatt' and not coalesce(g.ikke_ansatt, false)
     group by a.org_id, g.id
  loop
    insert into faktura.ansattgrupper (org_id, navn, ikke_ansatt, rekkefolge)
    values (r.org_id,
            case when r.navn is null then 'Ikke ansatt' else left(r.navn, 26) || ' (ikke ansatt)' end,
            true,
            coalesce(r.rekkefolge, (select coalesce(max(x.rekkefolge), 0) + 1 from faktura.ansattgrupper x where x.org_id = r.org_id)))
    returning id into ny;
    update faktura.ansatte set gruppe_id = ny
     where org_id = r.org_id and tilknytning <> 'ansatt' and gruppe_id is not distinct from r.gruppe;
  end loop;
end $$;

update faktura.ansatte a set arbeidstaker = false
  from faktura.ansattgrupper g
 where g.org_id = a.org_id and g.id = a.gruppe_id and g.ikke_ansatt;

-- Ny person, eller en annen rolle: om personen er ansatt, følger rollen.
create function faktura.ansatt_arbeidstaker() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.arbeidstaker := not coalesce(
    (select g.ikke_ansatt from faktura.ansattgrupper g where g.org_id = new.org_id and g.id = new.gruppe_id), false);
  return new;
end $$;
create trigger ansatte_arbeidstaker before insert or update of gruppe_id on faktura.ansatte
  for each row execute function faktura.ansatt_arbeidstaker();

-- Rollen blir (eller er ikke lenger) for dem som ikke er ansatt: alle med rollen følger med.
-- (Slettes rollen, står de uten rolle og er ansatt, gjennom triggeren over.)
create function faktura.rolle_arbeidstaker() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update faktura.ansatte set arbeidstaker = not new.ikke_ansatt
   where org_id = new.org_id and gruppe_id = new.id and arbeidstaker = new.ikke_ansatt;
  return null;
end $$;
create trigger ansattgrupper_arbeidstaker after update of ikke_ansatt on faktura.ansattgrupper
  for each row when (old.ikke_ansatt is distinct from new.ikke_ansatt) execute function faktura.rolle_arbeidstaker();

-- Feriebanken er bare for de ansatte.
create or replace function faktura.feriebank(_org uuid, _aar int)
returns table (ansatt_id uuid, navn text, aktiv boolean, dager_per_uke int, rett numeric, egen_rett boolean, ekstra_60 boolean,
               sen_start boolean, overfort_inn numeric, overfort_ut numeric, avviklet numeric, planlagt numeric, igjen numeric, venter numeric)
language sql stable security definer set search_path = '' as $$
  select a.id, a.fornavn || ' ' || a.etternavn, a.aktiv, s.*
    from faktura.ansatte a, faktura.ferie_saldo(_org, a.id, _aar) s
   where a.org_id = _org and faktura.ser_fravaertype(_org, a.id) and a.arbeidstaker
     and a.ansatt_fra <= make_date(_aar, 12, 31) and (a.ansatt_til is null or a.ansatt_til >= make_date(_aar, 1, 1))
   order by a.etternavn, a.fornavn
$$;

alter table faktura.ansatte drop column tilknytning;
