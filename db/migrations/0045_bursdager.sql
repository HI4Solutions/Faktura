-- Bursdager: eier og administrator kan slå på bursdagsvarsler for organisasjonen (Innstillinger
-- → Ansatte og timer; de ansatte har ikke tilgang dit). Når en ansatt har bursdag, får alle de
-- andre i organisasjonen push-varsel, e-post eller begge deler kl. 08 norsk tid; den som har
-- bursdag, får ikke. Bursdagen er fødselsdatoen på ansattkortet. En ansatt kan unntas (ikke
-- varsle om bursdagen), og hver bruker kan slå av push-varslene om bursdager for seg selv.

alter table faktura.lonn_oppsett
  add column bursdag_varsel text not null default 'av' check (bursdag_varsel in ('av', 'push', 'epost', 'begge'));
grant insert (bursdag_varsel), update (bursdag_varsel) on faktura.lonn_oppsett to faktura_app;

alter table faktura.ansatte add column bursdag_varsel boolean not null default true;  -- varsle de andre på bursdagen
grant select (bursdag_varsel), insert (bursdag_varsel), update (bursdag_varsel) on faktura.ansatte to faktura_app;

-- Bursdagen i et gitt år. Den som er født 29. februar, har bursdag 28. februar i år som ikke er
-- skuddår.
create function faktura.bursdag(_fodt date, _aar int) returns date
language sql immutable set search_path = '' as $$
  select case when extract(month from _fodt) = 2 and extract(day from _fodt) = 29
                   and not (_aar % 4 = 0 and (_aar % 100 <> 0 or _aar % 400 = 0))
              then make_date(_aar, 2, 28)
              else make_date(_aar, extract(month from _fodt)::int, extract(day from _fodt)::int) end
$$;

-- Hvem som har bursdag i dag (norsk tid): aktive ansatte med fødselsdato i organisasjoner med
-- ansatte og timer og bursdagsvarsler slått på. For workeren.
create function faktura.bursdager_i_dag()
returns table (org_id uuid, ansatt_id uuid, navn text, kanal text, dag date)
language sql stable security definer set search_path = '' as $$
  select a.org_id, a.id, a.fornavn || ' ' || a.etternavn, l.bursdag_varsel, faktura.i_dag()
    from faktura.ansatte a
    join faktura.lonn_oppsett l on l.org_id = a.org_id and l.aktiv and l.bursdag_varsel <> 'av'
   where a.aktiv and a.bursdag_varsel and a.fodselsdato is not null
     and a.ansatt_fra <= faktura.i_dag() and (a.ansatt_til is null or a.ansatt_til >= faktura.i_dag())
     and faktura.bursdag(a.fodselsdato, extract(year from faktura.i_dag())::int) = faktura.i_dag()
     and faktura.har_funksjon(a.org_id, 'ansatte')
   order by a.org_id, a.fornavn, a.etternavn
$$;

-- Alle andre i organisasjonen enn den som har bursdag: medlemmene (unntatt ansatte som har
-- sluttet) og de aktive ansatte, også dem uten innlogging (med e-post på ansattkortet). Én rad
-- per person: brukeren (for push) og e-postadressen.
create function faktura.bursdag_mottakere(_org uuid, _ansatt uuid)
returns table (bruker_id uuid, epost text)
language sql stable security definer set search_path = '' as $$
  with barnet as (
    select a.bruker_id, a.epost, b.epost as bruker_epost
      from faktura.ansatte a left join faktura.brukere b on b.id = a.bruker_id
     where a.org_id = _org and a.id = _ansatt
  ), alle_ as (
    select m.bruker_id, b.epost
      from faktura.medlemmer m join faktura.brukere b on b.id = m.bruker_id
     where m.org_id = _org and m.rolle <> 'ansatt'
    union
    select a.bruker_id, coalesce(b.epost, a.epost)
      from faktura.ansatte a left join faktura.brukere b on b.id = a.bruker_id
     where a.org_id = _org and a.aktiv
       and a.ansatt_fra <= faktura.i_dag() and (a.ansatt_til is null or a.ansatt_til >= faktura.i_dag())
  )
  select distinct on (coalesce(x.bruker_id::text, x.epost)) x.bruker_id, x.epost
    from alle_ x cross join barnet
   where (x.bruker_id is not null or x.epost is not null)
     and not coalesce(x.bruker_id = barnet.bruker_id, false)
     and not coalesce(x.epost = barnet.epost or x.epost = barnet.bruker_epost, false)
$$;

revoke all on function faktura.bursdager_i_dag(), faktura.bursdag_mottakere(uuid, uuid) from public;
grant execute on function faktura.bursdager_i_dag(), faktura.bursdag_mottakere(uuid, uuid) to faktura_system;
