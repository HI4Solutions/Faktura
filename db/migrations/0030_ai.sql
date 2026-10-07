-- 0030_ai.sql
-- AI med Gemini på Vertex AI (Google Cloud, i EU): fakturautkast fra tekst eller tale, og
-- forslag om hvilken faktura en innbetaling gjelder. AI-en lager bare utkast og forslag som
-- en person ser over. En administrator kan slå det av for organisasjonen. Bruken telles per
-- måned, og hver organisasjon har et tak (AI_GRENSE i API-et og workeren).

alter table faktura.organisasjoner add column ai_aktiv boolean not null default true;
grant update (ai_aktiv) on faktura.organisasjoner to faktura_app;

create table faktura.ai_bruk (
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  maaned date not null,                    -- første dag i måneden
  funksjon text not null check (funksjon in ('faktura', 'innbetaling')),
  antall int not null default 0,           -- forespørsler
  tokens_inn bigint not null default 0,
  tokens_ut bigint not null default 0,
  primary key (org_id, maaned, funksjon)
);
alter table faktura.ai_bruk enable row level security;
create policy ai_bruk_les on faktura.ai_bruk for select using (faktura.kan(org_id, 'les'));
grant select on faktura.ai_bruk to faktura_app;

-- Hvem som kan bruke funksjonen: fakturautkast krever skriv, innbetalinger bokfør (workeren
-- kan begge).
create function faktura.ai_krev(_org uuid, _funksjon text) returns void
language plpgsql stable set search_path = '' as $$
begin
  perform faktura.krev(_org, case _funksjon when 'faktura' then 'skriv' else 'bokfor' end);
end $$;

-- Reserverer én forespørsel for organisasjonen denne måneden. false: taket er nådd.
create function faktura.ai_reserver(_org uuid, _funksjon text, _grense int) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  m date := date_trunc('month', faktura.i_dag())::date;
  n bigint;
begin
  perform faktura.ai_krev(_org, _funksjon);
  if not coalesce((select o.ai_aktiv from faktura.organisasjoner o where o.id = _org), false) then
    raise exception 'AI er slått av for organisasjonen' using errcode = 'FA409';
  end if;
  -- Én om gangen per organisasjon, så taket holder når flere spør samtidig.
  perform pg_advisory_xact_lock(hashtext('ai_bruk:' || _org::text));
  select coalesce(sum(b.antall), 0) into n from faktura.ai_bruk b where b.org_id = _org and b.maaned = m;
  if n >= _grense then return false; end if;
  insert into faktura.ai_bruk (org_id, maaned, funksjon, antall) values (_org, m, _funksjon, 1)
  on conflict (org_id, maaned, funksjon) do update set antall = faktura.ai_bruk.antall + 1;
  return true;
end $$;

-- Fører tokenbruken etter svaret (for kostnadsoversikten).
create function faktura.ai_tokens(_org uuid, _funksjon text, _inn int, _ut int) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform faktura.ai_krev(_org, _funksjon);
  update faktura.ai_bruk
     set tokens_inn = tokens_inn + greatest(coalesce(_inn, 0), 0), tokens_ut = tokens_ut + greatest(coalesce(_ut, 0), 0)
   where org_id = _org and maaned = date_trunc('month', faktura.i_dag())::date and funksjon = _funksjon;
end $$;

-- For plattformadministratorene: bruken denne og forrige måned, organisasjonene som bruker
-- mest først.
create function faktura.admin_ai() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  m date := date_trunc('month', faktura.i_dag())::date;
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  return jsonb_build_object(
    'maaned', m,
    'sum', (select jsonb_build_object('antall', coalesce(sum(b.antall), 0), 'tokens_inn', coalesce(sum(b.tokens_inn), 0),
                                      'tokens_ut', coalesce(sum(b.tokens_ut), 0))
              from faktura.ai_bruk b where b.maaned = m),
    'forrige', (select jsonb_build_object('antall', coalesce(sum(b.antall), 0), 'tokens_inn', coalesce(sum(b.tokens_inn), 0),
                                          'tokens_ut', coalesce(sum(b.tokens_ut), 0))
                  from faktura.ai_bruk b where b.maaned = (m - interval '1 month')::date),
    'organisasjoner', coalesce((
        select jsonb_agg(jsonb_build_object('org_id', x.org_id, 'org', o.navn, 'faktura', x.faktura, 'innbetaling', x.innbetaling,
                                            'tokens_inn', x.tokens_inn, 'tokens_ut', x.tokens_ut)
                         order by x.faktura + x.innbetaling desc, o.navn)
          from (select b.org_id,
                       coalesce(sum(b.antall) filter (where b.funksjon = 'faktura'), 0) as faktura,
                       coalesce(sum(b.antall) filter (where b.funksjon = 'innbetaling'), 0) as innbetaling,
                       sum(b.tokens_inn) as tokens_inn, sum(b.tokens_ut) as tokens_ut
                  from faktura.ai_bruk b where b.maaned = m
                 group by b.org_id
                 order by sum(b.antall) desc
                 limit 50) x
          join faktura.organisasjoner o on o.id = x.org_id), '[]'::jsonb)
  );
end $$;

-- Forslag (fra AI-en) om hvilken faktura en uavklart innbetaling gjelder. Det registreres
-- ikke: en person bekrefter det med koble_banktransaksjon eller avviser det med angre.
create function faktura.foresla_banktransaksjon(_id uuid, _faktura uuid, _grunn text)
returns faktura.banktransaksjoner
language plpgsql security definer set search_path = '' as $$
declare
  t faktura.banktransaksjoner;
begin
  select * into t from faktura.banktransaksjoner where id = _id for update;
  if not found then raise exception 'Fant ikke innbetalingen' using errcode = 'FA404'; end if;
  perform faktura.krev(t.org_id, 'bokfor');
  if t.status <> 'uavklart' then
    raise exception 'Innbetalingen er allerede behandlet' using errcode = 'FA409';
  end if;
  if not exists (select 1 from faktura.fakturaer f where f.id = _faktura and f.org_id = t.org_id and f.type = 'faktura' and f.status = 'utstedt') then
    raise exception 'Fant ikke fakturaen' using errcode = 'FA404';
  end if;
  update faktura.banktransaksjoner set status = 'forslag', faktura_id = _faktura, grunn = left(_grunn, 500)
   where id = _id
  returning * into t;
  return t;
end $$;

revoke all on function faktura.ai_krev(uuid, text), faktura.ai_reserver(uuid, text, int), faktura.ai_tokens(uuid, text, int, int),
  faktura.admin_ai(), faktura.foresla_banktransaksjon(uuid, uuid, text) from public;
grant execute on function faktura.ai_reserver(uuid, text, int), faktura.ai_tokens(uuid, text, int, int), faktura.admin_ai(),
  faktura.foresla_banktransaksjon(uuid, uuid, text) to faktura_app;
