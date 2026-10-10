-- Kildeskatt på lønn (Lønn K6; lonnsberegning.ts, skattekort.ts, ansatte.ts, kildeskatt.ts).
-- Utenlandske arbeidstakere på kildeskatteordningen (PAYE) har et skattekort med prosenttrekk merket
-- «kildeskatt på lønn» (tilleggsopplysningen kildeskattPaaLoenn). ansatte.kildeskatt: den ansatte er
-- på ordningen; workeren setter det fra skattekortet fra Skatteetaten, og det kan settes for hånd
-- sammen med et prosenttrekk. Trekket er satsen av all lønn (også feriepengene), uten fradrag for
-- fagforeningskontingent og uten halv skatt, og rapporteres som ordinært forskuddstrekk.
alter table faktura.ansatte add column kildeskatt boolean not null default false;
grant select (kildeskatt), insert (kildeskatt), update (kildeskatt) on faktura.ansatte to faktura_app;
grant select (kildeskatt), update (kildeskatt) on faktura.ansatte to faktura_system;

-- Skattekortene som alt er hentet med tilleggsopplysningen.
update faktura.ansatte set kildeskatt = true where 'kildeskattPaaLoenn' = any(skattekort_tillegg);
