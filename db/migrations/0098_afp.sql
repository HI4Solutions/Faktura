-- AFP og OU (lonnsberegning.ts, lonn.ts, afpPremier.ts, lonnBokforing.ts, amelding.ts). Bedrifter
-- med tariffavtale som er med i Fellesordningen for AFP (privat sektor), betaler premie av den delen
-- av hver ansattes lønn i året som er mellom 1 G og 7,1 G (gjennomsnittlig G), fra og med året den
-- ansatte fyller 13 til og med året den ansatte fyller 61. Satsen fastsettes av styret i
-- Fellesordningen (2,7 % for 2025 og 2026). Premien faktureres kvartalsvis etterskudd ut fra
-- a-meldingen; lønnskjøringen avsetter den måned for måned (premien for året så langt, minus det som
-- er avsatt før). OU-premien (opplysnings- og utviklingsfondet, LO/NHO) faktureres sammen med den:
-- et fast beløp per måned per heltidsansatt (46 kr i 2026), uten arbeidsgiveravgift.
--
-- Arbeidsgiveravgiften av AFP-premien følger innbetalingen (avgiftsplikten knytter seg til den
-- faktiske innbetalingen av premien): den regnes når betalingen av fakturaen registreres
-- (afp_premier), og kommer i a-meldingen for måneden premien er betalt.
--
-- afp: med i Fellesordningen. afp_sats: premiesatsen (%). ou_premie: kroner per måned per
-- heltidsansatt (0: ingen). bokforing_afp: lønnsbilaget fører avsetningen (kostnad mot påløpt
-- premie), og betalingen føres mot den påløpte premien; uten føres premien som kostnad når den
-- betales.
alter table faktura.lonn_oppsett
  add column afp boolean not null default false,
  add column afp_sats numeric(5,2) not null default 2.7 check (afp_sats >= 0 and afp_sats <= 10),
  add column ou_premie numeric(8,2) not null default 0 check (ou_premie >= 0 and ou_premie <= 1000),
  add column bokforing_afp boolean not null default false;
grant insert (afp, afp_sats, ou_premie, bokforing_afp), update (afp, afp_sats, ou_premie, bokforing_afp) on faktura.lonn_oppsett to faktura_app;

-- Avsetningen på slippen: grunnlaget (kontantlønnen for den ansatte), AFP-premien og OU-premien.
alter table faktura.lonnsslipper
  add column afp_grunnlag numeric(12,2) not null default 0,
  add column afp numeric(12,2) not null default 0,
  add column ou numeric(12,2) not null default 0;
grant insert (afp_grunnlag, afp, ou), update (afp_grunnlag, afp, ou) on faktura.lonnsslipper to faktura_app;

-- Kontoene i lønnsoppsettet: honorar og styrehonorar (0096; manglet her, så de kunne ikke endres),
-- AFP- og OU-premien og den påløpte premien.
create or replace function faktura.lonnskontoer_gyldige(_k jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(_k) = 'object'
     and not exists (
       select 1 from jsonb_each(_k) e
        where e.key not in ('lonn', 'honorar', 'styrehonorar', 'feriepenger', 'aga', 'aga_feriepenger', 'otp', 'afp', 'ou', 'utgifter',
                            'forskuddstrekk', 'andre_trekk', 'paaleggstrekk', 'bidragstrekk', 'forskudd', 'bilgodtgjorelse', 'diett',
                            'reiseutlegg', 'naturalytelser', 'naturalytelser_mot', 'nav_refusjon',
                            'skyldig_aga', 'paalopt_aga_feriepenger', 'skyldig_lonn', 'skyldige_feriepenger', 'skyldig_otp', 'paalopt_afp', 'bank')
           or jsonb_typeof(e.value) <> 'string'
           or (e.value #>> '{}') !~ '^[0-9]{4,6}$')
$$;

-- Betalingene av fakturaene fra Fellesordningen: datoen premien ble betalt, kvartalet fakturaen
-- gjelder, AFP-premien og OU-premien, og arbeidsgiveravgiften av AFP-premien (satsen og beløpet,
-- regnet av API-et). Hver betaling bokføres med et bilag i lønnsserien (kilde afp_premie): den
-- påløpte premien (eller kostnaden) mot banken, og avgiften mot skyldig arbeidsgiveravgift. En
-- betaling som slettes, reverseres i regnskapet.
create table faktura.afp_premier (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  dato date not null,
  aar int not null check (aar between 2000 and 2100),
  kvartal int not null check (kvartal between 1 and 4),
  afp numeric(12,2) not null check (afp >= 0 and afp < 100000000),
  ou numeric(12,2) not null default 0 check (ou >= 0 and ou < 10000000),
  aga_sats numeric(5,2) not null check (aga_sats >= 0 and aga_sats <= 20),
  aga numeric(12,2) not null check (aga >= 0),
  tekst text check (tekst is null or length(tekst) <= 200),
  bilag_id uuid,
  opprettet_av uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null,
  opprettet timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, bilag_id) references faktura.bilag(org_id, id),
  check (afp + ou > 0)
);
create index afp_premier_dato on faktura.afp_premier (org_id, dato);
create trigger afp_premier_revisjon after insert or update or delete on faktura.afp_premier
  for each row execute function faktura.revider();

alter table faktura.afp_premier enable row level security;
create policy afp_premier_les on faktura.afp_premier for select using (faktura.kan(org_id, 'personal_les'));
create policy afp_premier_system on faktura.afp_premier for select using (faktura.er_system());
grant select on faktura.afp_premier to faktura_app, faktura_system;

-- Bilagene kan også komme fra betalingene av premien (kilde afp_premie); de ses som lønnsbilagene.
alter table faktura.bilag drop constraint bilag_kilde_check;
alter table faktura.bilag add constraint bilag_kilde_check
  check (kilde in ('lonn', 'nav_refusjon', 'afp_premie', 'anlegg', 'periodisering', 'manuell', 'faktura', 'innbetaling', 'utgift', 'utgift_betaling',
                   'bank', 'mva', 'aarsoppgjor', 'mva_justering'));
drop policy bilag_les on faktura.bilag;
create policy bilag_les on faktura.bilag for select
  using ((kilde in ('lonn', 'nav_refusjon', 'afp_premie') and faktura.kan(org_id, 'personal_les'))
         or (kilde in ('anlegg', 'periodisering', 'manuell', 'faktura', 'innbetaling', 'utgift', 'utgift_betaling', 'bank', 'mva', 'aarsoppgjor',
                       'mva_justering')
             and faktura.kan(org_id, 'regnskap')));

-- Eier eller administrator registrerer en betaling: raden og bilaget (på datoen premien ble betalt).
-- Posteringene (kontoene og beløpene, som går i null) og teksten regnes ut av API-et.
create function faktura.registrer_afp_premie(_org uuid, _r jsonb, _tekst text, _posteringer jsonb) returns uuid
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
  insert into faktura.afp_premier (org_id, dato, aar, kvartal, afp, ou, aga_sats, aga, tekst)
  values (_org, d, (_r->>'aar')::int, (_r->>'kvartal')::int, (_r->>'afp')::numeric(12,2), coalesce((_r->>'ou')::numeric(12,2), 0),
          (_r->>'aga_sats')::numeric(5,2), (_r->>'aga')::numeric(12,2), nullif(btrim(_r->>'tekst'), ''))
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

-- Eier eller administrator sletter en betaling som er registrert feil: bilaget reverseres (det
-- slettes aldri), og raden fjernes.
create function faktura.slett_afp_premie(_org uuid, _id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r faktura.afp_premier;
begin
  perform faktura.krev(_org, 'personal');
  select * into r from faktura.afp_premier where org_id = _org and id = _id for update;
  if r.id is null then raise exception 'Fant ikke betalingen' using errcode = 'FA404'; end if;
  if r.bilag_id is not null and exists (select 1 from faktura.bilag where id = r.bilag_id and reversert_av is null) then
    perform faktura.reverser_bilag(r.bilag_id, 'Reversert: betalingen av AFP-premien er slettet');
  end if;
  delete from faktura.afp_premier where id = r.id;
end $$;
revoke execute on function faktura.slett_afp_premie(uuid, uuid) from public;
grant execute on function faktura.slett_afp_premie(uuid, uuid) to faktura_app;

-- Revisjonsloggen for betalingene er, som for lønnen, bare for dem som ser lønnen.
drop policy revisjonslogg_les on faktura.revisjonslogg;
create policy revisjonslogg_les on faktura.revisjonslogg for select
  using (faktura.kan(org_id, 'les')
         and (coalesce(tabell, '') not in ('ansatte', 'ansatt_tillegg', 'fravaer', 'arbeidsplaner', 'ferie_overforinger', 'vaktbytter',
                                           'lonnskjoringer', 'lonn_inngaende', 'timebank_poster', 'avspasering_soknader',
                                           'ameldinger', 'bilag', 'lonnsendringer', 'nav_inntektsmeldinger', 'lonnstrekk',
                                           'naturalytelser', 'reiseregninger', 'nav_refusjoner', 'afp_premier')
              or faktura.kan(org_id, 'personal_les'))
         and (coalesce(tabell, '') not in ('anleggsmidler', 'regnskap_oppsett', 'saldo_satser', 'periodiseringer', 'utgifter', 'utgift_linjer',
                                           'bankregler', 'mva_terminer', 'aarsoppgjor', 'mva_justeringer')
              or faktura.kan(org_id, 'regnskap'))
         and (coalesce(tabell, '') not in ('fravaer', 'ferie_overforinger', 'avspasering_soknader', 'vaktbytter', 'nav_inntektsmeldinger',
                                           'nav_refusjoner')
              or faktura.kan(org_id, 'personal')));
