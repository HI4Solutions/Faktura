# Testflaten (docs/miljoer.md): prosjektet hi4-faktura-test på test.adminkonsoll.no, med
# testbedriftene og testmiljøene til Skatteetaten, Altinn og NAV. Det som ikke står her, er som i
# variables.tf eller kommer fra variablene i miljøet «test» i GitHub.
app_domain            = "test.adminkonsoll.no"
nettsted_domene       = "test.adminkonsoll.no"
domene_omdirigeringer = {}

# Som i produksjon, og først, som en prøve (docs/domene.md, «Nettstedet og appen»): appen flytter
# til app.test.adminkonsoll.no, og nettstedet tar over test.adminkonsoll.no. Steg 1: appen svarer
# også på app.test.adminkonsoll.no. Steg 2, når det har sertifikat:
# app_domain = "app.test.adminkonsoll.no" og app_domains = [].
app_domains = ["app.test.adminkonsoll.no"]

# Testflaten bruker alltid testmiljøene, uansett hva produksjon er satt til.
skatteetaten_miljo = "test"

# Minste database som holder (50 tilkoblinger), og PDF-ene kan slettes etter en dag.
db_tier                = "db-g1-small"
faktura_retention_days = 1

# Google Disk er ikke satt opp på testflaten.
google_oauth_client_id = ""
