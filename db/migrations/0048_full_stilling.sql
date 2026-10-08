-- Arbeidstiden i full stilling (timer per uke) for organisasjonen: standarden nye ansatte får
-- (vanligvis 37,5, f.eks. 35,5 eller 33,6 med turnus eller skift), så den ikke må skrives inn for
-- hver ansatt. Hver ansatt kan ha sin egen (ansatte.ukentlig_arbeidstid).
alter table faktura.lonn_oppsett
  add column full_stilling numeric(4,2) not null default 37.5 check (full_stilling > 0 and full_stilling <= 60);
grant insert (full_stilling), update (full_stilling) on faktura.lonn_oppsett to faktura_app;
