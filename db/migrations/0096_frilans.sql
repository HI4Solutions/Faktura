-- Frilansere, oppdragstakere og styremedlemmer i lønnen (lonn.ts, lonnsberegning.ts, amelding.ts):
-- den som har arbeidsforholdet «frilanser, oppdragstaker eller honorar» (0077), får honorar i
-- stedet for lønn. Ferieloven, OTP-loven og arbeidsgiverens sykepenger gjelder arbeidstakere, så
-- honoraret gir ikke feriepenger, OTP eller sykepenger, overtid regnes ikke, og permisjon og
-- permittering hører ikke til. Honoraret er trekkpliktig og gir arbeidsgiveravgift, og
-- arbeidsforholdet står i a-meldingen bare de månedene honoraret utbetales.
--
-- honorar_art: hva honoraret rapporteres som i a-meldingen og bokføres som: honorar for oppdrag
-- («honorar, akkord, prosent- eller provisjonslønn», konto 5390) eller styrehonorar og godtgjørelse
-- for verv (konto 5330).
alter table faktura.ansatte
  add column honorar_art text not null default 'honorar' check (honorar_art in ('honorar', 'styrehonorar'));
grant select (honorar_art), insert (honorar_art), update (honorar_art) on faktura.ansatte to faktura_app;
grant select (honorar_art) on faktura.ansatte to faktura_system;
