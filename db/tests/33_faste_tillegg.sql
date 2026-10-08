-- Faste tillegg på lønnen (0052_faste_tillegg.sql): eier og administrator legger dem inn og
-- endrer dem, regnskap og den ansatte selv ser dem, andre ansatte og fakturereren ser dem ikke,
-- og loggen over dem er for dem som ser de ansatte. Kontrollene på beløp, «per» og periode, og
-- at tilleggene forsvinner med den ansatte.

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
select id as u from faktura.registrer_bruker('uid-till-eier', 'eier-till@test.no') \gset
select id as regn from faktura.registrer_bruker('uid-till-regn', 'regn-till@test.no') \gset
select id as fakt from faktura.registrer_bruker('uid-till-fakt', 'fakt-till@test.no') \gset
select id as kari_b from faktura.registrer_bruker('uid-till-kari', 'kari-till@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Tillegg AS', '917654158') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
insert into faktura.ansatte (org_id, fornavn, etternavn) values (:'org', 'Kari', 'Till') returning id as kari \gset
insert into faktura.ansatte (org_id, fornavn, etternavn) values (:'org', 'Per', 'Till') returning id as per \gset

-- Eieren legger inn tilleggene.
insert into faktura.ansatt_tillegg (org_id, ansatt_id, navn, belop) values (:'org', :'kari', 'Funksjonstillegg', 1500) returning id as t1 \gset
insert into faktura.ansatt_tillegg (org_id, ansatt_id, navn, belop, per, fra, til) values (:'org', :'per', 'Fagbrevtillegg', 15, 'time', '2026-01-01', '2026-12-31');
select test.er((select per from faktura.ansatt_tillegg where id = :'t1'), 'maaned', 'per måned som standard');
update faktura.ansatt_tillegg set belop = 1750 where id = :'t1';
select test.er((select belop from faktura.ansatt_tillegg where id = :'t1'), 1750.00, 'beløpet er endret');

-- Kontrollene.
select test.feiler(format($$insert into faktura.ansatt_tillegg (org_id, ansatt_id, navn, belop) values (%L, %L, 'Null', 0)$$, :'org', :'kari'), '23514');
select test.feiler(format($$insert into faktura.ansatt_tillegg (org_id, ansatt_id, navn, belop) values (%L, %L, '  ', 100)$$, :'org', :'kari'), '23514');
select test.feiler(format($$insert into faktura.ansatt_tillegg (org_id, ansatt_id, navn, belop, per) values (%L, %L, 'Uke', 100, 'uke')$$, :'org', :'kari'), '23514');
select test.feiler(format($$insert into faktura.ansatt_tillegg (org_id, ansatt_id, navn, belop, fra, til) values (%L, %L, 'Baklengs', 100, '2026-05-01', '2026-04-01')$$, :'org', :'kari'), '23514');
select test.feiler(format($$update faktura.ansatt_tillegg set ansatt_id = %L where id = %L$$, :'per', :'t1'), '42501');
select test.feiler(format($$update faktura.ansatt_tillegg set org_id = gen_random_uuid() where id = %L$$, :'t1'), '42501');

-- Regnskap ser, men endrer ikke; fakturereren ser ingenting.
select faktura.inviter_medlem(:'org', 'regn-till@test.no', 'regnskap') as token \gset
select set_config('app.bruker_id', :'regn', false);
select faktura.aksepter_invitasjon(:'token');
select set_config('app.bruker_id', :'u', false);
select faktura.inviter_medlem(:'org', 'fakt-till@test.no', 'fakturerer') as token \gset
select set_config('app.bruker_id', :'fakt', false);
select faktura.aksepter_invitasjon(:'token');

select set_config('app.bruker_id', :'regn', false);
select test.er((select count(*) from faktura.ansatt_tillegg), 2::bigint, 'regnskap ser tilleggene');
select test.feiler(format($$insert into faktura.ansatt_tillegg (org_id, ansatt_id, navn, belop) values (%L, %L, 'Regnskap', 100)$$, :'org', :'kari'), '42501');
update faktura.ansatt_tillegg set belop = 1 where id = :'t1';
delete from faktura.ansatt_tillegg;
select test.er((select count(*) from faktura.revisjonslogg where tabell = 'ansatt_tillegg'), 3::bigint, 'regnskap ser loggen');

select set_config('app.bruker_id', :'fakt', false);
select test.er((select count(*) from faktura.ansatt_tillegg), 0::bigint, 'fakturereren ser ikke tilleggene');
select test.er((select count(*) from faktura.revisjonslogg where tabell = 'ansatt_tillegg'), 0::bigint, 'fakturereren ser ikke loggen');

-- Den ansatte ser bare sine egne.
\c :migrator
update faktura.ansatte set bruker_id = :'kari_b' where id = :'kari';
insert into faktura.medlemmer (org_id, bruker_id, rolle) values (:'org', :'kari_b', 'ansatt');
\c :api
select set_config('app.bruker_id', :'kari_b', false);
select test.er((select array_agg(navn) from faktura.ansatt_tillegg), array['Funksjonstillegg'], 'Kari ser bare sitt eget');
select test.er((select belop from faktura.ansatt_tillegg), 1750.00, 'regnskap endret ikke beløpet');
select test.feiler(format($$insert into faktura.ansatt_tillegg (org_id, ansatt_id, navn, belop) values (%L, %L, 'Selv', 100)$$, :'org', :'kari'), '42501');

-- En annen organisasjon ser ingenting.
select id as u2 from faktura.registrer_bruker('uid-till-annen', 'annen-till@test.no') \gset
select set_config('app.bruker_id', :'u2', false);
select faktura.opprett_organisasjon('Annen Tillegg AS', '917654166');
select test.er((select count(*) from faktura.ansatt_tillegg), 0::bigint, 'en annen organisasjon ser ingenting');
select test.feiler(format($$insert into faktura.ansatt_tillegg (org_id, ansatt_id, navn, belop) values (%L, %L, 'Fremmed', 100)$$, :'org', :'kari'), '42501');

-- Slettes den ansatte, forsvinner tilleggene.
select set_config('app.bruker_id', :'u', false);
delete from faktura.ansatte where id = :'per';
select test.er((select count(*) from faktura.ansatt_tillegg where org_id = :'org'), 1::bigint, 'Pers tillegg er borte');

\c :migrator
drop schema test cascade;
\echo '  ok'
