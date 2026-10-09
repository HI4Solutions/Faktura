-- Egenmelding (0071_egenmelding.sql): reglene for egen sykdom (3 dager per gang, 4 ganger i
-- løpet av 12 måneder, to måneder i jobben), fravær som henger sammen er samme tilfelle,
-- arbeidsgiverens utvidede ordning (og lovens regler, som gjelder uansett), sykt barn for seg,
-- og hvem som kan sende egenmelding og registrere sykmelding.

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
-- Egenmelding for den innloggede (eller lederen) fra og med i dag + _fra til i dag + _til.
create function test.egen(_org uuid, _ansatt uuid, _fra int, _til int, _type text default 'syk') returns uuid language sql as $$
  insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, dokumentasjon)
  values (_org, _ansatt, _type, faktura.i_dag() + _fra, faktura.i_dag() + _til, 'egenmelding') returning id
$$;
grant execute on all functions in schema test to public;

\c :api
select id as u from faktura.registrer_bruker('uid-egenmelding', 'egenmelding@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Egenmelding AS', '915000053') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
-- Ola og Per har vært ansatt i over et år; Kari begynte for en måned siden.
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, epost) values (:'org', 'Ola', 'Syk', faktura.i_dag() - 365, 'ola-egen@test.no') returning id as ola \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, epost) values (:'org', 'Per', 'Papir', faktura.i_dag() - 400, 'per-egen@test.no') returning id as per \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, epost) values (:'org', 'Kari', 'Ny', faktura.i_dag() - 30, 'kari-egen@test.no') returning id as kari \gset
select faktura.inviter_ansatt(:'org', :'ola') as t_ola \gset
select faktura.inviter_ansatt(:'org', :'per') as t_per \gset
select faktura.inviter_ansatt(:'org', :'kari') as t_kari \gset
select id as u_ola from faktura.registrer_bruker('uid-egen-ola', 'ola-egen@test.no') \gset
select id as u_per from faktura.registrer_bruker('uid-egen-per', 'per-egen@test.no') \gset
select id as u_kari from faktura.registrer_bruker('uid-egen-kari', 'kari-egen@test.no') \gset
select set_config('app.bruker_id', :'u_ola', false);
select faktura.aksepter_invitasjon(:'t_ola');
select set_config('app.bruker_id', :'u_per', false);
select faktura.aksepter_invitasjon(:'t_per');
select set_config('app.bruker_id', :'u_kari', false);
select faktura.aksepter_invitasjon(:'t_kari');

select test.er((select row(dager, ganger, dager_aar, barn_dager)::text from faktura.egenmelding_regler(:'org')), '(3,4,,3)', 'lovens regler');

-- Ola sender egenmelding (to dager), og forlenger den til tre; fire dager på rad går ikke.
select set_config('app.bruker_id', :'u_ola', false);
select test.egen(:'org', :'ola', -12, -11) as e1 \gset
select test.er((select egenmeldt is not null and egenmeldt_av = :'u_ola'::uuid from faktura.fravaer where id = :'e1'), true, 'sendt av Ola');
update faktura.fravaer set til = faktura.i_dag() - 10 where id = :'e1';
select test.feiler(format($$update faktura.fravaer set til = faktura.i_dag() - 9 where id = %L$$, :'e1'), 'FA400');
-- En ny egenmelding dagen etter er samme tilfelle (fire dager).
select test.feiler(format($$select test.egen(%L, %L, -9, -9)$$, :'org', :'ola'), 'FA400');
-- Eldre enn 16 dager, eller fram i tid, kan ikke den ansatte sende.
select test.feiler(format($$select test.egen(%L, %L, -20, -19)$$, :'org', :'ola'), 'FA400');
select test.feiler(format($$select test.egen(%L, %L, 2, 2)$$, :'org', :'ola'), 'FA400');
-- Sykmelding registrerer lederen, og egenmeldingen kan ikke fjernes av den ansatte.
select test.feiler(format($$update faktura.fravaer set dokumentasjon = 'sykmelding' where id = %L$$, :'e1'), 'FA403');
select test.feiler(format($$update faktura.fravaer set dokumentasjon = null where id = %L$$, :'e1'), 'FA403');

-- Lederen registrerer tre eldre egenmeldinger (på papir) i løpet av de siste 12 månedene.
select set_config('app.bruker_id', :'u', false);
select test.egen(:'org', :'ola', -300, -300) as e_papir \gset
select test.er((select egenmeldt_av from faktura.fravaer where id = :'e_papir'), :'u'::uuid, 'registrert av lederen');
select test.egen(:'org', :'ola', -200, -199);
select test.egen(:'org', :'ola', -100, -98);
select test.er((select row(ganger, dager)::text from faktura.egenmelding_brukt(:'org', :'ola', faktura.i_dag())), '(4,9)', 'fire ganger, ni dager');

-- Femte gang i løpet av 12 måneder: nei.
select set_config('app.bruker_id', :'u_ola', false);
select test.feiler(format($$select test.egen(%L, %L, 0, 0)$$, :'org', :'ola'), 'FA400');
-- Sykt barn telles ikke med, men er høyst tre dager på rad (deretter legeerklæring).
select test.egen(:'org', :'ola', -5, -4, 'sykt_barn');
select test.feiler(format($$select test.egen(%L, %L, -3, 0, 'sykt_barn')$$, :'org', :'ola'), 'FA400');

-- Arbeidsgiverens ordning (IA): 8 dager per gang og 24 dager i løpet av 12 måneder.
select set_config('app.bruker_id', :'u', false);
update faktura.lonn_oppsett set egenmelding_dager = 8, egenmelding_ganger = null, egenmelding_dager_aar = 24 where org_id = :'org';
select set_config('app.bruker_id', :'u_ola', false);
select test.egen(:'org', :'ola', 0, 0) as e_i_dag \gset
select set_config('app.bruker_id', :'u', false);
select test.feiler(format($$select test.egen(%L, %L, -60, -52)$$, :'org', :'ola'), 'FA400');
select test.egen(:'org', :'ola', -60, -53);
select test.egen(:'org', :'ola', -40, -33);
-- 1 + 2 + 3 + 8 + 8 + 3 + 1 = 26 dager; to til blir 27 (over 24).
select test.er((select row(ganger, dager)::text from faktura.egenmelding_brukt(:'org', :'ola', faktura.i_dag())), '(7,26)', 'sju ganger, 26 dager');
select set_config('app.bruker_id', :'u_ola', false);
select test.feiler(format($$update faktura.fravaer set til = faktura.i_dag() + 1 where id = %L$$, :'e_i_dag'), 'FA400');

-- Kari har vært ansatt i en måned: egenmelding for egen sykdom først etter to måneder, men
-- sykt barn går.
select set_config('app.bruker_id', :'u_kari', false);
select test.feiler(format($$select test.egen(%L, %L, 0, 0)$$, :'org', :'kari'), 'FA400');
select test.egen(:'org', :'kari', 0, 0, 'sykt_barn');

-- Per melder seg syk og sender egenmeldingen etterpå; sykmelding kan han ikke registrere selv.
select set_config('app.bruker_id', :'u_per', false);
insert into faktura.fravaer (org_id, ansatt_id, type, fra, til) values (:'org', :'per', 'syk', faktura.i_dag() - 1, faktura.i_dag()) returning id as p1 \gset
select test.er((select dokumentasjon from faktura.fravaer where id = :'p1'), null::text, 'meldt uten dokumentasjon');
update faktura.fravaer set dokumentasjon = 'egenmelding', arbeidsrelatert = false where id = :'p1';
select test.er((select egenmeldt_av from faktura.fravaer where id = :'p1'), :'u_per'::uuid, 'egenmelding sendt etterpå');
select test.feiler(format($$insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, dokumentasjon) values (%L, %L, 'syk', faktura.i_dag() + 1, faktura.i_dag() + 3, 'sykmelding')$$, :'org', :'per'), 'FA403');

-- Lederen registrerer sykmelding (også i stedet for en egenmelding), og ferie har ingen dokumentasjon.
select set_config('app.bruker_id', :'u', false);
insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, dokumentasjon) values (:'org', :'per', 'syk', faktura.i_dag() - 30, faktura.i_dag() - 20, 'sykmelding');
update faktura.fravaer set dokumentasjon = 'sykmelding', til = faktura.i_dag() + 5 where id = :'p1';
select test.er((select egenmeldt is null and egenmeldt_av is null from faktura.fravaer where id = :'p1'), true, 'egenmeldingen er erstattet');
insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, dokumentasjon, arbeidsrelatert)
values (:'org', :'per', 'ferie', faktura.i_dag() + 30, faktura.i_dag() + 35, 'sykmelding', true) returning id as ferie \gset
select test.er((select row(dokumentasjon, arbeidsrelatert)::text from faktura.fravaer where id = :'ferie'), '(,)', 'ferie uten dokumentasjon');

\c :migrator
drop schema test cascade;
\echo '  ok'
