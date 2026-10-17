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
| `felles.css` | Felles stil, skriftene, toppen, bunnen og arkene |
| `nettsted.js` | Måler høyden på toppen (`--hode`), holder skjemaarket unna sideskiftet mens man fyller ut kontaktskjemaet, og sender skjemaet. Sideskiftet gjør nettleseren selv. Uten skriptet virker alt |
| `fonter/` | Inter, Schibsted Grotesk og IBM Plex Mono (SIL Open Font License, lisensene ligger ved) |
| `robots.txt`, `sitemap.xml`, `og-bilde.png`, `favicon.svg` | SEO og deling |
| `firebase.json` | Firebase Hosting: korte adresser (`/vilkar` → `/vilkar.html`), sikkerhetshoder, hurtigbuffer, og alt annet videre til API-et, som sender gamle lenker til appen |
| `sw.js` | Fjerner den gamle appens service worker og hurtigbuffer hos dem som hadde appen på `adminkonsoll.no` |

## Arkene

Toppen, hver del av forsiden, dokumentet på de juridiske sidene og bunnen er egne ark på bordet,
med luft mellom. Toppen står fast øverst, og lenkene står til høyre ved «Logg inn» og «Opprett
konto» når skjermen er minst 1100 px bred. Da viker skjemakoden «AK-1 · utg. 10.2026», som bare
står på mellomstore skjermer; hvert ark har uansett «AK-1 · Side n av 10» øverst til høyre.

På forsiden har hvert ark sin plass (`.blad`) og sin egen høyde, med god luft mellom arkene og over
det første (`--mellom`, 40–96 px etter skjermbredden). Siden ruller fritt. En periode snappet den til
én del om gangen, med ark som fylte hele skjermen, men det gjorde rullingen stiv og delene tette, og
er tatt bort. Lenkene til delene legger delen rett under toppen (`scroll-padding-top` med høyden på
toppen, `--hode`, som `nettsted.js` måler).

Sideskiftet: når neste del kommer, blir arket liggende der det er, og det neste glir opp over det, med
en skygge langs kanten øverst. Et ark som er høyere enn skjermen (på mobil gjelder det de fleste),
rulles gjennom til bunnen er nådd, og blir liggende da. Det er en scroll-drevet animasjon på arket
(`animation-timeline`, uten skript), så den følger rullingen og går baklengs når man ruller tilbake.
Bare arket flytter seg, aldri plassen, så lenkene treffer. Arket blir liggende til det neste ligger på
plass over det, og forsvinner først da, så det ikke stikker fram over det neste. Chrome, Edge og
Safari 26 har scroll-drevne animasjoner; i andre nettlesere (Firefox, eldre Safari) ruller arkene
forbi som vanlig.

Kontaktskjemaet er det siste arket i bunken (`.bunke`) og blir ikke liggende: det neste dekker aldri
feltene eller «Send», heller ikke når tastaturet på mobilen kommer opp og nettleseren ruller feltet
fram. Underskriften («Ett skjema til») står utenfor bunken og ruller som vanlig.

Med redusert bevegelse (innstillingen i operativsystemet) og på utskrift ruller arkene bare forbi, og
lenkene hopper rett til delen.

En ny del legges inn som en plass med et ark: `<div class="blad" id="…">` med `<div class="ark">`,
og i arket `<span class="sidetall">` og `<div class="inn">` rundt delen. Sidetallene («Side n av 10»,
også i tittelfeltet) rettes.

Bunnen er kort: logoen, de juridiske sidene og knappen «Kontakt oss» (til skjemaet på forsiden) på
én rad, og selskapsopplysningene (navn, org.nr., adresse og e-post, som e-handelsloven krever) på
linjen under.

## Kontaktskjemaet

Del 8 på forsiden («Skriv til oss») sender en henvendelse rett til oss: navn, e-post, foretak
(valgfritt) og henvendelsen. Adressen står ikke der, bare e-postadressen for den som vil skrive
direkte.

- Skjemaet sendes til `POST /api/offentlig/kontakt` (`server/src/kontakt.ts`), som nettstedet
  sender videre til API-et som alt annet det ikke har selv. `nettsted.js` sender det som JSON og
  viser svaret under skjemaet. Uten skript sendes det som et vanlig skjema, og nettleseren sendes
  tilbake til forsiden med kvitteringen (`#kontakt-sendt`) eller feilen (`#kontakt-feil`).
- Henvendelsen legges i køen som e-post til `post@adminkonsoll.no` (`KONTAKT_EPOST`), med
  avsenderens e-postadresse som svaradresse, så man svarer rett fra innboksen. Ingenting lagres i
  databasen, og innholdet havner ikke i loggen.
- Et skjult felt (`nettsted`) fanger roboter: de får et vanlig svar, men ingenting sendes. Høyst fem
  henvendelser i timen fra samme IP-adresse og 100 i timen i alt (per instans).

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
- Bruksvilkårene har egen paragraf om dette («Programvare, ikke regnskapsføring»), og forsiden sier det
  under Spørsmål og svar og i del 5 («Dere eier regnskapet»).

## Publisering

Nettstedet skal ligge på `adminkonsoll.no`, og appen flytter til `app.adminkonsoll.no`. Det skjer i to
steg ([docs/domene.md](../docs/domene.md), «Nettstedet og appen»): så lenge appen ligger på
`adminkonsoll.no`, publiseres nettstedet til en forhåndsvisningskanal (adressen står i loggen fra Rull
ut), og de juridiske sidene ligger ved siden av appen, så lenkene til vilkårene virker.

- «Logg inn» og «Opprett konto» peker til `https://app.adminkonsoll.no` (`?konto=ny` åpner
  registreringen). På testflaten byttes de til testappens adresse, og sidene får `X-Robots-Tag:
  noindex`.
- `canonical`, `sitemap.xml` og `og:url` bruker `https://adminkonsoll.no` som rot.
- `felles.css` og `nettsted.js` får en kontrollsum av innholdet i adressen (`felles.css?v=…`) når de
  publiseres. Sidene hentes alltid på nytt, men stilarket lagres en time, og en ny side med et gammelt
  stilark mangler blant annet den faste toppen.
- Når et dokument endres, oppdateres versjonen og datoen i dokumentet og i en ny migrering for
  `faktura.avtaler` samtidig (servertesten `avtaler.test.ts` sjekker at de stemmer). Organisasjonene
  må da godta den nye versjonen.

## Personvern på nettstedet

- Ingen informasjonskapsler, analyse eller sporing, så det trengs ikke samtykkebanner.
- Kontaktskjemaet lagrer ingenting i nettleseren. Det man skriver, sendes på e-post til oss
  (gjennom Resend, som står blant underleverandørene). Personvernerklæringen dekker det i § 3,
  «Svare på henvendelser og gi brukerstøtte»; teksten er ikke endret.
- Skriftene ligger på eget domene. Siden henter ingenting fra andre domener (sjekket i nettleser).

## Funn i appen (GDPR), rettet

1. Inter ligger i appen (`web/src/fonter/`), og appen henter ingenting fra Google Fonts.
2. Brukeren kan slette sin egen konto under Innstillinger → Min konto → Slett kontoen. Personvern-
   erklæringen (§ 9) sier fortsatt at det gjøres ved å skrive til oss; teksten er ikke endret.
3. Regnskapsmaterialet i stengte organisasjoner slettes når oppbevaringstiden er ute, med filene
   (`docs/arkitektur.md`, sletting av organisasjoner).
4. Bruksvilkårene og databehandleravtalen godtas når en organisasjon opprettes, og versjonene, hvem og
   når lagres. Organisasjoner fra før må godta dem når de åpner appen.
