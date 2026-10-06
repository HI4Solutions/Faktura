-- 0019_kopimottakere.sql
-- Kopi av fakturaer på e-post:
-- 1. Fast kopiadresse per organisasjon: får blindkopi av alle fakturaer, kreditnotaer og
--    purringer som sendes. Tom liste: kopien går til organisasjonens e-post, som før.
-- 2. Kopimottakere per faktura og gjentakelse: får fakturaen sammen med kunden (synlig
--    kopi), også purringer. Kreditnotaer og fakturaer fra en gjentakelse arver dem.
--    Kan endres etter utstedelse (feltet er ikke en del av dokumentet), f.eks. når
--    fakturaen sendes på nytt.

create function faktura.epostliste_ok(_liste text[]) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(bool_and(length(e) <= 254 and e ~ '^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$'), true)
    from unnest(_liste) e
$$;
grant execute on function faktura.epostliste_ok(text[]) to faktura_app, faktura_system;

alter table faktura.organisasjoner
  add column kopi_til text[] not null default '{}'
    constraint organisasjoner_kopi_til_check check (cardinality(kopi_til) <= 5 and faktura.epostliste_ok(kopi_til));
alter table faktura.fakturaer
  add column kopi_til text[] not null default '{}'
    constraint fakturaer_kopi_til_check check (cardinality(kopi_til) <= 10 and faktura.epostliste_ok(kopi_til));
alter table faktura.gjentakelser
  add column kopi_til text[] not null default '{}'
    constraint gjentakelser_kopi_til_check check (cardinality(kopi_til) <= 10 and faktura.epostliste_ok(kopi_til));

grant update (kopi_til) on faktura.organisasjoner to faktura_app;
grant insert (kopi_til), update (kopi_til) on faktura.fakturaer to faktura_app;
grant insert (kopi_til), update (kopi_til) on faktura.gjentakelser to faktura_app;

-- Appen kan bare endre utkast direkte; kopimottakerne på en utstedt faktura endres
-- her (av den som kan sende fakturaer), f.eks. før den sendes på nytt.
create function faktura.sett_kopi_til(_id uuid, _kopi text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare
  o uuid;
begin
  select org_id into o from faktura.fakturaer where id = _id;
  if not found then raise exception 'Fant ikke fakturaen' using errcode = 'FA404'; end if;
  perform faktura.krev(o, 'utsted');
  update faktura.fakturaer set kopi_til = coalesce(_kopi, '{}') where id = _id;
end $$;
revoke all on function faktura.sett_kopi_til(uuid, text[]) from public;
grant execute on function faktura.sett_kopi_til(uuid, text[]) to faktura_app;

-- Ny faktura fra en gjentakelse arver konto, avsender og kopimottakere; en kreditnota
-- arver dem fra fakturaen.
create or replace function faktura.faktura_arv() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kreditnota_for is not null then
    select f.konto_id, f.avsender, f.kopi_til into new.konto_id, new.avsender, new.kopi_til
      from faktura.fakturaer f where f.id = new.kreditnota_for;
  elsif new.gjentakelse_id is not null then
    if new.konto_id is null and new.avsender is null then
      select g.konto_id, g.avsender into new.konto_id, new.avsender from faktura.gjentakelser g where g.id = new.gjentakelse_id;
    end if;
    if cardinality(new.kopi_til) = 0 then
      select g.kopi_til into new.kopi_til from faktura.gjentakelser g where g.id = new.gjentakelse_id;
    end if;
  end if;
  return new;
end $$;

-- E-postloggen tar med hvem som fikk kopi (synlig kopi), så det vises på fakturaen.
alter table faktura.eposter add column kopi text[] not null default '{}';

drop function faktura.logg_epost(uuid, uuid, uuid, text, text, text);
create function faktura.logg_epost(_org uuid, _faktura uuid, _purring uuid, _ekstern_id text, _til text, _emne text,
                                   _kopi text[] default '{}')
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not faktura.er_system() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  insert into faktura.eposter (org_id, faktura_id, purring_id, ekstern_id, til, emne, kopi)
  values (_org, _faktura, _purring, _ekstern_id, _til, _emne, coalesce(_kopi, '{}'))
  on conflict (ekstern_id) do nothing;
end $$;
grant execute on function faktura.logg_epost(uuid, uuid, uuid, text, text, text, text[]) to faktura_system;

-- Endret kopiadresse gir en hendelse, og workeren varsler alle eiere på e-post (som for
-- kontonummeret): den som får kopi av alle fakturaer, kan lage overbevisende svindel.
create or replace function faktura.org_etter_endring() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kontonr is distinct from old.kontonr then
    insert into faktura.utboks (org_id, hendelse, aggregat_id, data)
    values (new.id, 'organisasjon.kontonr_endret', new.id,
            jsonb_build_object('fra', old.kontonr, 'til', new.kontonr, 'endret_av', faktura.bruker_id()));
  end if;
  if new.kopi_til is distinct from old.kopi_til then
    insert into faktura.utboks (org_id, hendelse, aggregat_id, data)
    values (new.id, 'organisasjon.kopi_endret', new.id,
            jsonb_build_object('fra', to_jsonb(old.kopi_til), 'til', to_jsonb(new.kopi_til), 'endret_av', faktura.bruker_id()));
  end if;
  return null;
end $$;
