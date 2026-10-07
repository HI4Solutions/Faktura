-- 0029_admin.sql
-- Mer i plattformadministrasjonen: oversikt over bruken, detaljer om én organisasjon
-- (medlemmer, bruk, integrasjoner, banker, kontonummerendringer, verifiseringer og siste
-- aktivitet), driftsstatus (utboks, e-post, EHF, integrasjoner og banker), og når
-- organisasjoner og brukere sist gjorde noe. Bare betrodde kall (plattformadministratorer).

-- Når en bruker sist endret noe.
create index revisjonslogg_bruker_idx on faktura.revisjonslogg (bruker_id, tid desc) where bruker_id is not null;

drop function faktura.admin_organisasjoner();
create function faktura.admin_organisasjoner()
returns table (
  id uuid, navn text, orgnr text, type text, verifisering text, verifisert_metode text, sperret_grunn text,
  opprettet timestamptz, eier_epost text, antall_fakturaer bigint, sum_fakturert numeric,
  venter_manuell boolean, notat text, antall_medlemmer bigint, sist_aktiv timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  return query
  select o.id, o.navn, o.orgnr, o.type, o.verifisering, o.verifisert_metode, o.sperret_grunn, o.opprettet,
         (select string_agg(b.epost, ', ') from faktura.medlemmer m join faktura.brukere b on b.id = m.bruker_id
           where m.org_id = o.id and m.rolle = 'eier'),
         (select count(*) from faktura.fakturaer f where f.org_id = o.id and f.status <> 'utkast'),
         (select coalesce(sum(f.sum_inkl_mva), 0) from faktura.fakturaer f where f.org_id = o.id and f.status <> 'utkast' and f.type = 'faktura'),
         exists (select 1 from faktura.verifiseringer v where v.org_id = o.id and v.metode = 'manuell' and v.status = 'venter'),
         (select v.notat from faktura.verifiseringer v where v.org_id = o.id and v.metode = 'manuell' and v.status = 'venter' limit 1),
         (select count(*) from faktura.medlemmer m where m.org_id = o.id),
         (select max(r.tid) from faktura.revisjonslogg r where r.org_id = o.id)
    from faktura.organisasjoner o
   order by 12 desc, o.opprettet desc;
end $$;

drop function faktura.admin_brukere();
create function faktura.admin_brukere()
returns table (
  id uuid, epost text, navn text, opprettet timestamptz,
  organisasjoner jsonb, antall_passkeys bigint, sist_passkey timestamptz, sist_aktiv timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  return query
  select b.id, b.epost, b.navn, b.opprettet,
         coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'navn', o.navn, 'rolle', m.rolle, 'verifisering', o.verifisering) order by o.navn)
                     from faktura.medlemmer m join faktura.organisasjoner o on o.id = m.org_id
                    where m.bruker_id = b.id), '[]'::jsonb),
         (select count(*) from faktura.passkeys p where p.bruker_id = b.id),
         (select max(p.sist_brukt) from faktura.passkeys p where p.bruker_id = b.id),
         (select max(r.tid) from faktura.revisjonslogg r where r.bruker_id = b.id)
    from faktura.brukere b
   order by b.opprettet desc;
end $$;

-- Tellinger for oversikten. problemer: det samme som driftsfanen viser.
create function faktura.admin_oversikt() returns jsonb
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
      from faktura.organisasjoner o),
    'venter', (select count(distinct v.org_id) from faktura.verifiseringer v where v.metode = 'manuell' and v.status = 'venter'),
    'brukere', (select jsonb_build_object(
        'totalt', count(*),
        'nye_30', count(*) filter (where b.opprettet >= now() - interval '30 days'),
        'aktive_30', count(*) filter (where exists (select 1 from faktura.revisjonslogg r where r.bruker_id = b.id and r.tid >= now() - interval '30 days')))
      from faktura.brukere b),
    'fakturaer', (select jsonb_build_object(
        'totalt', count(*),
        'sum', coalesce(sum(f.sum_inkl_mva), 0),
        'antall_30', count(*) filter (where f.utstedt_at >= now() - interval '30 days'),
        'sum_30', coalesce(sum(f.sum_inkl_mva) filter (where f.utstedt_at >= now() - interval '30 days'), 0))
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

-- Alt om én organisasjon. null: finnes ikke.
create function faktura.admin_organisasjon(_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  o faktura.organisasjoner;
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  select * into o from faktura.organisasjoner where id = _id;
  if not found then return null; end if;
  return jsonb_build_object(
    'id', o.id, 'navn', o.navn, 'orgnr', o.orgnr, 'type', o.type, 'verifisering', o.verifisering,
    'verifisert_metode', o.verifisert_metode, 'verifisert_at', o.verifisert_at, 'sperret_grunn', o.sperret_grunn,
    'opprettet', o.opprettet, 'epost', o.epost, 'telefon', o.telefon, 'kontonr', o.kontonr, 'mva_registrert', o.mva_registrert,
    'adresse', nullif(concat_ws(', ', nullif(o.adresse, ''), nullif(concat_ws(' ', o.postnr, o.poststed), '')), ''),
    'medlemmer', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'navn', b.navn, 'epost', b.epost, 'rolle', m.rolle, 'siden', m.opprettet,
                 'sist_aktiv', (select max(r.tid) from faktura.revisjonslogg r where r.org_id = o.id and r.bruker_id = b.id))
               order by faktura.rolle_rang(m.rolle) desc, b.epost)
          from faktura.medlemmer m join faktura.brukere b on b.id = m.bruker_id
         where m.org_id = o.id), '[]'::jsonb),
    'antall', jsonb_build_object(
        'kunder', (select count(*) from faktura.kunder k where k.org_id = o.id),
        'produkter', (select count(*) from faktura.produkter p where p.org_id = o.id),
        'fakturaer', (select count(*) from faktura.fakturaer f where f.org_id = o.id and f.type = 'faktura' and f.status <> 'utkast'),
        'kreditnotaer', (select count(*) from faktura.fakturaer f where f.org_id = o.id and f.type = 'kreditnota' and f.status <> 'utkast'),
        'utkast', (select count(*) from faktura.fakturaer f where f.org_id = o.id and f.status = 'utkast'),
        'gjentakelser', (select count(*) from faktura.gjentakelser g where g.org_id = o.id and g.aktiv)),
    'fakturert', (select coalesce(sum(f.sum_inkl_mva), 0) from faktura.fakturaer f where f.org_id = o.id and f.type = 'faktura' and f.status <> 'utkast'),
    'utestaende', (select coalesce(sum(f.sum_inkl_mva - f.kreditert_belop - f.betalt_belop), 0)
                     from faktura.fakturaer f where f.org_id = o.id and f.type = 'faktura' and f.status = 'utstedt'),
    'siste_faktura', (select max(f.utstedt_at) from faktura.fakturaer f where f.org_id = o.id and f.status <> 'utkast'),
    'integrasjoner', coalesce((
        select jsonb_agg(jsonb_build_object('type', i.type, 'status', i.status, 'siste_feil', i.siste_feil, 'oppdatert', i.oppdatert) order by i.type)
          from faktura.integrasjoner i where i.org_id = o.id and i.status <> 'frakoblet'), '[]'::jsonb),
    'banker', coalesce((
        select jsonb_agg(jsonb_build_object('bank', k.bank, 'status', k.status, 'gyldig_til', k.gyldig_til, 'sist_hentet', k.sist_hentet, 'siste_feil', k.siste_feil)
                         order by k.opprettet)
          from faktura.bankkoblinger k where k.org_id = o.id), '[]'::jsonb),
    -- Endring av kontonummer er det mest attraktive svindelangrepet.
    'kontonr_endringer', coalesce((
        select jsonb_agg(jsonb_build_object('tid', r.tid, 'fra', r.endring -> 'kontonr' ->> 'fra', 'til', r.endring -> 'kontonr' ->> 'til', 'av', b.epost)
                         order by r.tid desc)
          from (select * from faktura.revisjonslogg r
                 where r.org_id = o.id and r.tabell = 'organisasjoner' and r.handling = 'UPDATE' and r.endring ? 'kontonr'
                 order by r.tid desc limit 5) r
          left join faktura.brukere b on b.id = r.bruker_id), '[]'::jsonb),
    'verifiseringer', coalesce((
        select jsonb_agg(jsonb_build_object('metode', v.metode, 'status', v.status, 'tid', v.opprettet, 'notat', v.notat, 'sendt_til', v.sendt_til)
                         order by v.opprettet desc)
          from (select * from faktura.verifiseringer v where v.org_id = o.id order by v.opprettet desc limit 10) v), '[]'::jsonb),
    'sist_aktiv', (select max(r.tid) from faktura.revisjonslogg r where r.org_id = o.id),
    -- Siste endringer (hvilke felt, ikke verdiene), uten fakturalinjene.
    'aktivitet', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'tid', r.tid, 'handling', r.handling, 'tabell', r.tabell, 'av', b.epost,
                 'felt', case when r.handling = 'UPDATE' and jsonb_typeof(r.endring) = 'object'
                              then (select jsonb_agg(k order by k) from jsonb_object_keys(r.endring) k) end,
                 'status', case when r.handling = 'UPDATE' then r.endring -> 'status' ->> 'til' end)
               order by r.tid desc)
          from (select * from faktura.revisjonslogg r
                 where r.org_id = o.id and r.tabell is distinct from 'faktura_linjer'
                 order by r.tid desc limit 15) r
          left join faktura.brukere b on b.id = r.bruker_id), '[]'::jsonb)
  );
end $$;

-- Driftsstatus: utboksen, e-post og EHF de siste dagene, og integrasjoner og banker med feil.
create function faktura.admin_drift() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  return jsonb_build_object(
    'utboks', (select jsonb_build_object(
        'venter', count(*),
        'eldste', min(u.opprettet),
        'med_feil', count(*) filter (where u.siste_feil is not null),
        'siste_feil', (select u2.siste_feil from faktura.utboks u2
                        where u2.publisert_at is null and u2.siste_feil is not null order by u2.id desc limit 1))
      from faktura.utboks u where u.publisert_at is null),
    'epost', coalesce((select jsonb_object_agg(e.status, e.n)
        from (select status, count(*) as n from faktura.eposter where opprettet >= now() - interval '7 days' group by status) e), '{}'::jsonb),
    'epost_problemer', coalesce((
        select jsonb_agg(jsonb_build_object('org_id', e.org_id, 'org', o.navn, 'tid', coalesce(e.siste_hendelse_at, e.opprettet), 'status', e.status,
                                            'til', e.til, 'emne', e.emne, 'detaljer', e.detaljer)
                         order by e.opprettet desc)
          from (select * from faktura.eposter
                 where status in ('sprett', 'klage', 'forsinket') and opprettet >= now() - interval '30 days'
                 order by opprettet desc limit 20) e
          join faktura.organisasjoner o on o.id = e.org_id), '[]'::jsonb),
    'ehf', coalesce((select jsonb_object_agg(s.status, s.n)
        from (select status, count(*) as n from faktura.ehf_sendinger where opprettet >= now() - interval '7 days' group by status) s), '{}'::jsonb),
    'ehf_problemer', coalesce((
        select jsonb_agg(jsonb_build_object('org_id', s.org_id, 'org', o.navn, 'tid', s.oppdatert, 'status', s.status, 'mottaker', s.mottaker,
                                            'detaljer', coalesce(s.detaljer, s.feil_kategori))
                         order by s.oppdatert desc)
          from (select * from faktura.ehf_sendinger
                 where (status = 'feilet' or (status = 'sender' and opprettet < now() - interval '1 hour'))
                   and opprettet >= now() - interval '30 days'
                 order by oppdatert desc limit 20) s
          join faktura.organisasjoner o on o.id = s.org_id), '[]'::jsonb),
    'integrasjoner', coalesce((
        select jsonb_agg(jsonb_build_object('org_id', i.org_id, 'org', o.navn, 'type', i.type, 'status', i.status, 'siste_feil', i.siste_feil, 'tid', i.oppdatert)
                         order by i.oppdatert desc)
          from faktura.integrasjoner i join faktura.organisasjoner o on o.id = i.org_id
         where i.status = 'feil' or (i.status <> 'frakoblet' and i.siste_feil is not null)), '[]'::jsonb),
    'banker', coalesce((
        select jsonb_agg(jsonb_build_object('org_id', k.org_id, 'org', o.navn, 'bank', k.bank, 'status', k.status, 'siste_feil', k.siste_feil,
                                            'gyldig_til', k.gyldig_til, 'tid', k.oppdatert)
                         order by k.oppdatert desc)
          from faktura.bankkoblinger k join faktura.organisasjoner o on o.id = k.org_id
         where k.status = 'feil' or k.siste_feil is not null), '[]'::jsonb)
  );
end $$;

revoke all on function faktura.admin_organisasjoner(), faktura.admin_brukere(), faktura.admin_oversikt(),
  faktura.admin_organisasjon(uuid), faktura.admin_drift() from public;
grant execute on function faktura.admin_organisasjoner(), faktura.admin_brukere(), faktura.admin_oversikt(),
  faktura.admin_organisasjon(uuid), faktura.admin_drift() to faktura_app;
