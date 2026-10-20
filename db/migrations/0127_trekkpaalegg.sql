-- 0127_trekkpaalegg.sql
-- Trekkpålegg fra Skatteetaten (server/src/trekkpaalegg.ts, Lønn → Trekkpålegg,
-- docs/trekkpaalegg.md).
--
-- Skatteetaten formidler pålegg om utleggstrekk i lønn til arbeidsgiveren (den trekkpliktige)
-- gjennom API-et for trekkpålegg. Workeren henter, med systembrukeren organisasjonen har gitt
-- systemet i Altinn (ressursen «Informasjon om trekkpålegg»), siste versjon av alle påleggene hver
-- morgen, med en gang tilgangen er gitt, og når appen ber om det («Hent nå»). Hvert pålegg lagres
-- med siste versjon (én rad per trekk-ID); endringene står i revisjonsloggen.
--
-- Skyldneren (fødselsnummeret i pålegget) kobles til den ansatte med det fødselsnummeret.
-- Fødselsnummeret lagres ikke, bare fødselsdatoen, så et pålegg for en som ikke er registrert med
-- fødselsnummer her, kan kjennes igjen.
--
-- Et pålegg for en ansatt blir et fast trekk (lonnstrekk med paalegg_id: samordnet utleggstrekk,
-- til Skatteetaten, med kontonummeret og KID-en i pålegget). Størrelsen står i pålegget (perioder
-- med et beløp eller en prosent, som kan være 0): lønnskjøringen trekker det som gjelder på
-- utbetalingsdatoen (server/src/lonn.ts). Eier og administrator kan ikke endre eller slette slike
-- trekk; de endres bare av Skatteetaten (en ny versjon av pålegget). Et trekk som er lagt inn for
-- hånd for det samme pålegget (samme KID), kobles til pålegget i stedet for at det lages et nytt.

create table faktura.trekkpaalegg (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  trekkid text not null check (length(trekkid) between 1 and 100),
  trekkversjon int not null check (trekkversjon >= 1),
  -- Skatteetatens løpenummer på tvers av alle pålegg (alltid stigende).
  sekvensnummer bigint not null check (sekvensnummer >= 0),
  saksnummer text check (saksnummer is null or length(saksnummer) between 1 and 100),
  trekkstatus text not null check (trekkstatus in ('aktiv', 'avsluttet')),
  -- Når versjonen ble formidlet («opprettet» i pålegget).
  formidlet timestamptz,
  -- Den ansatte med skyldnerens fødselsnummer (null: ingen her har det fødselsnummeret).
  ansatt_id uuid,
  fodselsdato date,
  -- Betalingen: mottakeren (organisasjonsnummeret til Skatteetaten), kontonummeret og KID-en.
  betalingsmottaker text check (betalingsmottaker is null or betalingsmottaker ~ '^[0-9]{9}$'),
  kontonr text check (kontonr is null or kontonr ~ '^[0-9]{11}$'),
  kid text check (kid is null or kid ~ '^[0-9]{2,25}$'),
  -- [{fra, til, belop, prosent}]: trekkstørrelsen i hver periode (beløp eller prosent).
  perioder jsonb not null default '[]' check (jsonb_typeof(perioder) = 'array'),
  -- Det lederen bør se på (f.eks. en skyldner som ikke er registrert som ansatt).
  merknader text[] not null default '{}',
  mottatt timestamptz not null default now(),
  endret timestamptz not null default now(),
  unique (org_id, trekkid),
  unique (org_id, id),
  foreign key (org_id, ansatt_id) references faktura.ansatte(org_id, id) on delete set null (ansatt_id)
);
create index trekkpaalegg_ansatt on faktura.trekkpaalegg (org_id, ansatt_id);
create trigger trekkpaalegg_org_id before update on faktura.trekkpaalegg
  for each row execute function faktura.org_id_uendret();
create trigger trekkpaalegg_revisjon after insert or update or delete on faktura.trekkpaalegg
  for each row execute function faktura.revider();
-- Et nytt eller endret pålegg gjør utkastene til lønnskjøring utdatert (0088_lonn_automatikk.sql).
create trigger trekkpaalegg_lonn_endret after insert or update or delete on faktura.trekkpaalegg
  for each row execute function faktura.lonn_endret();

-- De som ser lønnen, og den ansatte selv, ser påleggene; bare workeren skriver.
alter table faktura.trekkpaalegg enable row level security;
create policy trekkpaalegg_les on faktura.trekkpaalegg for select
  using (faktura.kan(org_id, 'personal_les') or faktura.er_meg(org_id, ansatt_id));
create policy trekkpaalegg_system on faktura.trekkpaalegg for all using (faktura.er_system()) with check (faktura.er_system());
grant select on faktura.trekkpaalegg to faktura_app;
grant select, insert, update, delete on faktura.trekkpaalegg to faktura_system;

-- Hentingen per organisasjon: siste forsøk (hver morgen fra kl. 06, når tilgangen er nettopp gitt,
-- og «Hent nå», høyst én gang i minuttet), når det sist ble hentet, hvor mange pålegg Skatteetaten
-- ga, og feilen fra siste forsøk (null når det gikk).
create table faktura.trekkpaalegg_henting (
  org_id uuid primary key references faktura.organisasjoner(id) on delete cascade,
  forsokt timestamptz,
  hentet timestamptz,
  antall int check (antall is null or antall >= 0),
  feil text check (feil is null or length(feil) <= 2000)
);
alter table faktura.trekkpaalegg_henting enable row level security;
create policy trekkpaalegg_henting_les on faktura.trekkpaalegg_henting for select using (faktura.kan(org_id, 'personal_les'));
create policy trekkpaalegg_henting_system on faktura.trekkpaalegg_henting for all using (faktura.er_system()) with check (faktura.er_system());
grant select on faktura.trekkpaalegg_henting to faktura_app;
grant select, insert, update on faktura.trekkpaalegg_henting to faktura_system;

-- ---------------------------------------------------------------------------
-- Trekket i lønnen
-- ---------------------------------------------------------------------------

-- Et trekk fra et pålegg har ikke beløp, prosent eller sum (de står i pålegget), og er alltid et
-- samordnet utleggstrekk; de andre har et beløp eller en prosent, som før.
alter table faktura.lonnstrekk add column paalegg_id uuid unique;
alter table faktura.lonnstrekk
  add foreign key (org_id, paalegg_id) references faktura.trekkpaalegg(org_id, id);
alter table faktura.lonnstrekk drop constraint lonnstrekk_check;
alter table faktura.lonnstrekk add constraint lonnstrekk_check check (
  case when paalegg_id is null then (belop is null) <> (prosent is null)
       else belop is null and prosent is null and totalt is null and type = 'utlegg_samordnet' end
);

-- Eier og administrator endrer og sletter bare trekkene som er lagt inn for hånd; workeren lager og
-- oppdaterer trekkene fra påleggene.
drop policy lonnstrekk_endre on faktura.lonnstrekk;
create policy lonnstrekk_endre on faktura.lonnstrekk for update
  using (faktura.kan(org_id, 'personal') and paalegg_id is null)
  with check (faktura.kan(org_id, 'personal') and paalegg_id is null);
drop policy lonnstrekk_slett on faktura.lonnstrekk;
create policy lonnstrekk_slett on faktura.lonnstrekk for delete using (faktura.kan(org_id, 'personal') and paalegg_id is null);
create policy lonnstrekk_system on faktura.lonnstrekk for all using (faktura.er_system()) with check (faktura.er_system());
grant insert (org_id, ansatt_id, type, tekst, fra, til, mottaker, kontonr, kid, paalegg_id),
      update (ansatt_id, type, tekst, belop, prosent, totalt, fra, til, mottaker, kontonr, kid, melding, paalegg_id)
  on faktura.lonnstrekk to faktura_system;

-- Det faste trekket for pålegget (lager det, kobler til et som er lagt inn for hånd med samme KID,
-- eller oppdaterer det). Gir ID-en til trekket, eller null når skyldneren ikke er koblet til en
-- ansatt, eller pålegget alt var avsluttet da det kom hit (da lages det ikke noe trekk). Datoene på
-- trekket er bare for lista: fra den første startdatoen, og til den siste sluttdatoen når pålegget
-- er avsluttet.
create function faktura.koble_trekkpaalegg(_paalegg uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  p faktura.trekkpaalegg;
  t faktura.lonnstrekk;
  _fra date;
  _til date;
  _konto text;
  _tekst text;
begin
  if not faktura.er_system() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  select * into p from faktura.trekkpaalegg where id = _paalegg for update;
  if p.id is null or p.ansatt_id is null then return null; end if;
  select min(least(x.fra, coalesce(x.til, x.fra))), max(coalesce(x.til, x.fra))
    into _fra, _til
    from jsonb_to_recordset(p.perioder) as x(fra date, til date);
  _fra := coalesce(_fra, (p.formidlet at time zone 'Europe/Oslo')::date, faktura.i_dag());
  _til := case when p.trekkstatus = 'avsluttet' then greatest(coalesce(_til, _fra), _fra) end;
  _konto := case when p.kontonr is not null and faktura.kontonr_gyldig(p.kontonr) then p.kontonr end;
  _tekst := case when p.saksnummer is not null then left('Sak ' || p.saksnummer, 100) end;

  select * into t from faktura.lonnstrekk l where l.paalegg_id = p.id for update;
  if t.id is null and p.kid is not null then
    select * into t from faktura.lonnstrekk l
     where l.org_id = p.org_id and l.ansatt_id = p.ansatt_id and l.paalegg_id is null and l.type = 'utlegg_samordnet' and l.kid = p.kid
     order by l.opprettet limit 1
     for update;
  end if;
  -- Et pålegg som alt var avsluttet da det kom hit, har ikke noe å trekke: ikke noe nytt trekk.
  if t.id is null and p.trekkstatus = 'avsluttet' then return null; end if;
  if t.id is null then
    insert into faktura.lonnstrekk (org_id, ansatt_id, type, tekst, fra, til, mottaker, kontonr, kid, paalegg_id)
    values (p.org_id, p.ansatt_id, 'utlegg_samordnet', _tekst, _fra, _til, 'Skatteetaten', _konto, p.kid, p.id)
    returning * into t;
    return t.id;
  end if;
  -- Bare når noe er endret (en oppdatering gjør utkastene til lønnskjøring utdatert).
  update faktura.lonnstrekk l
     set ansatt_id = p.ansatt_id, type = 'utlegg_samordnet', tekst = _tekst, belop = null, prosent = null, totalt = null,
         fra = _fra, til = _til, mottaker = 'Skatteetaten', kontonr = _konto, kid = p.kid, melding = null, paalegg_id = p.id
   where l.id = t.id
     and (l.ansatt_id, l.type, l.tekst, l.belop, l.prosent, l.totalt, l.fra, l.til, l.mottaker, l.kontonr, l.kid, l.melding, l.paalegg_id)
         is distinct from (p.ansatt_id, 'utlegg_samordnet'::text, _tekst, null::numeric, null::numeric, null::numeric, _fra, _til, 'Skatteetaten'::text, _konto, p.kid, null::text, p.id);
  return t.id;
end $$;
revoke execute on function faktura.koble_trekkpaalegg(uuid) from public;
grant execute on function faktura.koble_trekkpaalegg(uuid) to faktura_system;

-- Revisjonsloggen for påleggene er, som for trekkene, bare for dem som ser lønnen.
drop policy revisjonslogg_les on faktura.revisjonslogg;
create policy revisjonslogg_les on faktura.revisjonslogg for select
  using (faktura.kan(org_id, 'les')
         and (coalesce(tabell, '') not in ('ansatte', 'ansatt_tillegg', 'fravaer', 'arbeidsplaner', 'ferie_overforinger', 'vaktbytter',
                                           'lonnskjoringer', 'lonn_inngaende', 'timebank_poster', 'avspasering_soknader',
                                           'ameldinger', 'bilag', 'lonnsendringer', 'nav_inntektsmeldinger', 'lonnstrekk',
                                           'naturalytelser', 'reiseregninger', 'nav_refusjoner', 'afp_premier', 'virksomheter', 'yrkesskader',
                                           'trekkpaalegg')
              or faktura.kan(org_id, 'personal_les'))
         and (coalesce(tabell, '') not in ('anleggsmidler', 'regnskap_oppsett', 'saldo_satser', 'periodiseringer', 'utgifter', 'utgift_linjer',
                                           'bankregler', 'mva_terminer', 'aarsoppgjor', 'mva_justeringer')
              or faktura.kan(org_id, 'regnskap'))
         and (coalesce(tabell, '') not in ('fravaer', 'ferie_overforinger', 'avspasering_soknader', 'vaktbytter', 'nav_inntektsmeldinger',
                                           'nav_refusjoner', 'yrkesskader')
              or faktura.kan(org_id, 'personal')));
