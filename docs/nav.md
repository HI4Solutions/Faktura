# Sykepenger og NAV – oppsett og bruk

Appen henter sykmeldingene NAV sender til arbeidsgiveren og NAVs forespørsler om inntektsmelding,
og sender inntektsmeldingen (med refusjonskravet) til NAV. Det går gjennom NAVs API for
sykepenger med systembrukeren i Altinn, samme løsning som for skattekortene og a-meldingen.
Leverandøren av løsningen er Medinnova AS (org.nr. 936 564 046).

Hentingen og innsendingen er av til GitHub-variabelen `NAV_SYKEPENGER` er satt til `true`. Til da
registreres fraværet for hånd under Fravær, og inntektsmeldingen sendes på nav.no (Min side –
arbeidsgiver).

## Slik virker det

1. **Sykmeldingene.** Hver time henter workeren de nye sykmeldingene for virksomheten (fra siste
   løpenummer). Den sykmeldte kobles til den ansatte med fødselsnummeret; fødselsnummeret lagres
   ikke. Sykmeldingen blir sykefravær for dagene som ikke alt er registrert: egenmeldingsdagene
   før den som egenmelding, og periodene som sykmelding, med graden når sykmeldingen er gradert
   (f.eks. 50 %). Avventende sykmelding, behandlingsdager, reisetilskudd og dager med annet fravær
   står som merknader. Eier og administrator får varsel. Under Lønn → Sykepenger står
   sykmeldingene med meldingen til arbeidsgiveren og tiltakene; den ansatte ser sine egne.
2. **Forespørselen.** NAV ber om inntektsmelding når en ansatt er syk mer enn 16 dager og har søkt
   om sykepenger. Forespørselen hentes på samme måte, med inntekten i a-ordningen de tre månedene
   før inntektsdatoen, og eier og administrator får varsel.
3. **Inntektsmeldingen.** Appen foreslår den:
   - arbeidsgiverperioden: de første 16 dagene i sykefraværet (fra NAVs perioder og fraværet i
     appen; et nytt fravær innen 16 dager hører til det samme). Har den ansatte vært ansatt i
     mindre enn fire uker, betaler ikke arbeidsgiveren perioden, og begrunnelsen er fylt inn;
   - månedsinntekten: snittet av de tre siste månedene før inntektsdatoen i a-ordningen (det NAV
     sammenligner med), og lønnen fra lønnskjøringene ved siden av. Avviker beløpet mer enn
     1 000 kr fra a-ordningen, må årsaken stå med (f.eks. varig lønnsendring, ny stillingsprosent,
     nyansatt eller ferie); appen foreslår dem den ser;
   - refusjonen: når dere betaler lønnen under sykdommen, kreves den refundert (høyst sykepenger
     av 6 G). Endringer og stopp legges inn som et nytt beløp fra en dato (0 kr stopper);
     slutter den ansatte, stopper den av seg selv;
   - naturalytelser som faller bort under sykdommen, og kontaktpersonen hos dere.

   Rett det som trengs, og trykk «Send inntektsmeldingen». Workeren sender den, og NAV kontrollerer
   den (vanligvis noen minutter). Statusen står på forespørselen: sendt, godkjent eller avvist
   (med årsaken, f.eks. at inntekten avviker fra a-ordningen). En godkjent inntektsmelding kan
   korrigeres: hele meldingen sendes på nytt.
4. **Lønnen.** Valget under Innstillinger → Ansatte og timer → Lønn («Lønn under sykdom etter
   arbeidsgiverperioden») styrer lønnskjøringen:
   - «Vi betaler lønnen og krever refusjon»: fastlønnen går som vanlig, og de med timelønn får de
     planlagte timene (den sykmeldte delen ved gradert sykmelding);
   - «NAV betaler sykepengene til den ansatte»: fastlønnen trekkes for virkedagene etter
     arbeidsgiverperioden (den sykmeldte delen), og timelønn betales ikke.

   I arbeidsgiverperioden betaler arbeidsgiveren alltid (med timelønn: de planlagte timene; ved
   gradert sykmelding den sykmeldte delen, resten er arbeid som vanlig).
5. **Rapporten** «Sykepenger og refusjon» (Rapporter → Lønn) viser per ansatt dagene i og etter
   arbeidsgiverperioden, gradert sykmelding, inntektsmeldingen og den beregnede refusjonen for
   perioden (til regnskapet: krav på refusjon av sykepenger). Den kan sendes til regnskapsføreren
   hver måned.

Bare eier og administrator ser sykmeldingene, forespørslene og rapporten; det er
helseopplysninger. Diagnosen kommer ikke fra NAV.

Koden: `server/src/navSykepenger.ts` (workeren: hentingen, innsendingen og statusen),
`server/src/navInntektsmelding.ts` (skjemaet, forslaget og meldingen til NAV),
`server/src/navRuter.ts` (API-et), `server/src/sykepengerRapporter.ts` (rapporten),
`web/src/sider/LonnSykepenger.tsx` og `db/migrations/0079_nav_sykepenger.sql`.

## Hos kunden

1. **Virksomheten** (underenheten der de ansatte jobber) under Innstillinger → Ansatte og timer →
   A-melding, og **fødselsnummeret** på de ansatte.
2. **Tilgang i Altinn.** Kunder som allerede har koblet til Skatteetaten, trykker «Utvid
   tilgangen i Altinn» under Innstillinger → Ansatte og timer, og daglig leder godkjenner
   tilgangspakken «Lønn med personopplysninger av særlig kategori» i Altinn. Nye kunder får den
   med en gang de kobler til.
3. **Valget for lønn under sykdom** under Innstillinger → Ansatte og timer → Lønn.

## Oppsett hos Medinnova (din del)

Gjør det først i testmiljøet (Maskinporten-test og Altinn TT02), og deretter i produksjon.
Maskinporten-klienten og systemet i Altinn er de samme som for skattekortene (se
`docs/skattekort.md`); de må være satt opp først.

1. **Vilkårene.** NAVs bruksvilkår for API-et forutsetter Digdirs vilkår for
   sluttbrukersystemleverandører i Altinn. Send kontaktinformasjonen til Medinnova AS
   (kontaktperson, e-post og telefon) til **nav.prosjekt.2.inntektsmelding@nav.no**; uten den
   regnes vilkårene som ikke oppfylt.
2. **Scopet på Maskinporten-klienten.** Legg til `nav:helseytelser/sykepenger` på integrasjonen
   i Samarbeidsportalen (samme klient og nøkkel som for skattekortene). Scopet er åpent for alle;
   NAV trenger ikke godkjenne det.
3. **GitHub-variabelen** (Settings → Secrets and variables → Actions → Variables):
   `NAV_SYKEPENGER` = `true`. Kjør så workflowen «Infrastruktur» (Actions → Infrastruktur → Run
   workflow). Adressen til API-et følger `SKATTEETATEN_MILJO` (test:
   `sykepenger-api.ekstern.dev.nav.no`, produksjon: `sykepenger-api.nav.no`); den kan overstyres
   med `NAV_SYKEPENGER_URL`.
4. **Systemet i Altinn.** Administrasjon → Drift → «Skattekort (Skatteetaten)» → «Oppdater i
   Altinn». Systemet ber da også om tilgangspakken «Lønn med personopplysninger av særlig
   kategori» (`urn:altinn:accesspackage:lonn-personopplysninger-saerlig-kategori`), som gir
   sykmeldinger, søknader, forespørsler og inntektsmeldinger hos NAV.
5. **Test.** Be om tilgang til NAVs testdata (Dolly) ved å sende organisasjonsnummeret til
   Medinnova AS til **dolly@nav.no**. Lag en sykmeldt testperson med arbeidsforhold og inntekt hos
   en testarbeidsgiver i TT02, send sykmeldingen og søknaden fra
   <https://www.ekstern.dev.nav.no/syk/sykefravaer> (over 16 dager, så NAV sender forespørsel).
   La testarbeidsgiveren utvide tilgangen i appen, legg inn personen som ansatt med
   fødselsnummeret, trykk «Hent nå» under Lønn → Sykepenger, og send inntektsmeldingen.
6. **Produksjon.** Legg scopet på produksjonsklienten, sett `SKATTEETATEN_MILJO` til `prod` (om
   det ikke er gjort), og gjenta punkt 3–4. **Gi beskjed til nav.prosjekt.2.inntektsmelding@nav.no
   første gang** integrasjonen brukes i produksjon (bare første gang, ikke for hver kunde). Endringer
   i API-et må tas inn innen seks måneder etter at NAV har varslet dem.

Hemmeligheter (nøkkelen til Maskinporten) legges bare i Secret Manager fra Cloud Shell, som
beskrevet i `docs/skattekort.md`; de skal aldri sendes på e-post, i chat eller som skjermbilde.

Det som ikke er med ennå: inntektsmelding uten forespørsel (behandlingsdager, og fravær under 16
dager der NAV ikke spør; de sendes på nav.no), refusjonskrav for omsorgspenger, pleiepenger og
foreldrepenger (egne API-er hos NAV), og søknadene om sykepenger.

## Kilder

- NAV, API for sykepenger (kode og wiki): <https://github.com/navikt/sykepenger-im-lps-api>
- NAV, domenet for inntektsmeldingen: <https://github.com/navikt/hag-domene-inntektsmelding>
- NAV, bruksvilkår for API-et:
  <https://github.com/user-attachments/files/22612303/Bruksvilkar.-.Nav.sitt.API.for.sykepenger.-.V1.pdf>
- NAV, inntektsmelding: <https://www.nav.no/arbeidsgiver/inntektsmelding>
- Altinn, systembruker for systemleverandører:
  <https://docs.altinn.studio/nb/authorization/guides/system-vendor/system-user/>
