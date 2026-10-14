-- 0108_meny_vaktbytte.sql
-- Appen: om vaktbytte er slått på (lonn_oppsett.vaktbytte, 0060_vaktbytte.sql), så menyen til de
-- ansatte bare har «Bytter» når de kan bytte og gi bort vakter. Ellers som i 0073.
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
       faktura.timebank_paa(o.id) as timebank,
       coalesce((select l.vaktbytte from faktura.lonn_oppsett l where l.org_id = o.id), 'godkjenning') as vaktbytte
  from faktura.organisasjoner o;
