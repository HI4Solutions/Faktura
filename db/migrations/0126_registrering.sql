-- Person eller organisasjon ved «Opprett konto». Den nye brukeren velger om den registrerer seg
-- som person (uten organisasjonsnummer, og da bare Faktura, 0119_uten_orgnr.sql) eller som
-- organisasjon (med organisasjonsnummeret), og skriver alltid inn sitt eget navn. Valget,
-- organisasjonsnummeret og navnet i Enhetsregisteret lagres på kontoen mens den venter. De kommer
-- med i forespørselen til plattformadministratorene (0043_kontogodkjenning.sql, kontoer.ts), og
-- fyller ut den første organisasjonen etter godkjenningen (web/src/sider/NyOrganisasjon.tsx).
-- Organisasjonen lages fortsatt av brukeren, som godtar bruksvilkårene og databehandleravtalen
-- da (0122_avtaler.sql).

alter table faktura.brukere
  add column registrert_som text check (registrert_som in ('person', 'organisasjon')),
  add column oppgitt_orgnr text check (oppgitt_orgnr is null or faktura.orgnr_gyldig(oppgitt_orgnr)),
  add column oppgitt_orgnavn text,
  -- Organisasjonsnummer (og navn) bare for den som registrerte seg som organisasjon.
  add constraint brukere_registrering_check check (
    (registrert_som = 'organisasjon' and oppgitt_orgnr is not null)
    or (registrert_som is distinct from 'organisasjon' and oppgitt_orgnr is null and oppgitt_orgnavn is null)
  );
comment on column faktura.brukere.registrert_som is
  'Det brukeren registrerte seg som ved «Opprett konto»: person eller organisasjon (null: før valget kom, eller invitert)';
comment on column faktura.brukere.oppgitt_orgnr is 'Organisasjonsnummeret brukeren oppga ved registreringen (organisasjon)';
comment on column faktura.brukere.oppgitt_orgnavn is 'Navnet i Enhetsregisteret for organisasjonsnummeret (null: oppslaget ga ikke svar)';

-- Den innloggede velger mens kontoen venter (rett fra registreringen, eller på venteskjermen).
-- Navnet slår API-et opp i Enhetsregisteret. Etter godkjenningen endres ingenting her; da er det
-- organisasjonen som gjelder.
create function faktura.velg_registrering(_som text, _orgnr text default null, _orgnavn text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  _status text := (select status from faktura.brukere where id = faktura.bruker_id());
begin
  if _status is null then raise exception 'Ikke innlogget' using errcode = 'FA403'; end if;
  if _status <> 'venter' then raise exception 'Kontoen er alt behandlet' using errcode = 'FA403'; end if;
  if _som is null or _som not in ('person', 'organisasjon') then
    raise exception 'Velg om du registrerer deg som person eller organisasjon' using errcode = 'FA400';
  end if;
  if _som = 'organisasjon' and (_orgnr is null or not faktura.orgnr_gyldig(_orgnr)) then
    raise exception 'Ugyldig organisasjonsnummer' using errcode = 'FA400';
  end if;
  update faktura.brukere
     set registrert_som = _som,
         oppgitt_orgnr = case when _som = 'organisasjon' then _orgnr end,
         oppgitt_orgnavn = case when _som = 'organisasjon' then nullif(left(btrim(_orgnavn), 200), '') end
   where id = faktura.bruker_id();
end $$;

-- Kontoene som venter (som i 0105), med det de registrerte seg som.
drop function faktura.admin_kontoer_venter();
create function faktura.admin_kontoer_venter()
returns table (id uuid, epost text, navn text, opprettet timestamptz, varslet_at timestamptz, moduler text[],
               epost_bekreftet boolean, bekreftelse jsonb, registrert_som text, oppgitt_orgnr text, oppgitt_orgnavn text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  return query
  select b.id, b.epost, b.navn, b.opprettet, b.varslet_at, faktura.bruker_modulliste(b.id),
         coalesce(b.epost_bekreftet, false),
         (select jsonb_build_object('opprettet', e.opprettet, 'status', e.status, 'detaljer', e.detaljer,
                                    'av_admin', e.sendt_av is not null, 'antall', count(*) over ())
            from faktura.epostbekreftelser e
           where e.bruker_id = b.id
           order by e.opprettet desc
           limit 1),
         b.registrert_som, b.oppgitt_orgnr, b.oppgitt_orgnavn
    from faktura.brukere b
   where b.status = 'venter'
   order by b.opprettet;
end $$;

-- Som i 0123: kontoen anonymiseres, og det den registrerte seg som (organisasjonsnummeret og
-- navnet, som for et enkeltpersonforetak ofte er personens eget) fjernes også.
create or replace function faktura.slett_min_konto() returns void
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
         status = 'slettet', slettet_at = now(), epost_bekreftet = false, avvist_grunn = null,
         registrert_som = null, oppgitt_orgnr = null, oppgitt_orgnavn = null
   where id = _meg.id;
end $$;

revoke all on function faktura.velg_registrering(text, text, text), faktura.admin_kontoer_venter(), faktura.slett_min_konto() from public;
grant execute on function faktura.velg_registrering(text, text, text), faktura.admin_kontoer_venter(), faktura.slett_min_konto() to faktura_app;
