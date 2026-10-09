-- Årsoversikten (sammenstillingsoppgaven) til de ansatte (server/src/lonnAarsoversikt.ts):
-- arbeidsgiveren skal innen 31. januar gi hver ansatt en oversikt over lønnen og trekket som er
-- rapportert for året. Den ansatte ser sin egen under Lønnsslipper (også som PDF), og eier og
-- administrator kan laste ned alle. De ansatte med innlogging får varsel én gang i januar (av
-- den daglige jobben, når ingen lønnskjøring for året står som utkast, og senest 25. januar),
-- eller når lederen varsler dem selv.
--
-- lonn_aarsoversikt_varslet: når de ansatte ble varslet om årsoversikten for et år, og av hvem
-- (null: den daglige jobben).

create table faktura.lonn_aarsoversikt_varslet (
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  aar int not null check (aar between 2000 and 2100),
  varslet timestamptz not null default now(),
  varslet_av uuid references faktura.brukere(id) on delete set null,
  antall int not null default 0 check (antall >= 0),
  primary key (org_id, aar)
);
alter table faktura.lonn_aarsoversikt_varslet enable row level security;
create policy lonn_aarsoversikt_varslet_les on faktura.lonn_aarsoversikt_varslet for select
  using (faktura.kan(org_id, 'personal_les') or faktura.er_system());
create policy lonn_aarsoversikt_varslet_ny on faktura.lonn_aarsoversikt_varslet for insert
  with check (faktura.kan(org_id, 'personal') or faktura.er_system());
create policy lonn_aarsoversikt_varslet_endre on faktura.lonn_aarsoversikt_varslet for update
  using (faktura.kan(org_id, 'personal') or faktura.er_system())
  with check (faktura.kan(org_id, 'personal') or faktura.er_system());
grant select, insert (org_id, aar, varslet, varslet_av, antall), update (varslet, varslet_av, antall)
  on faktura.lonn_aarsoversikt_varslet to faktura_app, faktura_system;

-- Organisasjonene der de ansatte skal varsles om årsoversikten for _aar nå (den daglige jobben i
-- januar): lønnsfunksjonen er på, det finnes godkjente lønnskjøringer med utbetaling i året, de
-- ansatte er ikke varslet, og ingen kjøring for året står som utkast (eller det er 25. januar
-- eller senere). Bare workeren.
create function faktura.aarsoversikt_klar(_aar int, _i_dag date)
returns table (org_id uuid)
language sql stable security definer set search_path = '' as $$
  select o.id
    from faktura.organisasjoner o
   where faktura.er_system()
     and faktura.har_funksjon(o.id, 'lonn')
     and exists (select 1 from faktura.lonnskjoringer k
                  where k.org_id = o.id and k.status = 'godkjent' and extract(year from k.utbetalingsdato) = _aar)
     and not exists (select 1 from faktura.lonn_aarsoversikt_varslet v where v.org_id = o.id and v.aar = _aar)
     and (_i_dag >= make_date(_aar + 1, 1, 25)
          or not exists (select 1 from faktura.lonnskjoringer k
                          where k.org_id = o.id and k.status = 'utkast' and extract(year from k.utbetalingsdato) = _aar))
$$;
revoke execute on function faktura.aarsoversikt_klar(int, date) from public;
grant execute on function faktura.aarsoversikt_klar(int, date) to faktura_system;

-- De ansatte med innlogging som har lønn i året (godkjente kjøringer), til varselet: brukeren og
-- den ansatte. Eier og administrator (personal), eller workeren.
create function faktura.aarsoversikt_mottakere(_org uuid, _aar int)
returns table (bruker_id uuid, ansatt_id uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (faktura.er_system() or faktura.kan(_org, 'personal')) then
    raise exception 'Ingen tilgang' using errcode = 'FA403';
  end if;
  return query
    select distinct a.bruker_id, a.id
      from faktura.lonnsslipper s
      join faktura.lonnskjoringer k on k.id = s.kjoring_id
      join faktura.ansatte a on a.org_id = s.org_id and a.id = s.ansatt_id
     where s.org_id = _org and k.status = 'godkjent' and extract(year from k.utbetalingsdato) = _aar
       and a.bruker_id is not null;
end $$;
revoke execute on function faktura.aarsoversikt_mottakere(uuid, int) from public;
grant execute on function faktura.aarsoversikt_mottakere(uuid, int) to faktura_app, faktura_system;

-- Trekktabellene for et år mangler, og noen trenger dem: en organisasjon med lønn har en ansatt
-- med tabelltrekk på skattekortet. Den daglige jobben minner plattformadministratorene på det
-- (server/src/trekktabeller.ts). Bare workeren.
create function faktura.trekktabeller_mangler(_aar int) returns boolean
language sql stable security definer set search_path = '' as $$
  select faktura.er_system()
     and not exists (select 1 from faktura.trekktabeller t where t.aar = _aar)
     and exists (select 1 from faktura.ansatte a
                  where a.skattekort = 'tabell' and a.arbeidstaker and faktura.har_funksjon(a.org_id, 'lonn'))
$$;
revoke execute on function faktura.trekktabeller_mangler(int) from public;
grant execute on function faktura.trekktabeller_mangler(int) to faktura_system;
