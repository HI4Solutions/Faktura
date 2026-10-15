-- Krav og frister fra Skatteetaten (0112_skatteetaten_krav.sql): bare workeren skriver; eier,
-- administrator og regnskap (og en egen rolle med Regnskap) ser det, ikke fakturereren eller andre
-- organisasjoner; feilteksten er høyst 2000 tegn.

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
select id as u from faktura.registrer_bruker('uid-skattdb-eier', 'eier-skattdb@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Skatt DB AS', '915000312') \gset
select set_config('app.betrodd', 'on', false);
select faktura.admin_sett_funksjon(:'org', 'regnskap', true);
select set_config('app.betrodd', '', false);
select id as okonomi from faktura.lagre_tilgangsrolle(:'org', null, 'Økonomiansvarlig', null, array['regnskap']) \gset
select faktura.inviter_medlem(:'org', 'regn-skattdb@test.no', 'regnskap') as t_regn \gset
select faktura.inviter_medlem(:'org', 'fakt-skattdb@test.no', 'fakturerer') as t_fakt \gset
select faktura.inviter_medlem(:'org', 'okon-skattdb@test.no', 'tilpasset', :'okonomi') as t_okon \gset
select id as u_regn from faktura.registrer_bruker('uid-skattdb-regn', 'regn-skattdb@test.no') \gset
select id as u_fakt from faktura.registrer_bruker('uid-skattdb-fakt', 'fakt-skattdb@test.no') \gset
select id as u_okon from faktura.registrer_bruker('uid-skattdb-okon', 'okon-skattdb@test.no') \gset
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'t_regn');
select set_config('app.bruker_id', :'u_fakt', false);
select faktura.aksepter_invitasjon(:'t_fakt');
select set_config('app.bruker_id', :'u_okon', false);
select faktura.aksepter_invitasjon(:'t_okon');
-- En annen organisasjon.
select id as u_annen from faktura.registrer_bruker('uid-skattdb-annen', 'annen-skattdb@test.no') \gset
select set_config('app.bruker_id', :'u_annen', false);
select id as org2 from faktura.opprett_organisasjon('Annen AS', '915000320') \gset

-- Bare workeren skriver.
select set_config('app.bruker_id', :'u', false);
select test.feiler(format($$insert into faktura.skatteetaten_krav (org_id, forsokt) values (%L, now())$$, :'org'), '42501');

\c :worker
insert into faktura.skatteetaten_krav (org_id, krav, krav_hentet, frister, frister_hentet, forsokt)
values (:'org', '{"summer": {"saldo": 100}}', now(), '{"frister": [], "kilder": []}', now(), now());
update faktura.skatteetaten_krav set krav_feil = 'Kunne ikke hente kravene fra Skatteetaten: Skatteetaten svarte 500' where org_id = :'org';
select test.feiler(format($$update faktura.skatteetaten_krav set frister_feil = repeat('x', 2001) where org_id = %L$$, :'org'), '23514');
-- Én rad per organisasjon.
select test.feiler(format($$insert into faktura.skatteetaten_krav (org_id) values (%L)$$, :'org'), '23505');

\c :api
-- Eier, regnskap og en egen rolle med Regnskap ser det; fakturereren og andre organisasjoner ikke.
select set_config('app.bruker_id', :'u', false);
select test.er((select (krav -> 'summer' ->> 'saldo')::int from faktura.skatteetaten_krav where org_id = :'org'), 100, 'eieren ser kravene');
select test.er((select krav_feil from faktura.skatteetaten_krav where org_id = :'org'), 'Kunne ikke hente kravene fra Skatteetaten: Skatteetaten svarte 500', 'og feilen');
select test.feiler(format($$update faktura.skatteetaten_krav set krav = null where org_id = %L$$, :'org'), '42501');
select test.feiler(format($$delete from faktura.skatteetaten_krav where org_id = %L$$, :'org'), '42501');
select set_config('app.bruker_id', :'u_regn', false);
select test.er((select count(*)::int from faktura.skatteetaten_krav where org_id = :'org'), 1, 'regnskap ser kravene');
select set_config('app.bruker_id', :'u_okon', false);
select test.er((select count(*)::int from faktura.skatteetaten_krav where org_id = :'org'), 1, 'en egen rolle med Regnskap ser kravene');
select set_config('app.bruker_id', :'u_fakt', false);
select test.er((select count(*)::int from faktura.skatteetaten_krav where org_id = :'org'), 0, 'fakturereren ser ikke kravene');
select set_config('app.bruker_id', :'u_annen', false);
select test.er((select count(*)::int from faktura.skatteetaten_krav), 0, 'andre organisasjoner ser ikke kravene');

\c :migrator
drop schema test cascade;
\echo '  ok'
