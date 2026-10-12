-- En passkey virker bare på domenet den er laget på (WebAuthn: RP ID). Appen svarer på flere
-- domener mens den flytter fra faktura.hi4.no til adminkonsoll.no (server/src/appadresse.ts), så
-- hver passkey husker domenet sitt: appen viser hvor den virker, og applåsen spør bare etter dem
-- som virker der brukeren er. Alle passkeys fra før er laget på faktura.hi4.no (APP_URL fram til
-- flyttingen).
alter table faktura.passkeys add column rp_id text check (length(rp_id) <= 253);
update faktura.passkeys set rp_id = 'faktura.hi4.no' where rp_id is null;
alter table faktura.passkeys alter column rp_id set not null;

grant select (rp_id) on faktura.passkeys to faktura_app;
