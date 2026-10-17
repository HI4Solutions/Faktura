# Nettstedet: landingsside og juridiske sider

Statisk nettsted for Admin Konsoll, designet som et forhåndstrykt norsk skjema («blanketten»). Det er **ikke rullet ut**: ingen workflow bygger eller publiserer
denne mappen, og den ligger utenfor `web/`.

| Fil | Hva |
|---|---|
| `index.html` | Landingssiden |
| `personvern.html` | Personvernerklæring (vi som behandlingsansvarlig) |
| `vilkar.html` | Bruksvilkår |
| `databehandleravtale.html` | Databehandleravtale etter GDPR art. 28, med vedlegg (behandlingen, sikkerhetstiltak, underdatabehandlere) |
| `underleverandorer.html` | Underdatabehandlere, integrasjoner og andre mottakere |
| `informasjonskapsler.html` | Informasjonskapsler og lokal lagring |
| `felles.css` | Felles stil, skriftene og toppen og bunnen |
| `fonter/` | Inter, Schibsted Grotesk og IBM Plex Mono (SIL Open Font License, lisensene ligger ved) |
| `robots.txt`, `sitemap.xml`, `og-bilde.png`, `favicon.svg` | SEO og deling |

## Må fylles inn eller bekreftes før publisering

- **Forretningsadressen** står som `[Forretningsadresse – fyll inn]` (markert gult) i alle sidene:
  `grep -rl "Forretningsadresse" landingsside`.
- **Leverandøren** er satt til Medinnova AS (org.nr. 936 564 046), samme som `LEVERANDOR_ORGNR` i
  `server/src/config.ts`. Bekreft at det er selskapet som skal stå som avtalepart.
- **E-postadressen** for henvendelser er `post@adminkonsoll.no` (avsenderen i `config.ts`). Den må
  kunne ta imot e-post.
- **Regionen**: dokumentene sier at databasen og filene ligger i EU. Bekreft `GCP_REGION` (standard
  `europe-north1`, Finland).
- **Underleverandørene**: bekreft juridisk enhet og overføringsgrunnlag for Resend og Recommand.
- **Pris**: vilkårene viser til «gjeldende prisliste eller egen avtale». Det finnes ingen prisliste ennå.
- Dokumentene er skrevet ut fra hvordan løsningen faktisk virker, men bør gjennomgås av en advokat
  før de tas i bruk.

## Språkregel: programvare, ikke regnskapsføring

Bare autoriserte regnskapsførere kan føre regnskap for andre (regnskapsførerloven). Admin Konsoll er
programvare kunden fører sitt eget regnskap i, og all tekst (nettstedet, avtalene, appen) skal si det
slik:

- Verktøyet **regner ut, foreslår, klargjør og setter opp utkast**. Kunden **kontrollerer og godkjenner**.
- Kunden fører regnskapet selv, eller lar en autorisert regnskapsfører gjøre det i verktøyet. Ansvaret er
  kundens.
- Ikke skriv at Admin Konsoll «fører regnskapet», «bokfører for dere», «gjør årsoppgjøret», lager
  «ferdig regnskap» eller at noe «går av seg selv» uten at kunden har satt det opp og godkjent det.
- Bruksvilkårene har egen paragraf om dette («Programvare, ikke regnskapsføring»), og bunnteksten sier at
  Admin Konsoll ikke fører regnskap for kunder og ikke er autorisert regnskapsfører.

## Publisering

Appen ligger i dag på roten av `adminkonsoll.no`. Skal nettstedet ligge der, må appen flyttes (for
eksempel til `app.adminkonsoll.no`), og `APP`-lenkene, `canonical` og `sitemap.xml` må stemme med
det. Alle adresser bruker `https://adminkonsoll.no` som rot.

## Personvern på nettstedet

- Ingen informasjonskapsler, analyse eller sporing, så det trengs ikke samtykkebanner.
- Skriftene ligger på eget domene. Siden henter ingenting fra andre domener (sjekket i nettleser).

## Funn i appen som bør følges opp (GDPR)

1. `web/index.html` henter Inter fra Google Fonts. Da sendes brukerens IP-adresse til Google ved
   hvert besøk. Skriftene bør ligge i appen, slik de gjør her.
2. Det finnes ingen måte for en bruker å slette sin egen konto. Personvernerklæringen sier at det
   gjøres ved å skrive til oss.
3. Regnskapsmateriale i stengte organisasjoner skal slettes når oppbevaringstiden er ute, men den
   slettingen er ikke laget ennå (`docs/arkitektur.md`, sletting av organisasjoner).
4. Appen viser ikke bruksvilkårene og databehandleravtalen når en organisasjon opprettes, og
   lagrer ikke hvilken versjon kunden godtok. Det bør legges inn før dokumentene gjelder.
