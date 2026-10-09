-- 0088_lonn_automatikk.sql
-- Lønnen går av seg selv: et utkast til lønnskjøring regnes ut på nytt når noe lønnen regnes ut fra,
-- endres (timer, fravær, vakter, faste planer, tillegg, trekk, naturalytelser, reiser, timebanken,
-- lønnsendringer, de ansatte, oppsettet og trekktabellene, og når en annen kjøring godkjennes eller
-- åpnes igjen), workeren lager den ordinære kjøringen for måneden når organisasjonen har kjørt lønn
-- de siste tre månedene, og eier og administrator får en påminnelse før lønnsdagen når den ikke er
-- godkjent.
--
-- Endringene logges med transaksjonen som gjorde dem (én rad per organisasjon og transaksjon, så
-- samtidige endringer aldri venter på hverandre). Når et utkast regnes ut, lagres øyeblikksbildet
-- (pg_snapshot) fra starten av utregningen; utkastet er utdatert når det finnes en endring som ikke
-- var synlig i det. En godkjent kjøring regnes alltid ut på nytt før den godkjennes.

-- ---------------------------------------------------------------------------
-- Endringene i grunnlaget
-- ---------------------------------------------------------------------------

create table faktura.lonn_endringer (
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  xid xid8 not null default pg_current_xact_id(),
  tid timestamptz not null default now(),
  primary key (org_id, xid)
);
-- Bare funksjonene under leser og skriver tabellen.
alter table faktura.lonn_endringer enable row level security;

create function faktura.lonn_endret() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  o uuid := coalesce(new.org_id, old.org_id);
begin
  -- (Når hele organisasjonen slettes, er den borte først.)
  if exists (select 1 from faktura.organisasjoner where id = o) then
    insert into faktura.lonn_endringer (org_id) values (o) on conflict do nothing;
  end if;
  return null;
end $$;

-- Trekktabellene er felles: alle organisasjonene med et utkast.
create function faktura.lonn_endret_alle() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into faktura.lonn_endringer (org_id)
  select distinct k.org_id from faktura.lonnskjoringer k where k.status = 'utkast'
  on conflict do nothing;
  return null;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array['ansatte', 'ansatt_tillegg', 'lonnstrekk', 'naturalytelser', 'reiseregninger', 'timeforinger', 'fravaer',
                           'timebank_poster', 'vakter', 'arbeidsplaner', 'arbeidsplan_dager', 'arbeidsplan_fri', 'lonnsendringer',
                           'lonn_inngaende', 'lonn_oppsett'] loop
    execute format('create trigger %I after insert or update or delete on faktura.%I for each row execute function faktura.lonn_endret()',
                   t || '_lonn_endret', t);
  end loop;
end $$;
-- En kjøring som godkjennes eller åpnes igjen, endrer tallene i år, timene som er lønnet og trekket
-- som er betalt.
create trigger lonnskjoringer_lonn_endret after update of status on faktura.lonnskjoringer
  for each row execute function faktura.lonn_endret();
create trigger trekktabeller_lonn_endret after insert or update or delete or truncate on faktura.trekktabeller
  for each statement execute function faktura.lonn_endret_alle();

-- ---------------------------------------------------------------------------
-- Utregningen av hver kjøring
-- ---------------------------------------------------------------------------

-- snapshot: øyeblikksbildet fra starten av den siste utregningen; beregnet: da. paaminnet: da eier
-- og administrator fikk påminnelsen om at kjøringen ikke er godkjent (én gang per kjøring).
create table faktura.lonnskjoring_beregning (
  kjoring_id uuid primary key,
  org_id uuid not null,
  snapshot pg_snapshot not null,
  beregnet timestamptz not null default now(),
  paaminnet timestamptz,
  foreign key (org_id, kjoring_id) references faktura.lonnskjoringer(org_id, id) on delete cascade
);
alter table faktura.lonnskjoring_beregning enable row level security;
create policy lonnskjoring_beregning_les on faktura.lonnskjoring_beregning for select using (faktura.kan(org_id, 'personal_les'));
create policy lonnskjoring_beregning_paaminnet on faktura.lonnskjoring_beregning for update using (faktura.er_system()) with check (faktura.er_system());
grant select on faktura.lonnskjoring_beregning to faktura_app, faktura_system;
grant update (paaminnet) on faktura.lonnskjoring_beregning to faktura_system;

-- Kalles først i utregningen (server/src/lonn.ts): øyeblikksbildet lagres (i samme transaksjon som
-- slippene, så det gjelder bare når utregningen blir lagret).
create function faktura.lonn_beregnes(_kjoring uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  k faktura.lonnskjoringer;
begin
  select * into k from faktura.lonnskjoringer where id = _kjoring;
  if k.id is null then raise exception 'Fant ikke lønnskjøringen' using errcode = 'FA404'; end if;
  perform faktura.krev(k.org_id, 'personal');
  if k.status <> 'utkast' then raise exception 'Lønnskjøringen er godkjent. Åpne den igjen for å endre den.' using errcode = 'FA409'; end if;
  insert into faktura.lonnskjoring_beregning (kjoring_id, org_id, snapshot) values (k.id, k.org_id, pg_current_snapshot())
  on conflict (kjoring_id) do update set snapshot = excluded.snapshot, beregnet = now();
end $$;

-- Om et utkast må regnes ut på nytt: det er ikke regnet ut (siden denne migreringen), eller noe er
-- endret etter at det ble regnet ut. Null for den som ikke ser lønnen, og for en godkjent kjøring.
create function faktura.lonn_utdatert(_kjoring uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when k.status = 'utkast' then
           b.kjoring_id is null
           or exists (select 1 from faktura.lonn_endringer e
                       where e.org_id = k.org_id and e.xid >= pg_snapshot_xmin(b.snapshot) and not pg_visible_in_snapshot(e.xid, b.snapshot))
         end
    from faktura.lonnskjoringer k
    left join faktura.lonnskjoring_beregning b on b.kjoring_id = k.id
   where k.id = _kjoring and faktura.kan(k.org_id, 'personal_les')
$$;

-- Workeren rydder hver morgen: endringene alle utkastene har sett (eller som ingen utkast venter på).
create function faktura.rydd_lonn_endringer() returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  if not faktura.er_system() then raise exception 'Bare workeren rydder endringene' using errcode = 'FA403'; end if;
  delete from faktura.lonn_endringer e
   where not exists (select 1 from faktura.lonnskjoring_beregning b join faktura.lonnskjoringer k on k.id = b.kjoring_id
                      where b.org_id = e.org_id and k.status = 'utkast' and not pg_visible_in_snapshot(e.xid, b.snapshot));
  get diagnostics n = row_count;
  return n;
end $$;

grant execute on function faktura.lonn_beregnes(uuid), faktura.lonn_utdatert(uuid) to faktura_app, faktura_system;
revoke all on function faktura.rydd_lonn_endringer() from public;
grant execute on function faktura.rydd_lonn_endringer() to faktura_system;

-- ---------------------------------------------------------------------------
-- Kjøringen workeren lager, og valget i oppsettet
-- ---------------------------------------------------------------------------

-- automatisk: laget av workeren (den ordinære kjøringen for måneden).
alter table faktura.lonnskjoringer add column automatisk boolean not null default false;
grant insert (automatisk) on faktura.lonnskjoringer to faktura_system;

-- auto_kjoring: workeren lager den ordinære kjøringen den første i måneden (når organisasjonen har
-- kjørt lønn i HI4 de siste tre månedene), og den holdes oppdatert til den godkjennes.
alter table faktura.lonn_oppsett add column auto_kjoring boolean not null default true;
grant insert (auto_kjoring), update (auto_kjoring) on faktura.lonn_oppsett to faktura_app;
