-- Reserverte innbetalinger (0067_reserverte_innbetalinger.sql): bare workeren lagrer, endrer og
-- fjerner dem, alle medlemmer ser organisasjonens, andre ser ingenting, og en faktura som slettes,
-- fjernes fra den reserverte innbetalingen uten at den forsvinner.

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
select id as u from faktura.registrer_bruker('uid-reservert', 'reservert@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Reservert AS', '923609016') \gset
insert into faktura.kunder (org_id, navn) values (:'org', 'Kari Hansen') returning id as kunde \gset
insert into faktura.fakturaer (org_id, kunde_id) values (:'org', :'kunde') returning id as utkast \gset

-- Appen lagrer ikke reserverte innbetalinger.
select test.feiler(format($$insert into faktura.reserverte_innbetalinger (org_id, konto, ekstern_id, dato, belop) values (%L, '86011117947', 'r1', current_date, 100)$$, :'org'), '42501');

-- Workeren lagrer dem, med fakturaen de trolig gjelder, og oppdaterer og fjerner dem.
\c :worker
insert into faktura.reserverte_innbetalinger (org_id, konto, ekstern_id, dato, belop, betaler, melding, faktura_id, grunn)
values (:'org', '86011117947', 'r1', current_date, 2500, 'KARI HANSEN', 'Faktura 1', :'utkast', 'Fakturanummer 1 i meldingen');
insert into faktura.reserverte_innbetalinger (org_id, konto, ekstern_id, dato, belop) values (:'org', '86011117947', 'r2', current_date, 99);
insert into faktura.reserverte_innbetalinger (org_id, konto, ekstern_id, dato, belop) values (:'org', '86011117947', 'r2', current_date, 99)
on conflict (org_id, konto, ekstern_id) do update set belop = excluded.belop + 1, sist_sett = now();
select test.er((select belop from faktura.reserverte_innbetalinger where ekstern_id = 'r2'), 100.00, 'workeren oppdaterer den');
select test.feiler(format($$insert into faktura.reserverte_innbetalinger (org_id, konto, ekstern_id, dato, belop) values (%L, '86011117947', 'r3', current_date, 0)$$, :'org'), '23514');
select test.feiler(format($$update faktura.reserverte_innbetalinger set org_id = gen_random_uuid() where ekstern_id = 'r1' and org_id = %L$$, :'org'), '42501');
delete from faktura.reserverte_innbetalinger where org_id = :'org' and ekstern_id = 'r2';
select test.er((select count(*)::int from faktura.reserverte_innbetalinger where org_id = :'org'), 1, 'workeren fjerner den');

-- Et medlem med lesetilgang ser dem, men kan ikke fjerne dem.
\c :api
select id as u2 from faktura.registrer_bruker('uid-reservert-les', 'les-reservert@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select faktura.inviter_medlem(:'org', 'les-reservert@test.no', 'les') as token \gset
select set_config('app.bruker_id', :'u2', false);
select faktura.aksepter_invitasjon(:'token');
select test.er((select string_agg(ekstern_id || ':' || belop, ',') from faktura.reserverte_innbetalinger), 'r1:2500.00', 'lesetilgang ser dem');
select test.feiler(format($$delete from faktura.reserverte_innbetalinger where org_id = %L$$, :'org'), '42501');

-- Andre ser ingenting.
select id as u3 from faktura.registrer_bruker('uid-reservert-annen', 'annen-reservert@test.no') \gset
select set_config('app.bruker_id', :'u3', false);
select test.er((select count(*)::int from faktura.reserverte_innbetalinger), 0, 'andre ser dem ikke');

-- Fakturaen slettes: den reserverte innbetalingen blir stående uten faktura.
select set_config('app.bruker_id', :'u', false);
delete from faktura.fakturaer where id = :'utkast';
select test.er((select faktura_id is null and org_id = :'org' from faktura.reserverte_innbetalinger where ekstern_id = 'r1'), true, 'uten faktura');

\c :migrator
drop schema test cascade;
\echo '  ok'
