# Regnskap: anleggsmidler, avskrivninger og saldoavskrivninger

Regnskapsmodulen er HI4 Fakturas eget regnskap (ingen kobling til Tripletex, Fiken eller andre).
Første del er anleggsmidlene: anleggsregisteret med avskrivningsplanen over flere år (også
goodwill), bokføringen av avskrivninger, nedskrivning, salg og utrangering, og de skattemessige
saldoavskrivningene. Periodiseringer, manuelle bilag, hovedbok og saldobalanse kommer i neste del.

Modulen er funksjonen «Regnskap» (Administrasjon → Funksjoner) og menyen «Regnskap». Eier,
administrator og regnskapsføreren (rollen regnskap) ser og fører; fakturerer og les ser den ikke.

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

## Kontroller

Satsene, grensen på 15 000 kr, reglene for gevinst- og tapskontoen og behandlingen ved salg er lagt
inn etter skatteloven slik den var kjent da modulen ble laget; kontroller dem mot Skatteetatens
veiledning og skattemeldingen hvert år. Mva-justering for kapitalvarer (merverdiavgiftsloven
kapittel 9) regnes ikke ut.

## Kilder

- Regnskapsloven § 5-3 (avskrivning og nedskrivning av anleggsmidler):
  <https://lovdata.no/lov/1998-07-17-56/§5-3>
- Skatteloven kapittel 14 (saldoavskrivning, §§ 14-40 til 14-48, og gevinst- og tapskonto):
  <https://lovdata.no/lov/1999-03-26-14/§14-43>
- Skatteetaten, saldoavskrivning: <https://www.skatteetaten.no/bedrift-og-organisasjon/drift/naringsspesifikasjon/>
