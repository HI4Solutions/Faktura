# Produksjon (docs/miljoer.md): prosjektet hi4-faktura-prod på adminkonsoll.no. Det som ikke står
# her, er standardverdiene i variables.tf og variablene i repoet i GitHub.

# Appen har flyttet til app.adminkonsoll.no, og nettstedet har tatt over adminkonsoll.no, med appen
# under adminkonsoll.no/app (docs/domene.md, «Nettstedet og appen», steg 2; steg 1 var
# app_domains = ["app.adminkonsoll.no"]).
app_domain  = "app.adminkonsoll.no"
app_domains = []

# Regnskap er ikke klart for kundene ennå: modulen merkes «Kommer snart» i appen og på nettstedet,
# og nye kontoer kan ikke velge den. Plattformadministratoren kan fortsatt gi den.
kommer_snart = ["regnskap"]
