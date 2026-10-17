# Nettstedet: landingsside og juridiske sider

Statisk nettsted for Admin Konsoll, designet som et forhåndstrykt norsk skjema («blanketten»). Rull ut
publiserer det i Firebase Hosting (`scripts/publiser-hosting.sh`, se [Publisering](#publisering)). Det
bygges ikke; filene publiseres som de er.

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
| `firebase.json` | Firebase Hosting: korte adresser (`/vilkar` → `/vilkar.html`), sikkerhetshoder, hurtigbuffer, og alt annet videre til API-et, som sender gamle lenker til appen |
| `sw.js` | Fjerner den gamle appens service worker og hurtigbuffer hos dem som hadde appen på `adminkonsoll.no` |

## Fylt inn og bekreftet

- **Forretningsadressen**: Olasrudveien 23, 1284 Oslo, i alle sidene.
- **Leverandøren** og avtaleparten er Medinnova AS (org.nr. 936 564 046), samme som `LEVERANDOR_ORGNR`
  i `server/src/config.ts`.
- **E-postadressen** for henvendelser er `post@adminkonsoll.no` (avsenderen i `config.ts`), og den tar
  imot e-post.

## Må bekreftes

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

Nettstedet skal ligge på `adminkonsoll.no`, og appen flytter til `app.adminkonsoll.no`. Det skjer i to
steg ([docs/domene.md](../docs/domene.md), «Nettstedet og appen»): så lenge appen ligger på
`adminkonsoll.no`, publiseres nettstedet til en forhåndsvisningskanal (adressen står i loggen fra Rull
ut), og de juridiske sidene ligger ved siden av appen, så lenkene til vilkårene virker.

- «Logg inn» og «Opprett konto» peker til `https://app.adminkonsoll.no` (`?konto=ny` åpner
  registreringen). På testflaten byttes de til testappens adresse, og sidene får `X-Robots-Tag:
  noindex`.
- `canonical`, `sitemap.xml` og `og:url` bruker `https://adminkonsoll.no` som rot.
- Når et dokument endres, oppdateres versjonen og datoen i dokumentet og i en ny migrering for
  `faktura.avtaler` samtidig (servertesten `avtaler.test.ts` sjekker at de stemmer). Organisasjonene
  må da godta den nye versjonen.

## Personvern på nettstedet

- Ingen informasjonskapsler, analyse eller sporing, så det trengs ikke samtykkebanner.
- Skriftene ligger på eget domene. Siden henter ingenting fra andre domener (sjekket i nettleser).

## Funn i appen (GDPR), rettet

1. Inter ligger i appen (`web/src/fonter/`), og appen henter ingenting fra Google Fonts.
2. Brukeren kan slette sin egen konto under Innstillinger → Min konto → Slett kontoen. Personvern-
   erklæringen (§ 9) sier fortsatt at det gjøres ved å skrive til oss; teksten er ikke endret.
3. Regnskapsmaterialet i stengte organisasjoner slettes når oppbevaringstiden er ute, med filene
   (`docs/arkitektur.md`, sletting av organisasjoner).
4. Bruksvilkårene og databehandleravtalen godtas når en organisasjon opprettes, og versjonene, hvem og
   når lagres. Organisasjoner fra før må godta dem når de åpner appen.
