-- 0054_tilknytning.sql
-- Ikke alle som jobber her, er ansatt: leger på et legekontor kan være aksjonærer eller
-- selvstendig næringsdrivende, og noen er innleid. Tilknytningen står på personen i
-- ansattregisteret (standard: ansatt). De som ikke er ansatt, er med i vaktplanen, på tavla, i
-- bemanningskalenderen og i fraværet som før, men ikke i feriebanken (ferieloven gjelder
-- arbeidstakere), og appen og API-et holder dem utenfor lønn, faste tillegg, ekstratimer og
-- arbeidsmiljølovens advarsler.

alter table faktura.ansatte add column tilknytning text not null default 'ansatt'
  check (tilknytning in ('ansatt', 'eier', 'selvstendig', 'innleid'));
grant select (tilknytning), insert (tilknytning), update (tilknytning) on faktura.ansatte to faktura_app;

-- Feriebanken er bare for de ansatte.
create or replace function faktura.feriebank(_org uuid, _aar int)
returns table (ansatt_id uuid, navn text, aktiv boolean, dager_per_uke int, rett numeric, egen_rett boolean, ekstra_60 boolean,
               sen_start boolean, overfort_inn numeric, overfort_ut numeric, avviklet numeric, planlagt numeric, igjen numeric, venter numeric)
language sql stable security definer set search_path = '' as $$
  select a.id, a.fornavn || ' ' || a.etternavn, a.aktiv, s.*
    from faktura.ansatte a, faktura.ferie_saldo(_org, a.id, _aar) s
   where a.org_id = _org and faktura.ser_fravaertype(_org, a.id) and a.tilknytning = 'ansatt'
     and a.ansatt_fra <= make_date(_aar, 12, 31) and (a.ansatt_til is null or a.ansatt_til >= make_date(_aar, 1, 1))
   order by a.etternavn, a.fornavn
$$;
