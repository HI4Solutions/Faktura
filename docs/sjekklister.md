# Sjekklister

Sjekklister er en funksjon i Personal. Administrator lager sjekklister for det som skal sjekkes
daglig, ukentlig, månedlig eller ved behov (f.eks. åpning, stenging, varebestilling,
varemottak og HMS-runden). Den som gjør sjekklisten, svarer **Normalt** eller **Avvik** på hvert
punkt, eller trykker **Alt normalt**. Et avvik har alltid en kommentar, og avvikene går til
administrator, som lukker dem med det som er gjort.

Plattformadministratoren slår funksjonen av og på per organisasjon (Plattform → Organisasjoner →
Funksjoner). Den er på for organisasjoner med Personal, og står i menyen under Personal (for de
ansatte som et eget punkt).

## Lage sjekklister (administrator)

Sjekklister → **Oppsett** → **Ny sjekkliste**, eller start fra et forslag (Åpning, Stenging,
Varebestilling, Varemottak og HMS-runde) og endre punktene.

- **Hvor ofte:** Daglig (én gang hver dag), Ukentlig (mandag til søndag), Månedlig, eller Ved
  behov (hver gang den trengs; hver utfylling står for seg).
- **Hvem gjør den:** alle i organisasjonen, eller én eller flere roller (f.eks. bare Lager).
  Rollene er de samme som i vaktplanen (Ansatte → Roller). Administrator kan alltid fylle ut.
- **Beskrivelse:** vises øverst når sjekklisten fylles ut (f.eks. «Gjøres før døra åpnes»).
- **Punktene:** Enter gir et nytt punkt, og limer du inn en liste (fra Word, e-post eller et
  regneark), blir hver linje et punkt. Hvert punkt kan ha en veiledning (f.eks. «Under 4
  grader»), og flyttes opp og ned.

Endres punktene, gjelder det framover. Svarene som er gitt, står i historikken med teksten slik
den var. En sjekkliste kan **arkiveres** (den gjøres ikke lenger, men historikken og avvikene
finnes) og hentes fram igjen. **Slett** fjerner den helt hvis den aldri er brukt; ellers
arkiveres den.

## Fylle ut

**Å gjøre** viser sjekklistene du skal gjøre, daglig, ukentlig, månedlig og ved behov, med
status: ikke startet, påbegynt (hvor mange punkter som er besvart) eller fullført (av hvem og
når, og hvor mange avvik).

1. Trykk på sjekklisten.
2. Svar **Normalt** eller **Avvik** på hvert punkt. Normalt lagres med en gang. Ved avvik
   skriver du hva avviket er, og trykker **Lagre avviket**.
3. **Alt normalt** (eller **Resten normalt**) gir Normalt på alle punktene som ikke er besvart.
4. Skriv gjerne en kommentar, og trykk **Fullfør sjekklisten**. Med avvik får administrator
   varsel med en gang.

Fremdriften står fast øverst mens du ruller, også på telefonen.

- De **faste** sjekklistene har én utfylling per periode (dagen, uka fra mandag eller måneden).
  Flere kan jobbe på den samme; hvert punkt viser hvem som svarte. En fullført sjekkliste kan
  ikke endres.
- **Ved behov** gir en ny utfylling hver gang. Påbegynner du en og går fra den, fortsetter du
  der du var neste gang.
- **Glemt?** Ble en fast sjekkliste ikke gjort forrige gang (i går, forrige uke eller forrige
  måned), står det øverst, med **Fyll ut i etterkant**. En utfylling kan føres opp til to
  måneder tilbake.
- Har bedriften **stengt i helgene** (Innstillinger → Personal), regnes ikke lørdag og søndag
  med for de daglige sjekklistene.

## Avvik

Fanen **Avvik** viser de åpne avvikene (tallet står på fanen), eller alle. Administrator ser alle
og lukker dem med **Lukk avviket** og det som er gjort («Ringte service, kjøledisken er
reparert»). Den som meldte avviket, får varsel når det er lukket. De andre ser avvikene de selv
har meldt, og om de er lukket.

Varslene heter «Sjekklister: avvik og når de er lukket» under Innstillinger → App → Varsler.
Avvikene går til eier og administrator og egne roller med Personal.

## Historikk og oversikten

**Historikk** viser sjekklistene som er gjort i en periode (de siste 30 dagene først), med
hvem, når og avvikene, og kan filtreres på sjekkliste. Trykk på en for å se svarene.

Oversikten viser det som venter:

- Den ansatte: sjekklistene som skal gjøres i dag, denne uka og denne måneden, og de som er
  påbegynt (under «Venter på deg»).
- Lederen: åpne avvik, og faste sjekklister som ikke ble gjort forrige gang (under «Til
  oppfølging»).

## Rapporter

Under Rapporter → Personal, med utskrift (PDF), CSV og utsending til regnskapsfører som de andre
rapportene:

- **Sjekklister:** sjekklistene i perioden, når de ble gjort, av hvem og antall avvik, og de faste
  som ikke ble gjort.
- **Avvik fra sjekklistene:** punktet, avviket, hvem som meldte det, og om det er lukket og hva
  som ble gjort.

## Hvem ser og gjør hva

| | Lage og endre | Fylle ut | Se utfyllingene | Avvikene |
|---|---|---|---|---|
| Eier og administrator (og egne roller med Personal) | Ja | Alle sjekklistene | Alle | Ser alle, lukker dem, får varsel |
| Regnskap | Nei | Dem til alle | Alle (og rapportene) | Ser alle |
| Ansatte og andre medlemmer | Nei | Dem til alle og til rollen sin | Sine sjekklister | Ser sine egne, får varsel når de er lukket |

## Teknisk

- Databasen: `0114_sjekklister.sql`. `sjekklister` (navn, hvor ofte, rollene, aktiv),
  `sjekkliste_punkter` (tekst, veiledning, rekkefølge; et punkt som er besvart, settes inaktivt i
  stedet for å slettes), `sjekkliste_utfyllinger` (perioden, påbegynt eller fullført, av hvem;
  én per periode for de faste) og `sjekkliste_svar` (normalt eller avvik med kommentar, teksten
  på punktet slik den var, og tiltaket når avviket er lukket). Alt skrives gjennom funksjoner
  i databasen, som sjekker tilgangen; tabellene kan bare leses (radtilgang).
- Perioden: `sjekkliste_periode` (dagen, mandagen eller den første i måneden) og
  `sjekkliste_forrige` (perioden før; daglig med stengt i helgene er det hverdagen før).
- API-et: `server/src/sjekklister.ts` (`/api/org/:org/sjekklister …`), funksjonen
  `sjekklister` i `server/src/funksjoner.ts` (krever Ansatte og timer), varseltypen
  `sjekklister` i `server/src/push.ts`, og rapportene i `server/src/sjekklisteRapporter.ts`.
- Appen: `web/src/sider/Sjekklister.tsx` (fanene, utfyllingen med `?utfylling=<id>` i adressen,
  avvikene, historikken og oppsettet), og oppgavene på oversiktene.
- Testene: `db/tests/77_sjekklister.sql`, `server/test/sjekklister.test.ts` og
  `server/test/rapportmodul.test.ts`.
