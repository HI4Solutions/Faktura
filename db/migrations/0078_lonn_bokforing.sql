-- Bokføringen av lønnen i HI4 Fakturas eget regnskap (server/src/lonnBokforing.ts). Dette er
-- grunnlaget for regnskapsmodulen som kommer: bilag i nummerserier med posteringer på kontoene i
-- kontoplanen (norsk standard, NS 4102). Et bilag endres eller slettes aldri; en feil rettes med et
-- nytt bilag som reverserer det (som bokføringsloven krever). Lønnen er den første kilden: hver
-- godkjente lønnskjøring gir et lønnsbilag (serie L) på utbetalingsdatoen, og åpnes kjøringen
-- igjen, reverseres bilaget på samme dato. Det nye bilaget kommer når den godkjennes på nytt.
--
-- lonn_oppsett (kontoene og valgene for lønnsbilaget):
--   bokforing_kontoer: kontoene som avviker fra standarden, f.eks. {"lonn": "5001"}.
--   bokforing_feriepenger: avsetning (feriepengene og arbeidsgiveravgiften av dem avsettes hver
--     måned og tas fra avsetningen når de utbetales) eller utbetaling (kostnadsføres når de
--     utbetales).
--   bokforing_netto: skyldig (nettolønnen til skyldig lønn, betales fra banken) eller bank (rett fra
--     bankkontoen).
--   bokforing_otp: OTP-premien avsettes fra lønnen (ellers føres den fra fakturaen fra
--     pensjonsleverandøren).

create function faktura.lonnskontoer_gyldige(_k jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(_k) = 'object'
     and not exists (
       select 1 from jsonb_each(_k) e
        where e.key not in ('lonn', 'feriepenger', 'aga', 'aga_feriepenger', 'otp', 'utgifter', 'forskuddstrekk', 'andre_trekk',
                            'skyldig_aga', 'paalopt_aga_feriepenger', 'skyldig_lonn', 'skyldige_feriepenger', 'skyldig_otp', 'bank')
           or jsonb_typeof(e.value) <> 'string'
           or (e.value #>> '{}') !~ '^[0-9]{4,6}$')
$$;

alter table faktura.lonn_oppsett
  add column bokforing_kontoer jsonb not null default '{}' check (faktura.lonnskontoer_gyldige(bokforing_kontoer)),
  add column bokforing_feriepenger text not null default 'avsetning' check (bokforing_feriepenger in ('avsetning', 'utbetaling')),
  add column bokforing_netto text not null default 'skyldig' check (bokforing_netto in ('skyldig', 'bank')),
  add column bokforing_otp boolean not null default false;
grant insert (bokforing_kontoer, bokforing_feriepenger, bokforing_netto, bokforing_otp),
      update (bokforing_kontoer, bokforing_feriepenger, bokforing_netto, bokforing_otp)
  on faktura.lonn_oppsett to faktura_app;

-- ---------------------------------------------------------------------------
-- Bilagene og posteringene
-- ---------------------------------------------------------------------------

-- Nummerseriene: det siste nummeret i hver serie per år (L: lønn).
create table faktura.bilagserier (
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  serie text not null check (serie ~ '^[A-Z]{1,3}$'),
  aar int not null check (aar between 2000 and 2100),
  siste int not null check (siste > 0),
  primary key (org_id, serie, aar)
);
alter table faktura.bilagserier enable row level security;
create policy bilagserier_system on faktura.bilagserier for select using (faktura.er_system());

-- kilde og kilde_id: det bilaget kommer fra (lønnskjøringen; ingen fremmednøkkel, bilaget blir
-- stående). reverserer: bilaget dette reverserer; reversert_av: bilaget som reverserer dette.
create table faktura.bilag (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  serie text not null check (serie ~ '^[A-Z]{1,3}$'),
  aar int not null check (aar between 2000 and 2100),
  nummer int not null check (nummer > 0),
  dato date not null,
  tekst text not null check (length(tekst) between 1 and 300),
  kilde text not null check (kilde in ('lonn')),
  kilde_id uuid,
  reverserer uuid,
  reversert_av uuid,
  opprettet timestamptz not null default now(),
  opprettet_av uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null,
  unique (org_id, id),
  unique (org_id, serie, aar, nummer),
  check (aar = extract(year from dato)),
  foreign key (org_id, reverserer) references faktura.bilag(org_id, id),
  foreign key (org_id, reversert_av) references faktura.bilag(org_id, id)
);
-- Ett gjeldende bilag (ikke reversert, og ikke en reversering) for hver kjøring.
create unique index bilag_kilde_gjeldende on faktura.bilag (org_id, kilde, kilde_id) where reverserer is null and reversert_av is null;
create index bilag_dato on faktura.bilag (org_id, kilde, dato);
create trigger bilag_revisjon after insert or update or delete on faktura.bilag
  for each row execute function faktura.revider();

-- Beløpet er positivt i debet og negativt i kredit; et bilag går alltid i null.
create table faktura.posteringer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  bilag_id uuid not null,
  rekke int not null check (rekke > 0),
  konto text not null check (konto ~ '^[0-9]{4,6}$'),
  belop numeric(14,2) not null check (belop <> 0),
  tekst text check (tekst is null or length(tekst) <= 200),
  unique (bilag_id, rekke),
  foreign key (org_id, bilag_id) references faktura.bilag(org_id, id) on delete cascade
);
create index posteringer_konto on faktura.posteringer (org_id, konto);

create function faktura.bilag_i_balanse() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from faktura.posteringer where bilag_id = new.bilag_id having sum(belop) <> 0) then
    raise exception 'Bilaget går ikke i null' using errcode = 'FA400';
  end if;
  return null;
end $$;
create constraint trigger posteringer_i_balanse after insert or update on faktura.posteringer
  deferrable initially deferred for each row execute function faktura.bilag_i_balanse();

-- Lønnsbilagene ser de som ser lønnen. Ingen skriver bilagene direkte (bare funksjonene under),
-- og ingen endrer eller sletter dem.
alter table faktura.bilag enable row level security;
alter table faktura.posteringer enable row level security;
create policy bilag_les on faktura.bilag for select using (kilde = 'lonn' and faktura.kan(org_id, 'personal_les'));
create policy bilag_system on faktura.bilag for select using (faktura.er_system());
create policy posteringer_les on faktura.posteringer for select
  using (exists (select 1 from faktura.bilag b where b.org_id = posteringer.org_id and b.id = posteringer.bilag_id));
create policy posteringer_system on faktura.posteringer for select using (faktura.er_system());
grant select on faktura.bilag, faktura.posteringer to faktura_app, faktura_system;

-- Neste nummer i serien for året.
create function faktura.neste_bilagsnummer(_org uuid, _serie text, _aar int) returns int
language sql security definer set search_path = '' as $$
  insert into faktura.bilagserier (org_id, serie, aar, siste) values (_org, _serie, _aar, 1)
  on conflict (org_id, serie, aar) do update set siste = faktura.bilagserier.siste + 1
  returning siste
$$;
revoke execute on function faktura.neste_bilagsnummer(uuid, text, int) from public;

-- Reverserer et gjeldende bilag på samme dato: et nytt bilag i serien med motsatte beløp.
create function faktura.reverser_bilag(_bilag uuid, _tekst text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b faktura.bilag;
  ny uuid;
begin
  select * into b from faktura.bilag where id = _bilag for update;
  if b.id is null or b.reverserer is not null or b.reversert_av is not null then
    raise exception 'Bilaget kan ikke reverseres' using errcode = 'FA409';
  end if;
  insert into faktura.bilag (org_id, serie, aar, nummer, dato, tekst, kilde, kilde_id, reverserer)
  values (b.org_id, b.serie, b.aar, faktura.neste_bilagsnummer(b.org_id, b.serie, b.aar), b.dato, left(_tekst, 300), b.kilde, b.kilde_id, b.id)
  returning id into ny;
  insert into faktura.posteringer (org_id, bilag_id, rekke, konto, belop, tekst)
  select p.org_id, ny, p.rekke, p.konto, -p.belop, p.tekst from faktura.posteringer p where p.bilag_id = b.id;
  update faktura.bilag set reversert_av = ny where id = b.id;
  return ny;
end $$;
revoke execute on function faktura.reverser_bilag(uuid, text) from public;

-- Eier eller administrator: lønnsbilaget for en godkjent kjøring (når den godkjennes, eller en
-- kjøring som ble godkjent før bokføringen kom). Posteringene regnes ut av API-et
-- (lonnBokforing.ts): [{"konto": "5000", "belop": 50000, "tekst": "Lønn"}, …].
create function faktura.bokfor_lonn(_kjoring uuid, _dato date, _tekst text, _posteringer jsonb) returns faktura.bilag
language plpgsql security definer set search_path = '' as $$
declare
  k faktura.lonnskjoringer;
  b faktura.bilag;
  p jsonb;
  n int := 0;
begin
  select * into k from faktura.lonnskjoringer where id = _kjoring for update;
  if k.id is null then raise exception 'Fant ikke lønnskjøringen' using errcode = 'FA404'; end if;
  perform faktura.krev(k.org_id, 'personal');
  if k.status <> 'godkjent' then
    raise exception 'Godkjenn lønnskjøringen før den bokføres' using errcode = 'FA409';
  end if;
  if exists (select 1 from faktura.bilag where org_id = k.org_id and kilde = 'lonn' and kilde_id = k.id and reverserer is null and reversert_av is null) then
    raise exception 'Lønnskjøringen er alt bokført' using errcode = 'FA409';
  end if;
  if _dato is null or _tekst is null or jsonb_typeof(_posteringer) <> 'array' or jsonb_array_length(_posteringer) < 2 then
    raise exception 'Bilaget mangler dato, tekst eller posteringer' using errcode = 'FA400';
  end if;
  if (select sum((x->>'belop')::numeric(14,2)) from jsonb_array_elements(_posteringer) x) <> 0 then
    raise exception 'Bilaget går ikke i null' using errcode = 'FA400';
  end if;
  insert into faktura.bilag (org_id, serie, aar, nummer, dato, tekst, kilde, kilde_id)
  values (k.org_id, 'L', extract(year from _dato)::int, faktura.neste_bilagsnummer(k.org_id, 'L', extract(year from _dato)::int), _dato, left(_tekst, 300), 'lonn', k.id)
  returning * into b;
  for p in select * from jsonb_array_elements(_posteringer) loop
    n := n + 1;
    insert into faktura.posteringer (org_id, bilag_id, rekke, konto, belop, tekst)
    values (k.org_id, b.id, n, p->>'konto', (p->>'belop')::numeric(14,2), left(p->>'tekst', 200));
  end loop;
  return b;
end $$;
revoke execute on function faktura.bokfor_lonn(uuid, date, text, jsonb) from public;
grant execute on function faktura.bokfor_lonn(uuid, date, text, jsonb) to faktura_app;

-- Som før (0073), og lønnsbilaget reverseres når kjøringen åpnes igjen.
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
  update faktura.lonnskjoringer set status = 'utkast', godkjent_at = null, godkjent_av = null where id = k.id;
  -- Kontonummeret settes på nytt når kjøringen godkjennes.
  update faktura.lonnsslipper set kontonr = null where kjoring_id = k.id;
  select id into b from faktura.bilag
   where org_id = k.org_id and kilde = 'lonn' and kilde_id = k.id and reverserer is null and reversert_av is null;
  if b is not null then
    perform faktura.reverser_bilag(b, 'Reversert: lønnskjøringen er åpnet igjen');
  end if;
end $$;
