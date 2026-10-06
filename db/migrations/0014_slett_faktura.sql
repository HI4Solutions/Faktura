-- 0014_slett_faktura.sql
-- Sletting av utstedte fakturaer, ment for testfakturaer. Ekte fakturaer skal
-- krediteres (bokføringsloven), men en faktura som aldri var ment som en ekte
-- faktura skal heller ikke ligge i regnskapet.
--
-- Bare eier/administrator kan slette. Kreditnotaer, betalinger, purringer og
-- e-postlogg for fakturaen slettes sammen med den. Alt som slettes, ligger igjen
-- i revisjonslogg (fakturaer, linjer og betalinger logges allerede), i tillegg til
-- en egen rad med grunnen. Var fakturaene de siste i nummerserien, settes neste
-- fakturanummer tilbake, så serien fortsetter uten hull.

-- Låsen gjelder fortsatt alle andre, også tabelleieren; bare slett_faktura (eid av
-- tabelleieren, og som setter faktura.sletter i transaksjonen) kan slette en utstedt faktura.
create or replace function faktura.faktura_laas() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'utkast' and not (
      coalesce(current_setting('faktura.sletter', true), '') = 'on'
      and current_user = (select r.rolname from pg_catalog.pg_class c join pg_catalog.pg_roles r on r.oid = c.relowner
                           where c.oid = 'faktura.fakturaer'::regclass)
    ) then
      raise exception 'En utstedt faktura kan ikke slettes. Lag en kreditnota.' using errcode = 'FA409';
    end if;
    return old;
  end if;

  if old.status = 'utkast' then
    return new;
  end if;

  if new.status = 'utkast' then
    raise exception 'En utstedt faktura kan ikke bli utkast igjen' using errcode = 'FA409';
  end if;

  if (new.fakturanummer, new.kunde_id, new.type, new.kreditnota_for, new.fakturadato,
      new.forfallsdato, new.periode_fra, new.periode_til, new.kid, new.valuta,
      new.sum_eks_mva, new.mva, new.sum_inkl_mva, new.selger, new.kunde,
      new.deres_referanse, new.var_referanse, new.utstedt_at, new.utstedt_av)
     is distinct from
     (old.fakturanummer, old.kunde_id, old.type, old.kreditnota_for, old.fakturadato,
      old.forfallsdato, old.periode_fra, old.periode_til, old.kid, old.valuta,
      old.sum_eks_mva, old.mva, old.sum_inkl_mva, old.selger, old.kunde,
      old.deres_referanse, old.var_referanse, old.utstedt_at, old.utstedt_av)
  then
    raise exception 'Fakturaen er utstedt og låst. Rett feil med en kreditnota.' using errcode = 'FA409';
  end if;
  return new;
end $$;

-- Linjene slettes med cascade etter fakturaen; linjer_laas slipper dem da gjennom,
-- fordi fakturaen ikke finnes lenger.

-- Returnerer id-ene som ble slettet (fakturaen og eventuelle kreditnotaer).
create function faktura.slett_faktura(_org uuid, _faktura uuid, _grunn text)
returns uuid[]
language plpgsql security definer set search_path = '' as $$
declare
  f faktura.fakturaer;
  ider uuid[];
  neste bigint;
begin
  perform faktura.krev(_org, 'admin');
  if coalesce(btrim(_grunn), '') = '' then
    raise exception 'Oppgi hvorfor fakturaen slettes' using errcode = 'FA400';
  end if;

  select * into f from faktura.fakturaer where id = _faktura and org_id = _org for update;
  if not found then raise exception 'Fant ikke fakturaen' using errcode = 'FA404'; end if;
  if f.type = 'kreditnota' then
    raise exception 'Slett den opprinnelige fakturaen; kreditnotaen slettes sammen med den.' using errcode = 'FA409';
  end if;

  select array_agg(id) into ider from faktura.fakturaer
   where org_id = _org and (id = _faktura or kreditnota_for = _faktura);

  insert into faktura.revisjonslogg (org_id, bruker_id, handling, tabell, rad_id, endring)
  select _org, faktura.bruker_id(), 'SLETTET', 'fakturaer', x.id,
         jsonb_build_object('grunn', btrim(_grunn), 'type', x.type, 'fakturanummer', x.fakturanummer,
                            'sum_inkl_mva', x.sum_inkl_mva, 'kunde', x.kunde, 'pdf_sti', x.pdf_sti)
    from faktura.fakturaer x where x.id = any(ider);

  delete from faktura.eposter where faktura_id = any(ider)
     or purring_id in (select id from faktura.purringer where faktura_id = any(ider));
  delete from faktura.purringer where faktura_id = any(ider);
  delete from faktura.betalinger where faktura_id = any(ider);
  -- Kreditnotaenes linjer peker på fakturaens linjer; alt slettes i samme setning.
  perform pg_catalog.set_config('faktura.sletter', 'on', true);
  delete from faktura.fakturaer where id = any(ider);
  perform pg_catalog.set_config('faktura.sletter', 'off', true);

  -- Var dette de siste numrene i serien, fortsetter serien fra det høyeste som er igjen.
  select coalesce(max(fakturanummer), 0) + 1 into neste from faktura.fakturaer where org_id = _org;
  update faktura.nummerserier set neste_fakturanummer = neste
   where org_id = _org and neste_fakturanummer > neste;

  return ider;
end $$;

revoke all on function faktura.slett_faktura(uuid, uuid, text) from public;
grant execute on function faktura.slett_faktura(uuid, uuid, text) to faktura_app;
