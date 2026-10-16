-- Nullstilling av a-meldinger (0-melding), og meldingene som gjelder for måneden
-- (ameldingInnsending.ts, ameldingRuter.ts, avstemming.ts). A-meldinger for samme måned legges
-- sammen i a-ordningen, med mindre en melding erstatter en annen (erstatter: meldingsId-en den
-- erstatter; en melding kan bare erstattes én gang). En melding gjelder når den er levert (fila er
-- lastet opp), sendt eller mottatt, og ikke er erstattet av en annen melding som er det. Gjelder to
-- meldinger med innhold samtidig, er måneden rapportert dobbelt. Da nullstilles den som ikke skal
-- gjelde: en 0-melding (uten inntektsmottakere) som erstatter den og alt den inneholder.

alter table faktura.ameldinger add column nullstilling boolean not null default false;

-- Meldingen som erstatter en melding: den siste for måneden som oppgir den, og som er levert, sendt
-- eller mottatt (en avvist erstatning er ikke mottatt, så meldingen gjelder fortsatt). Null: den er
-- ikke erstattet.
create function faktura.amelding_erstattet_av(_org uuid, _maaned date, _meldings_id text)
returns uuid
language sql stable set search_path = '' as $$
  select b.id from faktura.ameldinger b
   where b.org_id = _org and b.maaned = _maaned and b.erstatter = _meldings_id
     and b.status in ('levert', 'sendt', 'mottatt')
   order by b.opprettet desc
   limit 1
$$;
revoke execute on function faktura.amelding_erstattet_av(uuid, date, text) from public;
grant execute on function faktura.amelding_erstattet_av(uuid, date, text) to faktura_app, faktura_system;

-- En melding for måneden lages (en time) eller venter på tilbakemelding (to dager): måneden får ikke
-- en ny melding eller en nullstilling før den er ferdig.
create function faktura.amelding_pagar(_org uuid, _maaned date)
returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from faktura.ameldinger
                  where org_id = _org and maaned = _maaned
                    and ((status = 'lages' and opprettet > now() - interval '1 hour')
                         or (status = 'sendt' and innsending = 'api' and sendt_at > now() - interval '2 days')))
$$;
revoke execute on function faktura.amelding_pagar(uuid, date) from public;

-- Bestillingen (0077). En ny melding erstatter den siste meldingen med innhold som gjelder for
-- måneden: ikke en nullstilling (da ville en annen melding som gjelder, bli stående ved siden av den
-- nye), og ikke en som alt er erstattet (en melding kan bare erstattes én gang).
create or replace function faktura.bestill_amelding(_org uuid, _maaned date, _innsending text, _erstatt boolean default true)
returns faktura.ameldinger
language plpgsql security definer set search_path = '' as $$
declare
  m faktura.ameldinger;
  forrige text;
begin
  perform faktura.krev(_org, 'personal');
  if _maaned is null or _maaned <> date_trunc('month', _maaned)::date then
    raise exception 'Velg en måned' using errcode = 'FA400';
  end if;
  if _innsending not in ('fil', 'api') then
    raise exception 'Ukjent innsending' using errcode = 'FA400';
  end if;
  if not exists (select 1 from faktura.organisasjoner where id = _org and orgnr is not null) then
    raise exception 'Organisasjonen mangler organisasjonsnummer' using errcode = 'FA400';
  end if;
  if faktura.amelding_pagar(_org, _maaned) then
    raise exception 'A-meldingen for måneden lages eller venter på tilbakemelding fra Skatteetaten. Vent til den er ferdig.' using errcode = 'FA409';
  end if;
  if _erstatt then
    select a.meldings_id into forrige from faktura.ameldinger a
     where a.org_id = _org and a.maaned = _maaned and a.status in ('levert', 'sendt', 'mottatt') and not a.nullstilling
       and faktura.amelding_erstattet_av(_org, _maaned, a.meldings_id) is null
     order by a.opprettet desc limit 1;
  end if;
  insert into faktura.ameldinger (org_id, maaned, innsending, erstatter)
  values (_org, _maaned, _innsending, forrige)
  returning * into m;
  return m;
end $$;

-- Eier eller administrator nullstiller en melding som gjelder for måneden: raden for 0-meldingen
-- lages med meldingen den erstatter, og workeren lager fila eller sender den. En nullstilling
-- nullstilles ikke (den har ikke noe innhold).
create function faktura.nullstill_amelding(_org uuid, _id uuid, _innsending text)
returns faktura.ameldinger
language plpgsql security definer set search_path = '' as $$
declare
  x faktura.ameldinger;
  m faktura.ameldinger;
begin
  perform faktura.krev(_org, 'personal');
  if _innsending not in ('fil', 'api') then
    raise exception 'Ukjent innsending' using errcode = 'FA400';
  end if;
  select * into x from faktura.ameldinger where org_id = _org and id = _id;
  if not found then
    raise exception 'Fant ikke a-meldingen' using errcode = 'FA404';
  end if;
  if x.nullstilling or x.status not in ('levert', 'sendt', 'mottatt')
     or faktura.amelding_erstattet_av(_org, x.maaned, x.meldings_id) is not null then
    raise exception 'Bare en melding som gjelder for måneden (lastet opp, sendt eller mottatt, og ikke erstattet), kan nullstilles.' using errcode = 'FA409';
  end if;
  if faktura.amelding_pagar(_org, x.maaned) then
    raise exception 'A-meldingen for måneden lages eller venter på tilbakemelding fra Skatteetaten. Vent til den er ferdig.' using errcode = 'FA409';
  end if;
  insert into faktura.ameldinger (org_id, maaned, innsending, erstatter, nullstilling)
  values (_org, x.maaned, _innsending, x.meldings_id, true)
  returning * into m;
  return m;
end $$;
revoke execute on function faktura.nullstill_amelding(uuid, uuid, text) from public;
grant execute on function faktura.nullstill_amelding(uuid, uuid, text) to faktura_app;
