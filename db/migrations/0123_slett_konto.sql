-- 0123_slett_konto.sql
-- Brukeren sletter sin egen konto (Innstillinger → Min konto → Slett kontoen, DELETE /api/meg).
--
-- Kontoen anonymiseres i stedet for at raden slettes: utstedte fakturaer, bilag, lønn og
-- revisjonsloggen viser til den («opprettet av», «godkjent av»), og de skal stå urørt så lenge
-- bokføringsloven krever. E-postadressen, navnet og koblingen til innloggingen (Identity Platform)
-- fjernes, og det som bare hørte til kontoen slettes: medlemskapene, passkeys, push-abonnementene
-- og varselvalgene, Google Disk-koblingen, modulene, de leste beskjedene, e-postbekreftelsene og
-- invitasjonene til adressen som ikke er tatt imot. Ansattkortet organisasjonen har om personen,
-- blir stående, men uten innloggingen. Serveren sletter brukeren i Identity Platform i samme
-- transaksjon (auth.ts), så den ikke kan logge inn igjen; en ny konto med samme adresse blir en ny
-- bruker.
--
-- Den som er eneste eier av en organisasjon, må gi eierrollen til en annen eller slette
-- organisasjonen først.

alter table faktura.brukere drop constraint brukere_status_check;
alter table faktura.brukere
  add constraint brukere_status_check check (status in ('venter', 'godkjent', 'avvist', 'slettet')),
  add column slettet_at timestamptz;

create function faktura.slett_min_konto() returns void
language plpgsql security definer set search_path = '' as $$
declare
  _meg faktura.brukere;
  _eneste text;
begin
  select * into _meg from faktura.brukere where id = faktura.bruker_id() and status <> 'slettet';
  if not found then raise exception 'Ikke innlogget' using errcode = 'FA403'; end if;

  select string_agg(o.navn, ', ' order by o.navn) into _eneste
    from faktura.medlemmer m join faktura.organisasjoner o on o.id = m.org_id
   where m.bruker_id = _meg.id and m.rolle = 'eier' and o.slettet_at is null
     and not exists (select 1 from faktura.medlemmer a
                      where a.org_id = m.org_id and a.rolle = 'eier' and a.bruker_id <> _meg.id);
  if _eneste is not null then
    raise exception 'Du er eneste eier av %. Gi eierrollen til en annen, eller slett organisasjonen først.', _eneste
      using errcode = 'FA409';
  end if;

  delete from faktura.medlemmer where bruker_id = _meg.id;
  update faktura.ansatte set bruker_id = null where bruker_id = _meg.id;
  delete from faktura.invitasjoner where akseptert_at is null and lower(epost) = lower(_meg.epost);
  delete from faktura.passkey_utfordringer where bruker_id = _meg.id;
  delete from faktura.passkeys where bruker_id = _meg.id;
  delete from faktura.push_abonnementer where bruker_id = _meg.id;
  delete from faktura.push_valg where bruker_id = _meg.id;
  delete from faktura.disk_koblinger where bruker_id = _meg.id;
  delete from faktura.bruker_moduler where bruker_id = _meg.id;
  delete from faktura.beskjed_lest where bruker_id = _meg.id;
  delete from faktura.epostbekreftelser where bruker_id = _meg.id;

  -- «Slettet bruker» vises der kontoen står som den som laget eller godkjente noe.
  update faktura.brukere
     set ekstern_id = 'slettet:' || id, epost = 'slettet-' || id || '@slettet.invalid', navn = 'Slettet bruker',
         status = 'slettet', slettet_at = now(), epost_bekreftet = false, avvist_grunn = null
   where id = _meg.id;
end $$;

revoke all on function faktura.slett_min_konto() from public;
grant execute on function faktura.slett_min_konto() to faktura_app;

-- Brukerlista i administrasjonen (som i 0105), uten de slettede kontoene.
create or replace function faktura.admin_brukere()
returns table (
  id uuid, epost text, navn text, opprettet timestamptz,
  organisasjoner jsonb, antall_passkeys bigint, sist_passkey timestamptz, sist_aktiv timestamptz,
  status text, behandlet_at timestamptz, avvist_grunn text, moduler text[], epost_bekreftet boolean
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
         (select max(r.tid) from faktura.revisjonslogg r where r.bruker_id = b.id),
         b.status, b.behandlet_at, b.avvist_grunn, faktura.bruker_modulliste(b.id), b.epost_bekreftet
    from faktura.brukere b
   where b.status <> 'slettet'
   order by b.opprettet desc;
end $$;

-- Plattformoversikten (som i 0109), uten de slettede kontoene blant brukerne.
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
      from faktura.brukere b where b.status <> 'slettet'),
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
