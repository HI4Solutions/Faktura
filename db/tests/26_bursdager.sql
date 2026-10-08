-- Bursdager (0045_bursdager.sql): hvem som har bursdag i dag (aktive ansatte med fødselsdato,
-- når organisasjonen har slått på bursdagsvarsler), hvem som får beskjed (alle andre i
-- organisasjonen, også ansatte uten innlogging, men ikke den som har bursdag eller har sluttet),
-- og at bare eier og administrator endrer innstillingen.

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

-- 29. februar feires 28. februar i år som ikke er skuddår.
select test.er(faktura.bursdag('2000-02-29', 2027), '2027-02-28'::date, '29. februar i et vanlig år');
select test.er(faktura.bursdag('2000-02-29', 2028), '2028-02-29'::date, '29. februar i et skuddår');
select test.er(faktura.bursdag('1990-10-08', 2026), '2026-10-08'::date, 'en vanlig bursdag');

\c :api
select id as eier from faktura.registrer_bruker('uid-bursdag-eier', 'eier-bursdag@test.no', 'Eva Eier') \gset
select id as kari_b from faktura.registrer_bruker('uid-bursdag-kari', 'kari-bursdag@test.no', 'Kari Kake') \gset
select id as ola_b from faktura.registrer_bruker('uid-bursdag-ola', 'ola-bursdag@test.no', 'Ola Olsen') \gset
select set_config('app.bruker_id', :'eier', false);
select id as org from faktura.opprett_organisasjon('Bursdag AS') \gset
insert into faktura.lonn_oppsett (org_id, aktiv, bursdag_varsel) values (:'org', true, 'push');
-- Fødselsdatoen et antall år tilbake som går opp i fire (så 29. februar også stemmer).
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, fodselsdato)
values (:'org', 'Kari', 'Kake', 'kari.privat@test.no', (faktura.i_dag() - interval '28 years')::date) returning id as kari \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, fodselsdato) values (:'org', 'Ola', 'Olsen', '1990-01-15') returning id as ola \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, epost) values (:'org', 'Per', 'Privat', 'per.privat@test.no');
-- Siri har også bursdag, men vil ikke at de andre skal varsles.
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, fodselsdato, bursdag_varsel)
values (:'org', 'Siri', 'Stille', 'siri@test.no', (faktura.i_dag() - interval '40 years')::date, false);
-- Tor har sluttet.
insert into faktura.ansatte (org_id, fornavn, etternavn, epost, fodselsdato, ansatt_fra, ansatt_til)
values (:'org', 'Tor', 'Tidligere', 'tor@test.no', (faktura.i_dag() - interval '32 years')::date, faktura.i_dag() - 100, faktura.i_dag() - 1);
-- Ulla har verken innlogging eller e-post.
insert into faktura.ansatte (org_id, fornavn, etternavn) values (:'org', 'Ulla', 'Uten');

-- Kari og Ola har innlogging.
\c :migrator
update faktura.ansatte set bruker_id = :'kari_b' where id = :'kari';
update faktura.ansatte set bruker_id = :'ola_b' where id = :'ola';
insert into faktura.medlemmer (org_id, bruker_id, rolle) values (:'org', :'kari_b', 'ansatt'), (:'org', :'ola_b', 'ansatt');

\c :worker
select test.er((select array_agg(navn) from faktura.bursdager_i_dag() where org_id = :'org'), array['Kari Kake'], 'bare Kari varsles om');
select test.er((select kanal from faktura.bursdager_i_dag() where org_id = :'org'), 'push', 'med push');
select test.er((select array_agg(coalesce(epost, '-') order by epost) from faktura.bursdag_mottakere(:'org', :'kari')),
               array['eier-bursdag@test.no', 'ola-bursdag@test.no', 'per.privat@test.no', 'siri@test.no'], 'alle andre enn Kari');
select test.er((select array_agg(bruker_id order by bruker_id) from faktura.bursdag_mottakere(:'org', :'kari') where bruker_id is not null),
               (select array_agg(x order by x) from unnest(array[:'eier'::uuid, :'ola_b'::uuid]) x), 'push til dem med innlogging');

-- Bare eier og administrator endrer innstillingen; API-et når ikke funksjonene for workeren.
\c :api
select test.feiler($$select * from faktura.bursdager_i_dag()$$, '42501');
select set_config('app.bruker_id', :'ola_b', false);
update faktura.lonn_oppsett set bursdag_varsel = 'av' where org_id = :'org';
select set_config('app.bruker_id', :'eier', false);
select test.er((select bursdag_varsel from faktura.lonn_oppsett where org_id = :'org'), 'push', 'den ansatte kan ikke slå av');
update faktura.lonn_oppsett set bursdag_varsel = 'av' where org_id = :'org';
\c :worker
select test.er((select count(*) from faktura.bursdager_i_dag() where org_id = :'org'), 0::bigint, 'av: ingen varsles om');
\c :migrator
update faktura.lonn_oppsett set bursdag_varsel = 'begge' where org_id = :'org';
update faktura.org_funksjoner set aktiv = false where org_id = :'org' and kode = 'ansatte';
\c :worker
select test.er((select count(*) from faktura.bursdager_i_dag() where org_id = :'org'), 0::bigint, 'uten ansatte og timer: ingen');

\c :migrator
drop schema test cascade;
\echo '  ok'
