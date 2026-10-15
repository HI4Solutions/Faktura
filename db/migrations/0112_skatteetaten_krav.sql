-- 0112_skatteetaten_krav.sql
-- Krav og betalinger og frister fra Skatteetaten (server/src/skatteetatenKrav.ts, fanen
-- «Skatteetaten» under Regnskap, docs/skatteetaten-krav.md).
--
-- Workeren henter med systembrukeren i Altinn (tilgangspakken «Krav, betalinger og utlegg»):
-- de åpne kravene (skatt og avgifter med forfall og betalingsinformasjon) og innbetalingene som
-- ikke er plassert, innbetalingene og utbetalingene de siste tolv månedene, og fristene for
-- mva-meldingen og skattemeldingen. Svaret lagres slik appen viser det (tolket, ikke det rå
-- svaret). Krav og frister hentes hver for seg, så den ene kan virke selv om den andre ikke gjør
-- det: det som sist ble hentet (og når), og feilen fra siste forsøk (null når det gikk).
--
-- Eier, administrator og regnskap (og en egen rolle med Regnskap) ser det; bare workeren skriver.
create table faktura.skatteetaten_krav (
  org_id uuid primary key references faktura.organisasjoner(id) on delete cascade,
  -- {oversikt, grupper, aapne, uplasserte, innbetalinger, utbetalinger, periode} (skatteetatenKrav.ts)
  krav jsonb,
  krav_hentet timestamptz,
  krav_feil text check (krav_feil is null or length(krav_feil) <= 2000),
  -- [{tittel, beskrivelse, type, frist, kilde}]
  frister jsonb,
  frister_hentet timestamptz,
  frister_feil text check (frister_feil is null or length(frister_feil) <= 2000),
  -- Siste forsøk (hver morgen, når tilgangen er godkjent, og «Hent nå», høyst én gang i minuttet).
  forsokt timestamptz
);
alter table faktura.skatteetaten_krav enable row level security;
create policy skatteetaten_krav_les on faktura.skatteetaten_krav for select using (faktura.kan(org_id, 'regnskap'));
create policy skatteetaten_krav_system on faktura.skatteetaten_krav for all using (faktura.er_system()) with check (faktura.er_system());
grant select on faktura.skatteetaten_krav to faktura_app;
grant select, insert, update on faktura.skatteetaten_krav to faktura_system;
