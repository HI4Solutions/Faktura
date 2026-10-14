-- 0109_plattformoversikt.sql
-- Plattformadministratorens egen oversikt (Plattform → Plattformoversikt, og første side når
-- plattformadministratoren ikke er med i noen organisasjon): i tillegg til organisasjonene,
-- brukerne, fakturaene, integrasjonene og driftsproblemene (0046), hvor mange organisasjoner som
-- bruker hver funksjon, og antall ansatte og lønnskjøringer. Bare antall, ingen navn eller beløp.
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
        'banker', (select count(*) from faktura.bankkoblinger k where k.status = 'feil' or k.siste_feil is not null)),
    -- Funksjonene i bruk: hvor mange organisasjoner som har hver, modul for modul.
    'moduler', (select coalesce(jsonb_agg(jsonb_build_object(
                    'kode', m.kode, 'navn', m.navn,
                    'funksjoner', (select coalesce(jsonb_agg(jsonb_build_object(
                                       'kode', f.kode, 'navn', f.navn,
                                       'antall', (select count(*) from faktura.organisasjoner o
                                                   where o.slettet_at is null and faktura.har_funksjon(o.id, f.kode)))
                                     order by f.rekkefolge), '[]'::jsonb)
                                     from faktura.funksjoner f where f.modul = m.kode))
                  order by m.rekkefolge), '[]'::jsonb)
                  from faktura.moduler m),
    -- Personalet: organisasjonene med ansatte og timer på, de aktive ansatte (og hvor mange av dem
    -- som logger inn) og lønnskjøringene som er godkjent siste 30 dager. Ingen navn eller beløp.
    'personal', jsonb_build_object(
        'organisasjoner', (select count(*) from faktura.lonn_oppsett l join faktura.organisasjoner o on o.id = l.org_id
                            where l.aktiv and o.slettet_at is null),
        'ansatte', (select count(*) from faktura.ansatte a join faktura.organisasjoner o on o.id = a.org_id
                     where o.slettet_at is null and a.aktiv and (a.ansatt_til is null or a.ansatt_til >= faktura.i_dag())),
        'med_innlogging', (select count(*) from faktura.ansatte a join faktura.organisasjoner o on o.id = a.org_id
                            where o.slettet_at is null and a.aktiv and a.bruker_id is not null
                              and (a.ansatt_til is null or a.ansatt_til >= faktura.i_dag())),
        'lonnskjoringer_30', (select count(*) from faktura.lonnskjoringer k
                               where k.status = 'godkjent' and k.godkjent_at >= now() - interval '30 days'))
  );
end $$;
