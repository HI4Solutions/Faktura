-- Åpent i helgene (lørdag og søndag) i personalmodulen. Har organisasjonen stengt i helgene
-- (helg = false), viser vaktplanen (dagen, uka og måneden), tavla, timeføringen og de faste
-- arbeidsdagene bare mandag–fredag, og dag for dag hopper over helgen. Lørdag og søndag vises
-- likevel når noen har vakt, fast dag eller timer da, så ingenting blir borte. AI-assistenten
-- legger perioder («hele neste uke») på mandag–fredag. Standard er åpent, som før.

alter table faktura.lonn_oppsett add column helg boolean not null default true;
grant insert (helg), update (helg) on faktura.lonn_oppsett to faktura_app;

-- Appen: om organisasjonen har åpent i helgene (uten oppsett: åpent).
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
       coalesce((select l.helg from faktura.lonn_oppsett l where l.org_id = o.id), true) as helg
  from faktura.organisasjoner o;
