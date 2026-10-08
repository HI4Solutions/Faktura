-- Plattformadministrasjonen viser ikke hvor mye organisasjonene fakturerer for (ingen beløp,
-- heller ikke utestående), bare hvor mange fakturaer de har sendt, og av dem hvor mange som gikk
-- på e-post og hvor mange som EHF. En faktura teller som EHF når EHF-sendingen ikke feilet, og
-- som e-post når den ble sendt på e-post og ikke som EHF.

create function faktura.sendt_som_ehf(_faktura uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from faktura.ehf_sendinger s where s.faktura_id = _faktura and s.status <> 'feilet')
$$;
create function faktura.sendt_som_epost(_faktura uuid) returns boolean
language sql stable set search_path = '' as $$
  select not faktura.sendt_som_ehf(_faktura)
         and exists (select 1 from faktura.eposter e where e.faktura_id = _faktura and e.purring_id is null)
$$;
revoke all on function faktura.sendt_som_ehf(uuid), faktura.sendt_som_epost(uuid) from public;

drop function faktura.admin_organisasjoner();
create function faktura.admin_organisasjoner()
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
   order by 13 desc, o.opprettet desc;
end $$;

-- Tellinger for oversikten, uten beløp.
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
      from faktura.organisasjoner o),
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

-- Detaljene om én organisasjon, uten beløp (fakturert og utestående er tatt bort): antall
-- fakturaer, og hvor mange av dem som gikk på e-post og som EHF. Med funksjonene.
create or replace function faktura.admin_organisasjon(_id uuid) returns jsonb
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
        'epost', (select count(*) from faktura.fakturaer f where f.org_id = o.id and f.type = 'faktura' and f.status <> 'utkast' and faktura.sendt_som_epost(f.id)),
        'ehf', (select count(*) from faktura.fakturaer f where f.org_id = o.id and f.type = 'faktura' and f.status <> 'utkast' and faktura.sendt_som_ehf(f.id)),
        'kreditnotaer', (select count(*) from faktura.fakturaer f where f.org_id = o.id and f.type = 'kreditnota' and f.status <> 'utkast'),
        'utkast', (select count(*) from faktura.fakturaer f where f.org_id = o.id and f.status = 'utkast'),
        'gjentakelser', (select count(*) from faktura.gjentakelser g where g.org_id = o.id and g.aktiv)),
    'siste_faktura', (select max(f.utstedt_at) from faktura.fakturaer f where f.org_id = o.id and f.status <> 'utkast'),
    -- Funksjonene organisasjonen har tilgang til (0041_funksjoner.sql).
    'funksjoner', coalesce((
        select jsonb_agg(jsonb_build_object('kode', f.kode, 'navn', f.navn, 'beskrivelse', f.beskrivelse, 'krever', f.krever,
                                            'aktiv', coalesce(x.aktiv, false)) order by f.rekkefolge)
          from faktura.funksjoner f
          left join faktura.org_funksjoner x on x.org_id = o.id and x.kode = f.kode), '[]'::jsonb),
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

revoke all on function faktura.admin_organisasjoner() from public;
grant execute on function faktura.admin_organisasjoner() to faktura_app;
