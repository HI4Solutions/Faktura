-- Lønnskjøring (steg 3): eier og administrator lager en lønnskjøring for en måned, og API-et
-- (server/src/lonn.ts) regner ut en lønnsslipp for hver ansatt med linjene (fastlønn eller
-- timelønn, overtid og merarbeid fra de godkjente timene, faste tillegg, sykepenger i
-- arbeidsgiverperioden, feriepenger og ferietrekk), skattetrekket etter skattekortet (tabell,
-- prosent eller frikort; uten skattekort 50 %), opptjente feriepenger, OTP og
-- arbeidsgiveravgift. Linjene kan endres, fjernes og legges til før kjøringen godkjennes; da
-- låses den, timene merkes som lønnet, og de ansatte ser sine lønnsslipper. Den kan åpnes igjen.
--
-- Skattekortet registreres på den ansatte (fra Altinn eller skattekortet den ansatte har fått).
-- Trekktabellene er Skatteetatens tabeller i tekstformat, som plattformadministratoren laster
-- opp for hvert år (bare månedstabellene for lønn lagres). Tall fra et tidligere lønnssystem
-- (feriepengegrunnlag, utbetalte feriepenger og trekkpliktig lønn i år) registreres per år.

-- ---------------------------------------------------------------------------
-- Funksjonen «Lønn» (bygger på ansatte og timer)
-- ---------------------------------------------------------------------------

insert into faktura.funksjoner (kode, navn, beskrivelse, rekkefolge, krever, modul)
values ('lonn', 'Lønn', 'Lønnskjøring med skattetrekk, feriepenger, OTP, arbeidsgiveravgift og lønnsslipper', 12, 'ansatte', 'bemanning');
update faktura.moduler
   set beskrivelse = 'Ansatte og timeføring, lønn, vaktplan, tavle, fravær og vikarer, bemanningskalender og faste arbeidsdager'
 where kode = 'bemanning';
-- Organisasjonene som har ansatte og timer, får lønn med en gang.
insert into faktura.org_funksjoner (org_id, kode, aktiv)
select o.org_id, 'lonn', o.aktiv from faktura.org_funksjoner o where o.kode = 'ansatte'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Oppsett per organisasjon
-- ---------------------------------------------------------------------------

-- aga_sone: sonen for arbeidsgiveravgift (1: 14,1 %, 1a: 10,6 % til fribeløpet er brukt, 2: 10,6 %,
-- 3: 6,4 %, 4: 5,1 %, 4a: 7,9 %, 5: 0 %). otp_prosent: innskuddet til obligatorisk tjenestepensjon
-- (minst 2 % fra første krone opp til 12 G; 0 når organisasjonen ikke har OTP). feriepenger_prosent:
-- 10,2 (fire uker og én dag) eller 12 (fem uker). lonnsdag: dagen i måneden lønnen utbetales
-- (virkedagen før når den faller på en helg eller helligdag). halv_skatt: måneden med halvt
-- tabelltrekk.
alter table faktura.lonn_oppsett
  add column aga_sone text not null default '1' check (aga_sone in ('1', '1a', '2', '3', '4', '4a', '5')),
  add column otp_prosent numeric(5,2) not null default 2 check (otp_prosent >= 0 and otp_prosent <= 25),
  add column feriepenger_prosent numeric(5,2) not null default 12 check (feriepenger_prosent >= 10.2 and feriepenger_prosent <= 20),
  add column lonnsdag int not null default 20 check (lonnsdag between 1 and 31),
  add column halv_skatt text not null default 'desember' check (halv_skatt in ('november', 'desember'));
-- Fire uker og én dag ferie: 10,2 %.
update faktura.lonn_oppsett set feriepenger_prosent = 10.2 where ferie_dager < 25;
grant insert (aga_sone, otp_prosent, feriepenger_prosent, lonnsdag, halv_skatt),
      update (aga_sone, otp_prosent, feriepenger_prosent, lonnsdag, halv_skatt)
  on faktura.lonn_oppsett to faktura_app;

-- ---------------------------------------------------------------------------
-- Skattekortet på den ansatte
-- ---------------------------------------------------------------------------

-- tabell: tabellnummer og prosentsatsen (for det som ikke er vanlig lønn); prosent: prosentsatsen;
-- frikort: beløpet som kan utbetales uten trekk (deretter 50 %). Uten skattekort: 50 %.
alter table faktura.ansatte
  add column skattekort text check (skattekort in ('tabell', 'prosent', 'frikort')),
  add column skatt_tabell int check (skatt_tabell between 1000 and 9999),
  add column skatt_prosent numeric(5,2) check (skatt_prosent >= 0 and skatt_prosent <= 100),
  add column skatt_frikort numeric(12,2) check (skatt_frikort >= 0 and skatt_frikort <= 100000000),
  add column skattekort_aar int check (skattekort_aar between 2000 and 2100),
  add constraint ansatte_skattekort check (
    skattekort is null
    or (skattekort = 'tabell' and skatt_tabell is not null and skatt_prosent is not null)
    or (skattekort = 'prosent' and skatt_prosent is not null)
    or (skattekort = 'frikort' and skatt_frikort is not null));
grant select (skattekort, skatt_tabell, skatt_prosent, skatt_frikort, skattekort_aar),
      insert (skattekort, skatt_tabell, skatt_prosent, skatt_frikort, skattekort_aar),
      update (skattekort, skatt_tabell, skatt_prosent, skatt_frikort, skattekort_aar)
  on faktura.ansatte to faktura_app;

-- ---------------------------------------------------------------------------
-- Tall fra et tidligere lønnssystem, per ansatt og år
-- ---------------------------------------------------------------------------

-- feriepengegrunnlag og feriepenger_utbetalt for opptjeningsåret (feriepengene for det året
-- utbetales året etter), trekkpliktig lønn og forskuddstrekk i året (frikortet og årsoversikten).
create table faktura.lonn_inngaende (
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  ansatt_id uuid not null,
  aar int not null check (aar between 2000 and 2100),
  feriepengegrunnlag numeric(12,2) not null default 0 check (feriepengegrunnlag >= 0 and feriepengegrunnlag <= 100000000),
  feriepenger_utbetalt numeric(12,2) not null default 0 check (feriepenger_utbetalt >= 0 and feriepenger_utbetalt <= 100000000),
  trekkpliktig numeric(12,2) not null default 0 check (trekkpliktig >= 0 and trekkpliktig <= 100000000),
  forskuddstrekk numeric(12,2) not null default 0 check (forskuddstrekk >= 0 and forskuddstrekk <= 100000000),
  oppdatert timestamptz not null default now(),
  primary key (ansatt_id, aar),
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete cascade
);
create trigger lonn_inngaende_oppdatert before update on faktura.lonn_inngaende
  for each row execute function faktura.sett_oppdatert();
create trigger lonn_inngaende_org_id before update on faktura.lonn_inngaende
  for each row execute function faktura.org_id_uendret();
create trigger lonn_inngaende_revisjon after insert or update or delete on faktura.lonn_inngaende
  for each row execute function faktura.revider();

alter table faktura.lonn_inngaende enable row level security;
create policy lonn_inngaende_les on faktura.lonn_inngaende for select
  using (faktura.kan(org_id, 'personal_les') or faktura.er_meg(org_id, ansatt_id));
create policy lonn_inngaende_ny on faktura.lonn_inngaende for insert with check (faktura.kan(org_id, 'personal'));
create policy lonn_inngaende_endre on faktura.lonn_inngaende for update
  using (faktura.kan(org_id, 'personal')) with check (faktura.kan(org_id, 'personal'));
create policy lonn_inngaende_slett on faktura.lonn_inngaende for delete using (faktura.kan(org_id, 'personal'));
grant select, delete,
      insert (org_id, ansatt_id, aar, feriepengegrunnlag, feriepenger_utbetalt, trekkpliktig, forskuddstrekk),
      update (feriepengegrunnlag, feriepenger_utbetalt, trekkpliktig, forskuddstrekk)
  on faktura.lonn_inngaende to faktura_app;

-- ---------------------------------------------------------------------------
-- Lønnskjøringer, lønnsslipper og lønnslinjer
-- ---------------------------------------------------------------------------

-- periode: måneden (den første dagen). type: ordinær (én i måneden) eller ekstra (f.eks. en bonus;
-- tabelltrekk går da etter prosentsatsen). feriepenger: feriepengene for i fjor utbetales i
-- kjøringen (vanligvis i juni). halv_skatt: halvt tabelltrekk (november eller desember).
create table faktura.lonnskjoringer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  periode date not null check (periode = date_trunc('month', periode)::date),
  type text not null default 'ordinar' check (type in ('ordinar', 'ekstra')),
  utbetalingsdato date not null,
  status text not null default 'utkast' check (status in ('utkast', 'godkjent')),
  feriepenger boolean not null default false,
  halv_skatt boolean not null default false,
  notat text check (notat is null or length(notat) <= 500),
  opprettet timestamptz not null default now(),
  opprettet_av uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null,
  godkjent_at timestamptz,
  godkjent_av uuid references faktura.brukere(id) on delete set null,
  oppdatert timestamptz not null default now(),
  unique (org_id, id),
  check ((status = 'godkjent') = (godkjent_at is not null)),
  check (utbetalingsdato between periode - 62 and periode + 92)
);
create unique index lonnskjoringer_ordinar on faktura.lonnskjoringer (org_id, periode) where type = 'ordinar';
create trigger lonnskjoringer_oppdatert before update on faktura.lonnskjoringer
  for each row execute function faktura.sett_oppdatert();
create trigger lonnskjoringer_org_id before update on faktura.lonnskjoringer
  for each row execute function faktura.org_id_uendret();
create trigger lonnskjoringer_revisjon after insert or update or delete on faktura.lonnskjoringer
  for each row execute function faktura.revider();

alter table faktura.lonnskjoringer enable row level security;
create policy lonnskjoringer_les on faktura.lonnskjoringer for select using (faktura.kan(org_id, 'personal_les'));
create policy lonnskjoringer_ny on faktura.lonnskjoringer for insert with check (faktura.kan(org_id, 'personal'));
create policy lonnskjoringer_endre on faktura.lonnskjoringer for update
  using (faktura.kan(org_id, 'personal') and status = 'utkast') with check (faktura.kan(org_id, 'personal') and status = 'utkast');
create policy lonnskjoringer_slett on faktura.lonnskjoringer for delete using (faktura.kan(org_id, 'personal') and status = 'utkast');
-- Status endres bare av lonn_godkjenn og lonn_gjenapne.
grant select, delete,
      insert (org_id, periode, type, utbetalingsdato, feriepenger, halv_skatt, notat),
      update (utbetalingsdato, feriepenger, halv_skatt, notat)
  on faktura.lonnskjoringer to faktura_app;

-- Én lønnsslipp per ansatt i kjøringen, med summene (regnet ut av API-et) og et øyeblikksbilde av
-- navnet, ansattnummeret, perioden og utbetalingsdatoen (så den ansatte, som ikke ser kjøringene,
-- har alt på slippen) og kontonummeret (satt når kjøringen godkjennes). trekkmetode: hvordan
-- skattetrekket er regnet (f.eks. «Tabell 7100»). trekkpliktig: all trekkpliktig lønn (også
-- feriepenger uten trekk); trekkgrunnlag: det trekket er regnet av. timeforinger: de godkjente
-- timene som lønnes (merkes når kjøringen godkjennes). merknader: det som bør sjekkes.
create table faktura.lonnsslipper (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  kjoring_id uuid not null,
  ansatt_id uuid not null,
  navn text not null,
  ansattnummer int not null,
  lonnstype text not null,
  periode date not null,
  utbetalingsdato date not null,
  kontonr text,
  trekkmetode text not null default '',
  trekkpliktig numeric(12,2) not null default 0,
  trekkgrunnlag numeric(12,2) not null default 0,
  skattetrekk numeric(12,2) not null default 0,
  skattetrekk_manuell boolean not null default false,
  brutto numeric(12,2) not null default 0,
  utgifter numeric(12,2) not null default 0,
  trekk_etter_skatt numeric(12,2) not null default 0,
  netto numeric(12,2) not null default 0,
  feriepengegrunnlag numeric(12,2) not null default 0,
  feriepenger_opptjent numeric(12,2) not null default 0,
  otp_grunnlag numeric(12,2) not null default 0,
  otp numeric(12,2) not null default 0,
  aga_grunnlag numeric(12,2) not null default 0,
  aga numeric(12,2) not null default 0,
  aga_sats numeric(5,2) not null default 0,
  timeforinger uuid[] not null default '{}',
  merknader text[] not null default '{}',
  oppdatert timestamptz not null default now(),
  unique (org_id, id),
  unique (kjoring_id, ansatt_id),
  foreign key (org_id, kjoring_id) references faktura.lonnskjoringer(org_id, id) on delete cascade,
  -- En ansatt med lønnsslipper kan ikke slettes (slett_organisasjon sletter kjøringene først).
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id)
);
create index lonnsslipper_ansatt_idx on faktura.lonnsslipper (org_id, ansatt_id);
create trigger lonnsslipper_oppdatert before update on faktura.lonnsslipper
  for each row execute function faktura.sett_oppdatert();
create trigger lonnsslipper_org_id before update on faktura.lonnsslipper
  for each row execute function faktura.org_id_uendret();

-- Linjene: lønnsart (f.eks. fastlonn, timelonn, overtid, fast_tillegg, feriepenger,
-- ferietrekk, trekk_etter_skatt; se server/src/lonnsarter.ts), antall, sats og beløp (positivt for
-- lønn, negativt for trekk). kilde: auto (regnet ut) eller manuell (lagt til eller endret).
-- nokkel: den automatiske linjen en manuell linje erstatter, eller som er fjernet (fjernet), så
-- den ikke lages på nytt. opptjeningsaar: året feriepengene er opptjent.
create table faktura.lonnslinjer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  slipp_id uuid not null,
  lonnsart text not null check (lonnsart ~ '^[a-z_0-9]{2,40}$'),
  tekst text not null check (length(btrim(tekst)) between 1 and 120),
  antall numeric(10,2),
  sats numeric(12,4),
  belop numeric(12,2) not null check (abs(belop) <= 100000000),
  kilde text not null default 'manuell' check (kilde in ('auto', 'manuell')),
  nokkel text check (nokkel is null or length(nokkel) <= 120),
  fjernet boolean not null default false,
  opptjeningsaar int check (opptjeningsaar between 2000 and 2100),
  rekkefolge int not null default 0,
  opprettet timestamptz not null default clock_timestamp(),
  unique (org_id, id),
  foreign key (org_id, slipp_id) references faktura.lonnsslipper(org_id, id) on delete cascade
);
create index lonnslinjer_slipp_idx on faktura.lonnslinjer (slipp_id);
create trigger lonnslinjer_org_id before update on faktura.lonnslinjer
  for each row execute function faktura.org_id_uendret();

-- En godkjent kjøring er låst: slippene og linjene endres ikke før den åpnes igjen. (Når hele
-- organisasjonen slettes, er kjøringen borte først, og da går det.)
create function faktura.lonn_laast() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  k uuid;
begin
  if tg_table_name = 'lonnsslipper' then
    k := coalesce(new.kjoring_id, old.kjoring_id);
  else
    select s.kjoring_id into k from faktura.lonnsslipper s where s.id = coalesce(new.slipp_id, old.slipp_id);
  end if;
  if exists (select 1 from faktura.lonnskjoringer where id = k and status = 'godkjent') then
    raise exception 'Lønnskjøringen er godkjent og kan ikke endres. Åpne den igjen først.' using errcode = 'FA409';
  end if;
  return coalesce(new, old);
end $$;
create trigger lonnsslipper_laast before insert or update or delete on faktura.lonnsslipper
  for each row execute function faktura.lonn_laast();
create trigger lonnslinjer_laast before insert or update or delete on faktura.lonnslinjer
  for each row execute function faktura.lonn_laast();

-- Slippene og linjene ser de som ser de ansatte, og den ansatte selv når kjøringen er godkjent.
create function faktura.min_lonnsslipp(_slipp uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from faktura.lonnsslipper s join faktura.lonnskjoringer k on k.id = s.kjoring_id
     where s.id = _slipp and k.status = 'godkjent' and faktura.er_meg(s.org_id, s.ansatt_id)
  )
$$;
-- Endres bare mens kjøringen er et utkast.
create function faktura.lonn_utkast(_kjoring uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from faktura.lonnskjoringer where id = _kjoring and status = 'utkast')
$$;

alter table faktura.lonnsslipper enable row level security;
create policy lonnsslipper_les on faktura.lonnsslipper for select
  using (faktura.kan(org_id, 'personal_les') or faktura.min_lonnsslipp(id));
create policy lonnsslipper_ny on faktura.lonnsslipper for insert
  with check (faktura.kan(org_id, 'personal') and faktura.lonn_utkast(kjoring_id));
create policy lonnsslipper_endre on faktura.lonnsslipper for update
  using (faktura.kan(org_id, 'personal') and faktura.lonn_utkast(kjoring_id))
  with check (faktura.kan(org_id, 'personal') and faktura.lonn_utkast(kjoring_id));
create policy lonnsslipper_slett on faktura.lonnsslipper for delete
  using (faktura.kan(org_id, 'personal') and faktura.lonn_utkast(kjoring_id));
grant select, delete,
      insert (org_id, kjoring_id, ansatt_id, navn, ansattnummer, lonnstype, periode, utbetalingsdato, trekkmetode, trekkpliktig, trekkgrunnlag,
              skattetrekk, skattetrekk_manuell, brutto, utgifter, trekk_etter_skatt, netto, feriepengegrunnlag,
              feriepenger_opptjent, otp_grunnlag, otp, aga_grunnlag, aga, aga_sats, timeforinger, merknader),
      update (navn, ansattnummer, lonnstype, periode, utbetalingsdato, trekkmetode, trekkpliktig, trekkgrunnlag, skattetrekk, skattetrekk_manuell,
              brutto, utgifter, trekk_etter_skatt, netto, feriepengegrunnlag, feriepenger_opptjent, otp_grunnlag, otp,
              aga_grunnlag, aga, aga_sats, timeforinger, merknader)
  on faktura.lonnsslipper to faktura_app;

alter table faktura.lonnslinjer enable row level security;
create policy lonnslinjer_les on faktura.lonnslinjer for select
  using (faktura.kan(org_id, 'personal_les') or faktura.min_lonnsslipp(slipp_id));
create policy lonnslinjer_ny on faktura.lonnslinjer for insert
  with check (faktura.kan(org_id, 'personal')
              and exists (select 1 from faktura.lonnsslipper s where s.id = slipp_id and faktura.lonn_utkast(s.kjoring_id)));
create policy lonnslinjer_endre on faktura.lonnslinjer for update
  using (faktura.kan(org_id, 'personal')
         and exists (select 1 from faktura.lonnsslipper s where s.id = slipp_id and faktura.lonn_utkast(s.kjoring_id)))
  with check (faktura.kan(org_id, 'personal'));
create policy lonnslinjer_slett on faktura.lonnslinjer for delete
  using (faktura.kan(org_id, 'personal')
         and exists (select 1 from faktura.lonnsslipper s where s.id = slipp_id and faktura.lonn_utkast(s.kjoring_id)));
grant select, delete,
      insert (org_id, slipp_id, lonnsart, tekst, antall, sats, belop, kilde, nokkel, fjernet, opptjeningsaar, rekkefolge),
      update (lonnsart, tekst, antall, sats, belop, kilde, nokkel, fjernet, opptjeningsaar, rekkefolge)
  on faktura.lonnslinjer to faktura_app;

-- ---------------------------------------------------------------------------
-- Timene som er lønnet
-- ---------------------------------------------------------------------------

-- Settes når kjøringen godkjennes, og tas bort når den åpnes igjen. Lønnede timer kan ikke
-- endres, avvises eller slettes (unntatt når hele organisasjonen slettes).
alter table faktura.timeforinger add column lonnskjoring_id uuid references faktura.lonnskjoringer(id) on delete set null;
create index timeforinger_lonnet_idx on faktura.timeforinger (lonnskjoring_id) where lonnskjoring_id is not null;

create function faktura.timer_lonnet() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.lonnskjoring_id is null or not exists (select 1 from faktura.organisasjoner where id = old.org_id) then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Timene er lønnet og kan ikke slettes. Åpne lønnskjøringen igjen først.' using errcode = 'FA409';
  end if;
  if new.lonnskjoring_id is not distinct from old.lonnskjoring_id
     and (new.dato, new.timer, new.overtid_prosent, new.status) is distinct from (old.dato, old.timer, old.overtid_prosent, old.status) then
    raise exception 'Timene er lønnet og kan ikke endres. Åpne lønnskjøringen igjen først.' using errcode = 'FA409';
  end if;
  return new;
end $$;
create trigger timeforinger_lonnet before update or delete on faktura.timeforinger
  for each row execute function faktura.timer_lonnet();

-- ---------------------------------------------------------------------------
-- Godkjenne og åpne igjen
-- ---------------------------------------------------------------------------

-- Godkjenner kjøringen: kontonummeret til hver ansatt lagres på slippen, og timene på slippene
-- merkes som lønnet (de må fortsatt være godkjent og ikke lønnet i en annen kjøring).
create function faktura.lonn_godkjenn(_kjoring uuid) returns void
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
  update faktura.lonnskjoringer set status = 'godkjent', godkjent_at = now(), godkjent_av = faktura.bruker_id() where id = k.id;
end $$;

-- Åpner en godkjent kjøring igjen (f.eks. for å rette noe): timene er ikke lenger lønnet.
create function faktura.lonn_gjenapne(_kjoring uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  k faktura.lonnskjoringer;
begin
  select * into k from faktura.lonnskjoringer where id = _kjoring for update;
  if k.id is null then raise exception 'Fant ikke lønnskjøringen' using errcode = 'FA404'; end if;
  perform faktura.krev(k.org_id, 'personal');
  if k.status <> 'godkjent' then raise exception 'Lønnskjøringen er ikke godkjent' using errcode = 'FA409'; end if;
  update faktura.timeforinger set lonnskjoring_id = null where lonnskjoring_id = k.id;
  update faktura.lonnskjoringer set status = 'utkast', godkjent_at = null, godkjent_av = null where id = k.id;
  -- Kontonummeret settes på nytt når kjøringen godkjennes.
  update faktura.lonnsslipper set kontonr = null where kjoring_id = k.id;
end $$;

grant execute on function faktura.lonn_godkjenn(uuid), faktura.lonn_gjenapne(uuid) to faktura_app;

-- ---------------------------------------------------------------------------
-- Trekktabellene
-- ---------------------------------------------------------------------------

-- Skatteetatens trekktabeller (tekstformat), månedstabellene for lønn: trekket for et trekkgrunnlag
-- er raden med det høyeste grunnlaget som ikke er større. Åpne tall, som alle kan lese.
create table faktura.trekktabeller (
  aar int not null check (aar between 2000 and 2100),
  tabell int not null check (tabell between 1000 and 9999),
  grunnlag int not null check (grunnlag >= 0),
  trekk int not null check (trekk >= 0),
  primary key (aar, tabell, grunnlag)
);
grant select on faktura.trekktabeller to faktura_app, faktura_system;

-- Plattformadministratoren laster opp tabellene for et år, i biter (den første biten tømmer året).
create function faktura.trekktabell_last(_aar int, _forste boolean, _tabell int[], _grunnlag int[], _trekk int[]) returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  if _aar is null or _aar not between 2000 and 2100 then raise exception 'Ugyldig år' using errcode = 'FA400'; end if;
  if cardinality(_tabell) is distinct from cardinality(_grunnlag) or cardinality(_tabell) is distinct from cardinality(_trekk) then
    raise exception 'Kolonnene har ulik lengde' using errcode = 'FA400';
  end if;
  if _forste then delete from faktura.trekktabeller where aar = _aar; end if;
  insert into faktura.trekktabeller (aar, tabell, grunnlag, trekk)
  select _aar, t, g, tr from unnest(_tabell, _grunnlag, _trekk) as x(t, g, tr)
  on conflict (aar, tabell, grunnlag) do update set trekk = excluded.trekk;
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function faktura.trekktabell_last(int, boolean, int[], int[], int[]) to faktura_app;

-- ---------------------------------------------------------------------------
-- Revisjonsloggen
-- ---------------------------------------------------------------------------

-- Lønnen (kjøringene og tallene fra et tidligere lønnssystem) er, som lønnen på de ansatte, bare
-- for dem som ser de ansatte.
drop policy revisjonslogg_les on faktura.revisjonslogg;
create policy revisjonslogg_les on faktura.revisjonslogg for select
  using (faktura.kan(org_id, 'les')
         and (coalesce(tabell, '') not in ('ansatte', 'ansatt_tillegg', 'fravaer', 'arbeidsplaner', 'ferie_overforinger', 'vaktbytter',
                                           'lonnskjoringer', 'lonn_inngaende')
              or faktura.kan(org_id, 'personal_les'))
         and (coalesce(tabell, '') not in ('fravaer', 'ferie_overforinger') or faktura.kan(org_id, 'personal')));

-- ---------------------------------------------------------------------------
-- Sletting av organisasjoner
-- ---------------------------------------------------------------------------

-- Godkjente lønnskjøringer er regnskapsmateriale, som utstedte fakturaer: da stenges
-- organisasjonen i stedet for å slettes, og materialet oppbevares i fem år etter året for den
-- siste fakturaen eller lønnsutbetalingen. Ellers som i 0046 (utkastene til lønnskjøringer slettes).
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
  insert into faktura.slettede_organisasjoner (id, navn, orgnr, type, slettet_av, slettet_av_navn, slettet_av_epost, av_plattformen, grunn,
                                               antall_fakturaer, oppbevares_til)
  values (o.id, o.navn, o.orgnr, o.type, _meg.id, _meg.navn, _meg.epost, _plattform, btrim(_grunn), _antall,
          case when _antall > 0 or _lonn > 0
               then make_date(extract(year from greatest(_siste, _siste_lonn))::int + 5, 12, 31) end)
  returning * into logg;

  if _antall = 0 and _lonn = 0 then
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
