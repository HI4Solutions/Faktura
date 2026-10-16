-- 0114_sjekklister.sql
-- Sjekklister (funksjonen «Sjekklister» i Personal): administrator (eier, administrator og en egen
-- rolle med Personal) lager sjekklister med punkter, f.eks. varemottak, åpning og stenging eller
-- renhold, som gjøres daglig, ukentlig, månedlig eller ved behov, av alle eller av bestemte roller
-- (ansattgruppene). De som gjør den, svarer på hvert punkt: «Normalt», eller «Avvik» med en
-- kommentar om hva som er galt. Avvikene går til administrator (varsel når sjekklisten er fullført),
-- som lukker dem med det som er gjort (tiltaket).
--
-- De faste sjekklistene (daglig, ukentlig, månedlig) har én utfylling per periode (dagen, uka fra
-- mandag, måneden), som flere kan jobbe på; ved behov får hver gang sin egen. Svarene tar vare på
-- teksten i punktet, så historikken står selv om sjekklisten endres. Et punkt som er besvart, tas
-- ut av lista i stedet for å slettes, og en sjekkliste som er brukt, arkiveres.
--
-- Alt skrives gjennom funksjonene under (som sjekker tilgangen); tabellene leses med RLS.

insert into faktura.funksjoner (kode, navn, beskrivelse, rekkefolge, krever, modul, standard)
values ('sjekklister', 'Sjekklister',
        'Sjekklister som gjøres daglig, ukentlig, månedlig eller ved behov (f.eks. varemottak og renhold), med avvik til administrator',
        14, 'ansatte', 'personal', true);
-- Organisasjonene med ansatte og timer får sjekklistene med en gang.
insert into faktura.org_funksjoner (org_id, kode, aktiv)
select o.org_id, 'sjekklister', o.aktiv from faktura.org_funksjoner o where o.kode = 'ansatte'
on conflict do nothing;
update faktura.moduler
   set beskrivelse = 'Ansatte og timeføring, vaktplan og turnus, tavle, fravær og vikarer, ferie og bemanningskalender, og sjekklister'
 where kode = 'personal';

-- ---------------------------------------------------------------------------
-- Tabellene
-- ---------------------------------------------------------------------------

create table faktura.sjekklister (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  navn text not null check (length(btrim(navn)) between 2 and 80),
  beskrivelse text check (beskrivelse is null or length(beskrivelse) <= 1000),
  frekvens text not null default 'daglig' check (frekvens in ('daglig', 'ukentlig', 'maanedlig', 'ved_behov')),
  roller uuid[] not null default '{}',          -- rollene (ansattgruppene) som gjør den; tom: alle
  aktiv boolean not null default true,          -- false: arkivert (historikken står)
  opprettet timestamptz not null default now(),
  opprettet_av uuid references faktura.brukere(id) on delete set null,
  endret timestamptz not null default now(),
  unique (org_id, id)
);
create unique index sjekklister_navn on faktura.sjekklister (org_id, lower(btrim(navn))) where aktiv;
create trigger sjekklister_org_id before update on faktura.sjekklister
  for each row execute function faktura.org_id_uendret();

create table faktura.sjekkliste_punkter (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  sjekkliste_id uuid not null,
  tekst text not null check (length(btrim(tekst)) between 1 and 200),
  hjelp text check (hjelp is null or length(hjelp) <= 500),  -- veiledning til den som sjekker
  rekkefolge int not null default 0,
  aktiv boolean not null default true,                      -- false: tatt ut av lista (er besvart før)
  opprettet timestamptz not null default now(),
  foreign key (org_id, sjekkliste_id) references faktura.sjekklister (org_id, id) on delete cascade,
  unique (org_id, id)
);
create index sjekkliste_punkter_liste on faktura.sjekkliste_punkter (org_id, sjekkliste_id, rekkefolge);

create table faktura.sjekkliste_utfyllinger (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  sjekkliste_id uuid not null,
  frekvens text not null check (frekvens in ('daglig', 'ukentlig', 'maanedlig', 'ved_behov')),  -- da den ble startet
  periode date not null,                         -- dagen, mandagen i uka eller den første i måneden
  status text not null default 'pagar' check (status in ('pagar', 'fullfort')),
  kommentar text check (kommentar is null or length(kommentar) <= 2000),
  startet timestamptz not null default now(),
  startet_av uuid references faktura.brukere(id) on delete set null,
  startet_navn text not null default '',
  fullfort timestamptz,
  fullfort_av uuid references faktura.brukere(id) on delete set null,
  fullfort_navn text,
  foreign key (org_id, sjekkliste_id) references faktura.sjekklister (org_id, id) on delete cascade,
  unique (org_id, id),
  check ((status = 'fullfort') = (fullfort is not null))
);
-- Én utfylling per periode for de faste sjekklistene.
create unique index sjekkliste_utfyllinger_periode on faktura.sjekkliste_utfyllinger (org_id, sjekkliste_id, frekvens, periode)
  where frekvens <> 'ved_behov';
create index sjekkliste_utfyllinger_dato on faktura.sjekkliste_utfyllinger (org_id, periode desc);

create table faktura.sjekkliste_svar (
  org_id uuid not null,
  utfylling_id uuid not null,
  punkt_id uuid not null,
  punkt_tekst text not null,                     -- teksten i punktet da det ble besvart
  svar text not null check (svar in ('ok', 'avvik')),
  kommentar text check (kommentar is null or length(kommentar) <= 2000),
  besvart timestamptz not null default now(),
  besvart_av uuid references faktura.brukere(id) on delete set null,
  besvart_navn text not null default '',
  -- Avviket: administrator lukker det med det som er gjort.
  avvik_lukket timestamptz,
  avvik_lukket_av uuid references faktura.brukere(id) on delete set null,
  avvik_lukket_navn text,
  tiltak text check (tiltak is null or length(tiltak) <= 2000),
  primary key (org_id, utfylling_id, punkt_id),
  foreign key (org_id, utfylling_id) references faktura.sjekkliste_utfyllinger (org_id, id) on delete cascade,
  foreign key (org_id, punkt_id) references faktura.sjekkliste_punkter (org_id, id) on delete cascade,
  check (svar = 'ok' or length(btrim(coalesce(kommentar, ''))) >= 2),
  check (svar = 'avvik' or avvik_lukket is null)
);
create index sjekkliste_svar_apne on faktura.sjekkliste_svar (org_id) where svar = 'avvik' and avvik_lukket is null;

-- ---------------------------------------------------------------------------
-- Hjelpefunksjoner og tilgangen
-- ---------------------------------------------------------------------------

-- Starten av perioden en dato hører til: dagen, mandagen i uka eller den første i måneden.
create function faktura.sjekkliste_periode(_frekvens text, _dato date) returns date
language sql immutable set search_path = '' as $$
  select case _frekvens when 'ukentlig' then date_trunc('week', _dato)::date
                        when 'maanedlig' then date_trunc('month', _dato)::date
                        else _dato end
$$;

-- Starten av perioden før den datoen hører til (de faste). Daglig når organisasjonen har stengt i
-- helgene (lonn_oppsett.helg, 0064_helg.sql): hverdagen før (mandag: fredag).
create function faktura.sjekkliste_forrige(_frekvens text, _dato date, _helg boolean) returns date
language sql immutable set search_path = '' as $$
  select case when _frekvens = 'ved_behov' then null
              when _frekvens = 'daglig' and not _helg
                then _dato - case extract(isodow from _dato)::int when 1 then 3 when 7 then 2 else 1 end
              else faktura.sjekkliste_periode(_frekvens, faktura.sjekkliste_periode(_frekvens, _dato) - 1) end
$$;

-- Navnet til den innloggede i organisasjonen (fra ansattregisteret, ellers fra innloggingen).
create function faktura.sjekkliste_navn(_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select a.fornavn || ' ' || a.etternavn from faktura.ansatte a
      where a.org_id = _org and a.bruker_id = faktura.bruker_id() order by a.aktiv desc limit 1),
    (select coalesce(nullif(btrim(b.navn), ''), b.epost) from faktura.brukere b where b.id = faktura.bruker_id()),
    '')
$$;

-- Kan den innloggede gjøre en sjekkliste med disse rollene? Alle i organisasjonen når den er til
-- alle; ellers de aktive med rollene, og administrator (Personal).
create function faktura.kan_gjore_sjekkliste(_org uuid, _roller uuid[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select faktura.kan(_org, 'medlem')
     and (cardinality(_roller) = 0
          or faktura.kan(_org, 'personal')
          or exists (select 1 from faktura.ansatte a
                      where a.org_id = _org and a.bruker_id = faktura.bruker_id() and a.aktiv and a.gruppe_id = any (_roller)))
$$;

-- Ser den innloggede utfyllingene av sjekklisten? De som kan gjøre den, og de som ser personalet.
create function faktura.ser_sjekkliste(_org uuid, _sjekkliste uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select faktura.kan(_org, 'personal_les')
      or exists (select 1 from faktura.sjekklister s
                  where s.org_id = _org and s.id = _sjekkliste and faktura.kan_gjore_sjekkliste(_org, s.roller))
$$;

alter table faktura.sjekklister enable row level security;
create policy sjekklister_les on faktura.sjekklister for select using (faktura.kan(org_id, 'medlem'));
alter table faktura.sjekkliste_punkter enable row level security;
create policy sjekkliste_punkter_les on faktura.sjekkliste_punkter for select using (faktura.kan(org_id, 'medlem'));
alter table faktura.sjekkliste_utfyllinger enable row level security;
create policy sjekkliste_utfyllinger_les on faktura.sjekkliste_utfyllinger for select
  using (faktura.ser_sjekkliste(org_id, sjekkliste_id) or startet_av = faktura.bruker_id() or fullfort_av = faktura.bruker_id());
alter table faktura.sjekkliste_svar enable row level security;
create policy sjekkliste_svar_les on faktura.sjekkliste_svar for select
  using (besvart_av = faktura.bruker_id()
         or exists (select 1 from faktura.sjekkliste_utfyllinger u
                     where u.org_id = sjekkliste_svar.org_id and u.id = sjekkliste_svar.utfylling_id
                       and faktura.ser_sjekkliste(u.org_id, u.sjekkliste_id)));
grant select on faktura.sjekklister, faktura.sjekkliste_punkter, faktura.sjekkliste_utfyllinger, faktura.sjekkliste_svar
  to faktura_app, faktura_system;

-- ---------------------------------------------------------------------------
-- Sjekklistene (administrator)
-- ---------------------------------------------------------------------------

-- Lager eller endrer en sjekkliste med punktene i rekkefølge ([{id?, tekst, hjelp?}]). Punktene som
-- er tatt ut, slettes, eller tas ut av lista når de er besvart før.
create function faktura.lagre_sjekkliste(_org uuid, _id uuid, _navn text, _beskrivelse text, _frekvens text, _roller uuid[], _punkter jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  sid uuid := _id;
  p jsonb;
  nr int := 0;
  pid uuid;
  tekst text;
  beholdt uuid[] := '{}';
begin
  perform faktura.krev(_org, 'personal');
  _navn := btrim(coalesce(_navn, ''));
  if length(_navn) < 2 or length(_navn) > 80 then raise exception 'Gi sjekklisten et navn (2–80 tegn)' using errcode = 'FA400'; end if;
  _beskrivelse := nullif(btrim(coalesce(_beskrivelse, '')), '');
  if _frekvens is null or _frekvens not in ('daglig', 'ukentlig', 'maanedlig', 'ved_behov') then
    raise exception 'Velg hvor ofte sjekklisten skal gjøres' using errcode = 'FA400';
  end if;
  _roller := coalesce((select array_agg(distinct r) from unnest(_roller) r), '{}');
  if exists (select 1 from unnest(_roller) r
              where not exists (select 1 from faktura.ansattgrupper g where g.org_id = _org and g.id = r)) then
    raise exception 'Fant ikke rollen' using errcode = 'FA404';
  end if;
  if jsonb_typeof(coalesce(_punkter, 'null')) <> 'array' or jsonb_array_length(_punkter) = 0 then
    raise exception 'Legg inn minst ett punkt' using errcode = 'FA400';
  end if;
  if jsonb_array_length(_punkter) > 100 then raise exception 'En sjekkliste kan ha høyst 100 punkter' using errcode = 'FA400'; end if;
  if exists (select 1 from faktura.sjekklister s
              where s.org_id = _org and s.aktiv and lower(btrim(s.navn)) = lower(_navn) and s.id is distinct from sid) then
    raise exception 'Det finnes allerede en sjekkliste med det navnet' using errcode = 'FA409';
  end if;

  if sid is null then
    insert into faktura.sjekklister (org_id, navn, beskrivelse, frekvens, roller, opprettet_av)
    values (_org, _navn, _beskrivelse, _frekvens, _roller, faktura.bruker_id())
    returning id into sid;
  else
    update faktura.sjekklister
       set navn = _navn, beskrivelse = _beskrivelse, frekvens = _frekvens, roller = _roller, endret = now()
     where org_id = _org and id = sid;
    if not found then raise exception 'Fant ikke sjekklisten' using errcode = 'FA404'; end if;
  end if;

  for p in select e from jsonb_array_elements(_punkter) e loop
    nr := nr + 1;
    tekst := btrim(coalesce(p ->> 'tekst', ''));
    if tekst = '' or length(tekst) > 200 then raise exception 'Punkt %: skriv hva som skal sjekkes (høyst 200 tegn)', nr using errcode = 'FA400'; end if;
    if length(coalesce(p ->> 'hjelp', '')) > 500 then raise exception 'Punkt %: veiledningen kan ha høyst 500 tegn', nr using errcode = 'FA400'; end if;
    pid := null;
    if coalesce(p ->> 'id', '') <> '' then
      select x.id into pid from faktura.sjekkliste_punkter x
       where x.org_id = _org and x.sjekkliste_id = sid and x.id::text = p ->> 'id';
    end if;
    if pid is not null then
      update faktura.sjekkliste_punkter
         set tekst = btrim(p ->> 'tekst'), hjelp = nullif(btrim(coalesce(p ->> 'hjelp', '')), ''), rekkefolge = nr, aktiv = true
       where org_id = _org and id = pid;
    else
      insert into faktura.sjekkliste_punkter (org_id, sjekkliste_id, tekst, hjelp, rekkefolge)
      values (_org, sid, tekst, nullif(btrim(coalesce(p ->> 'hjelp', '')), ''), nr)
      returning id into pid;
    end if;
    beholdt := beholdt || pid;
  end loop;

  delete from faktura.sjekkliste_punkter x
   where x.org_id = _org and x.sjekkliste_id = sid and x.id <> all (beholdt)
     and not exists (select 1 from faktura.sjekkliste_svar s where s.org_id = _org and s.punkt_id = x.id);
  update faktura.sjekkliste_punkter set aktiv = false
   where org_id = _org and sjekkliste_id = sid and id <> all (beholdt) and aktiv;
  return sid;
end $$;

-- Arkiverer eller henter fram en sjekkliste.
create function faktura.sett_sjekkliste_aktiv(_org uuid, _id uuid, _aktiv boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s faktura.sjekklister;
begin
  perform faktura.krev(_org, 'personal');
  select * into s from faktura.sjekklister where org_id = _org and id = _id for update;
  if not found then raise exception 'Fant ikke sjekklisten' using errcode = 'FA404'; end if;
  if _aktiv and not s.aktiv and exists (select 1 from faktura.sjekklister x
                                         where x.org_id = _org and x.aktiv and lower(btrim(x.navn)) = lower(btrim(s.navn)) and x.id <> s.id) then
    raise exception 'Det finnes allerede en sjekkliste med det navnet' using errcode = 'FA409';
  end if;
  update faktura.sjekklister set aktiv = _aktiv, endret = now() where org_id = _org and id = _id;
end $$;

-- Sletter en sjekkliste som aldri er brukt; en som er brukt, arkiveres (historikken står).
create function faktura.slett_sjekkliste(_org uuid, _id uuid) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform faktura.krev(_org, 'personal');
  if not exists (select 1 from faktura.sjekklister where org_id = _org and id = _id) then
    raise exception 'Fant ikke sjekklisten' using errcode = 'FA404';
  end if;
  if exists (select 1 from faktura.sjekkliste_utfyllinger where org_id = _org and sjekkliste_id = _id) then
    update faktura.sjekklister set aktiv = false, endret = now() where org_id = _org and id = _id;
    return 'arkivert';
  end if;
  delete from faktura.sjekklister where org_id = _org and id = _id;
  return 'slettet';
end $$;

-- ---------------------------------------------------------------------------
-- Utfyllingen (de som gjør sjekklisten)
-- ---------------------------------------------------------------------------

-- Utfyllingen den innloggede skal svare i, med låsen: finnes, kan gjøres og er ikke fullført.
create function faktura.sjekkliste_utfylling_for_svar(_org uuid, _utfylling uuid) returns faktura.sjekkliste_utfyllinger
language plpgsql security definer set search_path = '' as $$
declare
  u faktura.sjekkliste_utfyllinger;
begin
  select * into u from faktura.sjekkliste_utfyllinger where org_id = _org and id = _utfylling for update;
  if not found or not faktura.kan_gjore_sjekkliste(_org, (select s.roller from faktura.sjekklister s where s.org_id = _org and s.id = u.sjekkliste_id)) then
    raise exception 'Fant ikke sjekklisten' using errcode = 'FA404';
  end if;
  if u.status <> 'pagar' then raise exception 'Sjekklisten er allerede fullført' using errcode = 'FA409'; end if;
  return u;
end $$;

-- Starter (eller fortsetter) sjekklisten for perioden datoen hører til (i dag uten dato). De faste
-- har én utfylling per periode; ved behov fortsetter den innloggede sin egen som ikke er fullført,
-- ellers startes en ny.
create function faktura.start_sjekkliste(_org uuid, _sjekkliste uuid, _dato date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  s faktura.sjekklister;
  d date := coalesce(_dato, faktura.i_dag());
  p date;
  uid uuid;
begin
  select * into s from faktura.sjekklister where org_id = _org and id = _sjekkliste;
  if not found or not faktura.kan_gjore_sjekkliste(_org, s.roller) then
    raise exception 'Fant ikke sjekklisten' using errcode = 'FA404';
  end if;
  if not s.aktiv then raise exception 'Sjekklisten er arkivert' using errcode = 'FA409'; end if;
  if d > faktura.i_dag() then raise exception 'Datoen kan ikke være fram i tid' using errcode = 'FA400'; end if;
  if d < faktura.i_dag() - 62 then raise exception 'Datoen kan være høyst to måneder tilbake' using errcode = 'FA400'; end if;
  p := faktura.sjekkliste_periode(s.frekvens, d);
  if s.frekvens = 'ved_behov' then
    select u.id into uid from faktura.sjekkliste_utfyllinger u
     where u.org_id = _org and u.sjekkliste_id = s.id and u.status = 'pagar' and u.startet_av = faktura.bruker_id()
     order by u.startet desc limit 1;
    if uid is not null then return uid; end if;
    insert into faktura.sjekkliste_utfyllinger (org_id, sjekkliste_id, frekvens, periode, startet_av, startet_navn)
    values (_org, s.id, s.frekvens, p, faktura.bruker_id(), faktura.sjekkliste_navn(_org))
    returning id into uid;
    return uid;
  end if;
  insert into faktura.sjekkliste_utfyllinger (org_id, sjekkliste_id, frekvens, periode, startet_av, startet_navn)
  values (_org, s.id, s.frekvens, p, faktura.bruker_id(), faktura.sjekkliste_navn(_org))
  on conflict (org_id, sjekkliste_id, frekvens, periode) where frekvens <> 'ved_behov' do nothing
  returning id into uid;
  if uid is null then
    select u.id into uid from faktura.sjekkliste_utfyllinger u
     where u.org_id = _org and u.sjekkliste_id = s.id and u.frekvens = s.frekvens and u.periode = p;
  end if;
  return uid;
end $$;

-- Svarer på et punkt: «ok» (normalt) eller «avvik» med kommentar (null: tar bort svaret).
create function faktura.svar_sjekkliste(_org uuid, _utfylling uuid, _punkt uuid, _svar text, _kommentar text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  u faktura.sjekkliste_utfyllinger := faktura.sjekkliste_utfylling_for_svar(_org, _utfylling);
  t text;
begin
  select x.tekst into t from faktura.sjekkliste_punkter x
   where x.org_id = _org and x.id = _punkt and x.sjekkliste_id = u.sjekkliste_id and x.aktiv;
  if not found then raise exception 'Fant ikke punktet' using errcode = 'FA404'; end if;
  if _svar is null then
    delete from faktura.sjekkliste_svar where org_id = _org and utfylling_id = _utfylling and punkt_id = _punkt;
    return;
  end if;
  if _svar not in ('ok', 'avvik') then raise exception 'Ugyldig svar' using errcode = 'FA400'; end if;
  _kommentar := nullif(btrim(coalesce(_kommentar, '')), '');
  if _svar = 'avvik' and length(coalesce(_kommentar, '')) < 2 then
    raise exception 'Skriv hva avviket er' using errcode = 'FA400';
  end if;
  if length(coalesce(_kommentar, '')) > 2000 then raise exception 'Kommentaren kan ha høyst 2000 tegn' using errcode = 'FA400'; end if;
  insert into faktura.sjekkliste_svar (org_id, utfylling_id, punkt_id, punkt_tekst, svar, kommentar, besvart_av, besvart_navn)
  values (_org, _utfylling, _punkt, t, _svar, _kommentar, faktura.bruker_id(), faktura.sjekkliste_navn(_org))
  on conflict (org_id, utfylling_id, punkt_id) do update
     set punkt_tekst = excluded.punkt_tekst, svar = excluded.svar, kommentar = excluded.kommentar,
         besvart = now(), besvart_av = excluded.besvart_av, besvart_navn = excluded.besvart_navn;
end $$;

-- «Alt normalt»: punktene uten svar får «ok». Gir hvor mange.
create function faktura.sjekkliste_alt_normalt(_org uuid, _utfylling uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  u faktura.sjekkliste_utfyllinger := faktura.sjekkliste_utfylling_for_svar(_org, _utfylling);
  n integer;
begin
  insert into faktura.sjekkliste_svar (org_id, utfylling_id, punkt_id, punkt_tekst, svar, besvart_av, besvart_navn)
  select _org, _utfylling, x.id, x.tekst, 'ok', faktura.bruker_id(), faktura.sjekkliste_navn(_org)
    from faktura.sjekkliste_punkter x
   where x.org_id = _org and x.sjekkliste_id = u.sjekkliste_id and x.aktiv
     and not exists (select 1 from faktura.sjekkliste_svar s where s.org_id = _org and s.utfylling_id = _utfylling and s.punkt_id = x.id)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Fullfører sjekklisten (alle punktene i lista må være besvart). Gir antall avvik (varselet til
-- administrator sendes av API-et).
create function faktura.fullfor_sjekkliste(_org uuid, _utfylling uuid, _kommentar text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  u faktura.sjekkliste_utfyllinger := faktura.sjekkliste_utfylling_for_svar(_org, _utfylling);
  mangler integer;
begin
  select count(*) into mangler from faktura.sjekkliste_punkter x
   where x.org_id = _org and x.sjekkliste_id = u.sjekkliste_id and x.aktiv
     and not exists (select 1 from faktura.sjekkliste_svar s where s.org_id = _org and s.utfylling_id = _utfylling and s.punkt_id = x.id);
  if mangler > 0 then
    raise exception 'Svar på alle punktene først (% gjenstår)', mangler using errcode = 'FA400';
  end if;
  _kommentar := nullif(btrim(coalesce(_kommentar, '')), '');
  if length(coalesce(_kommentar, '')) > 2000 then raise exception 'Kommentaren kan ha høyst 2000 tegn' using errcode = 'FA400'; end if;
  update faktura.sjekkliste_utfyllinger
     set status = 'fullfort', fullfort = now(), fullfort_av = faktura.bruker_id(), fullfort_navn = faktura.sjekkliste_navn(_org),
         kommentar = coalesce(_kommentar, kommentar)
   where org_id = _org and id = _utfylling;
  return (select count(*)::int from faktura.sjekkliste_svar s where s.org_id = _org and s.utfylling_id = _utfylling and s.svar = 'avvik');
end $$;

-- ---------------------------------------------------------------------------
-- Avvikene (administrator)
-- ---------------------------------------------------------------------------

-- Lukker et avvik med det som er gjort. Gir brukeren som meldte det (for varselet).
create function faktura.lukk_sjekkliste_avvik(_org uuid, _utfylling uuid, _punkt uuid, _tiltak text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  meldt uuid;
begin
  perform faktura.krev(_org, 'personal');
  _tiltak := nullif(btrim(coalesce(_tiltak, '')), '');
  if length(coalesce(_tiltak, '')) < 2 then raise exception 'Skriv hva som er gjort med avviket' using errcode = 'FA400'; end if;
  if length(_tiltak) > 2000 then raise exception 'Tiltaket kan ha høyst 2000 tegn' using errcode = 'FA400'; end if;
  update faktura.sjekkliste_svar
     set avvik_lukket = now(), avvik_lukket_av = faktura.bruker_id(), avvik_lukket_navn = faktura.sjekkliste_navn(_org), tiltak = _tiltak
   where org_id = _org and utfylling_id = _utfylling and punkt_id = _punkt and svar = 'avvik' and avvik_lukket is null
  returning besvart_av into meldt;
  if not found then raise exception 'Fant ikke et åpent avvik' using errcode = 'FA404'; end if;
  return meldt;
end $$;

revoke all on function
  faktura.sjekkliste_periode(text, date), faktura.sjekkliste_navn(uuid), faktura.kan_gjore_sjekkliste(uuid, uuid[]),
  faktura.ser_sjekkliste(uuid, uuid), faktura.lagre_sjekkliste(uuid, uuid, text, text, text, uuid[], jsonb),
  faktura.sett_sjekkliste_aktiv(uuid, uuid, boolean), faktura.slett_sjekkliste(uuid, uuid),
  faktura.sjekkliste_utfylling_for_svar(uuid, uuid), faktura.start_sjekkliste(uuid, uuid, date),
  faktura.svar_sjekkliste(uuid, uuid, uuid, text, text), faktura.sjekkliste_alt_normalt(uuid, uuid),
  faktura.fullfor_sjekkliste(uuid, uuid, text), faktura.lukk_sjekkliste_avvik(uuid, uuid, uuid, text)
from public;
grant execute on function
  faktura.sjekkliste_periode(text, date), faktura.sjekkliste_navn(uuid), faktura.kan_gjore_sjekkliste(uuid, uuid[]),
  faktura.ser_sjekkliste(uuid, uuid)
to faktura_app, faktura_system;
grant execute on function
  faktura.lagre_sjekkliste(uuid, uuid, text, text, text, uuid[], jsonb), faktura.sett_sjekkliste_aktiv(uuid, uuid, boolean),
  faktura.slett_sjekkliste(uuid, uuid), faktura.start_sjekkliste(uuid, uuid, date), faktura.svar_sjekkliste(uuid, uuid, uuid, text, text),
  faktura.sjekkliste_alt_normalt(uuid, uuid), faktura.fullfor_sjekkliste(uuid, uuid, text), faktura.lukk_sjekkliste_avvik(uuid, uuid, uuid, text)
to faktura_app;
