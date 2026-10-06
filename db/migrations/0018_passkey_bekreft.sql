-- 0018_passkey_bekreft.sql
-- Applås: med en passkey på enheten (Face ID, Touch ID, Windows Hello) bekrefter
-- brukeren at det er riktig person som åpner appen. API-et sjekker at passkeyen
-- tilhører den innloggede brukeren.

alter table faktura.passkey_utfordringer drop constraint passkey_utfordringer_type_check;
alter table faktura.passkey_utfordringer
  add constraint passkey_utfordringer_type_check check (type in ('registrering', 'innlogging', 'bekreft'));
