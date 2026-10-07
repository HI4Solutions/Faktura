-- 0034_ehf_sjekk_pa_nytt.sql
-- EHF-oppslaget kunne svare «ikke registrert» også for mottakere som tar imot EHF (rettet i
-- peppol.ts). Kundene med det svaret sjekkes på nytt: workeren tar dem først i neste daglige
-- kjøring, og «Sjekk nå» på kunden gjør det med en gang. Svaret står til kunden er sjekket.
-- (Bare ehf_sjekket endres, så revisjonsloggen får ingen nye rader.)
update faktura.kunder set ehf_sjekket = null where ehf is false;
