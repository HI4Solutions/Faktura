# Produksjon (docs/miljoer.md): prosjektet hi4-faktura-prod på adminkonsoll.no. Det som ikke står
# her, er standardverdiene i variables.tf og variablene i repoet i GitHub.

# Appen flytter fra adminkonsoll.no til app.adminkonsoll.no, og nettstedet tar over adminkonsoll.no
# (docs/domene.md, «Nettstedet og appen»). Steg 1: appen svarer også på app.adminkonsoll.no. Steg 2,
# når app.adminkonsoll.no har sertifikat: app_domain = "app.adminkonsoll.no" og app_domains = [].
app_domains = ["app.adminkonsoll.no"]
