-- 0122_avtaler.sql
-- Bruksvilkårene og databehandleravtalen (landingsside/vilkar.html og databehandleravtale.html).
--
-- Organisasjonen godtar dem når den opprettes, og på nytt når en ny versjon gjelder. avtaler har
-- versjonen som gjelder nå (en ny versjon legges inn med en migrering, samtidig med at dokumentet
-- endres; servertesten avtaler sjekker at versjonen står i dokumentet). avtalegodkjenninger har hver
-- godkjenning: versjonene, hvem som godtok på vegne av organisasjonen og når. Bare eier og
-- administrator kan godta, og bare de versjonene som gjelder.

create table faktura.avtaler (
  type      text primary key check (type in ('vilkar', 'databehandleravtale')),
  navn      text not null,
  versjon   text not null check (btrim(versjon) <> ''),
  -- Adressen på nettstedet (NETTSTED_URL foran).
  sti       text not null check (sti like '/%'),
  oppdatert date not null
);

insert into faktura.avtaler (type, navn, versjon, sti, oppdatert) values
  ('vilkar', 'Bruksvilkår', '1.0', '/vilkar.html', '2026-10-16'),
  ('databehandleravtale', 'Databehandleravtale', '1.0', '/databehandleravtale.html', '2026-10-16');

alter table faktura.avtaler enable row level security;
create policy avtaler_les on faktura.avtaler for select using (true);
grant select on faktura.avtaler to faktura_app;

create table faktura.avtalegodkjenninger (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null references faktura.organisasjoner (id) on delete cascade,
  vilkar_versjon              text not null,
  databehandleravtale_versjon text not null,
  godtatt_av                  uuid references faktura.brukere (id) on delete set null,
  godtatt_at                  timestamptz not null default now()
);
create index avtalegodkjenninger_org_idx on faktura.avtalegodkjenninger (org_id, godtatt_at desc);

alter table faktura.avtalegodkjenninger enable row level security;
-- Eier og administrator ser godkjenningene; de lages bare med godta_avtaler.
create policy avtalegodkjenninger_les on faktura.avtalegodkjenninger for select
  using (faktura.kan(org_id, 'admin') or faktura.er_betrodd());
grant select on faktura.avtalegodkjenninger to faktura_app;

create trigger avtalegodkjenninger_revisjon after insert or update or delete on faktura.avtalegodkjenninger
  for each row execute function faktura.revider();

-- Om organisasjonen har godtatt versjonene som gjelder nå.
create function faktura.avtaler_godtatt(_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from faktura.avtalegodkjenninger g
     where g.org_id = _org
       and g.vilkar_versjon = (select a.versjon from faktura.avtaler a where a.type = 'vilkar')
       and g.databehandleravtale_versjon = (select a.versjon from faktura.avtaler a where a.type = 'databehandleravtale'))
$$;

-- Eier eller administrator godtar bruksvilkårene og databehandleravtalen på vegne av
-- organisasjonen. Versjonene er dem brukeren fikk se; er de endret siden, må siden lastes på nytt.
create function faktura.godta_avtaler(_org uuid, _vilkar text, _databehandleravtale text)
returns faktura.avtalegodkjenninger language plpgsql security definer set search_path = '' as $$
declare
  g faktura.avtalegodkjenninger;
begin
  perform faktura.krev(_org, 'admin');
  if _vilkar is distinct from (select a.versjon from faktura.avtaler a where a.type = 'vilkar')
     or _databehandleravtale is distinct from (select a.versjon from faktura.avtaler a where a.type = 'databehandleravtale') then
    raise exception 'Vilkårene er endret siden siden ble lastet. Last den inn på nytt og les dem.' using errcode = 'FA409';
  end if;
  insert into faktura.avtalegodkjenninger (org_id, vilkar_versjon, databehandleravtale_versjon, godtatt_av)
  values (_org, _vilkar, _databehandleravtale, faktura.bruker_id())
  returning * into g;
  return g;
end $$;

revoke all on function faktura.avtaler_godtatt(uuid) from public;
revoke all on function faktura.godta_avtaler(uuid, text, text) from public;
grant execute on function faktura.avtaler_godtatt(uuid) to faktura_app;
grant execute on function faktura.godta_avtaler(uuid, text, text) to faktura_app;

-- Som i 0111, og om organisasjonen har godtatt vilkårene og databehandleravtalen som gjelder.
create or replace view faktura.mine_organisasjoner with (security_invoker = true) as
select o.id, o.type, o.navn, o.orgnr, o.verifisering,
       faktura.rolle(o.id) as rolle,
       exists (select 1 from faktura.medlemmer m
                where m.org_id = o.id and m.bruker_id = faktura.bruker_id()) as direkte_medlem,
       coalesce((select l.aktiv from faktura.lonn_oppsett l where l.org_id = o.id), false)
         and faktura.har_funksjon(o.id, 'ansatte') as personal,
       (select a.id from faktura.ansatte a where a.org_id = o.id and a.bruker_id = faktura.bruker_id()) as ansatt_id,
       faktura.org_funksjonsliste(o.id) as funksjoner,
       faktura.kan(o.id, 'plan') as ser_planen,
       coalesce((select l.helg from faktura.lonn_oppsett l where l.org_id = o.id), true) as helg,
       faktura.timebank_paa(o.id) as timebank,
       coalesce((select l.vaktbytte from faktura.lonn_oppsett l where l.org_id = o.id), 'godkjenning') as vaktbytte,
       faktura.org_modulliste(o.id) as moduler,
       (select t.navn from faktura.medlemmer m join faktura.tilgangsroller t on t.org_id = m.org_id and t.id = m.tilgangsrolle_id
         where m.org_id = o.id and m.bruker_id = faktura.bruker_id()) as tilgangsrolle,
       (select array(select x from unnest(t.moduler) x where faktura.har_modul(o.id, x))
          from faktura.medlemmer m join faktura.tilgangsroller t on t.org_id = m.org_id and t.id = m.tilgangsrolle_id
         where m.org_id = o.id and m.bruker_id = faktura.bruker_id()) as rollemoduler,
       faktura.avtaler_godtatt(o.id) as avtaler_godtatt
  from faktura.organisasjoner o;
