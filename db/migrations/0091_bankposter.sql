-- 0091_bankposter.sql
-- Bankpostene (server/src/bankAvstemming.ts): alle bokførte transaksjoner på organisasjonens egne
-- kontoer, inn og ut, slik banken sender dem gjennom open banking (i de samme hentingene som
-- innbetalingene), og avstemmingen mot regnskapet. Hver post føres i regnskapet på én av tre måter:
--   - koblet til bilaget som alt fører den på bankkontoen: innbetalingen på en faktura, en
--     kvittering betalt med kort, lønnen (nettolønnen ført mot banken), en refusjon fra NAV eller
--     et manuelt bilag;
--   - bokført av reglene: betalingen av en leverandørfaktura (serie U, som når betalingen
--     registreres for hånd), og i et eget bilag i serie B (kilde bank) nettolønnen,
--     forskuddstrekket, trekkene, arbeidsgiveravgiften, overføringer mellom egne kontoer, gebyrer,
--     renter og det brukeren har lært reglene (motparten og kontoen);
--   - lagt fram for brukeren (Regnskap → Bank) med et forslag, eller uavklart.
-- Posteringene regnes i API-et og workeren; databasen kontrollerer dem.

alter table faktura.bilag drop constraint bilag_kilde_check;
alter table faktura.bilag add constraint bilag_kilde_check
  check (kilde in ('lonn', 'nav_refusjon', 'anlegg', 'periodisering', 'manuell', 'faktura', 'innbetaling', 'utgift', 'utgift_betaling', 'bank'));
drop policy bilag_les on faktura.bilag;
create policy bilag_les on faktura.bilag for select
  using ((kilde in ('lonn', 'nav_refusjon') and faktura.kan(org_id, 'personal_les'))
         or (kilde in ('anlegg', 'periodisering', 'manuell', 'faktura', 'innbetaling', 'utgift', 'utgift_betaling', 'bank') and faktura.kan(org_id, 'regnskap')));

-- bank_fra: bankpostene fra og med denne datoen føres i regnskapet (null: alle som er hentet); det
--   som er fra før, hører til den inngående balansen.
-- bank_auto: reglene fører og kobler bankpostene av seg selv (ellers bare forslag).
-- bankkontoer: kontoen i regnskapet for en bankkonto (kontonummeret); de som ikke er med, føres på
--   bankkontoen i kontoplanen (1920).
create function faktura.bankkontoer_gyldige(_k jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(_k) = 'object'
     and not exists (
       select 1 from jsonb_each(_k) e
        where e.key !~ '^[0-9A-Z]{5,34}$'
           or jsonb_typeof(e.value) <> 'string'
           or (e.value #>> '{}') !~ '^[0-9]{4,6}$')
$$;
alter table faktura.regnskap_oppsett
  add column bank_fra date,
  add column bank_auto boolean not null default true,
  add column bankkontoer jsonb not null default '{}' check (faktura.bankkontoer_gyldige(bankkontoer));
grant insert (bank_fra, bank_auto, bankkontoer), update (bank_fra, bank_auto, bankkontoer) on faktura.regnskap_oppsett to faktura_app;

-- Organisasjonene som alt henter fra banken, får bankpostene ført fra og med den første i måneden
-- (de eldre hentes neste gang det hentes); de kan velge en annen dato.
alter table faktura.regnskap_oppsett disable trigger regnskap_oppsett_revisjon;
insert into faktura.regnskap_oppsett (org_id, bank_fra)
select distinct k.org_id, date_trunc('month', faktura.i_dag())::date
  from faktura.bankkoblinger k
 where k.status = 'aktiv'
on conflict (org_id) do update set bank_fra = excluded.bank_fra;
alter table faktura.regnskap_oppsett enable trigger regnskap_oppsett_revisjon;

-- ---------------------------------------------------------------------------
-- Bankpostene
-- ---------------------------------------------------------------------------

-- belop: inn positivt, ut negativt. motpart: betaleren (inn) eller mottakeren (ut). referanse: KID
--   eller en annen strukturert referanse. saldo: saldoen etter transaksjonen, når banken sender den.
-- status: ny (ikke vurdert), avstemt (ført: bilag_id, eller en overføring mellom to egne kontoer på
--   samme konto i regnskapet: par_id), forslag (forslag: det reglene foreslår) eller uavklart.
-- regel: hvorfor den er ført slik, eller hva som mangler. auto: reglene kan føre den av seg selv
--   (false når brukeren har angret; da bare forslag). avstemt_av: null når den er ført av seg selv.
create table faktura.bankposter (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  konto text not null,
  ekstern_id text not null,
  dato date not null,
  belop numeric(14,2) not null check (belop <> 0),
  valuta text not null default 'NOK',
  motpart text,
  motpart_konto text,
  melding text,
  referanse text,
  saldo numeric(16,2),
  status text not null default 'ny' check (status in ('ny', 'avstemt', 'forslag', 'uavklart')),
  bilag_id uuid,
  par_id uuid,
  regel text check (regel is null or length(regel) <= 300),
  forslag jsonb,
  auto boolean not null default true,
  vurdert timestamptz,
  avstemt timestamptz,
  avstemt_av uuid references faktura.brukere(id) on delete set null,
  opprettet timestamptz not null default now(),
  unique (org_id, konto, ekstern_id),
  unique (org_id, id),
  foreign key (org_id, bilag_id) references faktura.bilag(org_id, id),
  foreign key (org_id, par_id) references faktura.bankposter(org_id, id) on delete set null (par_id),
  check (status = 'avstemt' or (bilag_id is null and par_id is null)),
  check (status <> 'avstemt' or bilag_id is not null or par_id is not null)
);
create index bankposter_dato on faktura.bankposter (org_id, konto, dato);
create index bankposter_apne on faktura.bankposter (org_id, status, dato) where status <> 'avstemt';
create index bankposter_bilag on faktura.bankposter (bilag_id) where bilag_id is not null;

alter table faktura.bankposter enable row level security;
create policy bankposter_les on faktura.bankposter for select using (faktura.kan(org_id, 'regnskap'));
create policy bankposter_system on faktura.bankposter for all using (faktura.er_system()) with check (faktura.er_system());
grant select on faktura.bankposter to faktura_app;
grant insert (org_id, konto, ekstern_id, dato, belop, valuta, motpart, motpart_konto, melding, referanse, saldo), update (saldo)
  on faktura.bankposter to faktura_system;
create trigger bankposter_org_id before update on faktura.bankposter
  for each row execute function faktura.org_id_uendret();

-- Hvor langt tilbake bankpostene er hentet for hver konto (eldre hentes når startdatoen flyttes
-- bakover, høyst 89 dager tilbake), og saldoen banken oppga sist (når brukeren var til stede).
create table faktura.bankpost_kontoer (
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  konto text not null,
  hentet_fra date not null,
  saldo numeric(16,2),
  saldo_dato date,
  oppdatert timestamptz not null default now(),
  primary key (org_id, konto)
);
alter table faktura.bankpost_kontoer enable row level security;
create policy bankpost_kontoer_les on faktura.bankpost_kontoer for select using (faktura.kan(org_id, 'regnskap'));
create policy bankpost_kontoer_system on faktura.bankpost_kontoer for all using (faktura.er_system()) with check (faktura.er_system());
grant select on faktura.bankpost_kontoer to faktura_app;
grant insert (org_id, konto, hentet_fra, saldo, saldo_dato, oppdatert), update (hentet_fra, saldo, saldo_dato, oppdatert)
  on faktura.bankpost_kontoer to faktura_system;

-- Reglene brukeren har lært: bankposter til (ut) eller fra (inn) motparten, kontonummeret eller
-- ellers navnet (små bokstaver), føres på kontoen.
create table faktura.bankregler (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  retning text not null check (retning in ('inn', 'ut')),
  motpart_konto text check (motpart_konto is null or motpart_konto ~ '^[0-9A-Z]{5,34}$'),
  motpart text check (motpart is null or (length(motpart) between 1 and 200 and motpart = lower(motpart))),
  konto text not null check (konto ~ '^[0-9]{4,6}$'),
  tekst text check (tekst is null or length(btrim(tekst)) between 1 and 200),
  opprettet timestamptz not null default now(),
  opprettet_av uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null,
  check (motpart_konto is not null or motpart is not null)
);
create unique index bankregler_unik on faktura.bankregler (org_id, retning, coalesce(motpart_konto, ''), coalesce(motpart, ''));
alter table faktura.bankregler enable row level security;
create policy bankregler_les on faktura.bankregler for select using (faktura.kan(org_id, 'regnskap') or faktura.er_system());
create policy bankregler_ny on faktura.bankregler for insert with check (faktura.kan(org_id, 'regnskap'));
create policy bankregler_endre on faktura.bankregler for update using (faktura.kan(org_id, 'regnskap')) with check (faktura.kan(org_id, 'regnskap'));
create policy bankregler_slett on faktura.bankregler for delete using (faktura.kan(org_id, 'regnskap'));
grant select, delete on faktura.bankregler to faktura_app;
grant insert (org_id, retning, motpart_konto, motpart, konto, tekst), update (konto, tekst) on faktura.bankregler to faktura_app;
create trigger bankregler_revisjon after insert or update or delete on faktura.bankregler
  for each row execute function faktura.revider();

-- ---------------------------------------------------------------------------
-- Funksjonene
-- ---------------------------------------------------------------------------

-- Kontoen i regnskapet for en bankkonto.
create function faktura.bankpost_konto(_org uuid, _konto text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select coalesce(r.bankkontoer ->> _konto, r.kontoer ->> 'bank') from faktura.regnskap_oppsett r where r.org_id = _org), '1920')
$$;

-- Det av bilagets beløp på bankkontoen som ikke er koblet til bankposter.
create function faktura.bilag_bankrest(_bilag uuid, _konto text) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(p.belop) from faktura.posteringer p where p.bilag_id = _bilag and p.konto = _konto), 0)
       - coalesce((select sum(x.belop) from faktura.bankposter x where x.bilag_id = _bilag and faktura.bankpost_konto(x.org_id, x.konto) = _konto), 0)
$$;

-- Bankposten låses og sjekkes før den føres: den finnes, er ikke ført, og er ikke fra før
-- startdatoen for banken i regnskapet.
create function faktura.bankpost_til_foring(_org uuid, _post uuid) returns faktura.bankposter
language plpgsql security definer set search_path = '' as $$
declare
  p faktura.bankposter;
  start date;
begin
  perform faktura.krev(_org, 'regnskap');
  select * into p from faktura.bankposter where org_id = _org and id = _post for update;
  if p.id is null then raise exception 'Fant ikke bankposten' using errcode = 'FA404'; end if;
  if p.status = 'avstemt' then raise exception 'Bankposten er alt ført' using errcode = 'FA409'; end if;
  select bank_fra into start from faktura.regnskap_oppsett where org_id = _org;
  if p.dato < start then
    raise exception 'Bankposten er fra før startdatoen for banken i regnskapet' using errcode = 'FA409';
  end if;
  return p;
end $$;

-- Fører en bankpost i et eget bilag (serie B, kilde bank, på bankdatoen) og kobler den til det. Med
-- _mot: også motposten på en annen egen konto (en overføring) kobles til bilaget.
create function faktura.bokfor_bankpost(_org uuid, _post uuid, _tekst text, _posteringer jsonb, _regel text, _auto boolean default false, _mot uuid default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  p faktura.bankposter;
  m faktura.bankposter;
  konto text;
  b uuid;
begin
  p := faktura.bankpost_til_foring(_org, _post);
  if _mot is not null then
    m := faktura.bankpost_til_foring(_org, _mot);
    if m.id = p.id or m.konto = p.konto or m.belop <> -p.belop then
      raise exception 'Motposten er ikke den samme overføringen på en annen konto' using errcode = 'FA400';
    end if;
  end if;
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
  konto := faktura.bankpost_konto(_org, p.konto);
  if (select coalesce(sum((x ->> 'belop')::numeric(14,2)), 0) from jsonb_array_elements(_posteringer) x where x ->> 'konto' = konto) <> p.belop then
    raise exception 'Bilaget fører ikke bankposten på bankkontoen (%)', konto using errcode = 'FA400';
  end if;
  if _mot is not null then
    if faktura.bankpost_konto(_org, m.konto) = konto then
      raise exception 'Kontoene føres på samme konto i regnskapet; overføringen trenger ikke bilag' using errcode = 'FA400';
    end if;
    if (select coalesce(sum((x ->> 'belop')::numeric(14,2)), 0) from jsonb_array_elements(_posteringer) x
         where x ->> 'konto' = faktura.bankpost_konto(_org, m.konto)) <> m.belop then
      raise exception 'Bilaget fører ikke motposten på bankkontoen (%)', faktura.bankpost_konto(_org, m.konto) using errcode = 'FA400';
    end if;
  end if;
  insert into faktura.bilag (org_id, serie, aar, nummer, dato, tekst, kilde, kilde_id)
  values (_org, 'B', extract(year from p.dato)::int, faktura.neste_bilagsnummer(_org, 'B', extract(year from p.dato)::int), p.dato,
          left(btrim(_tekst), 300), 'bank', p.id)
  returning id into b;
  insert into faktura.posteringer (org_id, bilag_id, rekke, konto, belop, tekst, mva_kode)
  select _org, b, y.n, y.x ->> 'konto', (y.x ->> 'belop')::numeric(14,2), left(nullif(btrim(y.x ->> 'tekst'), ''), 200), nullif(y.x ->> 'mva_kode', '')
    from jsonb_array_elements(_posteringer) with ordinality as y(x, n);
  update faktura.bankposter
     set status = 'avstemt', bilag_id = b, regel = left(_regel, 300), forslag = null, vurdert = now(), avstemt = now(),
         avstemt_av = case when coalesce(_auto, false) then null else faktura.bruker_id() end
   where id in (p.id, _mot);
  return b;
end $$;

-- Kobler en bankpost til et bilag som alt fører den på bankkontoen (det som ikke er koblet til
-- andre bankposter, med samme fortegn; flere poster kan dele et bilag, f.eks. lønnen til hver ansatt).
create function faktura.avstem_bankpost(_org uuid, _post uuid, _bilag uuid, _regel text, _auto boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p faktura.bankposter;
  b faktura.bilag;
  konto text;
  rest numeric;
begin
  p := faktura.bankpost_til_foring(_org, _post);
  select * into b from faktura.bilag where org_id = _org and id = _bilag for update;
  if b.id is null or b.reverserer is not null or b.reversert_av is not null then
    raise exception 'Fant ikke bilaget' using errcode = 'FA404';
  end if;
  konto := faktura.bankpost_konto(_org, p.konto);
  rest := faktura.bilag_bankrest(b.id, konto);
  if rest = 0 or sign(rest) <> sign(p.belop) or abs(p.belop) > abs(rest) then
    raise exception 'Bilaget har ikke % kr på bankkontoen (%) som ikke er koblet', p.belop, konto using errcode = 'FA400';
  end if;
  update faktura.bankposter
     set status = 'avstemt', bilag_id = b.id, regel = left(_regel, 300), forslag = null, vurdert = now(), avstemt = now(),
         avstemt_av = case when coalesce(_auto, false) then null else faktura.bruker_id() end
   where id = p.id;
end $$;

-- En overføring mellom to egne kontoer som føres på samme konto i regnskapet: de to postene
-- kobles til hverandre (ingen posteringer).
create function faktura.avstem_overforing(_org uuid, _post uuid, _mot uuid, _regel text, _auto boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p faktura.bankposter;
  m faktura.bankposter;
begin
  p := faktura.bankpost_til_foring(_org, _post);
  m := faktura.bankpost_til_foring(_org, _mot);
  if m.id = p.id or m.konto = p.konto or m.belop <> -p.belop then
    raise exception 'Motposten er ikke den samme overføringen på en annen konto' using errcode = 'FA400';
  end if;
  if faktura.bankpost_konto(_org, p.konto) <> faktura.bankpost_konto(_org, m.konto) then
    raise exception 'Kontoene føres på hver sin konto i regnskapet; overføringen må bokføres' using errcode = 'FA400';
  end if;
  update faktura.bankposter
     set status = 'avstemt', par_id = case when id = p.id then m.id else p.id end, regel = left(_regel, 300), forslag = null,
         vurdert = now(), avstemt = now(), avstemt_av = case when coalesce(_auto, false) then null else faktura.bruker_id() end
   where id in (p.id, m.id);
end $$;

-- Forslaget eller hvorfor bankposten ikke er ført (reglene), eller ny for å vurderes på nytt.
create function faktura.sett_bankpost(_org uuid, _post uuid, _status text, _regel text, _forslag jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p faktura.bankposter;
begin
  perform faktura.krev(_org, 'regnskap');
  if _status not in ('ny', 'forslag', 'uavklart') then raise exception 'Ugyldig status' using errcode = 'FA400'; end if;
  if _status = 'forslag' and _forslag is null then raise exception 'Forslaget mangler' using errcode = 'FA400'; end if;
  select * into p from faktura.bankposter where org_id = _org and id = _post for update;
  if p.id is null then raise exception 'Fant ikke bankposten' using errcode = 'FA404'; end if;
  if p.status = 'avstemt' then raise exception 'Bankposten er alt ført' using errcode = 'FA409'; end if;
  update faktura.bankposter
     set status = _status, regel = left(_regel, 300), forslag = case when _status = 'forslag' then _forslag end, vurdert = now()
   where id = p.id;
end $$;

-- Angrer føringen: et bilag i serie B for posten reverseres (motposten på den andre kontoen blir
-- ikke ført igjen), og koblingen til et annet bilag eller en motpost fjernes. Fra brukeren blir
-- posten uavklart (reglene foreslår bare); fra reglene (_auto, f.eks. når startdatoen er flyttet
-- fram) blir den ny.
create function faktura.apne_bankpost(_org uuid, _post uuid, _auto boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p faktura.bankposter;
  b faktura.bilag;
begin
  perform faktura.krev(_org, 'regnskap');
  select * into p from faktura.bankposter where org_id = _org and id = _post for update;
  if p.id is null then raise exception 'Fant ikke bankposten' using errcode = 'FA404'; end if;
  if p.status <> 'avstemt' then raise exception 'Bankposten er ikke ført' using errcode = 'FA409'; end if;
  if p.bilag_id is not null then
    select * into b from faktura.bilag where id = p.bilag_id;
    if b.kilde = 'bank' and b.reverserer is null and b.reversert_av is null
       and (b.kilde_id = p.id or exists (select 1 from faktura.bankposter x where x.id = b.kilde_id and x.bilag_id = b.id)) then
      -- Reverseringen åpner postene som er koblet til bilaget (utløseren under).
      perform faktura.reverser_bilag(b.id, 'Reversert, bankposten er angret: ' || b.tekst);
    end if;
  end if;
  update faktura.bankposter
     set status = 'ny', bilag_id = null, par_id = null, regel = null, forslag = null, avstemt = null, avstemt_av = null, vurdert = null
   where org_id = _org and (id = p.id or (p.par_id is not null and id = p.par_id));
  if not coalesce(_auto, false) then
    update faktura.bankposter
       set status = 'uavklart', auto = false, regel = 'Angret. Velg hvordan den skal føres.', vurdert = now()
     where id = p.id;
  end if;
end $$;

-- Et bilag som reverseres (en utgift som angres, en lønnskjøring som åpnes igjen, et bilag i serie
-- B som angres), slipper bankpostene som var koblet til det; de vurderes på nytt.
create function faktura.bilag_reversert_bankposter() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.reversert_av is not null and old.reversert_av is null then
    update faktura.bankposter
       set status = 'ny', bilag_id = null, regel = null, forslag = null, avstemt = null, avstemt_av = null, vurdert = null
     where bilag_id = new.id;
  end if;
  return new;
end $$;
create trigger bilag_reversert_bankposter after update of reversert_av on faktura.bilag
  for each row execute function faktura.bilag_reversert_bankposter();

-- Angrer betalingen av en utgift (ikke selve utgiften): betalingsbilaget reverseres, og utgiften
-- står som ubetalt igjen.
create function faktura.angre_utgift_betaling(_org uuid, _utgift uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  u faktura.utgifter;
begin
  perform faktura.krev(_org, 'regnskap');
  select * into u from faktura.utgifter where org_id = _org and id = _utgift for update;
  if u.id is null then raise exception 'Fant ikke utgiften' using errcode = 'FA404'; end if;
  if u.status <> 'bokfort' or u.betaling_bilag_id is null then raise exception 'Betalingen er ikke bokført' using errcode = 'FA409'; end if;
  if exists (select 1 from faktura.bilag where id = u.betaling_bilag_id and reverserer is null and reversert_av is null) then
    perform faktura.reverser_bilag(u.betaling_bilag_id, 'Reversert, betalingen er angret: ' || (select tekst from faktura.bilag where id = u.betaling_bilag_id));
  end if;
  perform pg_catalog.set_config('faktura.utgift_funksjon', 'on', true);
  update faktura.utgifter set betaling = 'ubetalt', betalt_dato = null, betaling_bilag_id = null where id = u.id;
  perform pg_catalog.set_config('faktura.utgift_funksjon', 'off', true);
end $$;

revoke execute on function faktura.bankpost_konto(uuid, text), faktura.bilag_bankrest(uuid, text), faktura.bankpost_til_foring(uuid, uuid),
  faktura.bokfor_bankpost(uuid, uuid, text, jsonb, text, boolean, uuid), faktura.avstem_bankpost(uuid, uuid, uuid, text, boolean),
  faktura.avstem_overforing(uuid, uuid, uuid, text, boolean), faktura.sett_bankpost(uuid, uuid, text, text, jsonb),
  faktura.apne_bankpost(uuid, uuid, boolean), faktura.angre_utgift_betaling(uuid, uuid), faktura.bilag_reversert_bankposter() from public;
grant execute on function faktura.bankpost_konto(uuid, text), faktura.bilag_bankrest(uuid, text),
  faktura.bokfor_bankpost(uuid, uuid, text, jsonb, text, boolean, uuid), faktura.avstem_bankpost(uuid, uuid, uuid, text, boolean),
  faktura.avstem_overforing(uuid, uuid, uuid, text, boolean), faktura.sett_bankpost(uuid, uuid, text, text, jsonb),
  faktura.apne_bankpost(uuid, uuid, boolean), faktura.angre_utgift_betaling(uuid, uuid)
  to faktura_app;
