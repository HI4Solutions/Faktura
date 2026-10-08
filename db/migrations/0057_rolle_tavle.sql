-- 0057_rolle_tavle.sql
-- Om en rolle er med på tavla (ressursfordelingen, 0037_tavle_og_fravaer.sql), f.eks.
-- sekretærene, men ikke legene. De med en rolle som ikke er med, står ikke på tavla,
-- rulleringen fordeler dem ikke, og de kan ikke plasseres der; plassene deres fra i dag av
-- forsvinner når rollen tas ut av tavla, eller når personen får en slik rolle. I vaktplanen,
-- bemanningskalenderen og fraværet er de med som før.

alter table faktura.ansattgrupper add column tavle boolean not null default true;
grant insert (tavle), update (tavle) on faktura.ansattgrupper to faktura_app;

-- Som før (0039), og en plass for en som ikke er med på tavla, lages ikke (raden hoppes over,
-- så rulleringen, kopieringen og vikaren tar dem bare ikke med; API-et sier fra når noen
-- plasseres for hånd). For dem som ikke er ansatt, sier meldingen at de ikke jobber her da.
create or replace function faktura.tavle_plassering_foer() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a faktura.ansatte;
  borte text;
begin
  select * into a from faktura.ansatte where org_id = new.org_id and id = new.ansatt_id;
  if not found then return new; end if;
  if exists (select 1 from faktura.ansattgrupper g where g.org_id = a.org_id and g.id = a.gruppe_id and not g.tavle) then
    return null;
  end if;
  if not a.aktiv or new.dato < a.ansatt_fra or (a.ansatt_til is not null and new.dato > a.ansatt_til) then
    raise exception '% % %', a.fornavn, a.etternavn, case when a.arbeidstaker then 'er ikke ansatt denne dagen' else 'jobber ikke her denne dagen' end
      using errcode = 'FA400';
  end if;
  borte := faktura.fravaer_type(new.org_id, new.ansatt_id, new.dato);
  if borte is not null then
    raise exception '% % er borte denne dagen (%)', a.fornavn, a.etternavn,
      case borte when 'syk' then 'syk' when 'sykt_barn' then 'sykt barn' when 'ferie' then 'ferie'
                 when 'permisjon' then 'permisjon' when 'kurs' then 'kurs' else 'fravær' end using errcode = 'FA409';
  end if;
  return new;
end $$;

-- Rollen tas ut av tavla: plassene fra i dag av for alle med rollen forsvinner.
create function faktura.rolle_ut_av_tavla() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from faktura.tavle_plasseringer p
   using faktura.ansatte a
   where p.org_id = new.org_id and a.org_id = p.org_id and a.id = p.ansatt_id and a.gruppe_id = new.id and p.dato >= faktura.i_dag();
  return null;
end $$;
create trigger ansattgrupper_tavle after update of tavle on faktura.ansattgrupper
  for each row when (old.tavle and not new.tavle) execute function faktura.rolle_ut_av_tavla();

-- Personen får en rolle som ikke er med på tavla: plassene fra i dag av forsvinner.
create function faktura.ansatt_ut_av_tavla() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from faktura.ansattgrupper g where g.org_id = new.org_id and g.id = new.gruppe_id and not g.tavle) then
    delete from faktura.tavle_plasseringer where org_id = new.org_id and ansatt_id = new.id and dato >= faktura.i_dag();
  end if;
  return null;
end $$;
create trigger ansatte_tavle after update of gruppe_id on faktura.ansatte
  for each row when (old.gruppe_id is distinct from new.gruppe_id) execute function faktura.ansatt_ut_av_tavla();
