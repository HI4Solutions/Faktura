-- Naturalytelser og reiser (server/src/naturalytelser.ts, server/src/reise.ts, server/src/lonn.ts,
-- web/src/sider/LonnNaturalytelser.tsx og web/src/sider/LonnReiser.tsx).
--
-- Naturalytelser: faste fordeler per ansatt som ikke utbetales, men er trekkpliktige og gir
-- arbeidsgiveravgift: fri bil (etter listeprisen), elektronisk kommunikasjon (sjablongen),
-- forsikringer, rentefordel på lån (normrenten), fri bolig og andre. Den ordinære lønnskjøringen
-- tar dem med hver måned de gjelder (påbegynt måned).
--
-- Reiseregninger: den ansatte (eller eier og administrator) fører reisen med tidene, overnattingen,
-- måltidene som er dekket, kjøringen med egen bil og utleggene, og sender den. Eier og
-- administrator godkjenner (beregningen lagres da) eller avviser med en grunn, og neste
-- lønnskjøring betaler den: diett, nattillegg og kilometergodtgjørelse innenfor de trekkfrie
-- satsene som trekkfri utgiftsgodtgjørelse, det som er over som trekkpliktig, og utleggene etter
-- regning. Reiseregningen merkes som utbetalt når kjøringen godkjennes.
--
-- lonn_oppsett.reise_satser: satsene som betales (statens satser, der det som er over de trekkfrie
-- satsene blir trekkpliktig, eller bare de trekkfrie satsene).

-- ---------------------------------------------------------------------------
-- Naturalytelser
-- ---------------------------------------------------------------------------

create table faktura.naturalytelser (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  ansatt_id uuid not null,
  type text not null check (type in ('bil', 'ek', 'forsikring', 'rentefordel', 'bolig', 'annet')),
  tekst text check (tekst is null or length(btrim(tekst)) between 1 and 100),
  -- Beløpet per måned (forsikring, bolig og annet; for elektronisk kommunikasjon: den faktiske
  -- kostnaden når den er lavere enn sjablongen).
  belop numeric(12,2) check (belop is null or (belop > 0 and belop <= 10000000)),
  -- Fri bil: listeprisen som ny, registreringsnummeret (eller bilpool), datoen bilen ble registrert
  -- første gang (eldre enn tre år ved årets begynnelse gir 75 %) og yrkeskjøring over 40 000 km i
  -- året (elektronisk kjørebok; også 75 %).
  listepris numeric(12,2) check (listepris is null or (listepris > 0 and listepris <= 100000000)),
  regnr text check (regnr is null or regnr ~ '^[A-ZÆØÅ0-9]{2,10}$'),
  bilpool boolean not null default false,
  forstegangsreg date,
  yrkeskjoring boolean not null default false,
  -- Rentefordel: lånet (saldoen) og renten den ansatte betaler (prosent per år).
  laan numeric(14,2) check (laan is null or (laan > 0 and laan <= 1000000000)),
  rente numeric(6,3) check (rente is null or (rente >= 0 and rente <= 100)),
  fra date not null,
  til date,
  opprettet timestamptz not null default clock_timestamp(),
  oppdatert timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete cascade,
  check (til is null or til >= fra),
  check (type <> 'bil' or (listepris is not null and (regnr is not null or bilpool))),
  check (type <> 'rentefordel' or (laan is not null and rente is not null)),
  check (type in ('bil', 'ek', 'rentefordel') or belop is not null)
);
create index naturalytelser_ansatt on faktura.naturalytelser (org_id, ansatt_id);
create trigger naturalytelser_oppdatert before update on faktura.naturalytelser
  for each row execute function faktura.sett_oppdatert();
create trigger naturalytelser_org_id before update on faktura.naturalytelser
  for each row execute function faktura.org_id_uendret();
create trigger naturalytelser_revisjon after insert or update or delete on faktura.naturalytelser
  for each row execute function faktura.revider();

-- De som ser lønnen, og den ansatte selv, ser dem; eier og administrator endrer dem.
alter table faktura.naturalytelser enable row level security;
create policy naturalytelser_les on faktura.naturalytelser for select
  using (faktura.kan(org_id, 'personal_les') or faktura.er_meg(org_id, ansatt_id));
create policy naturalytelser_ny on faktura.naturalytelser for insert with check (faktura.kan(org_id, 'personal'));
create policy naturalytelser_endre on faktura.naturalytelser for update
  using (faktura.kan(org_id, 'personal')) with check (faktura.kan(org_id, 'personal'));
create policy naturalytelser_slett on faktura.naturalytelser for delete using (faktura.kan(org_id, 'personal'));
grant select, delete,
      insert (org_id, ansatt_id, type, tekst, belop, listepris, regnr, bilpool, forstegangsreg, yrkeskjoring, laan, rente, fra, til),
      update (type, tekst, belop, listepris, regnr, bilpool, forstegangsreg, yrkeskjoring, laan, rente, fra, til)
  on faktura.naturalytelser to faktura_app;
grant select on faktura.naturalytelser to faktura_system;

-- ---------------------------------------------------------------------------
-- Reiseregninger
-- ---------------------------------------------------------------------------

-- fra og til: avreise og hjemkomst (norsk tid). overnatting: ingen (dagsreise), hotell, hybel
-- (hybel, pensjonat eller brakke uten kokemulighet) eller privat (hybel med kokemulighet eller
-- privat). nattillegg: ulegitimert nattillegg (innenlands, ikke på hotell). utland: reise i
-- utlandet, med landet og statens sats per døgn for landet (kostsats). diett: kostgodtgjørelse (ikke
-- når måltidene dekkes etter regning). maaltider: måltidene som er dekket per døgn, f.eks.
-- {"1": "F", "2": "FLM"} (frokost, lunsj, middag). kjoring: etappene med egen bil o.l. (dato, fra,
-- til, km, kjøretøy, passasjerene, km på skogsvei, tilhenger). utlegg: utleggene etter regning
-- (dato, tekst, beløp). trekkfri: vilkårene for trekkfri godtgjørelse er oppfylt (eier og
-- administrator tar det bort når de ikke er det; da er alt trekkpliktig). beregning: linjene som
-- utbetales (lagres når reiseregningen godkjennes), og belop summen.
create table faktura.reiseregninger (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  ansatt_id uuid not null,
  status text not null default 'utkast' check (status in ('utkast', 'sendt', 'godkjent', 'avvist')),
  formaal text not null check (length(btrim(formaal)) between 1 and 200),
  sted text check (sted is null or length(btrim(sted)) between 1 and 200),
  fra timestamp not null,
  til timestamp not null,
  overnatting text not null default 'ingen' check (overnatting in ('ingen', 'hotell', 'hybel', 'privat')),
  nattillegg boolean not null default false,
  utland boolean not null default false,
  land text check (land is null or length(btrim(land)) between 1 and 60),
  kostsats numeric(8,2) check (kostsats is null or (kostsats > 0 and kostsats <= 100000)),
  diett boolean not null default true,
  maaltider jsonb not null default '{}' check (jsonb_typeof(maaltider) = 'object'),
  kjoring jsonb not null default '[]' check (jsonb_typeof(kjoring) = 'array' and jsonb_array_length(kjoring) <= 200),
  utlegg jsonb not null default '[]' check (jsonb_typeof(utlegg) = 'array' and jsonb_array_length(utlegg) <= 200),
  merknad text check (merknad is null or length(merknad) <= 500),
  trekkfri boolean not null default true,
  beregning jsonb check (beregning is null or jsonb_typeof(beregning) = 'array'),
  belop numeric(12,2) check (belop is null or (belop >= 0 and belop <= 10000000)),
  avvist_grunn text check (avvist_grunn is null or length(avvist_grunn) <= 300),
  sendt_at timestamptz,
  godkjent_av uuid references faktura.brukere(id) on delete set null,
  godkjent_at timestamptz,
  lonnskjoring_id uuid references faktura.lonnskjoringer(id) on delete set null,
  opprettet_av uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null,
  opprettet timestamptz not null default clock_timestamp(),
  oppdatert timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete cascade,
  check (til > fra and til - fra <= interval '92 days'),
  check (overnatting <> 'ingen' or til - fra <= interval '24 hours'),
  check (not nattillegg or (overnatting in ('hybel', 'privat') and not utland)),
  check (utland or (land is null and kostsats is null)),
  check ((status = 'godkjent') = (beregning is not null and belop is not null)),
  check (lonnskjoring_id is null or status = 'godkjent')
);
create index reiseregninger_ansatt on faktura.reiseregninger (org_id, ansatt_id, fra);
create index reiseregninger_til_utbetaling on faktura.reiseregninger (org_id) where status = 'godkjent' and lonnskjoring_id is null;
create index reiseregninger_kjoring on faktura.reiseregninger (lonnskjoring_id) where lonnskjoring_id is not null;
create trigger reiseregninger_oppdatert before update on faktura.reiseregninger
  for each row execute function faktura.sett_oppdatert();
create trigger reiseregninger_org_id before update on faktura.reiseregninger
  for each row execute function faktura.org_id_uendret();
create trigger reiseregninger_revisjon after insert or update or delete on faktura.reiseregninger
  for each row execute function faktura.revider();

-- De som ser lønnen, og den ansatte selv, ser reiseregningene. De lages og endres bare gjennom
-- funksjonene under.
alter table faktura.reiseregninger enable row level security;
create policy reiseregninger_les on faktura.reiseregninger for select
  using (faktura.kan(org_id, 'personal_les') or faktura.er_meg(org_id, ansatt_id));
grant select on faktura.reiseregninger to faktura_app, faktura_system;

-- Den ansatte lagrer sin egen reiseregning (eier og administrator også for en ansatt). Ny når _id
-- er null. En reiseregning som er utbetalt, endres ikke; den ansatte endrer ikke en godkjent. Endres
-- en avvist, blir den et utkast igjen; endres en godkjent (eier og administrator), må den godkjennes
-- på nytt.
create function faktura.lagre_reiseregning(_org uuid, _id uuid, _ansatt uuid, _r jsonb) returns faktura.reiseregninger
language plpgsql security definer set search_path = '' as $$
declare
  leder boolean := faktura.kan(_org, 'personal');
  meg uuid := faktura.min_ansatt(_org);
  a uuid;
  x faktura.reiseregninger;
begin
  if _id is null then
    a := coalesce(_ansatt, meg);
    if a is null then raise exception 'Velg den ansatte' using errcode = 'FA400'; end if;
    if not leder and a is distinct from meg then
      raise exception 'Du kan bare føre reiseregninger for deg selv' using errcode = 'FA403';
    end if;
    if not exists (select 1 from faktura.ansatte where org_id = _org and id = a and arbeidstaker) then
      raise exception 'Fant ikke den ansatte' using errcode = 'FA404';
    end if;
    insert into faktura.reiseregninger (org_id, ansatt_id, formaal, sted, fra, til, overnatting, nattillegg, utland, land, kostsats,
                                        diett, maaltider, kjoring, utlegg, merknad)
    values (_org, a, btrim(_r->>'formaal'), nullif(btrim(_r->>'sted'), ''), (_r->>'fra')::timestamp, (_r->>'til')::timestamp,
            coalesce(_r->>'overnatting', 'ingen'), coalesce((_r->>'nattillegg')::boolean, false), coalesce((_r->>'utland')::boolean, false),
            nullif(btrim(_r->>'land'), ''), (_r->>'kostsats')::numeric, coalesce((_r->>'diett')::boolean, true),
            coalesce(_r->'maaltider', '{}'), coalesce(_r->'kjoring', '[]'), coalesce(_r->'utlegg', '[]'), nullif(btrim(_r->>'merknad'), ''))
    returning * into x;
    return x;
  end if;
  select * into x from faktura.reiseregninger where org_id = _org and id = _id for update;
  if not found or not (leder or faktura.er_meg(_org, x.ansatt_id)) then
    raise exception 'Fant ikke reiseregningen' using errcode = 'FA404';
  end if;
  if x.lonnskjoring_id is not null then raise exception 'Reiseregningen er utbetalt og kan ikke endres' using errcode = 'FA409'; end if;
  if x.status = 'godkjent' and not leder then raise exception 'Reiseregningen er godkjent og kan ikke endres' using errcode = 'FA409'; end if;
  update faktura.reiseregninger
     set formaal = btrim(_r->>'formaal'), sted = nullif(btrim(_r->>'sted'), ''), fra = (_r->>'fra')::timestamp, til = (_r->>'til')::timestamp,
         overnatting = coalesce(_r->>'overnatting', 'ingen'), nattillegg = coalesce((_r->>'nattillegg')::boolean, false),
         utland = coalesce((_r->>'utland')::boolean, false), land = nullif(btrim(_r->>'land'), ''), kostsats = (_r->>'kostsats')::numeric,
         diett = coalesce((_r->>'diett')::boolean, true), maaltider = coalesce(_r->'maaltider', '{}'), kjoring = coalesce(_r->'kjoring', '[]'),
         utlegg = coalesce(_r->'utlegg', '[]'), merknad = nullif(btrim(_r->>'merknad'), ''),
         status = case x.status when 'avvist' then 'utkast' when 'godkjent' then 'sendt' else x.status end,
         avvist_grunn = case when x.status = 'avvist' then null else x.avvist_grunn end,
         beregning = null, belop = null, godkjent_av = null, godkjent_at = null
   where id = x.id
  returning * into x;
  return x;
end $$;

-- Den ansatte (eller eier og administrator) sender et utkast eller en avvist reiseregning.
create function faktura.send_reiseregning(_org uuid, _id uuid) returns faktura.reiseregninger
language plpgsql security definer set search_path = '' as $$
declare
  x faktura.reiseregninger;
begin
  select * into x from faktura.reiseregninger where org_id = _org and id = _id for update;
  if not found or not (faktura.kan(_org, 'personal') or faktura.er_meg(_org, x.ansatt_id)) then
    raise exception 'Fant ikke reiseregningen' using errcode = 'FA404';
  end if;
  if x.status not in ('utkast', 'avvist') then raise exception 'Reiseregningen er allerede sendt' using errcode = 'FA409'; end if;
  update faktura.reiseregninger set status = 'sendt', sendt_at = now(), avvist_grunn = null where id = x.id returning * into x;
  return x;
end $$;

-- Eier og administrator godkjenner (et utkast eller en sendt reiseregning) med beregningen som
-- utbetales, og om vilkårene for trekkfri godtgjørelse er oppfylt.
create function faktura.godkjenn_reiseregning(_org uuid, _id uuid, _trekkfri boolean, _beregning jsonb, _belop numeric)
returns faktura.reiseregninger
language plpgsql security definer set search_path = '' as $$
declare
  x faktura.reiseregninger;
begin
  perform faktura.krev(_org, 'personal');
  select * into x from faktura.reiseregninger where org_id = _org and id = _id for update;
  if not found then raise exception 'Fant ikke reiseregningen' using errcode = 'FA404'; end if;
  if x.status not in ('utkast', 'sendt') then
    raise exception '%', case x.status when 'godkjent' then 'Reiseregningen er allerede godkjent' else 'Reiseregningen er avvist' end
      using errcode = 'FA409';
  end if;
  if _beregning is null or jsonb_typeof(_beregning) <> 'array' or _belop is null or _belop < 0 then
    raise exception 'Beregningen mangler' using errcode = 'FA400';
  end if;
  update faktura.reiseregninger
     set status = 'godkjent', trekkfri = coalesce(_trekkfri, true), beregning = _beregning, belop = round(_belop, 2),
         godkjent_av = faktura.bruker_id(), godkjent_at = now(), sendt_at = coalesce(sendt_at, now()), avvist_grunn = null
   where id = x.id returning * into x;
  return x;
end $$;

-- Eier og administrator avviser en sendt reiseregning med en grunn (den ansatte kan rette og sende
-- den på nytt).
create function faktura.avvis_reiseregning(_org uuid, _id uuid, _grunn text) returns faktura.reiseregninger
language plpgsql security definer set search_path = '' as $$
declare
  x faktura.reiseregninger;
begin
  perform faktura.krev(_org, 'personal');
  select * into x from faktura.reiseregninger where org_id = _org and id = _id for update;
  if not found then raise exception 'Fant ikke reiseregningen' using errcode = 'FA404'; end if;
  if x.status <> 'sendt' then raise exception 'Bare en sendt reiseregning kan avvises' using errcode = 'FA409'; end if;
  if nullif(btrim(_grunn), '') is null then raise exception 'Skriv hvorfor reiseregningen avvises' using errcode = 'FA400'; end if;
  if length(_grunn) > 300 then raise exception 'Grunnen kan ha høyst 300 tegn' using errcode = 'FA400'; end if;
  update faktura.reiseregninger set status = 'avvist', avvist_grunn = btrim(_grunn) where id = x.id returning * into x;
  return x;
end $$;

-- Eier og administrator åpner en godkjent reiseregning som ikke er utbetalt (den er sendt igjen).
create function faktura.apne_reiseregning(_org uuid, _id uuid) returns faktura.reiseregninger
language plpgsql security definer set search_path = '' as $$
declare
  x faktura.reiseregninger;
begin
  perform faktura.krev(_org, 'personal');
  select * into x from faktura.reiseregninger where org_id = _org and id = _id for update;
  if not found then raise exception 'Fant ikke reiseregningen' using errcode = 'FA404'; end if;
  if x.status <> 'godkjent' then raise exception 'Reiseregningen er ikke godkjent' using errcode = 'FA409'; end if;
  if x.lonnskjoring_id is not null then raise exception 'Reiseregningen er utbetalt' using errcode = 'FA409'; end if;
  update faktura.reiseregninger set status = 'sendt', beregning = null, belop = null, godkjent_av = null, godkjent_at = null
   where id = x.id returning * into x;
  return x;
end $$;

-- Den ansatte sletter sin egen reiseregning som ikke er godkjent; eier og administrator en som ikke
-- er utbetalt.
create function faktura.slett_reiseregning(_org uuid, _id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  x faktura.reiseregninger;
begin
  select * into x from faktura.reiseregninger where org_id = _org and id = _id for update;
  if not found or not (faktura.kan(_org, 'personal') or faktura.er_meg(_org, x.ansatt_id)) then
    raise exception 'Fant ikke reiseregningen' using errcode = 'FA404';
  end if;
  if x.lonnskjoring_id is not null then raise exception 'Reiseregningen er utbetalt og kan ikke slettes' using errcode = 'FA409'; end if;
  if x.status = 'godkjent' and not faktura.kan(_org, 'personal') then
    raise exception 'Reiseregningen er godkjent og kan ikke slettes' using errcode = 'FA409';
  end if;
  delete from faktura.reiseregninger where id = x.id;
end $$;

revoke execute on function faktura.lagre_reiseregning(uuid, uuid, uuid, jsonb), faktura.send_reiseregning(uuid, uuid),
  faktura.godkjenn_reiseregning(uuid, uuid, boolean, jsonb, numeric), faktura.avvis_reiseregning(uuid, uuid, text),
  faktura.apne_reiseregning(uuid, uuid), faktura.slett_reiseregning(uuid, uuid) from public;
grant execute on function faktura.lagre_reiseregning(uuid, uuid, uuid, jsonb), faktura.send_reiseregning(uuid, uuid),
  faktura.godkjenn_reiseregning(uuid, uuid, boolean, jsonb, numeric), faktura.avvis_reiseregning(uuid, uuid, text),
  faktura.apne_reiseregning(uuid, uuid), faktura.slett_reiseregning(uuid, uuid) to faktura_app;

-- ---------------------------------------------------------------------------
-- Lønnskjøringen
-- ---------------------------------------------------------------------------

-- Satsene for reiser: statens satser (det som er over de trekkfrie, er trekkpliktig) eller de
-- trekkfrie satsene.
alter table faktura.lonn_oppsett
  add column reise_satser text not null default 'staten' check (reise_satser in ('staten', 'trekkfri'));
grant insert (reise_satser), update (reise_satser) on faktura.lonn_oppsett to faktura_app;

-- Naturalytelsene på slippen (trekkpliktige, utbetales ikke), og reiseregningene som utbetales
-- (merkes når kjøringen godkjennes).
alter table faktura.lonnsslipper
  add column naturalytelser numeric(12,2) not null default 0,
  add column reiseregninger uuid[] not null default '{}';
grant insert (naturalytelser, reiseregninger), update (naturalytelser, reiseregninger) on faktura.lonnsslipper to faktura_app;

-- Tilleggsinformasjon til a-meldingen på linjen (fri bil: listeprisen og registreringsnummeret).
alter table faktura.lonnslinjer
  add column tillegg jsonb check (tillegg is null or jsonb_typeof(tillegg) = 'object');
grant insert (tillegg), update (tillegg) on faktura.lonnslinjer to faktura_app;

-- Som før (0073), og reiseregningene på slippene merkes som utbetalt. De må fortsatt være
-- godkjent, ikke utbetalt i en annen kjøring, og ikke godkjent på nytt etter at slippen ble regnet ut.
create or replace function faktura.lonn_godkjenn(_kjoring uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  k faktura.lonnskjoringer;
  ider uuid[];
  n int;
begin
  select * into k from faktura.lonnskjoringer where id = _kjoring for update;
  if k.id is null then raise exception 'Fant ikke lønnskjøringen' using errcode = 'FA404'; end if;
  perform faktura.krev(k.org_id, 'personal');
  if k.status <> 'utkast' then raise exception 'Lønnskjøringen er alt godkjent' using errcode = 'FA409'; end if;
  if not exists (select 1 from faktura.lonnsslipper where kjoring_id = k.id) then
    raise exception 'Lønnskjøringen har ingen lønnsslipper' using errcode = 'FA400';
  end if;
  -- (Før slippene endres under, så tidspunktet de ble regnet ut, står.)
  if exists (select 1
               from faktura.lonnsslipper s
               cross join lateral unnest(s.reiseregninger) as u(id)
               left join faktura.reiseregninger r on r.org_id = s.org_id and r.id = u.id
              where s.kjoring_id = k.id
                and (r.id is null or r.status <> 'godkjent' or r.lonnskjoring_id is not null or r.godkjent_at > s.oppdatert)) then
    raise exception 'Noen av reiseregningene er endret eller utbetalt i en annen kjøring. Regn ut lønnen på nytt.' using errcode = 'FA409';
  end if;
  update faktura.lonnsslipper s set kontonr = a.kontonr
    from faktura.ansatte a
   where s.kjoring_id = k.id and a.org_id = s.org_id and a.id = s.ansatt_id;
  ider := array(select distinct x from faktura.lonnsslipper s, unnest(s.timeforinger) x where s.kjoring_id = k.id);
  update faktura.timeforinger set lonnskjoring_id = k.id
   where org_id = k.org_id and id = any(ider) and status = 'godkjent' and lonnskjoring_id is null;
  get diagnostics n = row_count;
  if n <> coalesce(cardinality(ider), 0) then
    raise exception 'Noen av timene er endret eller lønnet i en annen kjøring. Regn ut lønnen på nytt.' using errcode = 'FA409';
  end if;
  ider := array(select distinct x from faktura.lonnsslipper s, unnest(s.timebank_poster) x where s.kjoring_id = k.id);
  update faktura.timebank_poster set lonnskjoring_id = k.id
   where org_id = k.org_id and id = any(ider) and type = 'utbetaling' and lonnskjoring_id is null;
  get diagnostics n = row_count;
  if n <> coalesce(cardinality(ider), 0) then
    raise exception 'Noen av utbetalingene fra timebanken er endret eller lønnet i en annen kjøring. Regn ut lønnen på nytt.' using errcode = 'FA409';
  end if;
  update faktura.reiseregninger r set lonnskjoring_id = k.id
    from faktura.lonnsslipper s
   where s.kjoring_id = k.id and r.org_id = s.org_id and r.id = any(s.reiseregninger);
  update faktura.lonnskjoringer set status = 'godkjent', godkjent_at = now(), godkjent_av = faktura.bruker_id() where id = k.id;
end $$;

-- Som før (0078), og reiseregningene er ikke lenger utbetalt.
create or replace function faktura.lonn_gjenapne(_kjoring uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  k faktura.lonnskjoringer;
  b uuid;
begin
  select * into k from faktura.lonnskjoringer where id = _kjoring for update;
  if k.id is null then raise exception 'Fant ikke lønnskjøringen' using errcode = 'FA404'; end if;
  perform faktura.krev(k.org_id, 'personal');
  if k.status <> 'godkjent' then raise exception 'Lønnskjøringen er ikke godkjent' using errcode = 'FA409'; end if;
  update faktura.timeforinger set lonnskjoring_id = null where lonnskjoring_id = k.id;
  update faktura.timebank_poster set lonnskjoring_id = null where lonnskjoring_id = k.id;
  update faktura.reiseregninger set lonnskjoring_id = null where lonnskjoring_id = k.id;
  update faktura.lonnskjoringer set status = 'utkast', godkjent_at = null, godkjent_av = null where id = k.id;
  -- Kontonummeret settes på nytt når kjøringen godkjennes.
  update faktura.lonnsslipper set kontonr = null where kjoring_id = k.id;
  select id into b from faktura.bilag
   where org_id = k.org_id and kilde = 'lonn' and kilde_id = k.id and reverserer is null and reversert_av is null;
  if b is not null then
    perform faktura.reverser_bilag(b, 'Reversert: lønnskjøringen er åpnet igjen');
  end if;
end $$;

-- Bokføringen: kilometergodtgjørelse (7100), diett og nattillegg (7150), utlegg på reise (7140), og
-- naturalytelsene med motkonto (5280 og 5290).
create or replace function faktura.lonnskontoer_gyldige(_k jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(_k) = 'object'
     and not exists (
       select 1 from jsonb_each(_k) e
        where e.key not in ('lonn', 'feriepenger', 'aga', 'aga_feriepenger', 'otp', 'utgifter', 'forskuddstrekk', 'andre_trekk',
                            'paaleggstrekk', 'bidragstrekk', 'forskudd', 'bilgodtgjorelse', 'diett', 'reiseutlegg',
                            'naturalytelser', 'naturalytelser_mot',
                            'skyldig_aga', 'paalopt_aga_feriepenger', 'skyldig_lonn', 'skyldige_feriepenger', 'skyldig_otp', 'bank')
           or jsonb_typeof(e.value) <> 'string'
           or (e.value #>> '{}') !~ '^[0-9]{4,6}$')
$$;

-- Revisjonsloggen for naturalytelsene og reiseregningene er, som for lønnen, bare for dem som ser
-- lønnen.
drop policy revisjonslogg_les on faktura.revisjonslogg;
create policy revisjonslogg_les on faktura.revisjonslogg for select
  using (faktura.kan(org_id, 'les')
         and (coalesce(tabell, '') not in ('ansatte', 'ansatt_tillegg', 'fravaer', 'arbeidsplaner', 'ferie_overforinger', 'vaktbytter',
                                           'lonnskjoringer', 'lonn_inngaende', 'timebank_poster', 'avspasering_soknader',
                                           'ameldinger', 'bilag', 'lonnsendringer', 'nav_inntektsmeldinger', 'lonnstrekk',
                                           'naturalytelser', 'reiseregninger')
              or faktura.kan(org_id, 'personal_les'))
         and (coalesce(tabell, '') not in ('fravaer', 'ferie_overforinger', 'avspasering_soknader', 'vaktbytter', 'nav_inntektsmeldinger')
              or faktura.kan(org_id, 'personal')));
