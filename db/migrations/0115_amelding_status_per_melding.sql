-- Svaret fra Skatteetaten gjelder hele måneden: hver melding for måneden står med sin egen
-- mottakstatus (mottak[].mottattLeveranse[] med meldingsId). Appen tok «avvist» fra en annen melding
-- samme måned, så meldinger som var mottatt, sto som avvist (og den neste meldingen erstattet dem
-- ikke). Har det lagrede svaret listen over meldingene, men ikke samme status for meldingen selv,
-- sjekkes den på nytt: hjerteslaget i workeren henter svaret igjen og leser statusen for
-- meldingsId-en (ameldingInnsending.ts).
with lev as (
  select a.id, l
    from faktura.ameldinger a
   cross join lateral jsonb_array_elements(
           case when jsonb_typeof(a.tilbakemelding -> 'data' -> 'mottak') = 'array' then a.tilbakemelding -> 'data' -> 'mottak' else '[]'::jsonb end) mo
   cross join lateral jsonb_array_elements(
           case when jsonb_typeof(mo -> 'mottattLeveranse') = 'array' then mo -> 'mottattLeveranse' else '[]'::jsonb end) l
)
update faktura.ameldinger a
   set status = 'sendt', sjekket = null
 where a.innsending = 'api'
   and a.status in ('mottatt', 'avvist')
   and a.sendt_at > now() - interval '7 days'
   and exists (select 1 from lev where lev.id = a.id)
   and not exists (select 1 from lev where lev.id = a.id and lev.l ->> 'meldingsId' = a.meldings_id and lower(lev.l ->> 'mottakstatus') = a.status);
