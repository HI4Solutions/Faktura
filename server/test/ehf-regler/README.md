# Offisielle valideringsregler for EHF / PEPPOL BIS Billing 3.0

Brukes bare i testene (`test/ehf.test.ts`) for å sjekke at EHF-filene appen lager er gyldige.

| Fil | Kilde | Versjon |
| --- | --- | --- |
| `CEN-EN16931-UBL.sch` | EN 16931 (CEN), via [OpenPEPPOL/peppol-bis-invoice-3](https://github.com/OpenPEPPOL/peppol-bis-invoice-3) `rules/sch` | 1.3.15 (2025-10-16), EUPL 1.2 |
| `PEPPOL-EN16931-UBL.sch` | PEPPOL BIS Billing 3.0, med norske regler (NO-R-…), samme repo | 3.0.20 (november 2025), commit 261c458 |
| `iso_*.xsl` | ISO Schematron «skeleton» ([Schematron/schematron](https://github.com/Schematron/schematron)) | MIT |

Ved ny utgave av reglene: kopier de to `.sch`-filene fra `rules/sch` i repoet over. Testene kompilerer
reglene til XSLT med SaxonJS (`xslt3`) og mellomlagrer resultatet i `node_modules/.cache/ehf-regler`.
