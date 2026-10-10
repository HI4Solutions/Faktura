-- 0094_aarsoppgjor.sql
-- Periodelås og årsoppgjør (server/src/aarsoppgjor.ts).
--
-- Regnskapet kan låses til og med en dato (regnskap_oppsett.laast_til): et bilag med dato i den låste
-- perioden føres på den første åpne dagen, med den opprinnelige datoen i teksten. Det gjelder alle
-- bilagene, også reverseringene og det automatikken fører (fakturaene, utgiftene, banken, lønnen),
-- så ingenting endres i en periode som er levert eller avsluttet, og automatikken stopper ikke.
-- Manuelle bilag i en låst periode avvises i API-et.
--
-- Årsoppgjøret: et bilag i serie Å (kilde aarsoppgjor) den 31. desember med skattekostnaden og
-- utbyttet (når de er oppgitt) og overføringen av resten av årsresultatet til annen egenkapital, så
-- resultatkontoene går i null for året. Ett gjeldende per år; et nytt reverserer det forrige. Etterpå
-- kan året låses.

alter table faktura.regnskap_oppsett add column laast_til date;
grant insert (laast_til), update (laast_til) on faktura.regnskap_oppsett to faktura_app;

-- Serien for årsoppgjøret er Å.
alter table faktura.bilag drop constraint bilag_serie_check;
alter table faktura.bilag add constraint bilag_serie_check check (serie ~ '^[A-ZÆØÅ]{1,3}$');
alter table faktura.bilagserier drop constraint bilagserier_serie_check;
alter table faktura.bilagserier add constraint bilagserier_serie_check check (serie ~ '^[A-ZÆØÅ]{1,3}$');

alter table faktura.bilag drop constraint bilag_kilde_check;
alter table faktura.bilag add constraint bilag_kilde_check
  check (kilde in ('lonn', 'nav_refusjon', 'anlegg', 'periodisering', 'manuell', 'faktura', 'innbetaling', 'utgift', 'utgift_betaling', 'bank', 'mva',
                   'aarsoppgjor'));
drop policy bilag_les on faktura.bilag;
create policy bilag_les on faktura.bilag for select
  using ((kilde in ('lonn', 'nav_refusjon') and faktura.kan(org_id, 'personal_les'))
         or (kilde in ('anlegg', 'periodisering', 'manuell', 'faktura', 'innbetaling', 'utgift', 'utgift_betaling', 'bank', 'mva', 'aarsoppgjor')
             and faktura.kan(org_id, 'regnskap')));

-- Et bilag i den låste perioden føres på den første åpne dagen. Nummeret ble trukket i året for den
-- opprinnelige datoen: havner bilaget i et annet år, gis nummeret tilbake (det var det siste, serien
-- er låst til transaksjonen er ferdig) og bilaget får et nummer i det nye året.
create function faktura.bilag_periodelas() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  laast date;
  nytt_aar int;
begin
  select o.laast_til into laast from faktura.regnskap_oppsett o where o.org_id = new.org_id;
  if laast is null or new.dato > laast then return new; end if;
  new.tekst := left(new.tekst, 300 - 40) || ' (datert ' || to_char(new.dato, 'DD.MM.YYYY') || ', perioden er låst)';
  new.dato := laast + 1;
  nytt_aar := extract(year from new.dato)::int;
  if nytt_aar <> new.aar then
    if new.nummer = 1 then
      delete from faktura.bilagserier s where s.org_id = new.org_id and s.serie = new.serie and s.aar = new.aar and s.siste = 1;
    else
      update faktura.bilagserier s set siste = s.siste - 1
       where s.org_id = new.org_id and s.serie = new.serie and s.aar = new.aar and s.siste = new.nummer;
    end if;
    new.aar := nytt_aar;
    new.nummer := faktura.neste_bilagsnummer(new.org_id, new.serie, nytt_aar);
  end if;
  return new;
end $$;
create trigger bilag_periodelas before insert on faktura.bilag
  for each row execute function faktura.bilag_periodelas();

-- Årsoppgjøret for et år: skattekostnaden og utbyttet som ble oppgitt, og når året ble avsluttet.
-- Bilaget er det med kilde aarsoppgjor og kilde_id lik raden (ett gjeldende).
create table faktura.aarsoppgjor (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  aar int not null check (aar between 2000 and 2100),
  skatt numeric(14,2) not null default 0 check (skatt >= 0),
  utbytte numeric(14,2) not null default 0 check (utbytte >= 0),
  oppdatert timestamptz not null default now(),
  unique (org_id, aar),
  unique (org_id, id)
);
alter table faktura.aarsoppgjor enable row level security;
create policy aarsoppgjor_les on faktura.aarsoppgjor for select using (faktura.kan(org_id, 'regnskap'));
create policy aarsoppgjor_ny on faktura.aarsoppgjor for insert with check (faktura.kan(org_id, 'regnskap'));
create policy aarsoppgjor_endre on faktura.aarsoppgjor for update using (faktura.kan(org_id, 'regnskap')) with check (faktura.kan(org_id, 'regnskap'));
grant select on faktura.aarsoppgjor to faktura_app;
grant insert (org_id, aar, skatt, utbytte), update (skatt, utbytte, oppdatert) on faktura.aarsoppgjor to faktura_app;
create trigger aarsoppgjor_org_id before update on faktura.aarsoppgjor
  for each row execute function faktura.org_id_uendret();
create trigger aarsoppgjor_revisjon after insert or update or delete on faktura.aarsoppgjor
  for each row execute function faktura.revider();

-- Fører årsoppgjøret (serie Å, kilde aarsoppgjor, den 31. desember). Året må være over og ikke låst;
-- et gjeldende årsoppgjør for året reverseres først. Posteringene regnes i API-et (aarsoppgjor.ts).
create function faktura.bokfor_aarsoppgjor(_org uuid, _aarsoppgjor uuid, _tekst text, _posteringer jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  a faktura.aarsoppgjor;
  dato date;
  gammelt uuid;
  b uuid;
begin
  perform faktura.krev(_org, 'regnskap');
  select * into a from faktura.aarsoppgjor where org_id = _org and id = _aarsoppgjor for update;
  if a.id is null then raise exception 'Fant ikke årsoppgjøret' using errcode = 'FA404'; end if;
  dato := make_date(a.aar, 12, 31);
  if dato >= faktura.i_dag() then raise exception 'Året er ikke over' using errcode = 'FA409'; end if;
  if coalesce((select o.laast_til from faktura.regnskap_oppsett o where o.org_id = _org), '-infinity') >= dato then
    raise exception 'Året er låst; lås det opp først' using errcode = 'FA409';
  end if;
  if length(btrim(coalesce(_tekst, ''))) = 0 then raise exception 'Bilaget mangler tekst' using errcode = 'FA400'; end if;
  if jsonb_typeof(_posteringer) <> 'array' or jsonb_array_length(_posteringer) not between 2 and 20 then
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
   where org_id = _org and kilde = 'aarsoppgjor' and kilde_id = a.id and reverserer is null and reversert_av is null
   for update;
  if gammelt is not null then
    perform faktura.reverser_bilag(gammelt, 'Reversert, årsoppgjøret er ført på nytt: ' || (select tekst from faktura.bilag where id = gammelt));
  end if;
  insert into faktura.bilag (org_id, serie, aar, nummer, dato, tekst, kilde, kilde_id)
  values (_org, 'Å', a.aar, faktura.neste_bilagsnummer(_org, 'Å', a.aar), dato, left(btrim(_tekst), 300), 'aarsoppgjor', a.id)
  returning id into b;
  insert into faktura.posteringer (org_id, bilag_id, rekke, konto, belop, tekst)
  select _org, b, y.n, y.x ->> 'konto', (y.x ->> 'belop')::numeric(14,2), left(nullif(btrim(y.x ->> 'tekst'), ''), 200)
    from jsonb_array_elements(_posteringer) with ordinality as y(x, n);
  return b;
end $$;

-- Angrer årsoppgjøret (reverserer det gjeldende), når året ikke er låst.
create function faktura.angre_aarsoppgjor(_org uuid, _aarsoppgjor uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  a faktura.aarsoppgjor;
  gammelt uuid;
begin
  perform faktura.krev(_org, 'regnskap');
  select * into a from faktura.aarsoppgjor where org_id = _org and id = _aarsoppgjor;
  if a.id is null then raise exception 'Fant ikke årsoppgjøret' using errcode = 'FA404'; end if;
  if coalesce((select o.laast_til from faktura.regnskap_oppsett o where o.org_id = _org), '-infinity') >= make_date(a.aar, 12, 31) then
    raise exception 'Året er låst; lås det opp først' using errcode = 'FA409';
  end if;
  select id into gammelt from faktura.bilag
   where org_id = _org and kilde = 'aarsoppgjor' and kilde_id = a.id and reverserer is null and reversert_av is null
   for update;
  if gammelt is null then raise exception 'Årsoppgjøret er ikke bokført' using errcode = 'FA409'; end if;
  return faktura.reverser_bilag(gammelt, 'Reversert, årsoppgjøret er angret: ' || (select tekst from faktura.bilag where id = gammelt));
end $$;

revoke execute on function faktura.bokfor_aarsoppgjor(uuid, uuid, text, jsonb), faktura.angre_aarsoppgjor(uuid, uuid) from public;
grant execute on function faktura.bokfor_aarsoppgjor(uuid, uuid, text, jsonb), faktura.angre_aarsoppgjor(uuid, uuid) to faktura_app;

-- Revisjonsloggen for utgiftene, bankreglene, mva-terminene og årsoppgjøret er for dem som fører
-- regnskapet (som for anleggsmidlene og periodiseringene).
drop policy revisjonslogg_les on faktura.revisjonslogg;
create policy revisjonslogg_les on faktura.revisjonslogg for select
  using (faktura.kan(org_id, 'les')
         and (coalesce(tabell, '') not in ('ansatte', 'ansatt_tillegg', 'fravaer', 'arbeidsplaner', 'ferie_overforinger', 'vaktbytter',
                                           'lonnskjoringer', 'lonn_inngaende', 'timebank_poster', 'avspasering_soknader',
                                           'ameldinger', 'bilag', 'lonnsendringer', 'nav_inntektsmeldinger', 'lonnstrekk',
                                           'naturalytelser', 'reiseregninger', 'nav_refusjoner')
              or faktura.kan(org_id, 'personal_les'))
         and (coalesce(tabell, '') not in ('anleggsmidler', 'regnskap_oppsett', 'saldo_satser', 'periodiseringer', 'utgifter', 'utgift_linjer',
                                           'bankregler', 'mva_terminer', 'aarsoppgjor')
              or faktura.kan(org_id, 'regnskap'))
         and (coalesce(tabell, '') not in ('fravaer', 'ferie_overforinger', 'avspasering_soknader', 'vaktbytter', 'nav_inntektsmeldinger',
                                           'nav_refusjoner')
              or faktura.kan(org_id, 'personal')));
