-- Kopi av fakturaer: fast kopiadresse per organisasjon og kopimottakere per faktura
-- (0019_kopimottakere.sql).

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
select id as u from faktura.registrer_bruker('uid-kopi', 'kopi@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Kopi AS', '923609016') \gset
update faktura.organisasjoner set kontonr = '86011117947' where id = :'org';
insert into faktura.kunder (org_id, navn, epost) values (:'org', 'Kunde', 'kunde@test.no') returning id as k \gset

-- Fast kopiadresse: gyldige adresser lagres, og endringen gir en hendelse (eierne varsles).
update faktura.organisasjoner set kopi_til = '{regnskap@byraa.no}' where id = :'org';
select test.er((select kopi_til from faktura.organisasjoner where id = :'org'), '{regnskap@byraa.no}'::text[], 'fast kopiadresse');
select set_config('test.org', :'org', false);
do $$ begin
  update faktura.organisasjoner set kopi_til = '{ikke-en-adresse}' where id = current_setting('test.org')::uuid;
  raise exception 'FEIL: ugyldig kopiadresse ble godtatt';
exception when check_violation then null;
end $$;
do $$ begin
  update faktura.organisasjoner set kopi_til = '{a@b.no,c@b.no,d@b.no,e@b.no,f@b.no,g@b.no}' where id = current_setting('test.org')::uuid;
  raise exception 'FEIL: mer enn fem faste kopiadresser ble godtatt';
exception when check_violation then null;
end $$;

-- Kopimottakere på fakturaen; kan endres etter utstedelse (de er ikke en del av dokumentet).
insert into faktura.fakturaer (org_id, kunde_id, kopi_til) values (:'org', :'k', '{lise@kunde.no}') returning id as f \gset
insert into faktura.faktura_linjer (org_id, faktura_id, beskrivelse, enhetspris) values (:'org', :'f', 'Arbeid', 100);
select faktura.utsted(:'f');
select faktura.sett_kopi_til(:'f', '{lise@kunde.no,per@kunde.no}');
select test.er((select kopi_til from faktura.fakturaer where id = :'f'), '{lise@kunde.no,per@kunde.no}'::text[], 'kopimottakere etter utstedelse');
select set_config('test.f', :'f', false);
do $$ begin
  perform faktura.sett_kopi_til(current_setting('test.f')::uuid, '{ikke gyldig@}');
  raise exception 'FEIL: ugyldig kopimottaker ble godtatt';
exception when check_violation then null;
end $$;

-- Bare den som kan sende fakturaer, kan endre kopimottakerne.
select id as u2 from faktura.registrer_bruker('uid-kopi-les', 'les@test.no') \gset
select faktura.inviter_medlem(:'org', 'les@test.no', 'les') as token \gset
select set_config('app.bruker_id', :'u2', false);
select faktura.aksepter_invitasjon(:'token');
do $$ begin
  perform faktura.sett_kopi_til(current_setting('test.f')::uuid, '{svindel@x.no}');
  raise exception 'FEIL: lesetilgang kunne endre kopimottakere';
exception when sqlstate 'FA403' then null;
end $$;
select set_config('app.bruker_id', :'u', false);

-- En kreditnota arver kopimottakerne.
select id as kn from faktura.krediter(:'f') \gset
select test.er((select kopi_til from faktura.fakturaer where id = :'kn'), '{lise@kunde.no,per@kunde.no}'::text[], 'kreditnota arver kopimottakere');

-- Fakturaer fra en gjentakelse arver gjentakelsens kopimottakere.
insert into faktura.gjentakelser (org_id, kunde_id, linjer, forfall_dag, neste_forfall, kopi_til)
values (:'org', :'k', '[{"beskrivelse": "Leie", "enhetspris": 100}]', 1, faktura.i_dag(), '{utleie@kunde.no}') returning id as g \gset
select faktura.lag_fra_gjentakelse(:'g') as f2 \gset
select test.er((select kopi_til from faktura.fakturaer where id = :'f2'), '{utleie@kunde.no}'::text[], 'gjentakelsens kopimottakere');

-- E-postloggen tar med kopimottakerne (bare workeren kan logge).
\c :worker
select faktura.logg_epost(:'org', :'f', null, 'resend-kopi-1', 'kunde@test.no', 'Faktura 1', '{lise@kunde.no,per@kunde.no}');
select faktura.logg_epost(:'org', :'f', null, 'resend-kopi-2', 'kunde@test.no', 'Faktura 1');

\c :migrator
select test.er((select kopi from faktura.eposter where ekstern_id = 'resend-kopi-1'), '{lise@kunde.no,per@kunde.no}'::text[], 'kopi i e-postloggen');
select test.er((select kopi from faktura.eposter where ekstern_id = 'resend-kopi-2'), '{}'::text[], 'uten kopi');
select test.er((select count(*)::int from faktura.utboks where org_id = :'org' and hendelse = 'organisasjon.kopi_endret'), 1, 'én hendelse for endret kopiadresse');
select test.er((select data -> 'til' from faktura.utboks where org_id = :'org' and hendelse = 'organisasjon.kopi_endret'), '["regnskap@byraa.no"]'::jsonb, 'ny kopiadresse i hendelsen');
select test.er((select data -> 'fra' from faktura.utboks where org_id = :'org' and hendelse = 'organisasjon.kopi_endret'), '[]'::jsonb, 'gammel kopiadresse i hendelsen');

\c :api
select set_config('app.bruker_id', :'u', false);
select set_config('test.org', :'org', false), set_config('test.f', :'f', false);
do $$ begin
  perform faktura.logg_epost(current_setting('test.org')::uuid, current_setting('test.f')::uuid, null, 'x', 'y@z.no', 'e', '{}');
  raise exception 'FEIL: API-et kunne logge e-post';
exception when insufficient_privilege or sqlstate 'FA403' then null;
end $$;

\c :migrator
drop schema test cascade;
\echo '  ok'
