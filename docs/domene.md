# Domenet: adminkonsoll.no

Admin Konsoll (tidligere HI4 Faktura) ligger på `adminkonsoll.no`. Det gamle domenet
`faktura.hi4.no` er fjernet fra løsningen og kan brukes til noe annet.

## Slik henger det sammen

Domenene står i Terraform (`infra/terraform/variables.tf`):

| Variabel | Hva | I Cloud Run | Nå |
|---|---|---|---|
| `app_domain` | Hoveddomenet. Lenkene i e-post og varsler peker hit, og Altinn-forespørslene (som lages i bakgrunnen) sender brukeren hit. | `APP_URL` | `adminkonsoll.no` |
| `app_domains` | Andre domener den samme appen svarer på fullt ut (brukes under en flytting). | `ANDRE_APP_URLER` | – |
| `gamle_domener` | Domener appen er flyttet fra. De virker fortsatt, men appen viser «Admin Konsoll har ny adresse». | `GAMLE_APP_URLER` | – |
| `domene_omdirigeringer` | Domener som bare sender videre (301, samme sti). | – | `www.adminkonsoll.no` → `adminkonsoll.no` |

Alle domenene er egne domener i Firebase Hosting (samme nettsted), autoriserte domener i Identity
Platform og godkjente henvisere for nøkkelen til Google Picker. Output `dns_for_domener` i loggen
fra Infrastruktur-jobben viser DNS-oppføringene Firebase vil ha, og `domenestatus` om domenet peker
riktig (`HOST_ACTIVE`), er bekreftet (`OWNERSHIP_ACTIVE`) og har sertifikat (`CERT_ACTIVE`).

## DNS for adminkonsoll.no

| Navn | Type | Verdi |
|---|---|---|
| `@` | A | `199.36.158.100` |
| `@` | TXT | `hosting-site=hi4-faktura-prod` |
| `www` | CNAME | `hi4-faktura-prod.web.app` |

Leverandørens egne A-oppføringer (standardsiden) er slått av. MX-oppføringen gjelder e-post til
domenet og skal stå.

## Tilbakeadressene hos tjenestene

- **Google OAuth-klienten** (Google Disk, `GOOGLE_OAUTH_CLIENT_ID`), i Google Cloud Console under
  APIs & Services → Credentials: `https://adminkonsoll.no` under «Authorized JavaScript origins»
  (mappevalget) og `https://adminkonsoll.no/api/offentlig/google/callback` under «Authorized
  redirect URIs».
- **Enable Banking** (hver organisasjon har sin egen applikasjon): «Allowed redirect URL»
  `https://adminkonsoll.no/bank/tilbake`. Mangler den, sier appen fra med adressen når banken
  kobles til eller tilgangen fornyes.
- **Altinn** (systemregisteret, når skattekortene er satt opp): trykk «Oppdater i Altinn» under
  Plattform → Drift, så systemet har tilbakeadressen på domenet.
- **Resend:** webhooken for e-postsporingen peker til `https://adminkonsoll.no/api/offentlig/resend`
  (hendelsene `email.delivered`, `email.delivery_delayed`, `email.bounced` og `email.complained`),
  og signeringsnøkkelen dens ligger i Secret Manager som `resend-webhook-secret`. API-et leser den
  når det starter, så etter en ny nøkkel må det rulles ut på nytt (Utrulling → Run workflow).
  E-posten sendes fra `post@adminkonsoll.no` (`epost_avsender`), og domenet må være verifisert i
  samme Resend-konto som API-nøkkelen hører til. Sier Resend at det ikke er det, sendes e-posten fra
  reserveadressen `faktura@hi4.no` i stedet (`EPOST_AVSENDER_RESERVE`), og loggen får en advarsel.

## Et nytt domene senere

Appen kan svare på flere domener samtidig, så en flytting kan skje uten at noen mister tilgangen:

1. Legg det nye domenet i `app_domains`, legg inn DNS-oppføringene og tilbakeadressene, og vent til
   sertifikatet er klart.
2. Gjør det nye til `app_domain`, og flytt det gamle til `gamle_domener` (meldingen om ny adresse).
3. Fjern det gamle, eller la det sende videre med `domene_omdirigeringer`.

Innloggingen i nettleseren gjelder ett domene om gangen. Det brukeren gjør der, følger adressen
brukeren er på (`server/src/appadresse.ts`): passkeys, BankID-en for banken og Google Disk sender
brukeren tilbake dit brukeren startet. En passkey virker bare på domenet den er laget på; den husker
domenet sitt (`passkeys.rp_id`), og appen viser hvor den virker. På et nytt domene må brukeren logge
inn på nytt, legge til passkey, installere appen på nytt og slå på varsler og applås igjen.

Interne navn (prosjektet `hi4-faktura-prod`, tjenestene `faktura-api` og `faktura-worker`,
bøttene og databasen) beholdes; de vises ikke for brukerne.
