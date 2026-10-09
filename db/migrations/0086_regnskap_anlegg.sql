-- 0086_regnskap_anlegg.sql
-- Regnskapsmodulen, første del: anleggsmidlene med avskrivningsplan over flere år (også goodwill),
-- bokføring av avskrivninger, nedskrivning (og reversering), salg og utrangering, og grunnlaget for
-- de skattemessige saldoavskrivningene. Beregningene gjøres i API-et (server/src/anlegg.ts og
-- server/src/saldo.ts); databasen fører bilagene (serie A, kilde anlegg) med hendelsene, og
-- kontrollerer at det som er bokført henger sammen.
--
-- Tilgang: eier, administrator og regnskap (handlingen «regnskap» i faktura.kan), med funksjonen
-- «Regnskap» (modulen Regnskap). Et regnskapsbilag slettes aldri; det reverseres.

-- ---------------------------------------------------------------------------
-- Modulen og funksjonen «Regnskap»
-- ---------------------------------------------------------------------------

insert into faktura.moduler (kode, navn, beskrivelse, rekkefolge) values
  ('regnskap', 'Regnskap', 'Eget regnskap: anleggsmidler og avskrivninger (også goodwill), saldoavskrivninger, bilag, hovedbok og saldobalanse', 3);
insert into faktura.funksjoner (kode, navn, beskrivelse, rekkefolge, krever, modul) values
  ('regnskap', 'Regnskap', 'Anleggsregister med avskrivningsplan over flere år, nedskrivning, salg og utrangering, goodwill og skattemessige saldoavskrivninger', 13, null, 'regnskap');
insert into faktura.org_funksjoner (org_id, kode, aktiv)
select id, 'regnskap', true from faktura.organisasjoner
on conflict do nothing;

-- Handlingen «regnskap»: eier, administrator og regnskap (som for lønnen å se).
create or replace function faktura.kan(_org uuid, _handling text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  r text;
begin
  if faktura.er_system() then return true; end if;
  if faktura.bruker_id() is null or _org is null then return false; end if;
  r := faktura.rolle(_org);
  if r is null then return false; end if;
  return case _handling
    when 'les'          then r <> 'ansatt'
    when 'skriv'        then r in ('eier', 'admin', 'fakturerer')
    when 'utsted'       then r in ('eier', 'admin', 'fakturerer')
    when 'bokfor'       then r in ('eier', 'admin', 'fakturerer', 'regnskap')
    when 'admin'        then r in ('eier', 'admin')
    when 'eier'         then r = 'eier'
    when 'personal'     then r in ('eier', 'admin')
    when 'personal_les' then r in ('eier', 'admin', 'regnskap')
    when 'regnskap'     then r in ('eier', 'admin', 'regnskap')
    when 'plan'         then r in ('eier', 'admin', 'regnskap') or faktura.min_ansatt(_org) is not null
    when 'medlem'       then true
    else false
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Oppsettet: kontoene (det som avviker fra standarden) og de skattemessige startverdiene
-- ---------------------------------------------------------------------------

create function faktura.regnskapskontoer_gyldige(_k jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(_k) = 'object'
     and not exists (
       select 1 from jsonb_each(_k) e
        where e.key !~ '^[a-z_]{2,40}$'
           or jsonb_typeof(e.value) <> 'string'
           or (e.value #>> '{}') !~ '^[0-9]{4,6}$')
$$;

create function faktura.saldo_inngaende_gyldig(_s jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(_s) = 'object'
     and not exists (select 1 from jsonb_each(_s) e
                      where e.key not in ('a', 'c', 'd', 'gevinst_tap') or jsonb_typeof(e.value) <> 'number'
                         or abs((e.value #>> '{}')::numeric) >= 1000000000000)
$$;

-- saldo_fra_aar: det første året saldoene regnes i HI4; saldo_inngaende: saldoen ved inngangen til
-- det året for samlesaldoene (gruppe a, c og d) og gevinst- og tapskontoen (gevinst_tap).
create table faktura.regnskap_oppsett (
  org_id uuid primary key references faktura.organisasjoner(id) on delete cascade,
  kontoer jsonb not null default '{}' check (faktura.regnskapskontoer_gyldige(kontoer)),
  saldo_fra_aar int check (saldo_fra_aar between 2000 and 2100),
  saldo_inngaende jsonb not null default '{}' check (faktura.saldo_inngaende_gyldig(saldo_inngaende)),
  oppdatert timestamptz not null default now()
);
create trigger regnskap_oppsett_revisjon after insert or update or delete on faktura.regnskap_oppsett
  for each row execute function faktura.revider();
alter table faktura.regnskap_oppsett enable row level security;
create policy regnskap_oppsett_les on faktura.regnskap_oppsett for select using (faktura.kan(org_id, 'regnskap') or faktura.er_system());
create policy regnskap_oppsett_ny on faktura.regnskap_oppsett for insert with check (faktura.kan(org_id, 'regnskap'));
create policy regnskap_oppsett_endre on faktura.regnskap_oppsett for update using (faktura.kan(org_id, 'regnskap')) with check (faktura.kan(org_id, 'regnskap'));
grant select on faktura.regnskap_oppsett to faktura_app, faktura_system;
grant insert (org_id, kontoer, saldo_fra_aar, saldo_inngaende, oppdatert), update (kontoer, saldo_fra_aar, saldo_inngaende, oppdatert)
  on faktura.regnskap_oppsett to faktura_app;

-- De høyeste satsene for saldoavskrivning (skatteloven § 14-43). Bygg i gruppe h med kort brukstid
-- kan ha høyere sats på det enkelte bygget (på anleggsmiddelet, høyst 10 %).
create function faktura.saldosats_maks(_gruppe text, _enkelt boolean default false) returns numeric
language sql immutable set search_path = '' as $$
  select case _gruppe when 'a' then 30 when 'b' then 20 when 'c' then 24 when 'd' then 20 when 'e' then 14
                      when 'f' then 12 when 'g' then 5 when 'h' then case when _enkelt then 10 else 4 end
                      when 'i' then 2 when 'j' then 10 else 0 end::numeric
$$;

-- Satsen organisasjonen velger for en gruppe et år (lavere enn den høyeste).
create table faktura.saldo_satser (
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  aar int not null check (aar between 2000 and 2100),
  gruppe text not null check (gruppe in ('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j')),
  sats numeric(5,2) not null check (sats >= 0 and sats <= faktura.saldosats_maks(gruppe)),
  primary key (org_id, aar, gruppe)
);
create trigger saldo_satser_revisjon after insert or update or delete on faktura.saldo_satser
  for each row execute function faktura.revider();
alter table faktura.saldo_satser enable row level security;
create policy saldo_satser_les on faktura.saldo_satser for select using (faktura.kan(org_id, 'regnskap') or faktura.er_system());
create policy saldo_satser_skriv on faktura.saldo_satser for all using (faktura.kan(org_id, 'regnskap')) with check (faktura.kan(org_id, 'regnskap'));
grant select, insert, update, delete on faktura.saldo_satser to faktura_app;
grant select on faktura.saldo_satser to faktura_system;

-- ---------------------------------------------------------------------------
-- Anleggsmidlene
-- ---------------------------------------------------------------------------

-- kategori: hva det er (goodwill, andre immaterielle eiendeler, tomt, bygning, fast teknisk
--   installasjon, maskiner, inventar, kontormaskiner og IT, personbil, varebil/lastebil, annet).
-- avskrives_fra: den første måneden med avskrivning (når det ble tatt i bruk).
-- levetid_mnd: den økonomiske levetiden i måneder (lineær avskrivning ned til restverdien); tomt
--   avskrives ikke.
-- konto: balansekontoen (avskrivningene krediteres den); avskrivningskonto: kostnadskontoen når den
--   er en annen enn standarden for kategorien.
-- skatt: saldogruppen (a–j), lineært (immaterielle rettigheter som taper seg i verdi) eller ingen
--   (tomt o.l.); skatt_kostpris når den skattemessige kostprisen er en annen; skatt_sats når satsen
--   for dette driftsmiddelet er en annen (enkeltsaldo, f.eks. bygg med kort brukstid).
-- tidligere_til og tidligere_avskrevet: ført i et annet system før HI4, avskrevet (og nedskrevet)
--   til og med den måneden; skatt_inngaende: den skattemessige saldoen for et driftsmiddel med egen
--   saldo (og lineært) ved inngangen til det første året i HI4.
-- avgang_*: solgt eller utrangert (settes av bokføringen, ikke direkte).
create table faktura.anleggsmidler (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  nummer int not null check (nummer > 0),
  navn text not null check (length(btrim(navn)) between 1 and 120),
  beskrivelse text check (beskrivelse is null or length(beskrivelse) <= 500),
  kategori text not null check (kategori in ('goodwill', 'immateriell', 'tomt', 'bygning', 'teknisk_installasjon', 'maskiner',
                                             'inventar', 'kontormaskiner', 'personbil', 'varebil', 'annet')),
  anskaffet date not null,
  avskrives_fra date not null check (avskrives_fra = date_trunc('month', avskrives_fra)::date),
  kostpris numeric(14,2) not null check (kostpris > 0 and kostpris < 1000000000000),
  restverdi numeric(14,2) not null default 0 check (restverdi >= 0),
  levetid_mnd int check (levetid_mnd between 1 and 1200),
  konto text not null check (konto ~ '^[0-9]{4,6}$'),
  avskrivningskonto text check (avskrivningskonto is null or avskrivningskonto ~ '^[0-9]{4,6}$'),
  skatt text not null check (skatt in ('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'lineaer', 'ingen')),
  skatt_kostpris numeric(14,2) check (skatt_kostpris is null or (skatt_kostpris >= 0 and skatt_kostpris < 1000000000000)),
  skatt_sats numeric(5,2) check (skatt_sats is null or (skatt in ('b', 'e', 'f', 'g', 'h', 'i', 'j')
                                                        and skatt_sats >= 0 and skatt_sats <= faktura.saldosats_maks(skatt, true))),
  tidligere_til date,
  tidligere_avskrevet numeric(14,2) not null default 0 check (tidligere_avskrevet >= 0),
  skatt_inngaende numeric(14,2) check (skatt_inngaende is null or (skatt_inngaende >= 0 and skatt_inngaende < 1000000000000)),
  avgang_dato date,
  avgang_type text check (avgang_type is null or avgang_type in ('salg', 'utrangering')),
  avgang_vederlag numeric(14,2) check (avgang_vederlag is null or avgang_vederlag >= 0),
  opprettet timestamptz not null default now(),
  opprettet_av uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null,
  unique (org_id, id),
  unique (org_id, nummer),
  check (restverdi < kostpris),
  check (avskrives_fra >= date_trunc('month', anskaffet)::date),
  check ((kategori = 'tomt') = (levetid_mnd is null)),
  check (kategori <> 'goodwill' or skatt = 'b'),
  check (kategori <> 'tomt' or skatt = 'ingen'),
  check (tidligere_til is null
         or (tidligere_til = (date_trunc('month', tidligere_til) + interval '1 month - 1 day')::date and tidligere_til >= avskrives_fra - 1)),
  check (tidligere_til is not null or tidligere_avskrevet = 0),
  check (tidligere_avskrevet <= kostpris),
  check ((avgang_dato is null) = (avgang_type is null) and (avgang_type is null) = (avgang_vederlag is null)),
  check (avgang_dato is null or avgang_dato >= anskaffet)
);
create index anleggsmidler_org on faktura.anleggsmidler (org_id, nummer);
create trigger anleggsmidler_revisjon after insert or update or delete on faktura.anleggsmidler
  for each row execute function faktura.revider();

-- Hendelsene som er bokført: anskaffelsen, avskrivningen for en måned, nedskrivning, reversering av
-- nedskrivning og avgangen (belop: den bokførte verdien som går ut; vederlag: salgssummen uten mva).
-- Hver har et bilag; når bilaget reverseres, gjelder ikke hendelsen lenger (reversert).
create table faktura.anleggshendelser (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  anleggsmiddel_id uuid not null,
  type text not null check (type in ('anskaffelse', 'avskrivning', 'nedskrivning', 'reversering', 'avgang')),
  dato date not null,
  maaned date check (maaned is null or maaned = date_trunc('month', maaned)::date),
  belop numeric(14,2) not null check (belop >= 0),
  vederlag numeric(14,2) check (vederlag is null or vederlag >= 0),
  tekst text check (tekst is null or length(tekst) <= 300),
  bilag_id uuid not null,
  reversert boolean not null default false,
  opprettet timestamptz not null default now(),
  foreign key (org_id, anleggsmiddel_id) references faktura.anleggsmidler(org_id, id) on delete cascade,
  foreign key (org_id, bilag_id) references faktura.bilag(org_id, id),
  check ((type = 'avskrivning') = (maaned is not null)),
  check ((type = 'avgang') = (vederlag is not null)),
  check (type = 'avgang' or belop > 0)
);
create unique index anleggshendelser_maaned on faktura.anleggshendelser (anleggsmiddel_id, maaned) where type = 'avskrivning' and not reversert;
create unique index anleggshendelser_en on faktura.anleggshendelser (anleggsmiddel_id, type) where type in ('anskaffelse', 'avgang') and not reversert;
create index anleggshendelser_bilag on faktura.anleggshendelser (bilag_id);
create index anleggshendelser_org on faktura.anleggshendelser (org_id, dato);

alter table faktura.anleggsmidler enable row level security;
alter table faktura.anleggshendelser enable row level security;
create policy anleggsmidler_les on faktura.anleggsmidler for select using (faktura.kan(org_id, 'regnskap') or faktura.er_system());
create policy anleggsmidler_ny on faktura.anleggsmidler for insert with check (faktura.kan(org_id, 'regnskap'));
create policy anleggsmidler_endre on faktura.anleggsmidler for update using (faktura.kan(org_id, 'regnskap')) with check (faktura.kan(org_id, 'regnskap'));
create policy anleggsmidler_slett on faktura.anleggsmidler for delete using (faktura.kan(org_id, 'regnskap'));
create policy anleggshendelser_les on faktura.anleggshendelser for select using (faktura.kan(org_id, 'regnskap') or faktura.er_system());
grant select on faktura.anleggsmidler, faktura.anleggshendelser to faktura_app, faktura_system;
grant insert (org_id, navn, beskrivelse, kategori, anskaffet, avskrives_fra, kostpris, restverdi, levetid_mnd, konto, avskrivningskonto,
              skatt, skatt_kostpris, skatt_sats, tidligere_til, tidligere_avskrevet, skatt_inngaende),
      update (navn, beskrivelse, kategori, anskaffet, avskrives_fra, kostpris, restverdi, levetid_mnd, konto, avskrivningskonto,
              skatt, skatt_kostpris, skatt_sats, tidligere_til, tidligere_avskrevet, skatt_inngaende),
      delete
  on faktura.anleggsmidler to faktura_app;

-- Nummeret (løpenummer i organisasjonen), og det som ikke kan endres når noe er bokført: kategorien,
-- kostprisen, datoene og kontoen (reverser bilagene først, eller bruk nedskrivning). Levetiden,
-- restverdien og avskrivningskontoen kan endres (gjelder avskrivningene framover), men ikke etter
-- salg eller utrangering. Et anleggsmiddel med bokførte bilag slettes ikke.
create function faktura.anleggsmidler_foer() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  bokfort boolean;
begin
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('anleggsmidler:' || new.org_id::text, 0));
    new.nummer := coalesce((select max(nummer) from faktura.anleggsmidler where org_id = new.org_id), 0) + 1;
    return new;
  end if;
  bokfort := exists (select 1 from faktura.anleggshendelser where anleggsmiddel_id = old.id and not reversert);
  if tg_op = 'DELETE' then
    if bokfort then
      raise exception 'Anleggsmiddelet har bokførte bilag. Reverser dem først, eller registrer salg eller utrangering.' using errcode = 'FA409';
    end if;
    return old;
  end if;
  new.nummer := old.nummer;
  if bokfort and (new.kategori, new.kostpris, new.anskaffet, new.avskrives_fra, new.konto, new.tidligere_til, new.tidligere_avskrevet)
                 is distinct from (old.kategori, old.kostpris, old.anskaffet, old.avskrives_fra, old.konto, old.tidligere_til, old.tidligere_avskrevet) then
    raise exception 'Anleggsmiddelet har bokførte bilag: kategorien, kostprisen, datoene og kontoen kan ikke endres. Reverser bilagene først, eller bruk nedskrivning.'
      using errcode = 'FA409';
  end if;
  if old.avgang_dato is not null and new.avgang_dato is not null
     and (new.levetid_mnd, new.restverdi, new.avskrivningskonto) is distinct from (old.levetid_mnd, old.restverdi, old.avskrivningskonto) then
    raise exception 'Anleggsmiddelet er solgt eller utrangert' using errcode = 'FA409';
  end if;
  return new;
end $$;
create trigger anleggsmidler_foer before insert or update or delete on faktura.anleggsmidler
  for each row execute function faktura.anleggsmidler_foer();

-- ---------------------------------------------------------------------------
-- Bilagene: serie A, kilde anlegg
-- ---------------------------------------------------------------------------

alter table faktura.bilag drop constraint bilag_kilde_check;
alter table faktura.bilag add constraint bilag_kilde_check check (kilde in ('lonn', 'nav_refusjon', 'anlegg'));
drop policy bilag_les on faktura.bilag;
create policy bilag_les on faktura.bilag for select
  using ((kilde in ('lonn', 'nav_refusjon') and faktura.kan(org_id, 'personal_les'))
         or (kilde = 'anlegg' and faktura.kan(org_id, 'regnskap')));

-- Fører et bilag for anleggsmidlene med posteringene (regnet ut av API-et) og hendelsene, og
-- kontrollerer at de henger sammen: anleggsmiddelet er ikke solgt eller utrangert, avskrivningene
-- bokføres i rekkefølge (ikke før avskrivningen begynner eller det som er ført i et annet system, og
-- ikke for en måned før en som er bokført; API-et fører hver måned med beløp), verdien blir ikke
-- negativ, avgangen tar ut den bokførte verdien, nedskrivning av goodwill reverseres ikke, og en
-- reversering er ikke større enn nedskrivningene.
-- _posteringer: [{konto, belop, tekst}]; _hendelser: [{anleggsmiddel_id, type, maaned, belop,
-- vederlag, avgang_type, tekst}]. En avskrivning står på bilagsdatoen når den er i måneden (den
-- siste dagen, eller avgangsdatoen for den siste måneden), ellers på den siste dagen i måneden.
create function faktura.bokfor_anlegg(_org uuid, _dato date, _tekst text, _posteringer jsonb, _hendelser jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b uuid;
  h jsonb;
  a faktura.anleggsmidler;
  m date;
  rest numeric;
begin
  perform faktura.krev(_org, 'regnskap');
  if _dato is null or length(btrim(coalesce(_tekst, ''))) = 0 then
    raise exception 'Bilaget mangler dato eller tekst' using errcode = 'FA400';
  end if;
  if jsonb_typeof(_hendelser) <> 'array' or jsonb_array_length(_hendelser) = 0 or jsonb_typeof(_posteringer) <> 'array' then
    raise exception 'Bilaget mangler hendelser' using errcode = 'FA400';
  end if;
  if (select coalesce(sum((x->>'belop')::numeric(14,2)), 0) from jsonb_array_elements(_posteringer) x) <> 0 then
    raise exception 'Bilaget går ikke i null' using errcode = 'FA400';
  end if;
  insert into faktura.bilag (org_id, serie, aar, nummer, dato, tekst, kilde)
  values (_org, 'A', extract(year from _dato)::int, faktura.neste_bilagsnummer(_org, 'A', extract(year from _dato)::int), _dato, left(btrim(_tekst), 300), 'anlegg')
  returning id into b;
  insert into faktura.posteringer (org_id, bilag_id, rekke, konto, belop, tekst)
  select _org, b, p.n, p.x->>'konto', (p.x->>'belop')::numeric(14,2), left(nullif(btrim(p.x->>'tekst'), ''), 200)
    from jsonb_array_elements(_posteringer) with ordinality as p(x, n);

  for h in select * from jsonb_array_elements(_hendelser) loop
    select * into a from faktura.anleggsmidler where org_id = _org and id = (h->>'anleggsmiddel_id')::uuid for update;
    if a.id is null then raise exception 'Fant ikke anleggsmiddelet' using errcode = 'FA404'; end if;
    if a.avgang_dato is not null then
      raise exception 'Anleggsmiddel % er solgt eller utrangert', a.nummer using errcode = 'FA409';
    end if;
    m := (h->>'maaned')::date;
    case h->>'type'
      when 'avskrivning' then
        if a.levetid_mnd is null then raise exception 'Anleggsmiddel % avskrives ikke', a.nummer using errcode = 'FA409'; end if;
        if m is null or m < a.avskrives_fra or (a.tidligere_til is not null and m <= a.tidligere_til) then
          raise exception 'Anleggsmiddel % avskrives ikke for den måneden', a.nummer using errcode = 'FA409';
        end if;
        if exists (select 1 from faktura.anleggshendelser x where x.anleggsmiddel_id = a.id and not x.reversert
                     and x.type = 'avskrivning' and x.maaned >= m) then
          raise exception 'Avskrivningen for anleggsmiddel % er alt bokført for måneden (eller en senere)', a.nummer using errcode = 'FA409';
        end if;
      when 'nedskrivning' then null;
      when 'reversering' then
        if a.kategori = 'goodwill' then
          raise exception 'Nedskrivning av goodwill kan ikke reverseres' using errcode = 'FA409';
        end if;
        if (h->>'belop')::numeric > coalesce((select sum(case x.type when 'nedskrivning' then x.belop else -x.belop end)
                                                from faktura.anleggshendelser x
                                               where x.anleggsmiddel_id = a.id and not x.reversert and x.type in ('nedskrivning', 'reversering')), 0) then
          raise exception 'Reverseringen er større enn nedskrivningene' using errcode = 'FA409';
        end if;
      when 'anskaffelse' then
        if a.tidligere_til is not null then
          raise exception 'Anskaffelsen av anleggsmiddel % er ført i et annet system', a.nummer using errcode = 'FA409';
        end if;
        if (h->>'belop')::numeric <> a.kostpris then
          raise exception 'Anskaffelsen må være kostprisen' using errcode = 'FA400';
        end if;
      when 'avgang' then
        -- Den bokførte verdien går ut (etter avskrivningene som er bokført).
        rest := a.kostpris - a.tidligere_avskrevet
                - coalesce((select sum(case x.type when 'reversering' then -x.belop else x.belop end) from faktura.anleggshendelser x
                             where x.anleggsmiddel_id = a.id and not x.reversert and x.type in ('avskrivning', 'nedskrivning', 'reversering')), 0);
        if abs((h->>'belop')::numeric - rest) >= 0.005 then
          raise exception 'Den bokførte verdien av anleggsmiddel % er % kr', a.nummer, rest using errcode = 'FA409';
        end if;
        update faktura.anleggsmidler
           set avgang_dato = _dato, avgang_type = coalesce(h->>'avgang_type', 'salg'), avgang_vederlag = coalesce((h->>'vederlag')::numeric, 0)
         where id = a.id;
      else
        raise exception 'Ukjent hendelse' using errcode = 'FA400';
    end case;
    insert into faktura.anleggshendelser (org_id, anleggsmiddel_id, type, dato, maaned, belop, vederlag, tekst, bilag_id)
    values (_org, a.id, h->>'type',
            case when m is null or _dato between m and (m + interval '1 month - 1 day')::date then _dato
                 else (m + interval '1 month - 1 day')::date end, m,
            (h->>'belop')::numeric(14,2), case when h->>'type' = 'avgang' then coalesce((h->>'vederlag')::numeric(14,2), 0) end,
            left(nullif(btrim(h->>'tekst'), ''), 300), b);
  end loop;

  -- Verdien etter det som er bokført, blir ikke negativ.
  for a in select x.* from faktura.anleggsmidler x
            where x.org_id = _org and x.id in (select (y->>'anleggsmiddel_id')::uuid from jsonb_array_elements(_hendelser) y) loop
    rest := a.kostpris - a.tidligere_avskrevet
            - coalesce((select sum(case x.type when 'reversering' then -x.belop else x.belop end) from faktura.anleggshendelser x
                         where x.anleggsmiddel_id = a.id and not x.reversert and x.type in ('avskrivning', 'nedskrivning', 'reversering')), 0);
    if rest < 0 then
      raise exception 'Verdien av anleggsmiddel % blir negativ', a.nummer using errcode = 'FA409';
    end if;
  end loop;
  return b;
end $$;
revoke execute on function faktura.bokfor_anlegg(uuid, date, text, jsonb, jsonb) from public;
grant execute on function faktura.bokfor_anlegg(uuid, date, text, jsonb, jsonb) to faktura_app;

-- Reverserer et bilag for anleggsmidlene (med motsatte beløp), og hendelsene gjelder ikke lenger.
-- Det siste først: et bilag kan ikke reverseres når et anleggsmiddel i det har senere bokføringer
-- (senere dato, eller samme dato og et senere bilag; anskaffelsen bare når ingenting annet er
-- bokført). En avgang som reverseres, gjør anleggsmiddelet aktivt igjen.
create function faktura.reverser_anlegg(_org uuid, _bilag uuid, _tekst text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b faktura.bilag;
  ny uuid;
  h faktura.anleggshendelser;
  nr int;
begin
  perform faktura.krev(_org, 'regnskap');
  select * into b from faktura.bilag where org_id = _org and id = _bilag and kilde = 'anlegg' for update;
  if b.id is null then raise exception 'Fant ikke bilaget' using errcode = 'FA404'; end if;
  if b.reverserer is not null or b.reversert_av is not null then
    raise exception 'Bilaget er reversert eller en reversering' using errcode = 'FA409';
  end if;
  for h in select * from faktura.anleggshendelser where bilag_id = _bilag and not reversert loop
    if exists (select 1 from faktura.anleggshendelser x join faktura.bilag xb on xb.id = x.bilag_id
                where x.anleggsmiddel_id = h.anleggsmiddel_id and not x.reversert and x.bilag_id <> _bilag
                  and (h.type = 'anskaffelse' or x.dato > h.dato
                       or (x.dato = h.dato and (xb.aar, xb.nummer) > (b.aar, b.nummer))
                       or (x.type = 'avskrivning' and h.type = 'avskrivning' and x.maaned > h.maaned))) then
      select nummer into nr from faktura.anleggsmidler where id = h.anleggsmiddel_id;
      raise exception 'Anleggsmiddel % har senere bokføringer. Reverser dem først.', nr using errcode = 'FA409';
    end if;
  end loop;
  ny := faktura.reverser_bilag(_bilag, coalesce(nullif(btrim(_tekst), ''), 'Reversert: ' || b.tekst));
  update faktura.anleggsmidler a set avgang_dato = null, avgang_type = null, avgang_vederlag = null
   where a.id in (select anleggsmiddel_id from faktura.anleggshendelser where bilag_id = _bilag and type = 'avgang' and not reversert);
  update faktura.anleggshendelser set reversert = true where bilag_id = _bilag;
  return ny;
end $$;
revoke execute on function faktura.reverser_anlegg(uuid, uuid, text) from public;
grant execute on function faktura.reverser_anlegg(uuid, uuid, text) to faktura_app;

-- ---------------------------------------------------------------------------
-- Revisjonsloggen og sletting av organisasjonen
-- ---------------------------------------------------------------------------

-- Revisjonsloggen for anleggsmidlene og regnskapsoppsettet er for dem som ser regnskapet (som
-- bilagene).
drop policy revisjonslogg_les on faktura.revisjonslogg;
create policy revisjonslogg_les on faktura.revisjonslogg for select
  using (faktura.kan(org_id, 'les')
         and (coalesce(tabell, '') not in ('ansatte', 'ansatt_tillegg', 'fravaer', 'arbeidsplaner', 'ferie_overforinger', 'vaktbytter',
                                           'lonnskjoringer', 'lonn_inngaende', 'timebank_poster', 'avspasering_soknader',
                                           'ameldinger', 'bilag', 'lonnsendringer', 'nav_inntektsmeldinger', 'lonnstrekk',
                                           'naturalytelser', 'reiseregninger', 'nav_refusjoner')
              or faktura.kan(org_id, 'personal_les'))
         and (coalesce(tabell, '') not in ('anleggsmidler', 'regnskap_oppsett', 'saldo_satser')
              or faktura.kan(org_id, 'regnskap'))
         and (coalesce(tabell, '') not in ('fravaer', 'ferie_overforinger', 'avspasering_soknader', 'vaktbytter', 'nav_inntektsmeldinger',
                                           'nav_refusjoner')
              or faktura.kan(org_id, 'personal')));

-- En organisasjon med bilag i regnskapet slettes ikke, men stenges, og regnskapsmaterialet
-- oppbevares (som med fakturaer og lønn): fem år etter utgangen av året for det siste.
create or replace function faktura.slett_organisasjon(_org uuid, _grunn text)
returns faktura.slettede_organisasjoner
language plpgsql security definer set search_path = '' as $$
declare
  o faktura.organisasjoner;
  logg faktura.slettede_organisasjoner;
  _antall int;
  _siste date;
  _lonn int;
  _siste_lonn date;
  _bilag int;
  _siste_bilag date;
  _plattform boolean := faktura.er_betrodd();
  _meg faktura.brukere;
begin
  select * into o from faktura.organisasjoner where id = _org for update;
  if not found or o.slettet_at is not null then raise exception 'Fant ikke organisasjonen' using errcode = 'FA404'; end if;
  if not _plattform and faktura.rolle(_org) is distinct from 'eier' then
    raise exception 'Bare eieren kan slette organisasjonen' using errcode = 'FA403';
  end if;
  if length(btrim(coalesce(_grunn, ''))) < 3 then raise exception 'Skriv hvorfor organisasjonen slettes' using errcode = 'FA400'; end if;
  select * into _meg from faktura.brukere where id = faktura.bruker_id();

  select count(*), max(fakturadato) into _antall, _siste from faktura.fakturaer where org_id = _org and fakturanummer is not null;
  select count(*), max(utbetalingsdato) into _lonn, _siste_lonn from faktura.lonnskjoringer where org_id = _org and status = 'godkjent';
  select count(*), max(dato) into _bilag, _siste_bilag from faktura.bilag where org_id = _org;
  insert into faktura.slettede_organisasjoner (id, navn, orgnr, type, slettet_av, slettet_av_navn, slettet_av_epost, av_plattformen, grunn,
                                               antall_fakturaer, oppbevares_til)
  values (o.id, o.navn, o.orgnr, o.type, _meg.id, _meg.navn, _meg.epost, _plattform, btrim(_grunn), _antall,
          case when _antall > 0 or _lonn > 0 or _bilag > 0
               then make_date(extract(year from greatest(_siste, _siste_lonn, _siste_bilag))::int + 5, 12, 31) end)
  returning * into logg;

  if _antall = 0 and _lonn = 0 and _bilag = 0 then
    -- Uten regnskapsmateriale slettes alt. Filene (vedlegg og logo) ryddes av workeren.
    if o.logo_sti is not null then insert into faktura.slettede_filer (sti) values (o.logo_sti) on conflict do nothing; end if;
    delete from faktura.vedlegg where org_id = _org;
    delete from faktura.fakturaer where org_id = _org;  -- bare utkast
    delete from faktura.gjentakelser where org_id = _org;
    delete from faktura.kunder where org_id = _org;
    delete from faktura.produkter where org_id = _org;
    delete from faktura.lonnskjoringer where org_id = _org;  -- bare utkast (slippene før de ansatte)
    delete from faktura.organisasjoner where id = _org;
    delete from faktura.revisjonslogg where org_id = _org;
  else
    -- Stenges: ingen tilgang og ingenting sendes; regnskapsmaterialet oppbevares.
    update faktura.organisasjoner
       set slettet_at = now(), slettet_av = _meg.id, slettet_grunn = btrim(_grunn), oppbevares_til = logg.oppbevares_til, purring_auto = false
     where id = _org;
    delete from faktura.fakturaer where org_id = _org and status = 'utkast';
    delete from faktura.vedlegg where org_id = _org and faktura_id is null;
    delete from faktura.lonnskjoringer where org_id = _org and status = 'utkast';
    update faktura.gjentakelser set aktiv = false where org_id = _org and aktiv;
    update faktura.paaminnelser set aktiv = false where org_id = _org and aktiv;
    delete from faktura.invitasjoner where org_id = _org;
    delete from faktura.org_tilgang where klient_org_id = _org or byraa_org_id = _org;
    delete from faktura.medlemmer where org_id = _org;
  end if;
  return logg;
end $$;
