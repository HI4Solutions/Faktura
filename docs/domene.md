# Domenet: adminkonsoll.no

Admin Konsoll (tidligere HI4 Faktura) ligger på `adminkonsoll.no`. Det gamle domenet
`faktura.hi4.no` er fjernet fra løsningen og kan brukes til noe annet.

Nettstedet (landingssiden og de juridiske sidene i `landingsside/`) ligger på `adminkonsoll.no`, med
appen under `adminkonsoll.no/app`, og appen har sitt eget domene, `app.adminkonsoll.no`. Flyttingen
skjedde i to steg, se [Nettstedet og appen](#nettstedet-og-appen).

## Slik henger det sammen

Domenene står i Terraform (`infra/terraform/variables.tf`):

| Variabel | Hva | I Cloud Run | Nå |
|---|---|---|---|
| `app_domain` | Hoveddomenet. Lenkene i e-post og varsler peker hit, og Altinn-forespørslene (som lages i bakgrunnen) sender brukeren hit. | `APP_URL` | `app.adminkonsoll.no` (steg 1: `adminkonsoll.no`) |
| `app_domains` | Andre domener den samme appen svarer på fullt ut (brukes under en flytting). | `ANDRE_APP_URLER` | – (steg 1: `app.adminkonsoll.no`) |
| `nettsted_domene` | Nettstedet (`landingsside/`), med appen under `/app` ved siden av (steg 2). Passkeys hører til dette domenet når appen ligger på et underdomene av det. | `NETTSTED_URL` | `adminkonsoll.no` |
| `gamle_domener` | Domener appen er flyttet fra. De virker fortsatt, men appen viser «Admin Konsoll har ny adresse». | `GAMLE_APP_URLER` | – |
| `domene_omdirigeringer` | Domener som bare sender videre (301, samme sti). | – | `www.adminkonsoll.no` → `adminkonsoll.no` |

Firebase Hosting har to sider i prosjektet: standardsiden (`hi4-faktura-prod`) med nettstedet og
appens egen side (`hi4-faktura-prod-app`). `nettsted_domene` ligger på standardsiden og appens domener
på appens side (`infra/terraform/auth_hosting.tf`); et domene flyttes aldri mellom sidene. Alle
domenene, også nettstedets (der appen ligger under `/app`), er autoriserte domener i Identity Platform
og godkjente henvisere for nøkkelen til Google Picker. Output `dns_for_domener` i loggen fra Infrastruktur-jobben viser DNS-oppføringene Firebase
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

Tilbakeadressene følger domenet brukeren er på i appen. Appen svarer på både `adminkonsoll.no` og
`app.adminkonsoll.no`, i steg 1 som appen alene og i steg 2 under `/app` ved siden av nettstedet, så
begge må stå der det står en liste. Stien er den samme på begge (nettstedet åpner appen for adresser
det ikke har selv, så `/bank/tilbake` blir `/app/bank/tilbake`). På testflaten gjelder det samme for
`test.adminkonsoll.no` og `app.test.adminkonsoll.no`.

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
databehandleravtalen, underleverandørene og informasjonskapslene) ligger på `adminkonsoll.no`,
med appen under `adminkonsoll.no/app` ved siden av, og appen har også sitt eget domene,
`app.adminkonsoll.no`. Rull ut publiserer begge (`scripts/publiser-hosting.sh`):

| | Standardsiden (`<prosjekt>`) | Appens side (`<prosjekt>-app`) |
|---|---|---|
| Steg 1: appen på begge domenene | Appen, med de juridiske sidene ved siden av (`/vilkar.html` osv.). Nettstedet ligger i forhåndsvisningskanalen «nettsted»; adressen står i loggen fra Rull ut. | Appen |
| Steg 2: nettstedet på `adminkonsoll.no` | Nettstedet, med appen under `/app` | Appen |

I steg 2 åpner «Logg inn» og «Opprett konto» appen under `/app` på samme domene som nettstedet. Den som
har lagt nettstedet på Hjem-skjermen, logger dermed inn og bruker appen inne i snarveien (et annet
domene åpner iPhone som en ny side oppå snarveien), og er man logget inn, går snarveien rett til
appen ([landingsside/README.md](../landingsside/README.md), «Hjem-skjermen»). Alt nettstedet ikke har
selv, åpner appen der: gamle bokmerker, lenker i e-post fra før flyttingen og tilbakeadressene fra
banken, Google og Altinn (`/bank/tilbake` blir `/app/bank/tilbake`, `web/src/appsti.ts`). API-kallene
(`/api/...`) svarer på begge domenene. Forhåndsvisningen av nettstedet i steg 1 har ikke appen; der
sender API-et GET-forespørsler nettstedet ikke har, til appens hoveddomene med samme sti og spørring
(301). `www.adminkonsoll.no` sender fortsatt til `adminkonsoll.no`.

Passkeys hører til `adminkonsoll.no` også når appen ligger på `app.adminkonsoll.no`
(`passkeyDomene` i `server/src/passkey.ts`), så de virker på begge domenene. Innloggingen i
nettleseren gjelder ett domene om gangen: på `app.adminkonsoll.no` logger brukeren inn for seg, og
installerer appen, varslene og applåsen der for seg. På `adminkonsoll.no` beholder brukeren alt etter
steg 2, for appen under `/app` er på samme domene: innloggingen, service workeren (`sw.js`, med
`/app/index.html` som skall) og varslene, og snarveien fra steg 1 åpner forsiden, eller appen når man
er logget inn.

**Steg 1** (`app_domains = ["app.adminkonsoll.no"]` i `infra/terraform/miljo/produksjon.tfvars`):

1. Infrastruktur lager appens side og domenet `app.adminkonsoll.no` på den, og setter `NETTSTED_URL`.
2. Legg inn DNS-oppføringen for `app` fra `dns_for_domener` hos domeneleverandøren, og vent til
   `domenestatus` viser `HOST_ACTIVE` og `CERT_ACTIVE` for `app.adminkonsoll.no`.
3. Legg til `app.adminkonsoll.no`-adressene hos tjenestene (over).
4. Rull ut: appen publiseres på begge sidene, og nettstedet til forhåndsvisning. Se over nettstedet
   der, og prøv appen på `https://app.adminkonsoll.no`.

**Steg 2**, når steg 1 virker: sett `app_domain = "app.adminkonsoll.no"` og `app_domains = []` i
`produksjon.tfvars`, og kjør Infrastruktur og Rull ut. Nå får standardsiden nettstedet med appen under
`/app`, lenkene i e-post og varsler peker til `app.adminkonsoll.no`, og den som åpner
`adminkonsoll.no/<noe>`, får appen der (`/app/<noe>`). Trykk «Oppdater i Altinn» under Plattform →
Drift, så Altinn har tilbakeadressene på begge domenene. Adressene på `adminkonsoll.no` hos Google og
bankene skal stå: appen under `/app` bruker dem.

Produksjon og testflaten har tatt begge stegene (`miljo/produksjon.tfvars` og `miljo/test.tfvars`).
I produksjon ligger nettstedet på `adminkonsoll.no`, med appen under `adminkonsoll.no/app`, og appen på
`app.adminkonsoll.no`; på testflaten er det `test.adminkonsoll.no` og `app.test.adminkonsoll.no`.
Nettstedet på testflaten har `X-Robots-Tag: noindex`, så det ikke havner i søkemotorene.

Etter steg 2 i produksjon (din del, når Infrastruktur og Rull ut har gått gjennom):

- Trykk «Oppdater i Altinn» under Plattform → Drift på `app.adminkonsoll.no`.
- Sjekk at adressene for `app.adminkonsoll.no` står hos Google og i bankappen til hver organisasjon
  ([Tilbakeadressene hos tjenestene](#tilbakeadressene-hos-tjenestene)); de skulle vært lagt inn i
  steg 1.
- Lenkene i e-post og varsler går nå til `app.adminkonsoll.no`, der brukerne logger inn for seg. På
  `adminkonsoll.no` beholder de innloggingen, for appen ligger under `/app` der.

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
