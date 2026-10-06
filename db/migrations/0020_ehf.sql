-- 0020_ehf.sql
-- EHF: om kunden kan motta EHF-faktura (registrert i PEPPOL, i Norge som regel i ELMA).
-- null = ikke sjekket ennå. Sjekkes når kunden lagres, på forespørsel og jevnlig av
-- workeren (en mottaker kan bli registrert eller avregistrert når som helst).

alter table faktura.kunder
  add column ehf boolean,
  add column ehf_sjekket timestamptz;

-- API-et og workeren (som arver faktura_app) oppdaterer statusen etter oppslag.
grant update (ehf, ehf_sjekket) on faktura.kunder to faktura_app;

-- Revisjonsloggen: en ny sjekk som ikke endrer svaret, er ingen endring verdt å logge.
create or replace function faktura.revider() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ny jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  gammel jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  rad jsonb := coalesce(ny, gammel);
  endring jsonb;
begin
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_object('fra', gammel -> n.key, 'til', n.value))
      into endring
      from jsonb_each(ny) n
     where n.value is distinct from gammel -> n.key and n.key not in ('oppdatert', 'ehf_sjekket');
    if endring is null then return null; end if;
  else
    endring := rad;
  end if;
  insert into faktura.revisjonslogg (org_id, bruker_id, handling, tabell, rad_id, endring)
  values (
    case when tg_table_name = 'organisasjoner' then (rad ->> 'id')::uuid else (rad ->> 'org_id')::uuid end,
    faktura.bruker_id(),
    tg_op,
    tg_table_name,
    case when rad ? 'id' then (rad ->> 'id')::uuid end,
    -- Krypterte hemmeligheter skal aldri havne i loggen.
    endring - 'hemmelighet_kryptert'
  );
  return null;
end $$;
