# Arkitektur

## Oversikt

```
 Nettapp (React)            Kundeportal            Åpent API / webhooks
 Firebase Hosting               │                         │
        │  /api/**              │                         │
        └──────────────► Cloud Run: faktura-api ◄─────────┘
                         (Identity Platform-token / API-nøkkel)
                            │        │         │
               Cloud SQL ◄──┘   Cloud Tasks   Cloud Storage (signerte URL-er)
               Postgres 16       «utsending»
               (privat IP)          │
                   ▲                ▼
                   └──── Cloud Run: faktura-worker ◄── Cloud Scheduler (gjenta, utboks, bank)
                         PDF · e-post · gjentakelser
                         utboks → Pub/Sub «hendelser» → google-disk / regnskap / webhooks
                                                         └─► dead-letter + varsel
```

| Behov | Tjeneste |
|---|---|
| Database | Cloud SQL for PostgreSQL 16, privat IP, IAM-innlogging, PITR |
| API og bakgrunnsjobber | Cloud Run (api, worker) og Cloud Run job (migrate) |
| Innlogging | Identity Platform: e-post og passord, e-postbekreftelse, TOTP-MFA |
| Filer | Cloud Storage: `fakturaer` med versjonering og oppbevaringsregel, `filer` for logo og vedlegg |
| Køer og hendelser | Cloud Tasks (utsending med gjentatte forsøk), Pub/Sub (integrasjoner). Cloud Tasks og Scheduler ligger i europe-west1, som er nærmeste region med disse tjenestene |
| Planlagte jobber | Cloud Scheduler med OIDC-token mot workeren |
| Hemmeligheter | Secret Manager. Cloud KMS krypterer OAuth- og integrasjonstokens |
| Bygg og utrulling | GitHub Actions med Workload Identity Federation, Artifact Registry, Terraform |
| Overvåking | Cloud Logging, oppetidssjekk og varsler i Cloud Monitoring |
| E-post | Resend (EU) bak et eget grensesnitt. Google har ingen transaksjonell e-posttjeneste |
| AI | Gemini på Vertex AI i EU (europe-west3, Frankfurt): fakturautkast fra tekst og tale, forslag på innbetalinger. Tjenestekontoene har `roles/aiplatform.user`, uten nøkler |

## Datamodell

Alle data hører til en organisasjon (`org_id`). Brukere er uavhengige av
organisasjoner og kobles via `medlemmer` med en rolle.

- `organisasjoner`: foretak eller regnskapsbyrå. Selgeropplysninger, kontonummer,
  standard frist og gebyr, KID, verifiseringsstatus og grenser
- `nummerserier`: neste fakturanummer og kundenummer per organisasjon, låst med radlås
- `medlemmer`, `invitasjoner`: brukere og roller
- `org_tilgang`: regnskapsbyrå ↔ klient (les eller bokfør), alltid med klientens samtykke
- `kunder`, `produkter`, `gjentakelser`
- `fakturaer`, `faktura_linjer`, `betalinger`
- `vedlegg`: filer på fakturaer (PDF, bilder, CSV og regneark, typene EHF godtar).
  Lastes opp før utkastet lagres, låses ved utstedelse, og workeren legger en kopi i
  `fakturaer`-bøtta når fakturaen sendes. Filer etter slettede vedlegg ryddes daglig
- `integrasjoner`: Google Disk, regnskapssystemer, bank, Peppol. Tokens er KMS-kryptert.
  EHF sendes gjennom organisasjonens egen konto hos Recommand (type `peppol`): API-et
  sjekker nøkkelen og krypterer hemmeligheten, bare workeren dekrypterer og sender
- `ehf_sendinger`: hver EHF-sending med status (levert, venter, feilet). Kommer den ikke
  fram, sender workeren e-post i stedet
- `banktransaksjoner`: innbetalinger lest fra organisasjonens egne bankkontoer gjennom open
  banking (Enable Banking, type `bank` i `integrasjoner`: egen applikasjon per organisasjon,
  privat nøkkel KMS-kryptert, bare workeren bruker den). Workeren henter høyst hver sjette
  time på dagtid og kobler innbetalingene til fakturaer: KID eller fakturanummer i meldingen
  registreres med en gang (`koble_banktransaksjon`), samme beløp og betaler blir forslag,
  resten uavklart. Uten KID-avtale med banken. Innbetalinger fra før startdatoen
  (`organisasjoner.bank_fra`, som standard dagen organisasjonen ble opprettet) hentes ikke,
  og `rydd_banktransaksjoner` fjerner de som er hentet (automatisk registrerte angres)
- `bankkoblinger`: én rad per bank (f.eks. DNB og Storebrand) på samme applikasjon, med egen
  BankID-innlogging, eget samtykke (økt og utløpsdato) og egen henting. Alle kontoene i økten
  lagres, men bare de som er lagt inn i HI4 Faktura (organisasjonens kontonummer og
  `kontoer`) vises og leses, hver fra sin egen dato. Appen legger til og fjerner banker;
  workeren lager BankID-adressen, fullfører økten og henter, og appen venter på svaret ved
  å spørre etter statusen
- `ai_bruk`: AI-forespørsler og tokens per organisasjon, måned og funksjon. Hver organisasjon
  har et tak per måned (`AI_GRENSE`), og en administrator kan slå AI av
  (`organisasjoner.ai_aktiv`). Fakturautkast: teksten eller lydopptaket sendes til Gemini
  sammen med kundene og produktene (med korte id-er, så modellen bare kan velge fra
  registrene), og svaret (JSON etter et fast skjema) sjekkes før skjemaet fylles ut; ingenting
  lagres. Innbetalinger reglene ikke fant noen faktura for, får et forslag fra Gemini når den
  er rimelig sikker (`foresla_banktransaksjon`); forslag registreres aldri uten at en person
  bekrefter. AI-assistenten (knappen på alle sider) tar kommandoer med tale eller tekst: Gemini
  velger handling og fyller ut feltene, serveren slår opp og svarer (betalinger, utestående),
  og alt som endrer noe (sende faktura eller utkast, registrere betaling, purre) blir forslag
  som appen utfører med de vanlige rutene når brukeren bekrefter
- `utboks`: hendelser skrevet i samme transaksjon, publisert til Pub/Sub
- `revisjonslogg`: alle endringer og regnskapsføreres oppslag

### Roller

| Handling | eier | admin | fakturerer | regnskap | les |
|---|:-:|:-:|:-:|:-:|:-:|
| Lese alt | ✓ | ✓ | ✓ | ✓ | ✓ |
| Kunder, produkter, utkast, gjentakelser | ✓ | ✓ | ✓ | | |
| Utstede, sende, kreditere | ✓ | ✓ | ✓ | | |
| Registrere betaling og refusjon | ✓ | ✓ | ✓ | ✓ | |
| Innstillinger, kontonummer, medlemmer, integrasjoner, regnskapsfører | ✓ | ✓ | | | |

En regnskapsfører med tilgangen «bokfør» får rollen `regnskap` hos klienten. Med
tilgangen «les» får regnskapsføreren rollen `les`. Tilgangen kan ha utløpsdato, og
begge parter kan trekke den.

### Sikkerhet i databasen

- API-et setter `SET LOCAL app.bruker_id` i hver transaksjon. RLS-policyene bruker
  `faktura.kan(org_id, handling)`. Appen sjekker tilgang selv i tillegg.
- Kolonnerettigheter: appen kan ikke sette status, nummer, summer, KID eller kopiene av
  selger og kunde. Det gjør bare funksjonene `utsted`, `krediter`, `registrer_betaling`
  og `registrer_refusjon`.
- En utstedt faktura, linjene og vedleggene dens er låst med triggere, også for tabelleieren.
- Workeren logger inn som medlem av `faktura_system` og ser alle organisasjoner.
- Endring av kontonummer gir hendelsen `organisasjon.kontonr_endret`. Workeren varsler
  alle eiere på e-post.

### Misbruksvern uten BankID

Nye organisasjoner har status `ny`, og grensen er 20 fakturaer og 50 000 kr per måned.
Workeren verifiserer organisasjonen med `faktura.sett_verifisering` etter én av disse
kontrollene:

1. organisasjonsnummeret slås opp i Enhetsregisteret, og foretaket er aktivt
2. e-postdomenet til brukeren samsvarer med foretakets domene, **eller**
3. en kode sendes til e-postadressen eller telefonnummeret som er registrert i
   Enhetsregisteret, **eller**
4. en kode sendes i brev, eller en administrator godkjenner manuelt.

Et organisasjonsnummer kan bare være verifisert hos én organisasjon. Andre grenser:
maks fem uverifiserte organisasjoner per bruker, reCAPTCHA Enterprise ved registrering,
og hastighetsgrenser i API-et.

## Forbedringer fra MedSide-modulen

- Delvis kreditering per linje. Originalen blir `kreditert` først når alt er kreditert.
- Inaktive kunder faktureres ikke fra gjentakelser, og gjentakelsen slås av.
- Intervallene måned, kvartal og år. Forfallsdagen holdes (31.01 → 28.02 → 31.03).
- Bankimport er idempotent: samme `ekstern_ref` registreres bare én gang.
- PDF-er bygges med flere sider (HTML → PDF i workeren).

## Veikart

1. **Grunnmur** (ferdig): skjema, RLS, regler, tester, Terraform, CI/CD
2. **Fakturering**: API, worker (PDF, e-post via Cloud Tasks), nettapp med kunder,
   produkter, utkast, utstedelse, kreditnota, betaling og refusjon
3. **Tillit**: Brønnøysund-oppslag, verifiseringsflyt, MFA påkrevd for utstedelse og
   kontonummer, reCAPTCHA, varsling ved endring av kontonummer
4. **Regnskapsfører og Google Disk**: byrå-dashboard, invitasjoner, Drive (`drive.file`)
   med kopi av PDF-er i `Fakturaer/ÅÅÅÅ/`
5. **Gjentakende fakturaer og kundeportal**
6. **Penger inn og regnskap**: bank via aggregator (KID-matching), OCR-fil, purring,
   adaptere for Fiken, Tripletex, PowerOffice Go og Visma, åpent API, webhooks, SAF-T
7. **EHF/Peppol** via aksesspunkt, betalingslenker (Vipps/Stripe Connect) og
   abonnementer for plattformens egne kunder
8. ~~**Passkeys**~~ Ferdig: WebAuthn i API-et, nøkler i Postgres, innlogging via Firebase custom token med kravet `passkey` (teller som totrinn)
