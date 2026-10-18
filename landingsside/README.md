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
| `status.html` | Hva som er i drift. Bruksvilkårene (§ 4) lenker hit; siden står ikke i nettstedskartet og har `noindex` |
| `felles.css` | Felles stil, skriftene, toppen, bunnen og arkene |
| `nettsted.js` | Måler hvor toppen slutter (`--hode`), sender kontaktskjemaet og går rett til appen når nettstedet åpnes fra Hjem-skjermen av en som er logget inn ([Hjem-skjermen](#hjem-skjermen)). Sideskiftet gjør nettleseren selv. Uten skriptet virker alt |
| `fonter/` | Inter, Schibsted Grotesk og IBM Plex Mono (SIL Open Font License, lisensene ligger ved) |
| `robots.txt`, `sitemap.xml`, `og-bilde.png`, `favicon.svg` | SEO og deling |
| `ikoner/` | Appens ikon for Hjem-skjermen: symbolet alene (laget med `scripts/lag-ikoner.mjs`, som i `web/public/ikoner`) |
| `firebase.json` | Firebase Hosting: korte adresser (`/vilkar` → `/vilkar.html`), sikkerhetshoder (CSP på sidene), hurtigbuffer, og alt annet videre til API-et, som sender gamle lenker til appen. Med appen under `/app` får den appens regler i tillegg ([Publisering](#publisering)) |

## Arkene

Toppen, hver del av forsiden, dokumentet på de juridiske sidene og bunnen er egne ark på bordet,
med luft mellom. Forsiden har ni ark: tittelfeltet, modulene (del 1), hvem gjør hva (del 2), eksempelet
med timen (del 3), hvem den er laget for (del 4), sikkerheten (del 5), veiledningen (del 6),
kontaktskjemaet (del 7) og underskriften. Toppen står fast øverst, med knappene «Logg inn» og «Opprett konto» til høyre på
alle skjermer. Lenkene til delene står ved knappene når skjermen er minst 1140 px bred. Da viker
skjemakoden «AK-1 · utg. 10.2026», som bare står på mellomstore skjermer; hvert ark har uansett
«AK-1 · Side n av 9» øverst til høyre. På telefon blir logoen og teksten i knappene mindre, så alt
står på én linje (knappene er like høye), og under 343 px står symbolet alene.

Ingen side skal være bredere enn skjermen, heller ikke på en telefon som er 320 px bred. Tittelen på
forsiden krymper på de smaleste telefonene, så «administrasjonen.» får plass, og lange ord i
overskriftene har myke bindestreker (`personopplysnings&shy;sikkerheten`), så de deles pent.

På forsiden har hvert ark sin plass (`.blad`) og sin egen høyde, med god luft mellom arkene
(`--mellom`, 40–96 px etter skjermbredden). Det første arket begynner rett under toppen, uten luft
over, og det gjør også dokumentet på de juridiske sidene. Siden ruller fritt. En periode snappet den
til én del om gangen, med ark som fylte hele skjermen, men det gjorde rullingen stiv og delene tette,
og er tatt bort. Lenkene til delene legger delen rett under toppen (`scroll-padding-top` med høyden
på toppen, `--hode`, som `nettsted.js` måler), og i sideskiftet legger arkene seg også rett under
toppen.

Sideskiftet: når neste del kommer, blir arket liggende der det er, og det neste glir opp over det, med
en skygge langs kanten øverst. Et ark som er høyere enn skjermen (på mobil gjelder det de fleste),
rulles gjennom til bunnen er nådd, og blir liggende da. Det er en scroll-drevet animasjon på arket
(`animation-timeline`, uten skript), så den følger rullingen og går baklengs når man ruller tilbake.
Bare arket flytter seg, aldri plassen, så lenkene treffer. Arket blir liggende til det neste ligger på
plass over det, og forsvinner først da, så det ikke stikker fram over det neste. Chrome, Edge og
Safari 26 har scroll-drevne animasjoner; i andre nettlesere (Firefox, eldre Safari) ruller arkene
forbi som vanlig.

Arkene som blir liggende, har hvit luft nederst: 30 % av høyden under toppen. Arket stopper når
bunnen når bunnen av skjermen, og det neste dekker luften før teksten, så den siste teksten står et
godt stykke over kanten (og over verktøylinjen nederst på telefonen) og kan leses før det neste arket
kommer over den. Luften måles mot den minste skjermhøyden (`svh`), som står i ro når verktøylinjene i
nettleseren kommer og går; med `dvh` ville arkene over endret høyde, og siden hoppet. Luften er bare
med der arkene faktisk blir liggende: ikke på kontaktskjemaet, ikke i nettlesere uten scroll-drevne
animasjoner, ikke med redusert bevegelse og ikke på utskrift.

Kontaktskjemaet er det siste arket i bunken (`.bunke`) og blir ikke liggende: det neste dekker aldri
feltene eller «Send», heller ikke når tastaturet på mobilen kommer opp og nettleseren ruller feltet
fram. Underskriften («Ett skjema til») står utenfor bunken og ruller som vanlig.

Med redusert bevegelse (innstillingen i operativsystemet) og på utskrift ruller arkene bare forbi, og
lenkene hopper rett til delen.

En ny del legges inn som en plass med et ark: `<div class="blad" id="…">` med `<div class="ark">`,
og i arket `<span class="sidetall">` og `<div class="inn">` rundt delen. Sidetallene («Side n av 9»,
også i tittelfeltet) rettes.

Bunnen er kort: logoen, de juridiske sidene og knappen «Kontakt oss» (til skjemaet på forsiden) på
én rad, og selskapsopplysningene (navn, org.nr., adresse og e-post, som e-handelsloven krever) på
linjen under.

## Hjem-skjermen

Nettstedet har appens ikon (`ikoner/apple-touch-icon.png`) og navnet «Admin Konsoll» når det legges på
Hjem-skjermen. På iPhone åpnes en slik snarvei som en app, uten adresselinje, og siden tegnes helt opp
under statuslinjen. Da ligger en mørk stripe bak statuslinjen, som i appen, og toppen, med «Logg inn»,
står under den (`felles.css`). Reglene bruker avstanden telefonen oppgir (`env(safe-area-inset-top)`)
og gjelder alltid, for `display-mode: standalone` slår ikke til for alle snarveier på iPhone; i
nettleseren er avstanden null.

Snarveien åpner forsiden. «Logg inn» og «Opprett konto» åpner appen under `/app` på samme domene
([Publisering](#publisering)), så innloggingen og appen blir inne i snarveien (et annet domene ville
iPhone åpnet som en ny side oppå). Logoen på innloggingen (og «Til nettstedet» på større
skjermer) går tilbake til forsiden, og det gjør også «Logg ut» i appen. Er man logget inn, går snarveien rett til appen (`nettsted.js` ser
etter `faktura.innlogget`, som appen setter i nettleseren). I nettleseren vises forsiden som vanlig.

## Kontaktskjemaet

Del 7 på forsiden («Skriv til oss») sender en henvendelse rett til oss: navn, e-post, foretak
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

## Innloggingen i appen

Innloggingen i appen (logg inn, opprett konto, glemt passord og totrinnskoden) og skjermene før appen
(bekreft e-post og venter på godkjenning) er blanketter som nettstedet: samme topp med logoen og
skjemakoden «AK-2», ark med hullrader, delbånd, nummererte felt, knapper, stempler på svarene og samme
bunn. Byggeklossene er kopiert fra `felles.css` til `web/src/blankett.css`, og skriftene ligger også i
appen (`web/src/fonter/`). Endres fargene, skriftene eller byggeklossene her, må `blankett.css` følge
med. Logoen i appen står også som her i lyst utseende (`docs/merkevare/README.md`).

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

Forsiden nevner ikke leverandørene våre ved navn (som Recommand, Enable Banking og Google), og
eksemplene bruker oppdiktede virksomheter. Leverandørene står i underleverandørene, personvern-
erklæringen og databehandleravtalen, der de skal stå. Offentlige tjenester og standarder (Altinn,
Skatteetaten, NAV, EHF og Peppol) kan nevnes.

## Publisering

Nettstedet ligger på `adminkonsoll.no`, med appen under `adminkonsoll.no/app`, og appen har også
`app.adminkonsoll.no`. Flyttingen skjedde i to steg ([docs/domene.md](../docs/domene.md), «Nettstedet
og appen»): så lenge appen lå på `adminkonsoll.no` (steg 1), ble nettstedet publisert til en
forhåndsvisningskanal (adressen står i loggen fra Rull ut), og de juridiske sidene lå ved siden av
appen, så lenkene til vilkårene virket. Produksjon og testflaten har tatt begge stegene: på
testflaten ligger nettstedet på `test.adminkonsoll.no`, med testappen under `/app` der og på
`app.test.adminkonsoll.no`.

- Med appen ved siden av peker «Logg inn» og «Opprett konto» til `/app` og `/app?konto=ny` (som åpner
  registreringen). `scripts/publiser-hosting.sh` legger appen inn: siden den starter fra er
  `app/index.html` (med `<meta name="app-sti" content="/app">`, `web/src/appsti.ts`), appens service
  worker er `sw.js`, og alt nettstedet ikke har selv, åpner appen. I forhåndsvisningen peker de til
  appens hoveddomene. På testflaten får sidene `X-Robots-Tag: noindex`.
- `canonical`, `sitemap.xml` og `og:url` bruker `https://adminkonsoll.no` som rot.
- En modul som ikke er klar ennå, får merket «Kommer snart» (`data-kommer-snart="<modul>"`, skjult
  som standard). Publiseringen viser det for modulene i `KOMMER_SNART` på API-et (`kommer_snart` i
  `infra/terraform/miljo/<miljø>.tfvars`, i produksjon nå Regnskap); se
  [docs/miljoer.md](../docs/miljoer.md), «Moduler som ikke er klare».
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
