-- 0058_kunder_som_rollehavere.sql
-- Kunder kan hentes inn som rollehavere (f.eks. legene på et legekontor, som kontoret
-- fakturerer): personen i registeret kobles til kunden, så kunden ikke hentes inn to ganger, og
-- ansattkortet viser hvilken kunde det er. Koblingen er bare innenfor organisasjonen, og slettes
-- kunden, står personen uten kobling.

alter table faktura.ansatte add column kunde_id uuid;
alter table faktura.ansatte add constraint ansatte_kunde_fk foreign key (org_id, kunde_id)
  references faktura.kunder(org_id, id) on delete set null (kunde_id);
create index ansatte_kunde_idx on faktura.ansatte (org_id, kunde_id) where kunde_id is not null;
grant select (kunde_id), insert (kunde_id), update (kunde_id) on faktura.ansatte to faktura_app;
