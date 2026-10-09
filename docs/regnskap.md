# Regnskap: bilag, hovedbok, fakturaer og innbetalinger, utgifter, anleggsmidler, periodiseringer og saldoavskrivninger

Regnskapsmodulen er HI4 Fakturas eget regnskap (ingen kobling til Tripletex, Fiken eller andre):
bilagene fra alle kildene med manuelle bilag (også den inngående balansen), saldobalansen og
hovedboken, fakturaene og innbetalingene som bokføres av seg selv, utgiftene (leverandørfakturaer og
kvitteringer, lest med AI og vurdert av reglene), anleggsmidlene med
avskrivningsplanen over flere år (også goodwill), bokføringen av avskrivninger, nedskrivning, salg
og utrangering, periodiseringene over flere måneder og år, månedsavslutningen og de skattemessige
saldoavskrivningene.

Modulen er funksjonen «Regnskap» (Administrasjon → Funksjoner) og menyen «Regnskap» med fanene
Bilag, Utgifter, Saldobalanse, Anleggsmidler, Periodiseringer, Saldoavskrivninger og Kontoer. Eier,
administrator og regnskapsføreren (rollen regnskap) ser og fører; fakturerer og les ser den ikke.

## Bilagene og hovedboken

- Et bilag har et nummer i en serie per år, en dato, en tekst og posteringer (konto og beløp,
  positivt i debet og negativt i kredit, og mva-koden der det er avgift) som går i null. Seriene:
  **F** fakturaer og kreditnotaer, **B** innbetalinger og refusjoner, **U** utgifter og betalingen
  av dem, **L** lønn og refusjoner fra NAV, **A** anleggsmidler, **P** periodiseringer og **M**
  manuelle bilag.
- Et bilag endres eller slettes aldri; det reverseres med et nytt bilag med motsatte beløp (og de
  samme mva-kodene). Anleggsmidlene og periodiseringene reverseres det siste først. En faktura
  rettes med en kreditnota, og en innbetaling ved å ta bort betalingen på fakturaen. Et lønnsbilag
  reverseres ved å åpne lønnskjøringen igjen, og en refusjon fra NAV ved å slette den
  (Lønn → Sykepenger).
- **Manuelle bilag** (Regnskap → Bilag → «Nytt bilag»): linjer med konto (norsk standard
  kontoplan, NS 4102), tekst og beløp i debet eller kredit, som må gå i null. Den inngående
  balansen fra et tidligere regnskapssystem føres som et manuelt bilag på den første dagen:
  eiendelene i debet, egenkapitalen og gjelden i kredit. Datoen kan ikke være fram i tid.
- **Saldobalansen** for en periode: inngående saldo, debet, kredit og utgående saldo per konto,
  gruppert etter kontoklassene. Balansekontoene (klasse 1 og 2) har saldoen fra starten;
  resultatkontoene (klasse 3–8) begynner på null 1. januar. Resultatet fra tidligere år som ikke er
  ført mot egenkapitalen (årsoppgjøret), står på en egen linje, så saldobalansen går i null.
  Resultatet i perioden er inntektene minus kostnadene.
- **Hovedboken** for en konto: inngående saldo, posteringene med bilaget og saldoen etter hver.

## Fakturaene og innbetalingene (bilagserie F og B)

Fakturaene, kreditnotaene og innbetalingene bokføres av seg selv (`server/src/salgBokforing.ts`,
`0089_regnskap_salg.sql`): workeren fører det som mangler hvert minutt, og regnskapet gjør det når
bilagene eller saldobalansen vises. Ingen trenger å gjøre noe.

- **Fakturaen** (og kreditnotaen, med motsatte beløp) får et bilag på fakturadatoen:
  kundefordringen (1500) med fakturaens sum, mot salget og den utgående avgiften per sats, med
  mva-koden fra Skatteetatens standard mva-koder for SAF-T:

  | Sats | Salget | Avgiften | Kode |
  | --- | --- | --- | --- |
  | 25 % (høy) | 3000 | 2700 | 3 |
  | 15 % (middels, næringsmidler) | 3030 | 2701 | 31 |
  | 11,11 % (råfisk) | 3035 | 2702 | 32 |
  | 12 % (lav) | 3050 | 2703 | 33 |
  | 0 %, utenfor merverdiavgiftsloven (f.eks. helsetjenester) | 3200 | – | 6 |
  | 0 %, fritatt (f.eks. bøker og aviser) | 3100 | – | 5 |

  Om salg uten avgift er utenfor loven (standarden) eller fritatt, velges under
  Regnskap → Kontoer. Den som ikke er mva-registrert, fører alt salget på 3200 uten mva-kode.
  Kontoene kan endres under Regnskap → Kontoer.
- **Innbetalingen** får et bilag på betalingsdatoen: banken (1920) mot kundefordringen. Er det
  betalt mer enn fakturaen (minus kreditnotaene til og med betalingsdatoen), er det overskytende
  purregebyr (3900, uten avgift) så langt fakturaen er purret med gebyr, og resten står som
  kundens tilgode på kundefordringen til det betales tilbake. Gebyret regnes likt hver gang, i den
  rekkefølgen betalingene kom, uansett når de bokføres. En **refusjon** er banken mot
  kundefordringen.
- En faktura eller betaling som **slettes**, får bilaget reversert («Reversert, fakturaen er
  slettet: …»); ellers reverseres bilagene ikke i regnskapet (fakturaen rettes med en kreditnota,
  og den bokføres av seg selv).
- **Startdatoen** (Regnskap → Kontoer → «Bokfør fra og med»): fakturaene (fakturadatoen) og
  innbetalingene (betalingsdatoen) fra og med datoen bokføres. Det som er fra før, hører til den
  inngående balansen: siden viser kundefordringene ved datoen (fakturaene før den minus det som er
  betalt før den, uten purregebyrene), som føres i den inngående balansen på 1500. Det som betales
  etter datoen for en eldre faktura, bokføres mot kundefordringen. Flyttes datoen fram, reverseres
  bilagene før den («Reversert, fra før startdatoen for salget: …»); flyttes den tilbake, bokføres
  de på nytt. Organisasjonene som hadde fakturaer da dette kom, fikk 1. januar i år som startdato;
  nye organisasjoner bokfører alt.
- Bilaget har en lenke til fakturaen (Regnskap → Bilag → «Åpne fakturaen»).

## Utgiftene (bilagserie U)

Leverandørfakturaer og kvitteringer (Regnskap → Utgifter; `server/src/utgifter.ts`,
`server/src/aiUtgift.ts`, `server/src/utgiftVurdering.ts`, `0090_utgifter.sql`):

- **Last opp eller ta bilde** (PDF eller bilde, høyst 12 MB; flere på en gang). Fila lagres med
  utgiften, og når den bokføres, kopieres den til fakturabøtta, som oppbevarer den (bokføringsloven
  § 13). En utgift kan også fylles ut for hånd.
- **AI leser** (når funksjonen AI er slått på): leverandøren og organisasjonsnummeret,
  fakturanummeret, datoene, KID og kontonummeret, beløpet, linjene per mva-sats med hva slags kjøp
  det er, om det er et varig driftsmiddel, perioden kostnaden gjelder, og om det er tjenester kjøpt
  fra utlandet uten norsk mva. Organisasjons- og kontonummer med feil kontrollsiffer og datoer fram i
  tid tas ut og sies fra om. Kan fila ikke leses, blir den en kladd å fylle ut.
- **Kontoen** for hver linje er den leverandøren fikk sist for samme slags kjøp (det som ble rettet,
  læres), ellers kontoen for kategorien (Skatteetatens standard kontoplan: f.eks. 6800
  kontorrekvisita, 6420 programvare, 6900 telefon, 7140 reise, 7350 representasjon, 7500
  forsikring).
- **Fradraget for inngående mva** er prosenten under Kontoer → Utgiftene (tomt: 100 % for den som er
  mva-registrert, ellers 0; imellom: forholdsmessig fradrag for fellesanskaffelser). Representasjon
  og gaver får ikke fradrag. Avgiften som trekkes fra, føres per sats med mva-koden (1, 11, 12 og 13
  på 2710–2713); det som ikke trekkes fra, blir kostnad. Tjenester kjøpt fra utlandet: avgiften
  beregnes (25 %, kode 86 med fradrag og 87 uten, på 2714 og 2704) for den som er mva-registrert.
- **Vurderingen**: et varig driftsmiddel til minst 30 000 kr (uten mva som trekkes fra) aktiveres som
  anleggsmiddel med kategorien og levetiden (anskaffelsen i serie A, avskrives med
  månedsavslutningen); en utgift for flere måneder fra grensen under Kontoer (standard 5 000 kr)
  periodiseres som forskuddsbetalt kostnad over månedene (starten i serie P); ellers kostnad i
  serie U. Begrunnelsen står på utgiften, og behandlingen kan endres før den godkjennes.
- **Godkjenn og bokfør**: kostnaden og avgiften mot leverandørgjelden (2400), eller banken (1920),
  kontantene (1900) eller gjelden til en ansatt (2910) når den er betalt. Det som ikke stemmer
  (linjene og beløpet, datoen, valutaen), bokføres ikke. Fra en leverandør som er godkjent før, med
  kontoen lært for hver linje, bokføres en kostnad av seg selv når alt stemmer og AI ikke hadde
  merknader (kan slås av under Kontoer).
- **Betalt**: leverandørgjelden mot banken (serie U). **Angre bokføringen**: betalingen og
  kostnaden reverseres (et anleggsmiddel eller en periodisering reverseres og slettes, så lenge
  ingenting er bokført etter), og utgiften blir en kladd igjen.
- Rapportene «Leverandørgjeld» (de ubetalte, med forfall, mot saldoen på 2400) og «Utgifter» (linje
  for linje i perioden) under Rapporter → Regnskap.

## Anleggsregisteret og avskrivningsplanen

- Et anleggsmiddel har kategori (goodwill, andre immaterielle eiendeler, tomt, bygning, fast
  teknisk installasjon, maskiner, inventar, kontormaskiner og IT, personbil, varebil/lastebil,
  andre driftsmidler), anskaffelsesdato, kostpris (uten fradragsberettiget mva), levetid,
  restverdi og måneden avskrivningen begynner (når det ble tatt i bruk). Kategorien foreslår
  balansekonto, avskrivningskonto, saldogruppe og levetid; alt kan endres.
- Avskrivningen er lineær (regnskapsloven § 5-3: en fornuftig avskrivningsplan), måned for måned
  ned til restverdien. Hver måned avskrives det som står igjen, delt på månedene som er igjen, så
  en nedskrivning, en reversering eller en ny levetid eller restverdi gjelder framover. Planen
  vises per år (verdien 1.1., avskrivningen, nedskrivningen, avgangen og verdien 31.12.) og måned
  for måned, med det som er bokført og det som er plan.
- Goodwill avskrives som de andre over den forventede økonomiske levetiden; en nedskrivning av
  goodwill kan ikke reverseres. Tomt avskrives ikke.
- Et anleggsmiddel som er ført i et annet system før, legges inn med det som er avskrevet til og
  med en måned; HI4 avskriver resten fra måneden etter.

## Bokføringen (bilagserie A)

- **Anskaffelsen** (valgfritt): kostprisen på balansekontoen og inngående mva mot leverandørgjeld
  eller bank, på anskaffelsesdatoen.
- **Månedsavslutningen**: avskrivningene som ikke er bokført til og med en måned, et bilag per
  måned (den siste dagen i måneden), avskrivningskostnaden (6000 bygg, 6010 driftsmidler, 6020
  immaterielle og goodwill) mot balansekontoen for hvert anleggsmiddel.
- **Nedskrivning** til virkelig verdi ved verdifall som ikke er forbigående (6050 mot
  balansekontoen), og **reversering** når grunnlaget ikke lenger er til stede (ikke for goodwill,
  ikke mer enn nedskrevet, og ikke høyere verdi enn etter planen uten nedskrivning).
- **Salg eller utrangering**: avskrivningene til og med måneden bokføres først (den siste på
  avgangsdatoen), så vederlaget (med mva) på bank eller kundefordringer, utgående mva, den
  bokførte verdien ut av balansekontoen og forskjellen som gevinst (3800) eller tap (7800).
- Et bilag endres eller slettes aldri; det reverseres med et nytt bilag med motsatte beløp, og det
  siste først. Kontoene kan endres under Regnskap → Kontoer (norsk standard kontoplan, NS 4102).

## Periodiseringene (bilagserie P)

Et beløp som gjelder flere måneder, fordeles likt på månedene (i øre, den siste tar resten) og
bokføres måned for måned mellom en resultatkonto og en balansekonto:

| Type | Eksempel | Hver måned | Balansekonto |
|---|---|---|:-:|
| Forskuddsbetalt kostnad | forsikring eller leie betalt for et år | kostnaden mot balansekontoen | 1700 |
| Påløpt kostnad | bonus eller strøm som faktureres senere | kostnaden mot balansekontoen (fakturaen føres mot den når den kommer) | 2960 |
| Uopptjent inntekt | årsabonnement fakturert på forskudd | inntekten fra balansekontoen | 2970 |
| Opptjent, ikke fakturert inntekt | arbeid som faktureres senere | inntekten mot balansekontoen (fakturaen føres mot den) | 1530 |

- Et forskudd har en **start** som fører beløpet til balansekontoen: bokføre fakturaen her (fra
  leverandørgjeld, kundefordringer eller bank, med inngående eller utgående mva), flytte beløpet
  fra resultatkontoen (fakturaen er ført der), eller ingen (beløpet er alt ført på
  balansekontoen). Månedene bokføres først når starten er bokført; starten kan også bokføres
  senere fra periodiseringen.
- Endres antallet måneder, fordeles det som står igjen på månedene som er igjen. Når noe er
  bokført, kan beløpet, den første måneden, kontoene og starten ikke endres (reverser bilagene
  først), og antallet måneder ikke bli færre enn det som er bokført. En periodisering uten
  bokføringer kan slettes.
- Bilagene reverseres det siste først (starten når ingen måned er bokført). Et bilag fra
  månedsavslutningen har månedens del for alle periodiseringene, og reverseres for alle.

## Månedsavslutningen

Avskrivningene og periodiseringene som ikke er bokført til og med en måned, bokføres samlet: et
bilag per måned for avskrivningene (serie A) og et for periodiseringene (serie P), datert den siste
dagen i måneden. Kortet står under Bilag, Anleggsmidler og Periodiseringer, og viser månedene som er
over og ikke bokført; denne måneden kan bokføres når den er over (eller før).

## Saldoavskrivningene (skattemessig)

Regnet fra registeret år for år (skatteloven kapittel 14), som grunnlag for saldoskjemaet i
næringsspesifikasjonen (rapporten «Saldoskjema» under Rapporter → Regnskap):

| Gruppe | Driftsmidler | Høyeste sats | Saldo |
|---|---|:-:|---|
| a | Kontormaskiner o.l. | 30 % | samlet |
| b | Ervervet forretningsverdi (goodwill) | 20 % | for hver |
| c | Vogntog, lastebiler, busser, varebiler, drosjebiler o.l. | 24 % | samlet |
| d | Personbiler, traktorer, maskiner, redskap, instrumenter, inventar o.l. | 20 % | samlet |
| e | Skip, fartøyer, rigger o.l. | 14 % | for hver |
| f | Fly og helikoptre | 12 % | for hver |
| g | Anlegg for overføring og distribusjon av elektrisk kraft o.l. | 5 % | for hver |
| h | Bygg og anlegg, hoteller, losjihus, bevertningssteder o.l. (kort brukstid: inntil 10 %) | 4 % | for hver |
| i | Forretningsbygg | 2 % | for hver |
| j | Fast teknisk installasjon i bygninger | 10 % | for hver |

- Det som anskaffes i året, avskrives med full sats; vederlaget for det som selges, trekkes fra
  samlesaldoen. Er grunnlaget under 15 000 kr (a, c, d og j), fradragsføres alt. En negativ
  samlesaldo inntektsføres med satsen (alt under 15 000 kr).
- Driftsmidler med egen saldo (goodwill og e–j): ved salg eller utrangering går forskjellen
  mellom vederlaget og saldoen til gevinst- og tapskontoen, der minst 20 % av en positiv saldo
  inntektsføres hvert år (og 20 % av en negativ fradragsføres; alt under 15 000 kr).
- Immaterielle rettigheter som taper seg i verdi, avskrives lineært; tomt avskrives ikke.
- Satsen kan settes lavere for et år og en gruppe, og for et driftsmiddel med egen saldo.
- **Startverdier**: det første året i HI4 og saldoene ved inngangen til det året fra
  skattemeldingen (samlesaldoene a, c og d og gevinst- og tapskontoen), og den skattemessige
  saldoen på hvert driftsmiddel med egen saldo som er ført før. Uten startverdier regnes saldoene
  fra registeret.
- Kolonnen «Regnskap» viser den regnskapsmessige verdien ved årsslutt, og forskjellen er den
  midlertidige forskjellen (grunnlaget for utsatt skatt).

## Rapportene

Under Rapporter → Regnskap, som tabell, CSV og PDF, og på e-post til regnskapsføreren:
Saldobalanse og Bilagsjournal (kan sendes hver måned), Hovedbok, Anleggsregister, Avskrivningsplan,
Avskrivninger og avganger (kan sendes hver måned), Saldoskjema, Periodiseringer, Leverandørgjeld
og Utgifter (kan sendes hver måned).

## Kontroller og det som ikke er med ennå

- Satsene, grensen på 15 000 kr, reglene for gevinst- og tapskontoen og behandlingen ved salg er
  lagt inn etter skatteloven slik den var kjent da modulen ble laget; kontroller dem mot
  Skatteetatens veiledning og skattemeldingen hvert år. Mva-justering for kapitalvarer
  (merverdiavgiftsloven kapittel 9) regnes ikke ut.
- Purregebyret føres på 3900 (annen driftsrelatert inntekt) uten avgift, når det er betalt; kontoen
  kan endres. Salg til utlandet (utførsel, kode 52) og omvendt avgiftsplikt (kode 51) skilles ikke
  ut: salg uten avgift er enten utenfor loven eller fritatt for hele organisasjonen. Tap på
  fordringer føres med et manuelt bilag (7830 mot 1500, og den utgående avgiften tilbake).
- Utgiftene: mva på personbil (kjøp, leie og drift) gir ikke fradrag; appen minner om det, men
  fradraget settes til 0 på linja. Fakturaer i annen valuta må skrives om til kroner (det som ble
  betalt). Innførsel av varer (kode 14, 15 og 81–85), omvendt avgiftsplikt innenlands og den
  særskilte meldingen for den som ikke er mva-registrert og kjøper tjenester fra utlandet, er ikke
  med. Betalingen bokføres når den registreres; banktransaksjonene matcher den av seg selv senere.
- Perioder låses ikke: et bilag kan føres med en dato i en periode som er rapportert. Årsoppgjøret
  (resultatet mot egenkapitalen, skatt) føres med et manuelt bilag.

## Kilder

- Skatteetaten, standard mva-koder for SAF-T (Standard Tax Codes) og standard kontoplan (General
  Ledger Standard Accounts, 4 siffer): <https://github.com/Skatteetaten/saf-t> (mappene «Standard
  Tax Codes» og «General Ledger Standard Accounts»)
- Skatteloven § 14-40 (aktivering av driftsmidler med kostpris fra 30 000 kr og brukstid på minst tre
  år): <https://lovdata.no/lov/1999-03-26-14/§14-40>
- Merverdiavgiftsloven § 3-30 (tjenester kjøpt fra utlandet), § 8-1 og § 8-2 (fradrag og
  forholdsmessig fradrag), § 8-3 (representasjon) og § 8-4 (personkjøretøy):
  <https://lovdata.no/lov/2009-06-19-58>

- Regnskapsloven § 4-1 (grunnleggende regnskapsprinsipper: opptjening og sammenstilling, grunnlaget
  for periodiseringene): <https://lovdata.no/lov/1998-07-17-56/§4-1>
- Bokføringsloven § 5 (spesifikasjoner av pliktig regnskapsrapportering: bokføringsspesifikasjon
  og kontospesifikasjon, her bilagsjournalen og hovedboken) og § 13 (oppbevaring):
  <https://lovdata.no/lov/2004-11-19-73/§5>
- Regnskapsloven § 5-3 (avskrivning og nedskrivning av anleggsmidler):
  <https://lovdata.no/lov/1998-07-17-56/§5-3>
- Skatteloven kapittel 14 (saldoavskrivning, §§ 14-40 til 14-48, og gevinst- og tapskonto):
  <https://lovdata.no/lov/1999-03-26-14/§14-43>
- Skatteetaten, saldoavskrivning: <https://www.skatteetaten.no/bedrift-og-organisasjon/drift/naringsspesifikasjon/>
