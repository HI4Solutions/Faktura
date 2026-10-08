-- Skjult fraværstype (0047_fravaer_skjult.sql): eier, administrator og den ansatte selv ser typen
-- (syk, ferie ...); regnskap ser bare at den ansatte har fravær, og heller ikke fraværet i
-- revisjonsloggen.

\set QUIET on
\set ON_ERROR_STOP on

create schema test;
grant usage on schema test to public;
create function test.er(_faktisk anycompatible, _forventet anycompatible, _hva text) returns void language plpgsql as $$
begin
  if _faktisk is distinct from _forventet then
    raise exception 'FEIL %: fikk %, forventet %', _hva, _faktisk, _forventet;
  end if;
end $$;
grant execute on all functions in schema test to public;

\c :api
select id as eier from faktura.registrer_bruker('uid-fskjult-eier', 'eier-fskjult@test.no', 'Eva Eier') \gset
select id as regn from faktura.registrer_bruker('uid-fskjult-regn', 'regn-fskjult@test.no', 'Rolf Regnskap') \gset
select id as kari_b from faktura.registrer_bruker('uid-fskjult-kari', 'kari-fskjult@test.no', 'Kari Kake') \gset
select set_config('app.bruker_id', :'eier', false);
select id as org from faktura.opprett_organisasjon('Fravær AS') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
insert into faktura.ansatte (org_id, fornavn, etternavn) values (:'org', 'Kari', 'Kake') returning id as kari \gset
insert into faktura.ansatte (org_id, fornavn, etternavn) values (:'org', 'Ola', 'Olsen') returning id as ola \gset
insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, notat) values (:'org', :'kari', 'syk', faktura.i_dag(), faktura.i_dag(), 'Ring meg');
insert into faktura.fravaer (org_id, ansatt_id, type, fra, til) values (:'org', :'ola', 'ferie', faktura.i_dag(), faktura.i_dag() + 7);
select faktura.inviter_medlem(:'org', 'regn-fskjult@test.no', 'regnskap') as token \gset
select set_config('app.bruker_id', :'regn', false);
select faktura.aksepter_invitasjon(:'token');

\c :migrator
update faktura.ansatte set bruker_id = :'kari_b' where id = :'kari';
insert into faktura.medlemmer (org_id, bruker_id, rolle) values (:'org', :'kari_b', 'ansatt');

\c :api
-- Eieren ser typen.
select set_config('app.bruker_id', :'eier', false);
select test.er((select array_agg(faktura.fravaer_type(org_id, ansatt_id, type) order by type) from faktura.fravaer where org_id = :'org'),
               array['ferie', 'syk'], 'eieren ser typen');
select test.er((select count(*) from faktura.revisjonslogg where org_id = :'org' and tabell = 'fravaer') > 0, true, 'og fraværet i revisjonsloggen');
-- Regnskap ser fraværet, men ikke hvorfor.
select set_config('app.bruker_id', :'regn', false);
select test.er((select array_agg(faktura.fravaer_type(org_id, ansatt_id, type)) from faktura.fravaer where org_id = :'org'),
               array['fravaer', 'fravaer'], 'regnskap ser bare at de har fravær');
select test.er((select bool_or(faktura.ser_fravaertype(org_id, ansatt_id)) from faktura.fravaer where org_id = :'org'), false, 'og ikke notatet');
select test.er((select count(*) from faktura.revisjonslogg where org_id = :'org' and tabell = 'fravaer'), 0::bigint, 'ikke fraværet i revisjonsloggen');
select test.er((select count(*) from faktura.revisjonslogg where org_id = :'org' and tabell = 'ansatte') > 0, true, 'men resten av loggen for de ansatte');
-- Den ansatte ser sitt eget.
select set_config('app.bruker_id', :'kari_b', false);
select test.er((select array_agg(faktura.fravaer_type(org_id, ansatt_id, type)) from faktura.fravaer where org_id = :'org'), array['syk'], 'Kari ser sitt eget');
\c :worker
select test.er((select faktura.fravaer_type(org_id, ansatt_id, type) from faktura.fravaer where ansatt_id = :'ola'), 'ferie', 'workeren ser typen');

\c :migrator
drop schema test cascade;
\echo '  ok'
