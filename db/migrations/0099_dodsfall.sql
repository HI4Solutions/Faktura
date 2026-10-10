-- Dødsfall (Lønn K5; lonnsberegning.ts, lonn.ts, amelding.ts). Dødsdatoen på den ansatte avslutter
-- arbeidsforholdet den dagen: sluttdatoen er dødsdatoen, og sluttårsaken i a-meldingen er
-- «arbeidstaker har sagt opp selv» (den Skatteetaten sier skal brukes også når den ansatte dør).
-- Lønn og feriepenger som er opptjent før dødsfallet og utbetales etter, er lønn etter dødsfall: ikke
-- forskuddstrekk og ikke arbeidsgiveravgift, rapportert som loennEtterDoedsfall på den avdøde, og
-- betalt til dødsboet (kontonummeret på den ansatte). lonnsslipper.etter_dodsfall: slippen er
-- utbetalt etter dødsdatoen.
alter table faktura.ansatte
  add column dodsdato date,
  add constraint ansatte_dodsdato check (dodsdato is null or ansatt_til = dodsdato);
grant select (dodsdato), insert (dodsdato), update (dodsdato) on faktura.ansatte to faktura_app;
grant select (dodsdato) on faktura.ansatte to faktura_system;

alter table faktura.lonnsslipper add column etter_dodsfall boolean not null default false;
grant insert (etter_dodsfall), update (etter_dodsfall) on faktura.lonnsslipper to faktura_app;
