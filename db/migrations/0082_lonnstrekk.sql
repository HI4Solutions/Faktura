-- Faste trekk i lønnen (server/src/lonnstrekk.ts, server/src/lonn.ts, web/src/sider/LonnsTrekk.tsx):
-- trekk etter pålegg (samordnet utleggstrekk fra Skatteetaten, utleggstrekk for skattekrav etter
-- det gamle regelverket, andre utleggstrekk og bidragstrekk), fagforeningskontingent,
-- tilbakebetaling av forskudd på lønn og andre trekk, per ansatt.
--
-- Hvert trekk er et beløp per lønnskjøring eller en prosent av bruttolønnen, fra en dato (og til en
-- dato), og eventuelt til en sum er trukket (forskudd, pålegg med et restbeløp). Den ordinære
-- lønnskjøringen trekker dem etter forskuddstrekket, i rekkefølgen dekningsloven gir (bidrag før
-- utlegg), og aldri mer enn nettolønnen. Fagforeningskontingenten reduserer grunnlaget for
-- forskuddstrekket. Trekkene med kontonummer betales med betalingsfila første virkedag etter
-- lønnsdagen, som forskuddstrekket.
--
-- lonn_oppsett.skatt_kontonr: Skatteetatens kontonummer for forskuddstrekk og utleggstrekk.
-- lonnskjoringer.forskuddstrekk_kid: KID-en for forskuddstrekket i måneden (fra Skatteetatens
-- KID-generator); den kan settes også når kjøringen er godkjent.

create table faktura.lonnstrekk (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  ansatt_id uuid not null,
  type text not null check (type in ('utlegg_samordnet', 'utlegg_skatt', 'utlegg_annet', 'bidrag', 'fagforening', 'forskudd', 'annet')),
  tekst text check (tekst is null or length(btrim(tekst)) between 1 and 100),
  belop numeric(12,2) check (belop is null or (belop > 0 and belop <= 10000000)),
  prosent numeric(5,2) check (prosent is null or (prosent > 0 and prosent <= 100)),
  totalt numeric(12,2) check (totalt is null or (totalt > 0 and totalt <= 100000000)),
  fra date not null,
  til date,
  mottaker text check (mottaker is null or length(btrim(mottaker)) between 1 and 140),
  kontonr text check (kontonr is null or faktura.kontonr_gyldig(kontonr)),
  kid text check (kid is null or kid ~ '^[0-9]{2,25}$'),
  melding text check (melding is null or length(btrim(melding)) between 1 and 140),
  opprettet timestamptz not null default clock_timestamp(),
  oppdatert timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete cascade,
  check ((belop is null) <> (prosent is null)),
  check (til is null or til >= fra),
  check (kid is null or melding is null)
);
create index lonnstrekk_ansatt on faktura.lonnstrekk (org_id, ansatt_id);
create trigger lonnstrekk_oppdatert before update on faktura.lonnstrekk
  for each row execute function faktura.sett_oppdatert();
create trigger lonnstrekk_org_id before update on faktura.lonnstrekk
  for each row execute function faktura.org_id_uendret();
create trigger lonnstrekk_revisjon after insert or update or delete on faktura.lonnstrekk
  for each row execute function faktura.revider();

-- De som ser lønnen, og den ansatte selv, ser trekkene; eier og administrator endrer dem.
alter table faktura.lonnstrekk enable row level security;
create policy lonnstrekk_les on faktura.lonnstrekk for select
  using (faktura.kan(org_id, 'personal_les') or faktura.er_meg(org_id, ansatt_id));
create policy lonnstrekk_ny on faktura.lonnstrekk for insert with check (faktura.kan(org_id, 'personal'));
create policy lonnstrekk_endre on faktura.lonnstrekk for update
  using (faktura.kan(org_id, 'personal')) with check (faktura.kan(org_id, 'personal'));
create policy lonnstrekk_slett on faktura.lonnstrekk for delete using (faktura.kan(org_id, 'personal'));
grant select, delete,
      insert (org_id, ansatt_id, type, tekst, belop, prosent, totalt, fra, til, mottaker, kontonr, kid, melding),
      update (type, tekst, belop, prosent, totalt, fra, til, mottaker, kontonr, kid, melding)
  on faktura.lonnstrekk to faktura_app;
grant select on faktura.lonnstrekk to faktura_system;

-- Revisjonsloggen for trekkene er, som for lønnen, bare for dem som ser lønnen.
drop policy revisjonslogg_les on faktura.revisjonslogg;
create policy revisjonslogg_les on faktura.revisjonslogg for select
  using (faktura.kan(org_id, 'les')
         and (coalesce(tabell, '') not in ('ansatte', 'ansatt_tillegg', 'fravaer', 'arbeidsplaner', 'ferie_overforinger', 'vaktbytter',
                                           'lonnskjoringer', 'lonn_inngaende', 'timebank_poster', 'avspasering_soknader',
                                           'ameldinger', 'bilag', 'lonnsendringer', 'nav_inntektsmeldinger', 'lonnstrekk')
              or faktura.kan(org_id, 'personal_les'))
         and (coalesce(tabell, '') not in ('fravaer', 'ferie_overforinger', 'avspasering_soknader', 'vaktbytter', 'nav_inntektsmeldinger')
              or faktura.kan(org_id, 'personal')));

-- Skatteetatens kontonummer for forskuddstrekk og utleggstrekk.
alter table faktura.lonn_oppsett
  add column skatt_kontonr text check (skatt_kontonr is null or faktura.kontonr_gyldig(skatt_kontonr));
grant insert (skatt_kontonr), update (skatt_kontonr) on faktura.lonn_oppsett to faktura_app;

-- KID-en for forskuddstrekket i måneden (19 siffer).
alter table faktura.lonnskjoringer
  add column forskuddstrekk_kid text check (forskuddstrekk_kid is null or forskuddstrekk_kid ~ '^[0-9]{19}$');

-- Eier og administrator setter KID-en, også når kjøringen er godkjent (den er betalingsinformasjon,
-- ikke lønn). De andre kjøringene med utbetaling i samme måned får den samme, om de ikke har en.
create function faktura.sett_forskuddstrekk_kid(_kjoring uuid, _kid text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  k faktura.lonnskjoringer;
  ny text := nullif(btrim(coalesce(_kid, '')), '');
begin
  select * into k from faktura.lonnskjoringer where id = _kjoring for update;
  if k.id is null then raise exception 'Fant ikke lønnskjøringen' using errcode = 'FA404'; end if;
  perform faktura.krev(k.org_id, 'personal');
  if ny is not null and ny !~ '^[0-9]{19}$' then
    raise exception 'KID-en for forskuddstrekk har 19 siffer' using errcode = 'FA400';
  end if;
  update faktura.lonnskjoringer set forskuddstrekk_kid = ny where id = k.id;
  if ny is not null then
    update faktura.lonnskjoringer set forskuddstrekk_kid = ny
     where org_id = k.org_id and id <> k.id and forskuddstrekk_kid is null
       and date_trunc('month', utbetalingsdato) = date_trunc('month', k.utbetalingsdato);
  end if;
end $$;
revoke execute on function faktura.sett_forskuddstrekk_kid(uuid, text) from public;
grant execute on function faktura.sett_forskuddstrekk_kid(uuid, text) to faktura_app;

-- Bokføringen: påleggstrekk (utlegg), bidragstrekk og forskudd til ansatte får egne kontoer i
-- lønnsbilaget (lonnBokforing.ts; standard 2610, 2620 og 1570).
create or replace function faktura.lonnskontoer_gyldige(_k jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(_k) = 'object'
     and not exists (
       select 1 from jsonb_each(_k) e
        where e.key not in ('lonn', 'feriepenger', 'aga', 'aga_feriepenger', 'otp', 'utgifter', 'forskuddstrekk', 'andre_trekk',
                            'paaleggstrekk', 'bidragstrekk', 'forskudd',
                            'skyldig_aga', 'paalopt_aga_feriepenger', 'skyldig_lonn', 'skyldige_feriepenger', 'skyldig_otp', 'bank')
           or jsonb_typeof(e.value) <> 'string'
           or (e.value #>> '{}') !~ '^[0-9]{4,6}$')
$$;
