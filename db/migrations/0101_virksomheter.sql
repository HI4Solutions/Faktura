-- Flere virksomheter og soner (Lønn K7; virksomheter.ts, lonn.ts, amelding.ts, afpPremier.ts,
-- navSykepenger.ts). Hovedvirksomheten er den i lønnsoppsettet (virksomhet_orgnr og aga_sone);
-- faktura.virksomheter er de andre virksomhetene (underenhetene i Enhetsregisteret) i foretaket,
-- med sonen for arbeidsgiveravgift der de ligger. ansatte.virksomhet_id er virksomheten den ansatte
-- jobber i (null: hovedvirksomheten). Lønnsslippen lagrer virksomheten og sonen den ble regnet med,
-- så a-meldingen (én virksomhet per underenhet) og fribeløpet i sone 1a (per foretak) bruker det som
-- gjaldt da lønnen ble utbetalt. AFP-premien (0098) lagrer sonen på samme måte.
create table faktura.virksomheter (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  orgnr text not null check (orgnr ~ '^[0-9]{9}$'),
  navn text not null check (length(btrim(navn)) between 1 and 200),
  aga_sone text not null default '1' check (aga_sone in ('1', '1a', '2', '3', '4', '4a', '5')),
  opprettet timestamptz not null default now(),
  oppdatert timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, orgnr)
);
create trigger virksomheter_oppdatert before update on faktura.virksomheter
  for each row execute function faktura.sett_oppdatert();
create trigger virksomheter_org_id before update on faktura.virksomheter
  for each row execute function faktura.org_id_uendret();
create trigger virksomheter_revisjon after insert or update or delete on faktura.virksomheter
  for each row execute function faktura.revider();

alter table faktura.virksomheter enable row level security;
create policy virksomheter_les on faktura.virksomheter for select using (faktura.kan(org_id, 'personal_les'));
create policy virksomheter_system on faktura.virksomheter for select using (faktura.er_system());
create policy virksomheter_ny on faktura.virksomheter for insert with check (faktura.kan(org_id, 'admin'));
create policy virksomheter_endre on faktura.virksomheter for update using (faktura.kan(org_id, 'admin')) with check (faktura.kan(org_id, 'admin'));
create policy virksomheter_slett on faktura.virksomheter for delete using (faktura.kan(org_id, 'admin'));
grant select, insert, update, delete on faktura.virksomheter to faktura_app;
grant select on faktura.virksomheter to faktura_system;

-- Virksomheten den ansatte jobber i (null: hovedvirksomheten i lønnsoppsettet).
alter table faktura.ansatte
  add column virksomhet_id uuid,
  add constraint ansatte_virksomhet foreign key (org_id, virksomhet_id) references faktura.virksomheter (org_id, id);
grant select (virksomhet_id), insert (virksomhet_id), update (virksomhet_id) on faktura.ansatte to faktura_app;
grant select (virksomhet_id) on faktura.ansatte to faktura_system;

-- Virksomheten og sonen slippen ble regnet med (null på eldre slipper: lønnsoppsettet).
alter table faktura.lonnsslipper
  add column virksomhet_orgnr text check (virksomhet_orgnr ~ '^[0-9]{9}$'),
  add column aga_sone text check (aga_sone in ('1', '1a', '2', '3', '4', '4a', '5'));
grant insert (virksomhet_orgnr, aga_sone), update (virksomhet_orgnr, aga_sone) on faktura.lonnsslipper to faktura_app;

-- Sonen AFP-premien ble regnet med (null på eldre betalinger: lønnsoppsettet).
alter table faktura.afp_premier add column aga_sone text check (aga_sone in ('1', '1a', '2', '3', '4', '4a', '5'));

create or replace function faktura.registrer_afp_premie(_org uuid, _r jsonb, _tekst text, _posteringer jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  ny uuid;
  b uuid;
  d date := (_r->>'dato')::date;
  p jsonb;
  n int := 0;
begin
  perform faktura.krev(_org, 'personal');
  if _tekst is null or jsonb_typeof(_posteringer) <> 'array' or jsonb_array_length(_posteringer) < 2 then
    raise exception 'Posteringene for bilaget mangler' using errcode = 'FA400';
  end if;
  if (select sum((x->>'belop')::numeric(12,2)) from jsonb_array_elements(_posteringer) x) <> 0 then
    raise exception 'Bilaget går ikke i null' using errcode = 'FA400';
  end if;
  insert into faktura.afp_premier (org_id, dato, aar, kvartal, afp, ou, aga_sats, aga, aga_sone, tekst)
  values (_org, d, (_r->>'aar')::int, (_r->>'kvartal')::int, (_r->>'afp')::numeric(12,2), coalesce((_r->>'ou')::numeric(12,2), 0),
          (_r->>'aga_sats')::numeric(5,2), (_r->>'aga')::numeric(12,2), nullif(_r->>'aga_sone', ''), nullif(btrim(_r->>'tekst'), ''))
  returning id into ny;
  insert into faktura.bilag (org_id, serie, aar, nummer, dato, tekst, kilde, kilde_id)
  values (_org, 'L', extract(year from d)::int, faktura.neste_bilagsnummer(_org, 'L', extract(year from d)::int), d, left(_tekst, 300), 'afp_premie', ny)
  returning id into b;
  for p in select * from jsonb_array_elements(_posteringer) loop
    if (p->>'konto') !~ '^[0-9]{4,6}$' then raise exception 'Ugyldig konto i bilaget' using errcode = 'FA400'; end if;
    n := n + 1;
    insert into faktura.posteringer (org_id, bilag_id, rekke, konto, belop, tekst)
    values (_org, b, n, p->>'konto', (p->>'belop')::numeric(12,2), left(coalesce(p->>'tekst', _tekst), 200));
  end loop;
  update faktura.afp_premier set bilag_id = b where id = ny;
  return ny;
end $$;
revoke execute on function faktura.registrer_afp_premie(uuid, jsonb, text, jsonb) from public;
grant execute on function faktura.registrer_afp_premie(uuid, jsonb, text, jsonb) to faktura_app;

-- Revisjonsloggen for virksomhetene er for dem som ser lønnen (som lønnsoppsettet).
drop policy revisjonslogg_les on faktura.revisjonslogg;
create policy revisjonslogg_les on faktura.revisjonslogg for select
  using (faktura.kan(org_id, 'les')
         and (coalesce(tabell, '') not in ('ansatte', 'ansatt_tillegg', 'fravaer', 'arbeidsplaner', 'ferie_overforinger', 'vaktbytter',
                                           'lonnskjoringer', 'lonn_inngaende', 'timebank_poster', 'avspasering_soknader',
                                           'ameldinger', 'bilag', 'lonnsendringer', 'nav_inntektsmeldinger', 'lonnstrekk',
                                           'naturalytelser', 'reiseregninger', 'nav_refusjoner', 'afp_premier', 'virksomheter')
              or faktura.kan(org_id, 'personal_les'))
         and (coalesce(tabell, '') not in ('anleggsmidler', 'regnskap_oppsett', 'saldo_satser', 'periodiseringer', 'utgifter', 'utgift_linjer',
                                           'bankregler', 'mva_terminer', 'aarsoppgjor', 'mva_justeringer')
              or faktura.kan(org_id, 'regnskap'))
         and (coalesce(tabell, '') not in ('fravaer', 'ferie_overforinger', 'avspasering_soknader', 'vaktbytter', 'nav_inntektsmeldinger',
                                           'nav_refusjoner')
              or faktura.kan(org_id, 'personal')));
