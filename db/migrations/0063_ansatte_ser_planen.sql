-- 0063_ansatte_ser_planen.sql
-- De ansatte ser hele planen, ikke bare sine egne vakter og plasser: den publiserte vaktplanen
-- (dag, uke og måned), tavla og bemanningskalenderen, bare til lesing. De ser kollegaenes navn,
-- rolle og forkortelse, de publiserte vaktene, de faste arbeidsdagene, plassene på tavla og den
-- faste oppgaven, og rollene med behovet. Utkast ser de ikke. Fraværet ser de bare som fravær
-- («F»): typen og notatet ser fortsatt bare eier, administrator og den ansatte selv (0047), og
-- fraværstabellen og ansattregisteret er låst som før; planen leser dem gjennom fravaer_plan og
-- ansatte_plan, som bare har det som hører til planen (ikke lønn, kontaktopplysninger, stilling
-- eller notater). Det gjelder aktive ansatte med innlogging (faktura.kan(org, 'plan')).

--   plan: se vaktplanen, tavla og bemanningskalenderen (de som ser de ansatte, og de aktive
--   ansatte med innlogging); ellers som i 0035.
create or replace function faktura.kan(_org uuid, _handling text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  r text;
begin
  if faktura.er_system() then return true; end if;
  if faktura.bruker_id() is null or _org is null then return false; end if;
  r := faktura.rolle(_org);
  if r is null then return false; end if;
  return case _handling
    when 'les'          then r <> 'ansatt'
    when 'skriv'        then r in ('eier', 'admin', 'fakturerer')
    when 'utsted'       then r in ('eier', 'admin', 'fakturerer')
    when 'bokfor'       then r in ('eier', 'admin', 'fakturerer', 'regnskap')
    when 'admin'        then r in ('eier', 'admin')
    when 'eier'         then r = 'eier'
    when 'personal'     then r in ('eier', 'admin')
    when 'personal_les' then r in ('eier', 'admin', 'regnskap')
    when 'plan'         then r in ('eier', 'admin', 'regnskap') or faktura.min_ansatt(_org) is not null
    when 'medlem'       then true
    else false
  end;
end $$;

-- Vaktene: de publiserte for alle som ser planen (utkastene som før bare for dem som ser de
-- ansatte), og den ansatte sine egne publiserte også etter at de har sluttet.
drop policy vakter_les on faktura.vakter;
create policy vakter_les on faktura.vakter for select
  using (faktura.kan(org_id, 'personal_les')
         or (publisert_at is not null and (faktura.kan(org_id, 'plan') or faktura.er_meg(org_id, ansatt_id))));

-- De faste arbeidsdagene, dagene gitt bort i et vaktbytte, plassene på tavla, den faste oppgaven og
-- rollene: alle som ser planen.
drop policy arbeidsplaner_les on faktura.arbeidsplaner;
create policy arbeidsplaner_les on faktura.arbeidsplaner for select
  using (faktura.kan(org_id, 'plan') or faktura.er_meg(org_id, ansatt_id));
drop policy arbeidsplan_dager_les on faktura.arbeidsplan_dager;
create policy arbeidsplan_dager_les on faktura.arbeidsplan_dager for select
  using (faktura.kan(org_id, 'plan')
         or exists (select 1 from faktura.arbeidsplaner p where p.id = plan_id and faktura.er_meg(p.org_id, p.ansatt_id)));
drop policy arbeidsplan_fri_les on faktura.arbeidsplan_fri;
create policy arbeidsplan_fri_les on faktura.arbeidsplan_fri for select
  using (faktura.kan(org_id, 'plan') or faktura.er_meg(org_id, ansatt_id));
drop policy tavle_plasseringer_les on faktura.tavle_plasseringer;
create policy tavle_plasseringer_les on faktura.tavle_plasseringer for select
  using (faktura.kan(org_id, 'plan') or faktura.er_meg(org_id, ansatt_id));
drop policy tavle_fast_oppgave_les on faktura.tavle_fast_oppgave;
create policy tavle_fast_oppgave_les on faktura.tavle_fast_oppgave for select
  using (faktura.kan(org_id, 'plan') or faktura.er_meg(org_id, ansatt_id));
drop policy ansattgrupper_les on faktura.ansattgrupper;
create policy ansattgrupper_les on faktura.ansattgrupper for select using (faktura.kan(org_id, 'plan'));

-- Personene i planen: det planen viser (navn, forkortelse, rolle, ansettelsesperioden og om de er
-- ansatt), for alle som ser planen. Stillingen, stillingsprosenten og ansettelsestypen ser bare de
-- som ser de ansatte, og den ansatte selv. Viewet leser ansattregisteret som eieren (forbi
-- radsikkerheten der), så det er where-leddet her som avgjør hvem som ser hvem.
create view faktura.ansatte_plan with (security_barrier) as
select a.id, a.org_id, a.ansattnummer, a.fornavn, a.etternavn, a.forkortelse, a.gruppe_id, a.aktiv,
       a.ansatt_fra, a.ansatt_til, a.arbeidstaker, a.ukentlig_arbeidstid, a.opprettet,
       a.bruker_id is not null and a.bruker_id = faktura.bruker_id() as meg,
       case when faktura.kan(a.org_id, 'personal_les') or faktura.er_meg(a.org_id, a.id) then a.stilling end as stilling,
       case when faktura.kan(a.org_id, 'personal_les') or faktura.er_meg(a.org_id, a.id) then a.stillingsprosent end as stillingsprosent,
       case when faktura.kan(a.org_id, 'personal_les') or faktura.er_meg(a.org_id, a.id) then a.ansettelsestype end as ansettelsestype
  from faktura.ansatte a
 where faktura.kan(a.org_id, 'plan') or faktura.er_meg(a.org_id, a.id);

-- Fraværet i planen: hvem som er borte når, for alle som ser planen, med typen og notatet bare for
-- dem som ser dem (fravaer_type og ser_fravaertype, 0047); ellers typen «fravaer» og uten notat.
create view faktura.fravaer_plan with (security_barrier) as
select f.id, f.org_id, f.ansatt_id, f.fra, f.til,
       faktura.fravaer_type(f.org_id, f.ansatt_id, f.type) as type,
       case when faktura.ser_fravaertype(f.org_id, f.ansatt_id) then f.notat end as notat
  from faktura.fravaer f
 where faktura.kan(f.org_id, 'plan') or faktura.er_meg(f.org_id, f.ansatt_id);

grant select on faktura.ansatte_plan, faktura.fravaer_plan to faktura_app, faktura_system;

-- Appen: om den innloggede ser planen (ser_planen; en ansatt som har sluttet, gjør ikke det).
create or replace view faktura.mine_organisasjoner with (security_invoker = true) as
select o.id, o.type, o.navn, o.orgnr, o.verifisering,
       faktura.rolle(o.id) as rolle,
       exists (select 1 from faktura.medlemmer m
                where m.org_id = o.id and m.bruker_id = faktura.bruker_id()) as direkte_medlem,
       coalesce((select l.aktiv from faktura.lonn_oppsett l where l.org_id = o.id), false)
         and faktura.har_funksjon(o.id, 'ansatte') as personal,
       (select a.id from faktura.ansatte a where a.org_id = o.id and a.bruker_id = faktura.bruker_id()) as ansatt_id,
       faktura.org_funksjonsliste(o.id) as funksjoner,
       faktura.kan(o.id, 'plan') as ser_planen
  from faktura.organisasjoner o;
