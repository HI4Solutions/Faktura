-- Rapportmodulen (0070_rapportmodul.sql): oppsettet for utsending til regnskapsføreren endres
-- bare av eier og administrator, med gyldige adresser; nye mottakere gir en hendelse i utboksen
-- (eierne varsles), og loggen over utsendinger skrives bare av workeren.

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
select id as u from faktura.registrer_bruker('uid-rapportmodul', 'rapportmodul@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Rapportmodul AS', '915000045') \gset
select faktura.inviter_medlem(:'org', 'regn-rapportmodul@test.no', 'regnskap') as t_regn \gset
select faktura.inviter_medlem(:'org', 'admin-rapportmodul@test.no', 'admin') as t_admin \gset
select id as u_regn from faktura.registrer_bruker('uid-rapportmodul-regn', 'regn-rapportmodul@test.no') \gset
select id as u_admin from faktura.registrer_bruker('uid-rapportmodul-admin', 'admin-rapportmodul@test.no') \gset
select id as u_annen from faktura.registrer_bruker('uid-rapportmodul-annen', 'annen-rapportmodul@test.no') \gset
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'t_regn');
select set_config('app.bruker_id', :'u_admin', false);
select faktura.aksepter_invitasjon(:'t_admin');

-- Regnskap kan ikke legge inn oppsettet; eieren kan, med gyldige adresser (høyst 10).
select set_config('app.bruker_id', :'u_regn', false);
select test.feiler(format($$insert into faktura.rapport_oppsett (org_id, mottakere) values (%L, '{regnskap@byraa.no}')$$, :'org'), '42501');
select set_config('app.bruker_id', :'u', false);
select test.feiler(format($$insert into faktura.rapport_oppsett (org_id, mottakere) values (%L, '{ikke en adresse}')$$, :'org'), '23514');
select test.feiler(
  format($$insert into faktura.rapport_oppsett (org_id, mottakere) values (%L, %L)$$, :'org',
         (select array_agg('r' || i || '@byraa.no') from generate_series(1, 11) i)),
  '23514');
insert into faktura.rapport_oppsett (org_id, mottakere, lonn_ved_godkjenning, maanedlig)
values (:'org', '{regnskap@byraa.no}', true, '{faktura.journal,lonn.journal}');
select test.er((select oppdatert_av from faktura.rapport_oppsett where org_id = :'org'), :'u'::uuid, 'lagt inn av eieren');
select test.feiler(format($$update faktura.rapport_oppsett set oppdatert_av = null where org_id = %L$$, :'org'), '42501');

-- Nye mottakere gir en hendelse (eierne varsles); de samme med andre store bokstaver, eller færre, gjør ikke det.
\c :migrator
select test.er((select data -> 'nye' from faktura.utboks where org_id = :'org' and hendelse = 'organisasjon.rapportmottakere_endret'),
               '["regnskap@byraa.no"]'::jsonb, 'hendelse for den første mottakeren');
\c :api
select set_config('app.bruker_id', :'u_admin', false);
update faktura.rapport_oppsett set mottakere = '{Regnskap@Byraa.no,lonn@byraa.no}' where org_id = :'org';
update faktura.rapport_oppsett set mottakere = '{lonn@byraa.no}' where org_id = :'org';
update faktura.rapport_oppsett set lonn_ved_godkjenning = false where org_id = :'org';
select test.er((select oppdatert_av from faktura.rapport_oppsett where org_id = :'org'), :'u_admin'::uuid, 'sist endret av administratoren');
\c :migrator
select test.er((select count(*)::int from faktura.utboks where org_id = :'org' and hendelse = 'organisasjon.rapportmottakere_endret'), 2, 'to hendelser');
select test.er((select data -> 'nye' from faktura.utboks where org_id = :'org' and hendelse = 'organisasjon.rapportmottakere_endret' order by id desc limit 1),
               '["lonn@byraa.no"]'::jsonb, 'bare den nye adressen');
select test.er((select data ->> 'endret_av' from faktura.utboks where org_id = :'org' and hendelse = 'organisasjon.rapportmottakere_endret' order by id desc limit 1),
               :'u_admin', 'endret av administratoren');

-- Regnskap ser oppsettet, men kan ikke endre det (raden er ikke synlig for endring).
\c :api
select set_config('app.bruker_id', :'u_regn', false);
select test.er((select mottakere from faktura.rapport_oppsett where org_id = :'org'), '{lonn@byraa.no}'::text[], 'regnskap ser oppsettet');
update faktura.rapport_oppsett set mottakere = '{tyv@example.com}' where org_id = :'org';
select test.er((select mottakere from faktura.rapport_oppsett where org_id = :'org'), '{lonn@byraa.no}'::text[], 'regnskap endret ingenting');
-- En utenfor organisasjonen ser ingenting.
select set_config('app.bruker_id', :'u_annen', false);
select test.er((select count(*)::int from faktura.rapport_oppsett where org_id = :'org'), 0, 'andre ser ikke oppsettet');

-- Loggen: bare workeren skriver den; medlemmene ser den.
select set_config('app.bruker_id', :'u', false);
select test.feiler(format($$insert into faktura.rapport_utsendinger (org_id, til) values (%L, '{x@byraa.no}')$$, :'org'), '42501');
\c :worker
insert into faktura.rapport_utsendinger (org_id, til, rapporter, automatisk)
values (:'org', '{lonn@byraa.no}', '[{"id": "lonn.journal", "navn": "Lønnsjournal", "periode": "oktober 2026"}]', 'lonn');
select test.feiler(format($$insert into faktura.rapport_utsendinger (org_id, til, automatisk) values (%L, '{x@byraa.no}', 'ukjent')$$, :'org'), '23514');
\c :api
select set_config('app.bruker_id', :'u_regn', false);
select test.er((select automatisk from faktura.rapport_utsendinger where org_id = :'org'), 'lonn', 'regnskap ser loggen');
select test.feiler(format($$delete from faktura.rapport_utsendinger where org_id = %L$$, :'org'), '42501');
select set_config('app.bruker_id', :'u_annen', false);
select test.er((select count(*)::int from faktura.rapport_utsendinger where org_id = :'org'), 0, 'andre ser ikke loggen');

-- Månedene som er tatt for månedsrapportene: bare workeren, og alltid den 1.
select set_config('app.bruker_id', :'u', false);
select test.feiler(format($$insert into faktura.rapport_maanedsutsendinger (org_id, maaned) values (%L, '2026-10-01')$$, :'org'), '42501');
\c :worker
insert into faktura.rapport_maanedsutsendinger (org_id, maaned) values (:'org', '2026-10-01');
select test.feiler(format($$insert into faktura.rapport_maanedsutsendinger (org_id, maaned) values (%L, '2026-10-01')$$, :'org'), '23505');
select test.feiler(format($$insert into faktura.rapport_maanedsutsendinger (org_id, maaned) values (%L, '2026-11-02')$$, :'org'), '23514');
\c :api

-- Ingen månedsrapporter igjen fra denne organisasjonen i servertestene.
select set_config('app.bruker_id', :'u', false);
update faktura.rapport_oppsett set maanedlig = '{}' where org_id = :'org';

\c :migrator
drop schema test cascade;
\echo '  ok'
