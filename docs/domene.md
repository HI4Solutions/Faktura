# Domenet: adminkonsoll.no

Admin Konsoll (tidligere HI4 Faktura) flytter fra `faktura.hi4.no` til `adminkonsoll.no`. Appen kan
svare på flere domener samtidig, så flyttingen skjer uten at noen mister tilgangen.

## Slik henger det sammen

Domenene står i Terraform (`infra/terraform/variables.tf`):

| Variabel | Hva | I Cloud Run |
|---|---|---|
| `app_domain` | Hoveddomenet. Lenkene i e-post og varsler peker hit, og Altinn-forespørslene (som lages i bakgrunnen) sender brukeren hit. | `APP_URL` |
| `app_domains` | Andre domener den samme appen svarer på fullt ut. | `ANDRE_APP_URLER` |
| `gamle_domener` | Domener appen er flyttet fra. De virker fortsatt, men appen viser «Admin Konsoll har ny adresse». | `GAMLE_APP_URLER` |
| `domene_omdirigeringer` | Domener som bare sender videre (301, samme sti), f.eks. `www.adminkonsoll.no`. | – |

Alle domenene er egne domener i Firebase Hosting (samme nettsted), autoriserte domener i Identity
Platform og godkjente henvisere for nøkkelen til Google Picker.

Innloggingen i nettleseren gjelder ett domene om gangen. Det brukeren gjør der, følger derfor
adressen brukeren er på (`server/src/appadresse.ts`): passkeys, BankID-en for banken (Enable
Banking) og Google Disk sender brukeren tilbake dit brukeren startet. En passkey virker bare på
domenet den er laget på; den husker domenet sitt (`passkeys.rp_id`), og appen viser hvor den virker.

På et nytt domene må brukeren derfor logge inn på nytt (e-post og passord, og koden fra
autentiseringsappen), legge til passkey, installere appen på nytt og slå på varsler og applås igjen.

## Flyttingen

1. **Nå:** `adminkonsoll.no` er lagt til (`app_domains`), og `www.adminkonsoll.no` sender videre.
   Hoveddomenet er fortsatt `faktura.hi4.no`.
   - Legg inn DNS-oppføringene hos domeneleverandøren. De står i loggen fra Infrastruktur-jobben
     (output `dns_for_domener`). Fjern andre A- og AAAA-oppføringer på samme navn (f.eks.
     leverandørens parkeringsside).
   - Firebase bekrefter domenet og lager sertifikat av seg selv (fra noen minutter til et døgn).
     Output `domenestatus` viser når det er klart: `HOST_ACTIVE`, `OWNERSHIP_ACTIVE` og
     `CERT_ACTIVE`.
   - Legg til tilbakeadressene for `adminkonsoll.no` hos tjenestene (under).
2. **Når adminkonsoll.no virker:** `app_domain = "adminkonsoll.no"`, `app_domains = []` og
   `gamle_domener = ["faktura.hi4.no"]`. Lenkene i e-post peker da til den nye adressen, og den
   gamle viser meldingen om ny adresse.
3. **Etter overgangen:** flytt `faktura.hi4.no` fra `gamle_domener` til `domene_omdirigeringer`
   (`"faktura.hi4.no" = "adminkonsoll.no"`). Da sender den gamle adressen videre. Bytt
   webhooken i Resend først (under), for en webhook følger ikke en videresending.

## Tilbakeadressene hos tjenestene

- **Google OAuth-klienten** (Google Disk, `GOOGLE_OAUTH_CLIENT_ID`), i Google Cloud Console under
  APIs & Services → Credentials: legg til `https://adminkonsoll.no` under «Authorized JavaScript
  origins» (mappevalget) og `https://adminkonsoll.no/api/offentlig/google/callback` under
  «Authorized redirect URIs». Behold de gamle til trinn 3.
- **Enable Banking** (hver organisasjon har sin egen applikasjon): «Allowed redirect URL»
  `https://adminkonsoll.no/bank/tilbake`, i tillegg til den gamle. Mangler den, sier appen fra med
  adressen når banken kobles til eller tilgangen fornyes.
- **Altinn** (systemregisteret): trykk «Oppdater i Altinn» under Administrasjon → Drift →
  Skattekort etter utrullingen. Da får systemet navnet «Admin Konsoll» og tilbakeadressen på alle
  domenene, så hoveddomenet kan byttes senere uten mer.
- **Resend:** webhooken for e-postsporingen bør peke til
  `https://adminkonsoll.no/api/offentlig/resend` før trinn 3. Avsenderen (`epost_avsender`,
  `faktura@hi4.no`) beholdes til et domene under `adminkonsoll.no` er verifisert i Resend.

Interne navn (prosjektet `hi4-faktura-prod`, tjenestene `faktura-api` og `faktura-worker`,
bøttene og databasen) beholdes; de vises ikke for brukerne.
