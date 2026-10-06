-- 0005_uten_mva.sql
-- Organisasjoner som ikke er mva-registrert (eller er fritatt) fakturerer uten mva.
-- Da tvinges mva-satsen til 0 på produkter, utkast og gjentakelser – også når
-- innstillingen slås av senere. Kreditnotaer beholder satsen fra originalen,
-- så en faktura sendt med mva krediteres med mva.

create function faktura.uten_mva(_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not mva_registrert from faktura.organisasjoner where id = _org
$$;

create function faktura.produkt_mva() returns trigger
language plpgsql set search_path = '' as $$
begin
  if faktura.uten_mva(new.org_id) then new.mva_sats := 0; end if;
  return new;
end $$;

create trigger produkter_mva before insert or update on faktura.produkter
  for each row execute function faktura.produkt_mva();

create function faktura.linje_mva() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if faktura.uten_mva(new.org_id)
     and exists (select 1 from faktura.fakturaer where id = new.faktura_id and type = 'faktura' and status = 'utkast') then
    new.mva_sats := 0;
  end if;
  return new;
end $$;

-- Navnet sorterer etter «faktura_linjer_laas», så låsen sjekkes først.
create trigger faktura_linjer_mva before insert or update on faktura.faktura_linjer
  for each row execute function faktura.linje_mva();

-- Når mva-registreringen slås av: alt som ikke er utstedt, blir uten mva.
create function faktura.org_mva_endret() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.mva_registrert and not new.mva_registrert then
    update faktura.produkter set mva_sats = 0 where org_id = new.id and mva_sats <> 0;
    update faktura.faktura_linjer l set mva_sats = 0
      from faktura.fakturaer f
     where f.id = l.faktura_id and f.org_id = new.id and f.status = 'utkast' and f.type = 'faktura' and l.mva_sats <> 0;
    update faktura.gjentakelser
       set linjer = (select jsonb_agg(jsonb_set(e, '{mva_sats}', '0')) from jsonb_array_elements(linjer) e)
     where org_id = new.id;
  end if;
  return null;
end $$;

create trigger organisasjoner_mva after update of mva_registrert on faktura.organisasjoner
  for each row execute function faktura.org_mva_endret();

grant execute on function faktura.uten_mva(uuid) to faktura_app;
