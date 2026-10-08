-- 0053_ai_lonnsslipp.sql
-- Lønnsslipper leses med AI (server/src/aiLonnsslipp.ts): navn, adresse, fødselsnummer,
-- kontonummer, stilling, lønn, faste tillegg og andre opplysninger om de ansatte, til importen
-- av ansatte eller skjemaet for én ansatt. Ingenting lagres før brukeren har sett over det.
-- Det telles i samme tak som de andre AI-funksjonene, og bare eier og administrator (de som
-- legger inn ansatte) kan bruke det.

alter table faktura.ai_bruk drop constraint ai_bruk_funksjon_check;
alter table faktura.ai_bruk add constraint ai_bruk_funksjon_check check (funksjon in ('faktura', 'innbetaling', 'assistent', 'lonnsslipp'));

create or replace function faktura.ai_krev(_org uuid, _funksjon text) returns void
language plpgsql stable set search_path = '' as $$
begin
  perform faktura.krev(_org, case _funksjon when 'faktura' then 'skriv' when 'assistent' then 'les' when 'lonnsslipp' then 'personal' else 'bokfor' end);
end $$;

-- Bruken per organisasjon med lønnsslippene som egen kolonne.
create or replace function faktura.admin_ai() returns jsonb
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
                                            'assistent', x.assistent, 'lonnsslipp', x.lonnsslipp, 'tokens_inn', x.tokens_inn, 'tokens_ut', x.tokens_ut)
                         order by x.faktura + x.innbetaling + x.assistent + x.lonnsslipp desc, o.navn)
          from (select b.org_id,
                       coalesce(sum(b.antall) filter (where b.funksjon = 'faktura'), 0) as faktura,
                       coalesce(sum(b.antall) filter (where b.funksjon = 'innbetaling'), 0) as innbetaling,
                       coalesce(sum(b.antall) filter (where b.funksjon = 'assistent'), 0) as assistent,
                       coalesce(sum(b.antall) filter (where b.funksjon = 'lonnsslipp'), 0) as lonnsslipp,
                       sum(b.tokens_inn) as tokens_inn, sum(b.tokens_ut) as tokens_ut
                  from faktura.ai_bruk b where b.maaned = m
                 group by b.org_id
                 order by sum(b.antall) desc
                 limit 50) x
          join faktura.organisasjoner o on o.id = x.org_id), '[]'::jsonb)
  );
end $$;
