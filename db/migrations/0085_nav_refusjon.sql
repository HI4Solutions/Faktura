-- 0085_nav_refusjon.sql
-- Refusjonene fra NAV (lønn, fase J): det NAV har betalt arbeidsgiveren (sykepenger og
-- omsorgspenger etter refusjonskravet i inntektsmeldingen, foreldrepenger, svangerskapspenger,
-- pleiepenger og annet), med datoen pengene kom, beløpet, perioden og den ansatte. Hver refusjon
-- bokføres med et bilag i lønnsserien (bank mot kontoen for refusjon fra NAV, standard 5800), og
-- en refusjon som slettes, reverseres i regnskapet. Avstemmingen sammenligner det som er mottatt
-- med det som er krevd (server/src/avstemming.ts).
--
-- Sykepenger er helseopplysninger: refusjonene ser og registrerer bare eier og administrator, og
-- bilaget har ikke navnet på den ansatte (regnskapet ser bilagene).

create table faktura.nav_refusjoner (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  ansatt_id uuid,
  type text not null check (type in ('sykepenger', 'omsorgspenger', 'foreldrepenger', 'svangerskapspenger', 'pleiepenger', 'annet')),
  dato date not null,
  belop numeric(12,2) not null check (belop > 0 and belop < 10000000),
  fra date,
  til date,
  tekst text check (tekst is null or length(tekst) <= 200),
  bilag_id uuid,
  opprettet_av uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null,
  opprettet timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete set null (ansatt_id),
  foreign key (org_id, bilag_id) references faktura.bilag(org_id, id),
  check ((fra is null) = (til is null) and (til is null or til >= fra)),
  check (til is null or til - fra <= 400)
);
create index nav_refusjoner_dato on faktura.nav_refusjoner (org_id, dato);
create trigger nav_refusjoner_revisjon after insert or update or delete on faktura.nav_refusjoner
  for each row execute function faktura.revider();

alter table faktura.nav_refusjoner enable row level security;
create policy nav_refusjoner_les on faktura.nav_refusjoner for select using (faktura.kan(org_id, 'personal'));
create policy nav_refusjoner_system on faktura.nav_refusjoner for select using (faktura.er_system());
grant select on faktura.nav_refusjoner to faktura_app, faktura_system;

-- Bilagene kan også komme fra refusjonene (kilde nav_refusjon); regnskapet ser dem som lønnsbilagene.
alter table faktura.bilag drop constraint bilag_kilde_check;
alter table faktura.bilag add constraint bilag_kilde_check check (kilde in ('lonn', 'nav_refusjon'));
drop policy bilag_les on faktura.bilag;
create policy bilag_les on faktura.bilag for select using (kilde in ('lonn', 'nav_refusjon') and faktura.kan(org_id, 'personal_les'));

-- Kontoen for refusjon fra NAV i lønnsoppsettet.
create or replace function faktura.lonnskontoer_gyldige(_k jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(_k) = 'object'
     and not exists (
       select 1 from jsonb_each(_k) e
        where e.key not in ('lonn', 'feriepenger', 'aga', 'aga_feriepenger', 'otp', 'utgifter', 'forskuddstrekk', 'andre_trekk',
                            'paaleggstrekk', 'bidragstrekk', 'forskudd', 'bilgodtgjorelse', 'diett', 'reiseutlegg',
                            'naturalytelser', 'naturalytelser_mot', 'nav_refusjon',
                            'skyldig_aga', 'paalopt_aga_feriepenger', 'skyldig_lonn', 'skyldige_feriepenger', 'skyldig_otp', 'bank')
           or jsonb_typeof(e.value) <> 'string'
           or (e.value #>> '{}') !~ '^[0-9]{4,6}$')
$$;

-- Eier eller administrator registrerer en refusjon: raden og bilaget (bank i debet, kontoen for
-- refusjonen i kredit, på datoen pengene kom). Kontoene og teksten regnes ut av API-et.
create function faktura.registrer_nav_refusjon(_org uuid, _r jsonb, _bank text, _konto text, _tekst text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  ny uuid;
  b uuid;
  d date := (_r->>'dato')::date;
  belop numeric(12,2) := (_r->>'belop')::numeric(12,2);
begin
  perform faktura.krev(_org, 'personal');
  if _bank !~ '^[0-9]{4,6}$' or _konto !~ '^[0-9]{4,6}$' or _tekst is null then
    raise exception 'Kontoene for bilaget mangler' using errcode = 'FA400';
  end if;
  insert into faktura.nav_refusjoner (org_id, ansatt_id, type, dato, belop, fra, til, tekst)
  values (_org, nullif(_r->>'ansatt_id', '')::uuid, _r->>'type', d, belop, (_r->>'fra')::date, (_r->>'til')::date, nullif(btrim(_r->>'tekst'), ''))
  returning id into ny;
  insert into faktura.bilag (org_id, serie, aar, nummer, dato, tekst, kilde, kilde_id)
  values (_org, 'L', extract(year from d)::int, faktura.neste_bilagsnummer(_org, 'L', extract(year from d)::int), d, left(_tekst, 300), 'nav_refusjon', ny)
  returning id into b;
  insert into faktura.posteringer (org_id, bilag_id, rekke, konto, belop, tekst)
  values (_org, b, 1, _bank, belop, left(_tekst, 200)), (_org, b, 2, _konto, -belop, left(_tekst, 200));
  update faktura.nav_refusjoner set bilag_id = b where id = ny;
  return ny;
end $$;
revoke execute on function faktura.registrer_nav_refusjon(uuid, jsonb, text, text, text) from public;
grant execute on function faktura.registrer_nav_refusjon(uuid, jsonb, text, text, text) to faktura_app;

-- Eier eller administrator sletter en refusjon som er registrert feil: bilaget reverseres (det
-- slettes aldri), og raden fjernes.
create function faktura.slett_nav_refusjon(_org uuid, _id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r faktura.nav_refusjoner;
begin
  perform faktura.krev(_org, 'personal');
  select * into r from faktura.nav_refusjoner where org_id = _org and id = _id for update;
  if r.id is null then raise exception 'Fant ikke refusjonen' using errcode = 'FA404'; end if;
  if r.bilag_id is not null and exists (select 1 from faktura.bilag where id = r.bilag_id and reversert_av is null) then
    perform faktura.reverser_bilag(r.bilag_id, 'Reversert: refusjonen fra NAV er slettet');
  end if;
  delete from faktura.nav_refusjoner where id = r.id;
end $$;
revoke execute on function faktura.slett_nav_refusjon(uuid, uuid) from public;
grant execute on function faktura.slett_nav_refusjon(uuid, uuid) to faktura_app;

-- Revisjonsloggen for refusjonene (sykepenger) er, som for fraværet, bare for eier og administrator.
drop policy revisjonslogg_les on faktura.revisjonslogg;
create policy revisjonslogg_les on faktura.revisjonslogg for select
  using (faktura.kan(org_id, 'les')
         and (coalesce(tabell, '') not in ('ansatte', 'ansatt_tillegg', 'fravaer', 'arbeidsplaner', 'ferie_overforinger', 'vaktbytter',
                                           'lonnskjoringer', 'lonn_inngaende', 'timebank_poster', 'avspasering_soknader',
                                           'ameldinger', 'bilag', 'lonnsendringer', 'nav_inntektsmeldinger', 'lonnstrekk',
                                           'naturalytelser', 'reiseregninger', 'nav_refusjoner')
              or faktura.kan(org_id, 'personal_les'))
         and (coalesce(tabell, '') not in ('fravaer', 'ferie_overforinger', 'avspasering_soknader', 'vaktbytter', 'nav_inntektsmeldinger',
                                           'nav_refusjoner')
              or faktura.kan(org_id, 'personal')));
