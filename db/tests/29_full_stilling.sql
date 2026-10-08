-- Arbeidstiden i full stilling (0048_full_stilling.sql): 37,5 som standard, mellom 0 og 60, og bare
-- eier og administrator endrer den.

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
create function test.feiler(_sql text, _kode text) returns void language plpgsql as $$
begin
  begin
    execute _sql;
  exception when others then
    if sqlstate = _kode then return; end if;
    raise exception 'Forventet % men fikk % (%) fra: %', _kode, sqlstate, sqlerrm, _sql;
  end;
  raise exception 'Forventet feil % fra: %', _kode, _sql;
end $$;
grant execute on all functions in schema test to public;

\c :api
select id as eier from faktura.registrer_bruker('uid-fullst-eier', 'eier-fullst@test.no') \gset
select id as les from faktura.registrer_bruker('uid-fullst-les', 'les-fullst@test.no') \gset
select set_config('app.bruker_id', :'eier', false);
select id as org from faktura.opprett_organisasjon('Full Stilling AS') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
select test.er((select full_stilling from faktura.lonn_oppsett where org_id = :'org'), 37.5::numeric, '37,5 som standard');
select test.feiler(format($$update faktura.lonn_oppsett set full_stilling = 61 where org_id = %L$$, :'org'), '23514');
update faktura.lonn_oppsett set full_stilling = 35.5 where org_id = :'org';
select faktura.inviter_medlem(:'org', 'les-fullst@test.no', 'les') as token \gset
select set_config('app.bruker_id', :'les', false);
select faktura.aksepter_invitasjon(:'token');
update faktura.lonn_oppsett set full_stilling = 40 where org_id = :'org';
select test.er((select full_stilling from faktura.lonn_oppsett where org_id = :'org'), 35.5::numeric, 'leseren kan ikke endre den');

\c :migrator
drop schema test cascade;
\echo '  ok'
