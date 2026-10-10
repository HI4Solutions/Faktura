-- Medlemskapet i den obligatoriske tjenestepensjonen (lonnsberegning.ts, amelding.ts): hvem som er
-- med, og at de er meldt inn og ut hos pensjonsleverandøren. Etter innskuddspensjonsloven § 4-2
-- (pensjon fra første krone og dag, fra 2022) skal arbeidstakere som har fylt 13 år være med fra
-- første dag; ordningens regelverk kan si at de som har fylt 75 år ikke tas opp. Frilansere og
-- oppdragstakere er ikke arbeidstakere (0096) og er ikke med.
--
-- otp_unntak_75: ordningen tar ikke opp arbeidstakere som har fylt 75 år.
-- otp_innmeldt og otp_utmeldt på den ansatte: da den ansatte ble meldt inn og ut hos
-- pensjonsleverandøren (føres av eier eller administrator; a-meldingen minner om det som mangler).
alter table faktura.lonn_oppsett add column otp_unntak_75 boolean not null default false;
grant insert (otp_unntak_75), update (otp_unntak_75) on faktura.lonn_oppsett to faktura_app;

alter table faktura.ansatte
  add column otp_innmeldt date,
  add column otp_utmeldt date,
  add constraint ansatte_otp_utmeldt check (otp_utmeldt is null or otp_innmeldt is null or otp_utmeldt >= otp_innmeldt);
grant select (otp_innmeldt, otp_utmeldt), insert (otp_innmeldt, otp_utmeldt), update (otp_innmeldt, otp_utmeldt) on faktura.ansatte to faktura_app;
grant select (otp_innmeldt, otp_utmeldt) on faktura.ansatte to faktura_system;
