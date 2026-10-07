-- 0033_verifisering_registrert_epost.sql
-- Automatisk verifisering også når brukerens bekreftede e-postadresse er nøyaktig den som står
-- på foretaket i Enhetsregisteret (også Gmail og lignende): brukeren har vist at hen eier
-- adressen, og det er like godt som å ta imot koden dit. Metoden er da brreg_epost, som for
-- koden; e-postdomenet gir fortsatt epostdomene.

drop function faktura.verifiser_epostdomene(uuid, text);

create function faktura.verifiser_epostdomene(_org uuid, _epost text, _metode text default 'epostdomene')
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  if _metode not in ('epostdomene', 'brreg_epost') then raise exception 'Ugyldig metode' using errcode = 'FA400'; end if;
  perform faktura.krev(_org, 'admin');
  insert into faktura.verifiseringer (org_id, bruker_id, metode, status, sendt_til, behandlet_at)
  values (_org, faktura.bruker_id(), _metode, 'godkjent', _epost, now());
  perform faktura.sett_verifisering(_org, 'verifisert', _metode);
end $$;

revoke all on function faktura.verifiser_epostdomene(uuid, text, text) from public;
grant execute on function faktura.verifiser_epostdomene(uuid, text, text) to faktura_app;
