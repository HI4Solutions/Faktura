-- 0010_admin_brukere.sql
-- Brukeroversikt for plattformadministratorer.

create function faktura.admin_brukere()
returns table (
  id uuid, epost text, navn text, opprettet timestamptz,
  organisasjoner jsonb, antall_passkeys bigint, sist_passkey timestamptz
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
         (select max(p.sist_brukt) from faktura.passkeys p where p.bruker_id = b.id)
    from faktura.brukere b
   order by b.opprettet desc;
end $$;

grant execute on function faktura.admin_brukere() to faktura_app;
