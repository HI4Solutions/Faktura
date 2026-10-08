-- Sletting av organisasjoner: eieren (Innstillinger → Organisasjon) eller plattformadministratoren
-- (Administrasjon) sletter en organisasjon, alltid med en grunn. Uten utstedte fakturaer eller
-- kreditnotaer slettes alt med en gang. Utstedte fakturaer er regnskapsmateriale som skal
-- oppbevares i fem år etter regnskapsårets slutt (bokføringsloven § 13), og er låst; da stenges
-- organisasjonen i stedet: ingen har tilgang lenger (medlemmer, regnskapsførertilgang og
-- invitasjoner fjernes), utkast slettes, gjentakelser, påminnelser og automatisk purring
-- stoppes, og funksjonene er av, så bakgrunnsjobbene hopper over den. Fakturaene, kundene og
-- betalingene blir liggende til oppbevaringstiden er ute. Hver sletting logges med grunnen
-- (slettede_organisasjoner), også når alt er borte.

alter table faktura.organisasjoner
  add column slettet_at timestamptz,
  add column slettet_av uuid references faktura.brukere(id) on delete set null,
  add column slettet_grunn text,
  add column oppbevares_til date;  -- regnskapsmaterialet kan slettes etter denne datoen

create table faktura.slettede_organisasjoner (
  id uuid primary key,                -- organisasjonens id (raden kan være borte)
  navn text not null,
  orgnr text,
  type text not null,
  slettet_at timestamptz not null default now(),
  slettet_av uuid references faktura.brukere(id) on delete set null,
  slettet_av_navn text,
  slettet_av_epost text,
  av_plattformen boolean not null,    -- plattformadministratoren; ellers eieren
  grunn text not null check (length(btrim(grunn)) >= 3),
  antall_fakturaer int not null,      -- utstedte fakturaer og kreditnotaer
  oppbevares_til date                 -- null: alt er slettet
);
alter table faktura.slettede_organisasjoner enable row level security;
create policy slettede_organisasjoner_les on faktura.slettede_organisasjoner for select using (faktura.er_betrodd());
grant select on faktura.slettede_organisasjoner to faktura_app;

-- Slett en organisasjon (eieren, eller betrodd: plattformadministratoren), med grunn.
create function faktura.slett_organisasjon(_org uuid, _grunn text)
returns faktura.slettede_organisasjoner
language plpgsql security definer set search_path = '' as $$
declare
  o faktura.organisasjoner;
  logg faktura.slettede_organisasjoner;
  _antall int;
  _siste date;
  _plattform boolean := faktura.er_betrodd();
  _meg faktura.brukere;
begin
  select * into o from faktura.organisasjoner where id = _org for update;
  if not found or o.slettet_at is not null then raise exception 'Fant ikke organisasjonen' using errcode = 'FA404'; end if;
  if not _plattform and faktura.rolle(_org) is distinct from 'eier' then
    raise exception 'Bare eieren kan slette organisasjonen' using errcode = 'FA403';
  end if;
  if length(btrim(coalesce(_grunn, ''))) < 3 then raise exception 'Skriv hvorfor organisasjonen slettes' using errcode = 'FA400'; end if;
  select * into _meg from faktura.brukere where id = faktura.bruker_id();

  select count(*), max(fakturadato) into _antall, _siste from faktura.fakturaer where org_id = _org and fakturanummer is not null;
  insert into faktura.slettede_organisasjoner (id, navn, orgnr, type, slettet_av, slettet_av_navn, slettet_av_epost, av_plattformen, grunn,
                                               antall_fakturaer, oppbevares_til)
  values (o.id, o.navn, o.orgnr, o.type, _meg.id, _meg.navn, _meg.epost, _plattform, btrim(_grunn), _antall,
          case when _antall > 0 then make_date(extract(year from _siste)::int + 5, 12, 31) end)
  returning * into logg;

  if _antall = 0 then
    -- Uten regnskapsmateriale slettes alt. Filene (vedlegg og logo) ryddes av workeren.
    if o.logo_sti is not null then insert into faktura.slettede_filer (sti) values (o.logo_sti) on conflict do nothing; end if;
    delete from faktura.vedlegg where org_id = _org;
    delete from faktura.fakturaer where org_id = _org;  -- bare utkast
    delete from faktura.gjentakelser where org_id = _org;
    delete from faktura.kunder where org_id = _org;
    delete from faktura.produkter where org_id = _org;
    delete from faktura.organisasjoner where id = _org;
    delete from faktura.revisjonslogg where org_id = _org;
  else
    -- Stenges: ingen tilgang og ingenting sendes; regnskapsmaterialet oppbevares.
    update faktura.organisasjoner
       set slettet_at = now(), slettet_av = _meg.id, slettet_grunn = btrim(_grunn), oppbevares_til = logg.oppbevares_til, purring_auto = false
     where id = _org;
    delete from faktura.fakturaer where org_id = _org and status = 'utkast';
    delete from faktura.vedlegg where org_id = _org and faktura_id is null;
    update faktura.gjentakelser set aktiv = false where org_id = _org and aktiv;
    update faktura.paaminnelser set aktiv = false where org_id = _org and aktiv;
    delete from faktura.invitasjoner where org_id = _org;
    delete from faktura.org_tilgang where klient_org_id = _org or byraa_org_id = _org;
    delete from faktura.medlemmer where org_id = _org;
  end if;
  return logg;
end $$;
revoke all on function faktura.slett_organisasjon(uuid, text) from public;
grant execute on function faktura.slett_organisasjon(uuid, text) to faktura_app;

-- En stengt organisasjon har ingen funksjoner (bakgrunnsjobbene hopper over den). Ellers som i 0041.
create or replace function faktura.har_funksjon(_org uuid, _kode text) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from faktura.organisasjoner x where x.id = _org and x.slettet_at is not null)
     and coalesce((select o.aktiv
                          and (f.krever is null
                               or coalesce((select k.aktiv from faktura.org_funksjoner k where k.org_id = _org and k.kode = f.krever), false))
                     from faktura.org_funksjoner o join faktura.funksjoner f on f.kode = o.kode
                    where o.org_id = _org and o.kode = _kode), false)
$$;

-- Administrasjonen viser ikke de stengte organisasjonene (de står under Slettede).
create or replace function faktura.admin_organisasjoner()
returns table (
  id uuid, navn text, orgnr text, type text, verifisering text, verifisert_metode text, sperret_grunn text,
  opprettet timestamptz, eier_epost text, antall_fakturaer bigint, antall_epost bigint, antall_ehf bigint,
  venter_manuell boolean, notat text, antall_medlemmer bigint, sist_aktiv timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  return query
  select o.id, o.navn, o.orgnr, o.type, o.verifisering, o.verifisert_metode, o.sperret_grunn, o.opprettet,
         (select string_agg(b.epost, ', ') from faktura.medlemmer m join faktura.brukere b on b.id = m.bruker_id
           where m.org_id = o.id and m.rolle = 'eier'),
         f.antall, f.epost, f.ehf,
         exists (select 1 from faktura.verifiseringer v where v.org_id = o.id and v.metode = 'manuell' and v.status = 'venter'),
         (select v.notat from faktura.verifiseringer v where v.org_id = o.id and v.metode = 'manuell' and v.status = 'venter' limit 1),
         (select count(*) from faktura.medlemmer m where m.org_id = o.id),
         (select max(r.tid) from faktura.revisjonslogg r where r.org_id = o.id)
    from faktura.organisasjoner o
    cross join lateral (
      select count(*) as antall,
             count(*) filter (where faktura.sendt_som_epost(x.id)) as epost,
             count(*) filter (where faktura.sendt_som_ehf(x.id)) as ehf
        from faktura.fakturaer x
       where x.org_id = o.id and x.type = 'faktura' and x.status <> 'utkast') f
   where o.slettet_at is null
   order by 13 desc, o.opprettet desc;
end $$;

create or replace function faktura.admin_oversikt() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  return jsonb_build_object(
    'organisasjoner', (select jsonb_build_object(
        'totalt', count(*),
        'verifisert', count(*) filter (where o.verifisering = 'verifisert'),
        'ny', count(*) filter (where o.verifisering = 'ny'),
        'sperret', count(*) filter (where o.verifisering = 'sperret'),
        'nye_30', count(*) filter (where o.opprettet >= now() - interval '30 days'))
      from faktura.organisasjoner o where o.slettet_at is null),
    'venter', (select count(distinct v.org_id) from faktura.verifiseringer v where v.metode = 'manuell' and v.status = 'venter'),
    'brukere', (select jsonb_build_object(
        'totalt', count(*),
        'nye_30', count(*) filter (where b.opprettet >= now() - interval '30 days'),
        'aktive_30', count(*) filter (where exists (select 1 from faktura.revisjonslogg r where r.bruker_id = b.id and r.tid >= now() - interval '30 days')))
      from faktura.brukere b),
    'fakturaer', (select jsonb_build_object(
        'totalt', count(*),
        'epost', count(*) filter (where faktura.sendt_som_epost(f.id)),
        'ehf', count(*) filter (where faktura.sendt_som_ehf(f.id)),
        'antall_30', count(*) filter (where f.utstedt_at >= now() - interval '30 days'),
        'epost_30', count(*) filter (where f.utstedt_at >= now() - interval '30 days' and faktura.sendt_som_epost(f.id)),
        'ehf_30', count(*) filter (where f.utstedt_at >= now() - interval '30 days' and faktura.sendt_som_ehf(f.id)))
      from faktura.fakturaer f where f.type = 'faktura' and f.status <> 'utkast'),
    'integrasjoner', jsonb_build_object(
        'ehf', (select count(*) from faktura.integrasjoner i where i.type = 'peppol' and i.status <> 'frakoblet'),
        'bank', (select count(distinct k.org_id) from faktura.bankkoblinger k where k.status = 'aktiv')),
    'problemer', jsonb_build_object(
        'utboks', (select count(*) from faktura.utboks u where u.publisert_at is null and u.opprettet < now() - interval '15 minutes'),
        'epost', (select count(*) from faktura.eposter e where e.status in ('sprett', 'klage') and e.opprettet >= now() - interval '7 days'),
        'ehf', (select count(*) from faktura.ehf_sendinger s
                 where (s.status = 'feilet' or (s.status = 'sender' and s.opprettet < now() - interval '1 hour')) and s.opprettet >= now() - interval '7 days'),
        'integrasjoner', (select count(*) from faktura.integrasjoner i where i.status = 'feil' or (i.status <> 'frakoblet' and i.siste_feil is not null)),
        'banker', (select count(*) from faktura.bankkoblinger k where k.status = 'feil' or k.siste_feil is not null))
  );
end $$;

create or replace function faktura.admin_funksjoner() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  return jsonb_build_object(
    'moduler', (select coalesce(jsonb_agg(jsonb_build_object('kode', m.kode, 'navn', m.navn, 'beskrivelse', m.beskrivelse) order by m.rekkefolge), '[]'::jsonb)
                  from faktura.moduler m),
    'funksjoner', (select coalesce(jsonb_agg(jsonb_build_object('kode', f.kode, 'navn', f.navn, 'beskrivelse', f.beskrivelse, 'krever', f.krever,
                                                                 'standard', f.standard, 'modul', f.modul) order by m.rekkefolge, f.rekkefolge), '[]'::jsonb)
                     from faktura.funksjoner f join faktura.moduler m on m.kode = f.modul),
    'organisasjoner', (select coalesce(jsonb_agg(jsonb_build_object(
                                 'id', o.id, 'navn', o.navn, 'orgnr', o.orgnr, 'type', o.type, 'verifisering', o.verifisering,
                                 'aktive', (select coalesce(jsonb_agg(x.kode order by f.rekkefolge), '[]'::jsonb)
                                              from faktura.org_funksjoner x join faktura.funksjoner f on f.kode = x.kode
                                             where x.org_id = o.id and x.aktiv),
                                 'endret', (select max(x.endret) from faktura.org_funksjoner x where x.org_id = o.id and x.endret_av is not null))
                               order by o.navn), '[]'::jsonb)
                         from faktura.organisasjoner o where o.slettet_at is null)
  );
end $$;
