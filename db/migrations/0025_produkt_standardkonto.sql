-- 0025_produkt_standardkonto.sql
-- Fast konto på et produkt kan også være organisasjonens standardkonto, ikke bare en av
-- de ekstra kontoene. Standardkontoen har ingen rad i faktura.kontoer (konto_id er null
-- for den på fakturaen), så valget lagres i et eget felt.

alter table faktura.produkter
  add column standardkonto boolean not null default false,
  add constraint produkter_en_konto check (not (standardkonto and konto_id is not null));
grant insert (standardkonto), update (standardkonto) on faktura.produkter to faktura_app;
