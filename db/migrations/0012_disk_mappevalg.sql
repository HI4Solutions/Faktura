-- 0012_disk_mappevalg.sql
-- Brukeren kan velge hvilken mappe i Google Disk fakturaene kopieres til.
-- Navnet lagres så vi kan vise det uten å spørre Google.

alter table faktura.disk_koblinger add column rotmappe_navn text;
update faktura.disk_koblinger set rotmappe_navn = 'HI4 Faktura' where rotmappe_navn is null;

grant select (rotmappe_navn), update (rotmappe_navn) on faktura.disk_koblinger to faktura_app;

-- Tom mappe betyr «lag HI4 Faktura ved neste kopiering» (når brukeren går tilbake til standard).
alter table faktura.disk_koblinger alter column rotmappe drop not null;
