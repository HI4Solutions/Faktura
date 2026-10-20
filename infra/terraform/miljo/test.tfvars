# Testflaten (docs/miljoer.md): prosjektet hi4-faktura-test, med appen på app.test.adminkonsoll.no og
# nettstedet på test.adminkonsoll.no, og med testbedriftene og testmiljøene til Skatteetaten, Altinn
# og NAV. Det som ikke står her, er som i variables.tf eller kommer fra variablene i miljøet «test» i
# GitHub.
app_domain            = "app.test.adminkonsoll.no"
nettsted_domene       = "test.adminkonsoll.no"
domene_omdirigeringer = {}

# Begge stegene er tatt her, før produksjon (docs/domene.md, «Nettstedet og appen»): appen har
# flyttet til app.test.adminkonsoll.no, og nettstedet har tatt over test.adminkonsoll.no.
app_domains = []

# Testflaten bruker alltid testmiljøene, uansett hva produksjon er satt til.
skatteetaten_miljo = "test"

# Mva-meldingen sendes fra appen (docs/mva-innsending.md), med ID-porten og Altinn i testmiljøene.
# Den vises når ID-porten-klienten er satt opp (IDPORTEN_KLIENT_ID i miljøet «test» i GitHub).
mva_innsending = true

# Trekkpålegg fra Skatteetaten (docs/trekkpaalegg.md): Skatteetaten har gitt scopet
# skatteetaten:trekkpaalegg i testmiljøet (20.10.2026).
trekkpaalegg = true

# Minste database som holder (50 tilkoblinger), og PDF-ene kan slettes etter en dag.
db_tier                = "db-g1-small"
faktura_retention_days = 1

# Google Disk er ikke satt opp på testflaten.
google_oauth_client_id = ""
