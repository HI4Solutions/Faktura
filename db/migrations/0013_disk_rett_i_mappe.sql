-- 0013_disk_rett_i_mappe.sql
-- Har brukeren valgt en egen mappe, legges fakturaene rett i den. Standardmappen
-- «HI4 Faktura» beholder undermapper per organisasjon og år.

alter table faktura.disk_koblinger add column undermapper boolean not null default true;
update faktura.disk_koblinger set undermapper = false where rotmappe_navn is distinct from 'HI4 Faktura';

grant select (undermapper), update (undermapper) on faktura.disk_koblinger to faktura_app;
