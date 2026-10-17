# Domenet: adminkonsoll.no

Admin Konsoll (tidligere HI4 Faktura) ligger på `adminkonsoll.no`. Det gamle domenet
`faktura.hi4.no` er fjernet fra løsningen og kan brukes til noe annet.

Nettstedet (landingssiden og de juridiske sidene i `landingsside/`) tar over `adminkonsoll.no`, og
appen flytter til `app.adminkonsoll.no`. Det skjer i to steg, se [Nettstedet og
appen](#nettstedet-og-appen).

## Slik henger det sammen

Domenene står i Terraform (`infra/terraform/variables.tf`):

| Variabel | Hva | I Cloud Run | Nå |
|---|---|---|---|
| `app_domain` | Hoveddomenet. Lenkene i e-post og varsler peker hit, og Altinn-forespørslene (som lages i bakgrunnen) sender brukeren hit. | `APP_URL` | `adminkonsoll.no` (steg 2: `app.adminkonsoll.no`) |
| `app_domains` | Andre domener den samme appen svarer på fullt ut (brukes under en flytting). | `ANDRE_APP_URLER` | `app.adminkonsoll.no` (steg 2: –) |
| `nettsted_domene` | Nettstedet (`landingsside/`). Passkeys hører til dette domenet når appen ligger på et underdomene av det. | `NETTSTED_URL` | `adminkonsoll.no` |
| `gamle_domener` | Domener appen er flyttet fra. De virker fortsatt, men appen viser «Admin Konsoll har ny adresse». | `GAMLE_APP_URLER` | – |
| `domene_omdirigeringer` | Domener som bare sender videre (301, samme sti). | – | `www.adminkonsoll.no` → `adminkonsoll.no` |

Firebase Hosting har to sider i prosjektet: standardsiden (`hi4-faktura-prod`) med nettstedet og
appens egen side (`hi4-faktura-prod-app`). `nettsted_domene` ligger på standardsiden og appens domener
på appens side (`infra/terraform/auth_hosting.tf`); et domene flyttes aldri mellom sidene. Alle
domenene er autoriserte domener i Identity Platform og godkjente henvisere for nøkkelen til Google
Picker. Output `dns_for_domener` i loggen fra Infrastruktur-jobben viser DNS-oppføringene Firebase
vil ha, `domenestatus` om domenet peker riktig (`HOST_ACTIVE`), er bekreftet (`OWNERSHIP_ACTIVE`) og
har sertifikat (`CERT_ACTIVE`), og `hosting_sider` hvilken side hvert domene ligger på.

## DNS for adminkonsoll.no

| Navn | Type | Verdi |
|---|---|---|
| `@` | A | `199.36.158.100` |
| `@` | TXT | `hosting-site=hi4-faktura-prod` |
| `www` | CNAME | `hi4-faktura-prod.web.app` |
| `app` | CNAME | `hi4-faktura-prod-app.web.app` (sjekk mot `dns_for_domener`) |

Leverandørens egne A-oppføringer (standardsiden) er slått av. MX-oppføringen gjelder e-post til
domenet og skal stå.

### E-post fra domenet (SPF, DKIM og DMARC)

E-posten fra appen sendes fra `post@adminkonsoll.no` gjennom Resend. Oppføringene Resend viser
under Domains → `adminkonsoll.no` (DKIM-nøkkelen `resend._domainkey`, og MX og SPF for
underdomenet `send`) skal stå; det er dem som gjør domenet verifisert. I tillegg har domenet en
DMARC-oppføring, så mottakerne (Gmail, Outlook og andre) vet hvordan e-post fra domenet skal
kontrolleres, og Gmail og Yahoo krever den av avsendere som sender mye:

| Navn | Type | Verdi |
|---|---|---|
| `_dmarc` | TXT | `v=DMARC1; p=none; rua=mailto:post@adminkonsoll.no; adkim=r; aspf=r` |

E-post fra Resend består kontrollen: DKIM-signaturen gjelder `adminkonsoll.no`, og returadressen
(Return-Path) er på `send.adminkonsoll.no`, som regnes som samme domene med `aspf=r`. Med `p=none`
stoppes ingenting ennå; mottakerne sender bare daglige rapporter (XML) til adressen i `rua`, som må
kunne ta imot e-post. Sjekk oppføringen i Cloud Shell med `dig +short TXT _dmarc.adminkonsoll.no`.

Når rapportene i et par uker viser at all e-post fra domenet består, skjerpes regelen til
`p=quarantine` (e-post som ikke består, havner i søppelposten) og senere `p=reject` (den avvises).
Det gjelder også e-post som sendes fra en vanlig e-postkonto på domenet: den må ha SPF og DKIM hos
e-postleverandøren, ellers havner den i søppelposten når regelen skjerpes. Reserveadressen
`faktura@hi4.no` hører til domenet `hi4.no` og berøres ikke.

## Tilbakeadressene hos tjenestene

Tilbakeadressene følger domenet brukeren er på i appen. Mens appen svarer på både `adminkonsoll.no` og
`app.adminkonsoll.no` (steg 1), må begge stå der det står en liste.

- **Google OAuth-klienten** (Google Disk, `GOOGLE_OAUTH_CLIENT_ID`), i Google Cloud Console under
  APIs & Services → Credentials: `https://adminkonsoll.no` og `https://app.adminkonsoll.no` under
  «Authorized JavaScript origins» (mappevalget), og `https://adminkonsoll.no/api/offentlig/google/callback`
  og `https://app.adminkonsoll.no/api/offentlig/google/callback` under «Authorized redirect URIs».
- **Enable Banking** (hver organisasjon har sin egen applikasjon): «Allowed redirect URL»
  `https://adminkonsoll.no/bank/tilbake` og `https://app.adminkonsoll.no/bank/tilbake`. Mangler den,
  sier appen fra med adressen når banken kobles til eller tilgangen fornyes.
- **Altinn** (systemregisteret, når skattekortene er satt opp): trykk «Oppdater i Altinn» under
  Plattform → Drift, så systemet har tilbakeadressen på domenet.
- **Resend:** webhooken for e-postsporingen peker til `https://adminkonsoll.no/api/offentlig/resend`
  (hendelsene `email.delivered`, `email.delivery_delayed`, `email.bounced` og `email.complained`),
  og signeringsnøkkelen dens ligger i Secret Manager som `resend-webhook-secret`. Den kan stå på
  `adminkonsoll.no` også etter steg 2 (under): nettstedet sender `/api/...` videre til API-et. API-et leser den
  når det starter, så etter en ny nøkkel må det rulles ut på nytt (Utrulling → Run workflow).
  E-posten sendes fra `post@adminkonsoll.no` (`epost_avsender`), og domenet må være verifisert i
  samme Resend-konto som API-nøkkelen hører til. Sier Resend at det ikke er det, sendes e-posten fra
  reserveadressen `faktura@hi4.no` i stedet (`EPOST_AVSENDER_RESERVE`), og loggen får en advarsel.

## Nettstedet og appen

Nettstedet i `landingsside/` (landingssiden, personvernerklæringen, bruksvilkårene,
databehandleravtalen, underleverandørene og informasjonskapslene) skal ligge på `adminkonsoll.no`,
og appen på `app.adminkonsoll.no`. Rull ut publiserer begge (`scripts/publiser-hosting.sh`):

| | Standardsiden (`<prosjekt>`) | Appens side (`<prosjekt>-app`) |
|---|---|---|
| Steg 1: appen på begge domenene | Appen, med de juridiske sidene ved siden av (`/vilkar.html` osv.). Nettstedet ligger i forhåndsvisningskanalen «nettsted»; adressen står i loggen fra Rull ut. | Appen |
| Steg 2: appen bare på `app.` | Nettstedet | Appen |

Nettstedet sender alt det ikke har selv, videre til API-et, og API-et sender GET-forespørsler som
ikke er `/api/...` til appens hoveddomene med samme sti og spørring (301). Gamle bokmerker, lenker i
e-post som er sendt før flyttingen og tilbakeadresser som fortsatt står på `adminkonsoll.no` (banken,
Google og Altinn), havner dermed i appen. API-kallene (`/api/...`) svarer på begge domenene, så en
appversjon som ikke er oppdatert ennå, virker til den er det. `www.adminkonsoll.no` sender fortsatt
til `adminkonsoll.no`.

Passkeys hører til `adminkonsoll.no` også når appen ligger på `app.adminkonsoll.no`
(`passkeyDomene` i `server/src/passkey.ts`), så de som er laget før flyttingen, virker etterpå. Det
gjør ikke innloggingen i nettleseren: på `app.adminkonsoll.no` logger brukeren inn på nytt, installerer
appen på nytt fra den adressen og slår på varsler og applås igjen. Nettstedet har en `sw.js` som
fjerner den gamle appens service worker og hurtigbuffer hos dem som hadde appen på `adminkonsoll.no`.

**Steg 1** (`app_domains = ["app.adminkonsoll.no"]` i `infra/terraform/miljo/produksjon.tfvars`):

1. Infrastruktur lager appens side og domenet `app.adminkonsoll.no` på den, og setter `NETTSTED_URL`.
2. Legg inn DNS-oppføringen for `app` fra `dns_for_domener` hos domeneleverandøren, og vent til
   `domenestatus` viser `HOST_ACTIVE` og `CERT_ACTIVE` for `app.adminkonsoll.no`.
3. Legg til `app.adminkonsoll.no`-adressene hos tjenestene (over).
4. Rull ut: appen publiseres på begge sidene, og nettstedet til forhåndsvisning. Se over nettstedet
   der, og prøv appen på `https://app.adminkonsoll.no`.

**Steg 2**, når steg 1 virker: sett `app_domain = "app.adminkonsoll.no"` og `app_domains = []` i
`produksjon.tfvars`, og kjør Infrastruktur og Rull ut. Nå får standardsiden nettstedet, lenkene i e-post
og varsler peker til `app.adminkonsoll.no`, og den som åpner `adminkonsoll.no/<noe>`, sendes til
appen. Trykk «Oppdater i Altinn» under Plattform → Drift, så Altinn har den nye tilbakeadressen.
Adressene på `adminkonsoll.no` hos Google og bankene kan fjernes når ingen bruker dem lenger.

Testflaten gjør det samme med `test.adminkonsoll.no` (nettstedet) og `app.test.adminkonsoll.no`
(appen), i `miljo/test.tfvars`, og bør gå først. Nettstedet der har `X-Robots-Tag: noindex`, så det
ikke havner i søkemotorene.

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
