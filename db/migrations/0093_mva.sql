-- 0093_mva.sql
-- Mva-meldingen fra bilagene (server/src/mva.ts): for hver termin regnes linjene i mva-meldingen
-- (mva-koden, grunnlaget, satsen og merverdiavgiften) fra posteringene, og oppgjøret føres i et eget
-- bilag (serie V, kilde mva): avgiftskontoene mot oppgjørskontoen (2740), med øreavrundingen. Når
-- terminen endres etter oppgjøret, reverseres det og føres på nytt. Brukeren merker terminen som
-- levert når mva-meldingen er levert i Altinn.

-- mva_termin: skattleggingsperioden: tomaaneder (alminnelig, seks terminer), aar (årstermin) eller
-- maaned.
alter table faktura.regnskap_oppsett
  add column mva_termin text not null default 'tomaaneder' check (mva_termin in ('tomaaneder', 'aar', 'maaned'));
grant insert (mva_termin), update (mva_termin) on faktura.regnskap_oppsett to faktura_app;

alter table faktura.bilag drop constraint bilag_kilde_check;
alter table faktura.bilag add constraint bilag_kilde_check
  check (kilde in ('lonn', 'nav_refusjon', 'anlegg', 'periodisering', 'manuell', 'faktura', 'innbetaling', 'utgift', 'utgift_betaling', 'bank', 'mva'));
drop policy bilag_les on faktura.bilag;
create policy bilag_les on faktura.bilag for select
  using ((kilde in ('lonn', 'nav_refusjon') and faktura.kan(org_id, 'personal_les'))
         or (kilde in ('anlegg', 'periodisering', 'manuell', 'faktura', 'innbetaling', 'utgift', 'utgift_betaling', 'bank', 'mva') and faktura.kan(org_id, 'regnskap')));

-- En termin: året, typen og nummeret (1–6 for tomaaneder, 1 for aar, 1–12 for maaned), og når
-- mva-meldingen ble levert (og med hvilket beløp: positivt å betale, negativt til gode). Oppgjøret
-- er bilaget med kilde mva og kilde_id lik terminens id (ett gjeldende).
create table faktura.mva_terminer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  aar int not null check (aar between 2000 and 2100),
  type text not null check (type in ('tomaaneder', 'aar', 'maaned')),
  termin int not null,
  levert date,
  levert_belop numeric(14,0),
  levert_av uuid references faktura.brukere(id) on delete set null,
  oppdatert timestamptz not null default now(),
  unique (org_id, aar, type, termin),
  unique (org_id, id),
  check ((type = 'tomaaneder' and termin between 1 and 6) or (type = 'aar' and termin = 1) or (type = 'maaned' and termin between 1 and 12)),
  check ((levert is null) = (levert_belop is null))
);
alter table faktura.mva_terminer enable row level security;
create policy mva_terminer_les on faktura.mva_terminer for select using (faktura.kan(org_id, 'regnskap'));
create policy mva_terminer_ny on faktura.mva_terminer for insert with check (faktura.kan(org_id, 'regnskap'));
create policy mva_terminer_endre on faktura.mva_terminer for update using (faktura.kan(org_id, 'regnskap')) with check (faktura.kan(org_id, 'regnskap'));
grant select on faktura.mva_terminer to faktura_app;
grant insert (org_id, aar, type, termin, levert, levert_belop, levert_av), update (levert, levert_belop, levert_av, oppdatert) on faktura.mva_terminer to faktura_app;
create trigger mva_terminer_org_id before update on faktura.mva_terminer
  for each row execute function faktura.org_id_uendret();
create trigger mva_terminer_revisjon after insert or update or delete on faktura.mva_terminer
  for each row execute function faktura.revider();

-- Fører oppgjøret for terminen (serie V, kilde mva, på den siste dagen i terminen). Et gjeldende
-- oppgjør for terminen reverseres først (terminen er endret). Posteringene regnes i API-et og
-- workeren (mva.ts): avgiftskontoene mot oppgjørskontoen, uten mva-koder.
create function faktura.bokfor_mva_oppgjor(_org uuid, _termin uuid, _dato date, _tekst text, _posteringer jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  gammelt uuid;
  b uuid;
begin
  perform faktura.krev(_org, 'regnskap');
  if not exists (select 1 from faktura.mva_terminer where org_id = _org and id = _termin) then
    raise exception 'Fant ikke terminen' using errcode = 'FA404';
  end if;
  if _dato is null or _dato > faktura.i_dag() then raise exception 'Datoen kan ikke være fram i tid' using errcode = 'FA400'; end if;
  if length(btrim(coalesce(_tekst, ''))) = 0 then raise exception 'Bilaget mangler tekst' using errcode = 'FA400'; end if;
  if jsonb_typeof(_posteringer) <> 'array' or jsonb_array_length(_posteringer) not between 2 and 50 then
    raise exception 'Bilaget må ha minst to linjer' using errcode = 'FA400';
  end if;
  if exists (select 1 from jsonb_array_elements(_posteringer) x
              where coalesce(x ->> 'konto', '') !~ '^[0-9]{4,6}$' or coalesce((x ->> 'belop')::numeric(14,2), 0) = 0) then
    raise exception 'Hver linje må ha en konto og et beløp' using errcode = 'FA400';
  end if;
  if (select sum((x ->> 'belop')::numeric(14,2)) from jsonb_array_elements(_posteringer) x) <> 0 then
    raise exception 'Bilaget går ikke i null' using errcode = 'FA400';
  end if;
  select id into gammelt from faktura.bilag
   where org_id = _org and kilde = 'mva' and kilde_id = _termin and reverserer is null and reversert_av is null
   for update;
  if gammelt is not null then
    perform faktura.reverser_bilag(gammelt, 'Reversert, terminen er endret: ' || (select tekst from faktura.bilag where id = gammelt));
  end if;
  insert into faktura.bilag (org_id, serie, aar, nummer, dato, tekst, kilde, kilde_id)
  values (_org, 'V', extract(year from _dato)::int, faktura.neste_bilagsnummer(_org, 'V', extract(year from _dato)::int), _dato,
          left(btrim(_tekst), 300), 'mva', _termin)
  returning id into b;
  insert into faktura.posteringer (org_id, bilag_id, rekke, konto, belop, tekst)
  select _org, b, y.n, y.x ->> 'konto', (y.x ->> 'belop')::numeric(14,2), left(nullif(btrim(y.x ->> 'tekst'), ''), 200)
    from jsonb_array_elements(_posteringer) with ordinality as y(x, n);
  return b;
end $$;

-- Angrer oppgjøret for terminen (reverserer det gjeldende).
create function faktura.angre_mva_oppgjor(_org uuid, _termin uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  gammelt uuid;
begin
  perform faktura.krev(_org, 'regnskap');
  select id into gammelt from faktura.bilag
   where org_id = _org and kilde = 'mva' and kilde_id = _termin and reverserer is null and reversert_av is null
   for update;
  if gammelt is null then raise exception 'Oppgjøret for terminen er ikke bokført' using errcode = 'FA409'; end if;
  return faktura.reverser_bilag(gammelt, 'Reversert, oppgjøret er angret: ' || (select tekst from faktura.bilag where id = gammelt));
end $$;

revoke execute on function faktura.bokfor_mva_oppgjor(uuid, uuid, date, text, jsonb), faktura.angre_mva_oppgjor(uuid, uuid) from public;
grant execute on function faktura.bokfor_mva_oppgjor(uuid, uuid, date, text, jsonb), faktura.angre_mva_oppgjor(uuid, uuid) to faktura_app;
