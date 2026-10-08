-- Fraværstypen (syk, sykt barn, ferie, permisjon, kurs eller annet) og notatet er bare for eier og
-- administrator, som registrerer og følger opp fraværet, og for den ansatte selv. Alle andre som
-- ser vaktplanen, tavla, bemanningskalenderen og fraværslista (f.eks. regnskap), ser bare at den
-- ansatte har fravær («F»), ikke hvorfor. Det samme gjelder revisjonsloggen.

-- Om den innloggede ser typen og notatet på fraværet til en ansatt.
create function faktura.ser_fravaertype(_org uuid, _ansatt uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select faktura.er_system() or faktura.kan(_org, 'personal') or faktura.er_meg(_org, _ansatt)
$$;

-- Typen slik den innloggede får se den: «fravaer» for dem som ikke ser den.
create function faktura.fravaer_type(_org uuid, _ansatt uuid, _type text) returns text
language sql stable security definer set search_path = '' as $$
  select case when faktura.ser_fravaertype(_org, _ansatt) then _type else 'fravaer' end
$$;

revoke all on function faktura.ser_fravaertype(uuid, uuid), faktura.fravaer_type(uuid, uuid, text) from public;
grant execute on function faktura.ser_fravaertype(uuid, uuid), faktura.fravaer_type(uuid, uuid, text) to faktura_app, faktura_system;

-- Revisjonsloggen for fraværet er bare for eier og administrator (som i 0040, der ansatte,
-- fravær og arbeidsplaner er for dem som ser de ansatte).
drop policy revisjonslogg_les on faktura.revisjonslogg;
create policy revisjonslogg_les on faktura.revisjonslogg for select
  using (faktura.kan(org_id, 'les')
         and (coalesce(tabell, '') not in ('ansatte', 'fravaer', 'arbeidsplaner') or faktura.kan(org_id, 'personal_les'))
         and (coalesce(tabell, '') <> 'fravaer' or faktura.kan(org_id, 'personal')));
