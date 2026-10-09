# HI4 Faktura – faste regler for utviklingen

- Språk: appen, kommentarene i koden, dokumentasjonen og commit-meldingene er på norsk (bokmål).
- Rapporter: plattformen har én felles rapportmodul (Rapporter) med en del per modul (Faktura,
  Personal, Lønn …). Nye moduler skal, der det er mulig, komme med en rapportdel som legges inn
  i rapportmodulen, med eksport og utsending til regnskapsfører som de andre rapportene.
  Slik: lag rapportene som `Rapportdef` (id `modul.navn`, funksjonen og tilgangen de krever,
  valget periode/termin/år/ingen, `maanedlig` for dem regnskapsføreren kan få hver måned) i en
  egen fil, legg dem i `RAPPORTER` og modulen i `MODULER` i `server/src/rapportmodul.ts`, og
  test dem i `server/test/rapportmodul.test.ts`. Visningen, CSV, PDF og utsendingen er felles.
- Hemmeligheter: be aldri brukeren lime inn tokens, nøkler eller passord i chatten. De legges inn
  i Secret Manager fra Cloud Shell (`read -s … | gcloud secrets versions add …`) eller i felt i
  appens innstillinger.
- Plattformadministratorer bestemmes bare av GitHub-variabelen `ADMIN_EPOSTER`, som brukeren
  setter selv.
- Bank (PSD2): bakgrunnsjobber sender aldri PSU-hoder til banken; de sendes bare når brukeren
  faktisk er til stede.
