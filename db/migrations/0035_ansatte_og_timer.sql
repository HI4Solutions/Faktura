-- 0035_ansatte_og_timer.sql
-- Ansatte og timer (første steg av lønn og bemanning).
--
-- Ny rolle «ansatt»: den ansatte logger inn og ser bare sitt eget (sin ansattrad og sine
-- timer, senere vakter og lønnsslipper), aldri fakturaer, kunder eller andre ansatte. Derfor
-- gir «les» ikke lenger tilgang for alle roller: kan(org, 'les') er usann for ansatte.
-- Nye handlinger i kan():
--   personal      ansatte og godkjenning av timer (eier, admin)
--   personal_les  se alle ansatte og timer, også lønn (eier, admin, regnskap)
--   medlem        alle roller, også ansatt (organisasjonens navn og oppsett)
--
-- Fødselsnummeret lagres kryptert (KMS) av API-et, som bare kan kryptere; bare workeren kan
-- lese det (til a-meldingen senere). Det havner aldri i revisjonsloggen, og loggen for
-- ansatte (med lønn) vises bare for dem som kan se de ansatte.

-- ---------------------------------------------------------------------------
-- Rollen
-- ---------------------------------------------------------------------------

alter table faktura.medlemmer drop constraint medlemmer_rolle_check;
alter table faktura.medlemmer add constraint medlemmer_rolle_check
  check (rolle in ('eier', 'admin', 'fakturerer', 'regnskap', 'les', 'ansatt'));
alter table faktura.invitasjoner drop constraint invitasjoner_rolle_check;
alter table faktura.invitasjoner add constraint invitasjoner_rolle_check
  check (rolle in ('admin', 'fakturerer', 'regnskap', 'les', 'ansatt'));

-- En ansatt i et regnskapsbyrå får ikke tilgang til byråets klienter.
create or replace function faktura.rolle(_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select r.rolle from (
    select m.rolle
      from faktura.medlemmer m
     where m.org_id = _org and m.bruker_id = faktura.bruker_id()
    union all
    select case when bm.rolle = 'les' or t.rolle = 'les' then 'les' else 'regnskap' end
      from faktura.org_tilgang t
      join faktura.medlemmer bm on bm.org_id = t.byraa_org_id and bm.bruker_id = faktura.bruker_id()
     where t.klient_org_id = _org
       and t.status = 'aktiv'
       and (t.utloper is null or t.utloper >= faktura.i_dag())
       and bm.rolle <> 'ansatt'
  ) r
  order by faktura.rolle_rang(r.rolle) desc
  limit 1
$$;

--   les alle roller unntatt ansatt | skriv kunder,produkter,utkast,gjentakelser | utsted utstede,sende,kreditere
--   bokfor betaling/refusjon | admin innstillinger,medlemmer,integrasjoner | eier slette org, overføre eierskap
--   personal ansatte og godkjenning av timer | personal_les se ansatte, timer og lønn | medlem alle roller
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
    when 'medlem'       then true
    else false
  end;
end $$;

-- Workeren (Google Disk): en ansatt skal ikke få fakturaene kopiert til sin Disk.
create or replace function faktura.bruker_kan_lese(_bruker uuid, _org uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if not faktura.er_system() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  return exists (
    select 1 from faktura.medlemmer m where m.org_id = _org and m.bruker_id = _bruker and m.rolle <> 'ansatt'
    union all
    select 1 from faktura.org_tilgang t join faktura.medlemmer bm on bm.org_id = t.byraa_org_id and bm.bruker_id = _bruker
     where t.klient_org_id = _org and t.status = 'aktiv' and (t.utloper is null or t.utloper >= faktura.i_dag())
       and bm.rolle <> 'ansatt'
  );
end $$;

-- Alle medlemmer (også ansatte) ser organisasjonen og sitt eget medlemskap.
drop policy organisasjoner_les on faktura.organisasjoner;
create policy organisasjoner_les on faktura.organisasjoner for select using (faktura.kan(id, 'medlem'));
drop policy medlemmer_les on faktura.medlemmer;
create policy medlemmer_les on faktura.medlemmer for select
  using (faktura.kan(org_id, 'les') or bruker_id = faktura.bruker_id());

-- ---------------------------------------------------------------------------
-- Oppsett per organisasjon
-- ---------------------------------------------------------------------------

-- aktiv: delen «Ansatte og timer» er slått på. Overtid: timer over daglig grense, og timer
-- over ukentlig grense ellers i uka, med tillegg (arbeidsmiljøloven: 9 og 40 timer, minst 40 %).
create table faktura.lonn_oppsett (
  org_id uuid primary key references faktura.organisasjoner(id) on delete cascade,
  aktiv boolean not null default false,
  daglig_grense numeric(4,2) not null default 9 check (daglig_grense > 0 and daglig_grense <= 24),
  ukentlig_grense numeric(4,2) not null default 40 check (ukentlig_grense > 0 and ukentlig_grense <= 80),
  overtid_prosent int not null default 40 check (overtid_prosent between 40 and 200),
  oppdatert timestamptz not null default now()
);

alter table faktura.lonn_oppsett enable row level security;
create policy lonn_oppsett_les on faktura.lonn_oppsett for select using (faktura.kan(org_id, 'medlem'));
create policy lonn_oppsett_ny on faktura.lonn_oppsett for insert with check (faktura.kan(org_id, 'admin'));
create policy lonn_oppsett_endre on faktura.lonn_oppsett for update
  using (faktura.kan(org_id, 'admin')) with check (faktura.kan(org_id, 'admin'));
grant select,
      insert (org_id, aktiv, daglig_grense, ukentlig_grense, overtid_prosent),
      update (aktiv, daglig_grense, ukentlig_grense, overtid_prosent)
  on faktura.lonn_oppsett to faktura_app;
create trigger lonn_oppsett_oppdatert before update on faktura.lonn_oppsett
  for each row execute function faktura.sett_oppdatert();

-- ---------------------------------------------------------------------------
-- Ansatte
-- ---------------------------------------------------------------------------

alter table faktura.nummerserier add column neste_ansattnummer int not null default 1 check (neste_ansattnummer > 0);

create table faktura.ansatte (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  ansattnummer int not null,
  fornavn text not null check (length(fornavn) between 1 and 100),
  etternavn text not null check (length(etternavn) between 1 and 100),
  epost text check (epost is null or (length(epost) <= 254 and epost like '%_@_%')),
  telefon text check (telefon is null or length(telefon) <= 30),
  adresse text check (adresse is null or length(adresse) <= 200),
  postnr text check (postnr is null or postnr ~ '^\d{4}$'),
  poststed text check (poststed is null or length(poststed) <= 100),
  fodselsdato date check (fodselsdato is null or fodselsdato >= '1900-01-01'),
  fnr_kryptert bytea,                       -- fødselsnummer eller D-nummer (KMS), bare workeren leser det
  har_fnr boolean generated always as (fnr_kryptert is not null) stored,
  kontonr text check (kontonr is null or faktura.kontonr_gyldig(kontonr)),
  stilling text check (stilling is null or length(stilling) <= 100),
  stillingsprosent numeric(5,2) not null default 100 check (stillingsprosent > 0 and stillingsprosent <= 100),
  ukentlig_arbeidstid numeric(4,2) not null default 37.5 check (ukentlig_arbeidstid > 0 and ukentlig_arbeidstid <= 60),
  ansatt_fra date not null default faktura.i_dag(),
  ansatt_til date,
  ansettelsestype text not null default 'fast' check (ansettelsestype in ('fast', 'midlertidig', 'tilkalling')),
  lonnstype text not null default 'time' check (lonnstype in ('maaned', 'time')),
  maanedslonn numeric(12,2) check (maanedslonn is null or maanedslonn >= 0),
  timelonn numeric(10,2) check (timelonn is null or timelonn >= 0),
  bruker_id uuid references faktura.brukere(id) on delete set null, -- egen innlogging
  aktiv boolean not null default true,
  notat text check (notat is null or length(notat) <= 2000),
  opprettet timestamptz not null default now(),
  oppdatert timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, ansattnummer),
  unique (org_id, bruker_id),
  check (ansatt_til is null or ansatt_til >= ansatt_fra)
);

create function faktura.ansatt_foer() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.fornavn := btrim(new.fornavn);
  new.etternavn := btrim(new.etternavn);
  new.epost := nullif(lower(btrim(new.epost)), '');
  if tg_op = 'INSERT' then
    update faktura.nummerserier
       set neste_ansattnummer = neste_ansattnummer + 1
     where org_id = new.org_id
    returning neste_ansattnummer - 1 into new.ansattnummer;
    if new.ansattnummer is null then
      raise exception 'Organisasjonen mangler nummerserie' using errcode = 'FA409';
    end if;
  elsif new.ansattnummer is distinct from old.ansattnummer then
    raise exception 'Ansattnummeret kan ikke endres' using errcode = 'FA400';
  end if;
  return new;
end $$;

create trigger ansatte_foer before insert or update on faktura.ansatte
  for each row execute function faktura.ansatt_foer();
create trigger ansatte_oppdatert before update on faktura.ansatte
  for each row execute function faktura.sett_oppdatert();
create trigger ansatte_org_id before update on faktura.ansatte
  for each row execute function faktura.org_id_uendret();
create trigger ansatte_revisjon after insert or update or delete on faktura.ansatte
  for each row execute function faktura.revider();

-- Er den innloggede denne ansatte (og fortsatt med i organisasjonen)?
create function faktura.er_meg(_org uuid, _ansatt uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from faktura.ansatte a
      join faktura.medlemmer m on m.org_id = a.org_id and m.bruker_id = a.bruker_id
     where a.org_id = _org and a.id = _ansatt and a.bruker_id = faktura.bruker_id()
  )
$$;

alter table faktura.ansatte enable row level security;
create policy ansatte_les on faktura.ansatte for select
  using (faktura.kan(org_id, 'personal_les') or faktura.er_meg(org_id, id));
create policy ansatte_ny on faktura.ansatte for insert with check (faktura.kan(org_id, 'personal'));
create policy ansatte_endre on faktura.ansatte for update
  using (faktura.kan(org_id, 'personal')) with check (faktura.kan(org_id, 'personal'));
create policy ansatte_slett on faktura.ansatte for delete using (faktura.kan(org_id, 'personal'));

-- API-et kan skrive fødselsnummeret (kryptert), men ikke lese det. Koblingen til en
-- innlogging settes bare av funksjonene under.
grant select (id, org_id, ansattnummer, fornavn, etternavn, epost, telefon, adresse, postnr, poststed,
              fodselsdato, har_fnr, kontonr, stilling, stillingsprosent, ukentlig_arbeidstid, ansatt_fra,
              ansatt_til, ansettelsestype, lonnstype, maanedslonn, timelonn, bruker_id, aktiv, notat,
              opprettet, oppdatert),
      insert (org_id, fornavn, etternavn, epost, telefon, adresse, postnr, poststed, fodselsdato, fnr_kryptert,
              kontonr, stilling, stillingsprosent, ukentlig_arbeidstid, ansatt_fra, ansatt_til,
              ansettelsestype, lonnstype, maanedslonn, timelonn, aktiv, notat),
      update (fornavn, etternavn, epost, telefon, adresse, postnr, poststed, fodselsdato, fnr_kryptert,
              kontonr, stilling, stillingsprosent, ukentlig_arbeidstid, ansatt_fra, ansatt_til,
              ansettelsestype, lonnstype, maanedslonn, timelonn, aktiv, notat),
      delete
  on faktura.ansatte to faktura_app;
grant select (fnr_kryptert) on faktura.ansatte to faktura_system;

-- Organisasjonene den innloggede har tilgang til, med om ansatte og timer er slått på, og
-- den innloggedes egen ansattrad (for «Mine timer»).
create or replace view faktura.mine_organisasjoner with (security_invoker = true) as
select o.id, o.type, o.navn, o.orgnr, o.verifisering,
       faktura.rolle(o.id) as rolle,
       exists (select 1 from faktura.medlemmer m
                where m.org_id = o.id and m.bruker_id = faktura.bruker_id()) as direkte_medlem,
       coalesce((select l.aktiv from faktura.lonn_oppsett l where l.org_id = o.id), false) as personal,
       (select a.id from faktura.ansatte a where a.org_id = o.id and a.bruker_id = faktura.bruker_id()) as ansatt_id
  from faktura.organisasjoner o;

-- ---------------------------------------------------------------------------
-- Egen innlogging for den ansatte
-- ---------------------------------------------------------------------------

alter table faktura.invitasjoner add column ansatt_id uuid;
alter table faktura.invitasjoner add constraint invitasjoner_ansatt_fk
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete cascade;

-- Inviterer den ansatte (rollen ansatt) på e-postadressen. Er adressen alt med i
-- organisasjonen (f.eks. eieren selv), kobles den med en gang, og svaret er null.
create function faktura.inviter_ansatt(_org uuid, _ansatt uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  a faktura.ansatte;
  medlem uuid;
  token text := encode(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()), 'hex');
begin
  perform faktura.krev(_org, 'personal');
  select * into a from faktura.ansatte where org_id = _org and id = _ansatt for update;
  if not found then raise exception 'Fant ikke den ansatte' using errcode = 'FA404'; end if;
  if a.epost is null then raise exception 'Legg inn e-postadressen til den ansatte først' using errcode = 'FA400'; end if;
  if not a.aktiv then raise exception 'Den ansatte har sluttet' using errcode = 'FA409'; end if;
  select m.bruker_id into medlem
    from faktura.medlemmer m join faktura.brukere b on b.id = m.bruker_id
   where m.org_id = _org and lower(b.epost) = a.epost;
  if medlem is not null then
    if exists (select 1 from faktura.ansatte where org_id = _org and bruker_id = medlem and id <> a.id) then
      raise exception 'Brukeren er alt koblet til en annen ansatt' using errcode = 'FA409';
    end if;
    update faktura.ansatte set bruker_id = medlem where id = a.id;
    return null;
  end if;
  insert into faktura.invitasjoner (org_id, epost, rolle, token_hash, invitert_av, ansatt_id)
  values (_org, a.epost, 'ansatt', sha256(convert_to(token, 'UTF8')), faktura.bruker_id(), a.id);
  return token;
end $$;

-- Som før, og en invitasjon til en ansatt kobler innloggingen til den ansatte.
create or replace function faktura.aksepter_invitasjon(_token text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  inv faktura.invitasjoner;
  bruker faktura.brukere;
begin
  select * into bruker from faktura.brukere where id = faktura.bruker_id();
  if not found then raise exception 'Ikke innlogget' using errcode = 'FA403'; end if;

  select * into inv from faktura.invitasjoner
   where token_hash = sha256(convert_to(_token, 'UTF8')) for update;
  if not found or inv.akseptert_at is not null or inv.utloper < now() then
    raise exception 'Invitasjonen er ugyldig eller utløpt' using errcode = 'FA404';
  end if;
  if inv.epost <> bruker.epost then
    raise exception 'Invitasjonen gjelder en annen e-postadresse' using errcode = 'FA403';
  end if;

  insert into faktura.medlemmer (org_id, bruker_id, rolle) values (inv.org_id, bruker.id, inv.rolle)
  on conflict (org_id, bruker_id) do nothing;
  if inv.ansatt_id is not null then
    if exists (select 1 from faktura.ansatte where org_id = inv.org_id and bruker_id = bruker.id and id <> inv.ansatt_id) then
      raise exception 'Du er alt koblet til en annen ansatt i organisasjonen' using errcode = 'FA409';
    end if;
    update faktura.ansatte set bruker_id = bruker.id
     where org_id = inv.org_id and id = inv.ansatt_id and (bruker_id is null or bruker_id = bruker.id);
  end if;
  update faktura.invitasjoner set akseptert_av = bruker.id, akseptert_at = now() where id = inv.id;
  return inv.org_id;
end $$;

-- Tar bort innloggingen til den ansatte: koblingen, en ren ansatt-tilgang (ikke eieren eller
-- en admin) og ventende invitasjoner.
create function faktura.fjern_ansatt_tilgang(_org uuid, _ansatt uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  b uuid;
begin
  perform faktura.krev(_org, 'personal');
  select bruker_id into b from faktura.ansatte where org_id = _org and id = _ansatt for update;
  if not found then raise exception 'Fant ikke den ansatte' using errcode = 'FA404'; end if;
  update faktura.ansatte set bruker_id = null where org_id = _org and id = _ansatt;
  if b is not null then
    delete from faktura.medlemmer where org_id = _org and bruker_id = b and rolle = 'ansatt';
  end if;
  delete from faktura.invitasjoner where org_id = _org and ansatt_id = _ansatt and akseptert_at is null;
end $$;

-- ---------------------------------------------------------------------------
-- Timer
-- ---------------------------------------------------------------------------

-- Én føring per arbeidsøkt: fra–til med pause (timene regnes ut), eller bare timer.
-- overtid_prosent: hele føringen er overtid med dette tillegget (ellers regnes overtiden
-- ut fra grensene i oppsettet). Status: utkast → levert → godkjent, eller avvist (med grunn)
-- og levert på nytt.
create table faktura.timeforinger (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  ansatt_id uuid not null,
  dato date not null,
  fra time,
  til time,
  pause_min int not null default 0 check (pause_min between 0 and 600),
  timer numeric(5,2) not null check (timer > 0 and timer <= 24),
  overtid_prosent int check (overtid_prosent is null or overtid_prosent between 40 and 200),
  beskrivelse text check (beskrivelse is null or length(beskrivelse) <= 500),
  status text not null default 'utkast' check (status in ('utkast', 'levert', 'godkjent', 'avvist')),
  avvist_grunn text check (avvist_grunn is null or length(avvist_grunn) <= 500),
  levert_at timestamptz,
  godkjent_av uuid references faktura.brukere(id) on delete set null,
  godkjent_at timestamptz,
  opprettet_av uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null,
  opprettet timestamptz not null default now(),
  oppdatert timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete cascade,
  check ((fra is null) = (til is null))
);
create index timeforinger_ansatt_idx on faktura.timeforinger (org_id, ansatt_id, dato);
create index timeforinger_levert_idx on faktura.timeforinger (org_id, dato) where status = 'levert';

create function faktura.timer_foer() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a faktura.ansatte;
  minutter int;
begin
  if tg_op = 'UPDATE' and new.ansatt_id is distinct from old.ansatt_id then
    raise exception 'Timene kan ikke flyttes til en annen ansatt' using errcode = 'FA400';
  end if;
  -- Fra–til gir timene, over midnatt om til er før fra.
  if new.fra is not null and new.til is not null then
    if new.fra = new.til then raise exception 'Fra og til kan ikke være like' using errcode = 'FA400'; end if;
    minutter := (extract(epoch from (new.til - new.fra)) / 60)::int;
    if minutter < 0 then minutter := minutter + 24 * 60; end if;
    minutter := minutter - new.pause_min;
    if minutter <= 0 then raise exception 'Pausen er like lang som arbeidstiden' using errcode = 'FA400'; end if;
    new.timer := round(minutter / 60.0, 2);
  end if;
  new.beskrivelse := nullif(btrim(new.beskrivelse), '');
  select * into a from faktura.ansatte where org_id = new.org_id and id = new.ansatt_id;
  if new.dato < a.ansatt_fra or (a.ansatt_til is not null and new.dato > a.ansatt_til) then
    raise exception 'Datoen er utenfor ansettelsen (%–%)', to_char(a.ansatt_fra, 'DD.MM.YYYY'),
      coalesce(to_char(a.ansatt_til, 'DD.MM.YYYY'), '') using errcode = 'FA400';
  end if;
  if not a.aktiv and not faktura.kan(new.org_id, 'personal') then
    raise exception 'Du er ikke lenger registrert som ansatt' using errcode = 'FA403';
  end if;
  -- Endret etter at timene ble avvist: et nytt utkast som leveres på nytt.
  if tg_op = 'UPDATE' and old.status = 'avvist' and new.status = 'avvist' then
    new.status := 'utkast';
  end if;
  return new;
end $$;

create trigger timeforinger_foer before insert or update on faktura.timeforinger
  for each row execute function faktura.timer_foer();
create trigger timeforinger_oppdatert before update on faktura.timeforinger
  for each row execute function faktura.sett_oppdatert();
create trigger timeforinger_org_id before update on faktura.timeforinger
  for each row execute function faktura.org_id_uendret();

alter table faktura.timeforinger enable row level security;
create policy timeforinger_les on faktura.timeforinger for select
  using (faktura.kan(org_id, 'personal_les') or faktura.er_meg(org_id, ansatt_id));
create policy timeforinger_ny on faktura.timeforinger for insert
  with check (faktura.kan(org_id, 'personal') or faktura.er_meg(org_id, ansatt_id));
create policy timeforinger_endre on faktura.timeforinger for update
  using (faktura.kan(org_id, 'personal') or (faktura.er_meg(org_id, ansatt_id) and status in ('utkast', 'avvist')))
  with check (faktura.kan(org_id, 'personal') or (faktura.er_meg(org_id, ansatt_id) and status in ('utkast', 'avvist')));
create policy timeforinger_slett on faktura.timeforinger for delete
  using (faktura.kan(org_id, 'personal') or (faktura.er_meg(org_id, ansatt_id) and status in ('utkast', 'avvist')));

-- Status endres bare av funksjonene under.
grant select, delete on faktura.timeforinger to faktura_app;
grant insert (org_id, ansatt_id, dato, fra, til, pause_min, timer, overtid_prosent, beskrivelse),
      update (dato, fra, til, pause_min, timer, overtid_prosent, beskrivelse)
  on faktura.timeforinger to faktura_app;

-- Lever timene i perioden (utkast og avviste): den ansatte selv, eller personal.
create function faktura.lever_timer(_org uuid, _ansatt uuid, _fra date, _til date) returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  if not (faktura.kan(_org, 'personal') or faktura.er_meg(_org, _ansatt)) then
    raise exception 'Ingen tilgang' using errcode = 'FA403';
  end if;
  if _til < _fra or _til - _fra > 62 then raise exception 'Ugyldig periode' using errcode = 'FA400'; end if;
  update faktura.timeforinger set status = 'levert', avvist_grunn = null, levert_at = now()
   where org_id = _org and ansatt_id = _ansatt and dato between _fra and _til and status in ('utkast', 'avvist');
  get diagnostics n = row_count;
  return n;
end $$;

create function faktura.godkjenn_timer(_org uuid, _ider uuid[]) returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  perform faktura.krev(_org, 'personal');
  update faktura.timeforinger set status = 'godkjent', godkjent_av = faktura.bruker_id(), godkjent_at = now(), avvist_grunn = null
   where org_id = _org and id = any(_ider) and status = 'levert';
  get diagnostics n = row_count;
  return n;
end $$;

-- Avviser leverte (eller godkjente) timer med en grunn; den ansatte retter og leverer på nytt.
create function faktura.avvis_timer(_org uuid, _ider uuid[], _grunn text) returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  perform faktura.krev(_org, 'personal');
  if nullif(btrim(_grunn), '') is null then raise exception 'Skriv hvorfor timene avvises' using errcode = 'FA400'; end if;
  if length(_grunn) > 500 then raise exception 'Grunnen kan ha høyst 500 tegn' using errcode = 'FA400'; end if;
  update faktura.timeforinger set status = 'avvist', avvist_grunn = btrim(_grunn), godkjent_av = null, godkjent_at = null
   where org_id = _org and id = any(_ider) and status in ('levert', 'godkjent');
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Revisjonsloggen
-- ---------------------------------------------------------------------------

-- Som før (0020), og fødselsnummeret havner aldri i loggen: bare at det er registrert eller endret.
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
     where n.value is distinct from gammel -> n.key and n.key not in ('oppdatert', 'ehf_sjekket', 'har_fnr');
    if endring is null then return null; end if;
  else
    endring := rad - 'har_fnr';
  end if;
  if endring ? 'fnr_kryptert' then
    endring := (endring - 'fnr_kryptert') || case
      when tg_op = 'UPDATE' then jsonb_build_object('fodselsnummer', 'endret')
      when jsonb_typeof(endring -> 'fnr_kryptert') <> 'null' then jsonb_build_object('fodselsnummer', 'registrert')
      else '{}'::jsonb end;
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

-- Loggen for ansatte (med lønn) vises bare for dem som kan se de ansatte.
drop policy revisjonslogg_les on faktura.revisjonslogg;
create policy revisjonslogg_les on faktura.revisjonslogg for select
  using (faktura.kan(org_id, 'les') and (tabell is distinct from 'ansatte' or faktura.kan(org_id, 'personal_les')));

-- ---------------------------------------------------------------------------
-- Funksjoner
-- ---------------------------------------------------------------------------

revoke all on function faktura.ansatt_foer(), faktura.timer_foer(), faktura.er_meg(uuid, uuid),
  faktura.inviter_ansatt(uuid, uuid), faktura.fjern_ansatt_tilgang(uuid, uuid),
  faktura.lever_timer(uuid, uuid, date, date), faktura.godkjenn_timer(uuid, uuid[]),
  faktura.avvis_timer(uuid, uuid[], text) from public;
grant execute on function faktura.er_meg(uuid, uuid), faktura.inviter_ansatt(uuid, uuid),
  faktura.fjern_ansatt_tilgang(uuid, uuid), faktura.lever_timer(uuid, uuid, date, date),
  faktura.godkjenn_timer(uuid, uuid[]), faktura.avvis_timer(uuid, uuid[], text)
to faktura_app;
