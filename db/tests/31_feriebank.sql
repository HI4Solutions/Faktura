-- Feriebank (0050_feriebank.sql): retten (fem uker, regnet om etter arbeidsdagene, en uke ekstra
-- fra 60 år, én uke ved start etter 30. september, eller satt for den ansatte), avviklet og
-- planlagt ferie i arbeidsdager uten helligdager, og overføring til neste år: den ansatte søker,
-- eier og administrator godkjenner, og ingen kan overføre mer enn det som er igjen.

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

-- Påske og helligdager.
select test.er(array[faktura.paaskedag(2024), faktura.paaskedag(2025), faktura.paaskedag(2026), faktura.paaskedag(2027)],
               array['2024-03-31', '2025-04-20', '2026-04-05', '2027-03-28']::date[], 'påskedagene');
select test.er((select array_agg(d order by d) from faktura.helligdager(2025) d),
               array['2025-01-01', '2025-04-17', '2025-04-18', '2025-04-20', '2025-04-21', '2025-05-01', '2025-05-17', '2025-05-29',
                     '2025-06-08', '2025-06-09', '2025-12-25', '2025-12-26']::date[], 'helligdagene i 2025');
select test.er(faktura.dager_tekst(12.5) || ' ' || faktura.dager_tekst(10.0), '12,5 10', 'dager som tekst');

\c :api
select id as eier from faktura.registrer_bruker('uid-ferie-eier', 'eier-ferie@test.no', 'Eva Eier') \gset
select id as regn from faktura.registrer_bruker('uid-ferie-regn', 'regn-ferie@test.no', 'Rolf Regnskap') \gset
select id as kari_b from faktura.registrer_bruker('uid-ferie-kari', 'kari-ferie@test.no', 'Kari Kake') \gset
select set_config('app.bruker_id', :'eier', false);
select id as org from faktura.opprett_organisasjon('Ferie AS') \gset
insert into faktura.lonn_oppsett (org_id, aktiv) values (:'org', true);
select test.er((select ferie_dager from faktura.lonn_oppsett where org_id = :'org'), 25.0, 'fem uker som standard');
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, fodselsdato) values (:'org', 'Kari', 'Kake', '2020-01-01', '1990-03-01') returning id as kari \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra) values (:'org', 'Per', 'Pedersen', '2020-01-01') returning id as per \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, fodselsdato) values (:'org', 'Siri', 'Senior', '2020-01-01', '1965-05-01') returning id as siri \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra) values (:'org', 'Nils', 'Ny', '2025-10-15') returning id as nils \gset
insert into faktura.ansatte (org_id, fornavn, etternavn, ansatt_fra, ferie_dager) values (:'org', 'Ola', 'Olsen', '2020-01-01', 20) returning id as ola \gset
-- Per jobber mandag, onsdag og fredag.
insert into faktura.arbeidsplaner (org_id, ansatt_id, gjelder_fra) values (:'org', :'per', '2020-01-01') returning id as plan \gset
insert into faktura.arbeidsplan_dager (org_id, plan_id, ukedag) values (:'org', :'plan', 1), (:'org', :'plan', 3), (:'org', :'plan', 5);

-- Retten.
select test.er((select array_agg(array[rett, dager_per_uke] order by navn) from faktura.feriebank(:'org', 2025)),
               array[array[25, 5], array[5, 5], array[20, 5], array[15, 3], array[30, 5]]::numeric[],
               'Kari 25, Nils én uke (begynte i oktober), Ola 20 (satt), Per 15 (tre dager i uka), Siri 30 (fyller 60)');
select test.er((select rett from faktura.feriebank(:'org', 2024) where ansatt_id = :'siri' and not ekstra_60), 25.0, 'Siri før hun fyller 60');
select test.er((select count(*) from faktura.feriebank(:'org', 2024) where ansatt_id = :'nils'), 0::bigint, 'Nils var ikke ansatt i 2024');
select test.er((select rett from faktura.feriebank(:'org', 2026) where ansatt_id = :'nils'), 25.0, 'Nils får fem uker året etter');

-- Avviklet ferie: tre uker i juli, og uka med Kristi himmelfartsdag (fire arbeidsdager).
insert into faktura.fravaer (org_id, ansatt_id, type, fra, til) values
  (:'org', :'kari', 'ferie', '2025-07-07', '2025-07-27'),
  (:'org', :'kari', 'ferie', '2025-05-26', '2025-05-30'),
  (:'org', :'kari', 'syk', '2025-08-04', '2025-08-08'),
  (:'org', :'per', 'ferie', '2025-07-07', '2025-07-25');
select test.er((select array[avviklet, planlagt, igjen] from faktura.feriebank(:'org', 2025) where ansatt_id = :'kari'), array[19, 0, 6]::numeric[],
               'Kari: 15 + 4 dager, sykdommen teller ikke');
select test.er((select array[avviklet, igjen] from faktura.feriebank(:'org', 2025) where ansatt_id = :'per'), array[9, 6]::numeric[], 'Per: bare dagene han jobber');
select test.er((select array_agg(array[dager, avviklet] order by fra) from faktura.ferie_perioder(:'org', :'kari', 2025)),
               array[array[4, 4], array[15, 15]], 'periodene');
-- Ferie over nyttår telles i hvert sitt år, og planlagt ferie neste år er planlagt.
select (extract(year from faktura.i_dag())::int + 1) as neste \gset
insert into faktura.fravaer (org_id, ansatt_id, type, fra, til) values (:'org', :'ola', 'ferie', make_date(:neste, 7, 1), make_date(:neste, 7, 31));
select test.er((select avviklet = 0 and planlagt > 0 and igjen = rett - planlagt from faktura.feriebank(:'org', :neste) where ansatt_id = :'ola'), true, 'planlagt');
-- Endres ferien, justeres banken.
update faktura.fravaer set til = '2025-05-28' where ansatt_id = :'kari' and fra = '2025-05-26';
select test.er((select avviklet from faktura.feriebank(:'org', 2025) where ansatt_id = :'kari'), 18::numeric, 'kortere ferie');

-- Overføring: eieren kan overføre for et tidligere år.
insert into faktura.ferie_overforinger (org_id, ansatt_id, fra_aar, dager, status) values (:'org', :'per', 2025, 5, 'godkjent');
select test.er((select array[overfort_ut, igjen] from faktura.feriebank(:'org', 2025) where ansatt_id = :'per'), array[5, 1]::numeric[], 'trukket fra i 2025');
select test.er((select array[overfort_inn, igjen] from faktura.feriebank(:'org', 2026) where ansatt_id = :'per'), array[5, 20]::numeric[], 'lagt til i 2026');
select test.feiler(format($$insert into faktura.ferie_overforinger (org_id, ansatt_id, fra_aar, dager, status) values (%L, %L, 2025, 2, 'godkjent')$$, :'org', :'per'), 'FA400');
select test.feiler(format($$insert into faktura.ferie_overforinger (org_id, ansatt_id, fra_aar, dager) values (%L, %L, 2025, 0.3)$$, :'org', :'per'), '23514');

-- Kari får innlogging som ansatt, og regnskap blir med.
select faktura.inviter_medlem(:'org', 'regn-ferie@test.no', 'regnskap') as token \gset
select set_config('app.bruker_id', :'regn', false);
select faktura.aksepter_invitasjon(:'token');
\c :migrator
update faktura.ansatte set bruker_id = :'kari_b' where id = :'kari';
insert into faktura.medlemmer (org_id, bruker_id, rolle) values (:'org', :'kari_b', 'ansatt');

\c :api
select (extract(year from faktura.i_dag())::int) as i_aar \gset
select set_config('app.bruker_id', :'kari_b', false);
select test.er((select array_agg(navn) from faktura.feriebank(:'org', :i_aar)), array['Kari Kake'], 'Kari ser bare seg selv');
-- Kari søker; hun kan ikke godkjenne selv, ikke søke for andre år og ikke om mer enn hun har.
select test.feiler(format($$insert into faktura.ferie_overforinger (org_id, ansatt_id, fra_aar, dager, status) values (%L, %L, %s, 5, 'godkjent')$$, :'org', :'kari', :i_aar), 'FA403');
select test.feiler(format($$insert into faktura.ferie_overforinger (org_id, ansatt_id, fra_aar, dager) values (%L, %L, %s, 5)$$, :'org', :'kari', :i_aar - 2), 'FA400');
select test.feiler(format($$insert into faktura.ferie_overforinger (org_id, ansatt_id, fra_aar, dager) values (%L, %L, %s, 26)$$, :'org', :'kari', :i_aar), 'FA400');
select test.feiler(format($$insert into faktura.ferie_overforinger (org_id, ansatt_id, fra_aar, dager) values (%L, %L, %s, 1)$$, :'org', :'per', :i_aar), '42501');
insert into faktura.ferie_overforinger (org_id, ansatt_id, fra_aar, dager, begrunnelse) values (:'org', :'kari', :i_aar, 5, '  Mye å gjøre i høst  ') returning id as s1 \gset
select test.er((select array[status, begrunnelse] from faktura.ferie_overforinger where id = :'s1'), array['venter', 'Mye å gjøre i høst'], 'søknaden venter');
select test.er((select venter from faktura.feriebank(:'org', :i_aar)), 5.0, 'banken viser søknaden');
-- En søknad til kan ikke ta mer enn det som er igjen etter den første.
select test.feiler(format($$insert into faktura.ferie_overforinger (org_id, ansatt_id, fra_aar, dager) values (%L, %L, %s, 21)$$, :'org', :'kari', :i_aar), 'FA400');
insert into faktura.ferie_overforinger (org_id, ansatt_id, fra_aar, dager) values (:'org', :'kari', :i_aar, 2) returning id as s2 \gset
-- Hun kan ikke behandle den selv, men kan trekke en søknad som venter.
with u as (update faktura.ferie_overforinger set status = 'godkjent' where id = :'s1' returning 1) select test.er(count(*), 0::bigint, 'ikke godkjenne selv') from u;
delete from faktura.ferie_overforinger where id = :'s2';
select test.er((select count(*) from faktura.ferie_overforinger where id = :'s2'), 0::bigint, 'trukket');

-- Regnskap ser ikke feriebanken.
select set_config('app.bruker_id', :'regn', false);
select test.er((select count(*) from faktura.feriebank(:'org', :i_aar)), 0::bigint, 'regnskap ser ikke banken');
select test.er((select count(*) from faktura.ferie_overforinger where org_id = :'org'), 0::bigint, 'eller søknadene');

-- Eieren godkjenner; da flyttes dagene, og søknaden kan ikke behandles på nytt.
select set_config('app.bruker_id', :'eier', false);
update faktura.ferie_overforinger set status = 'godkjent', svar = 'OK' where id = :'s1';
select test.er((select behandlet_av = :'eier'::uuid and behandlet_at is not null from faktura.ferie_overforinger where id = :'s1'), true, 'behandlet av eieren');
select test.er((select array[overfort_ut, venter] from faktura.feriebank(:'org', :i_aar) where ansatt_id = :'kari'), array[5, 0]::numeric[], 'godkjent');
select test.er((select overfort_inn from faktura.feriebank(:'org', :i_aar + 1) where ansatt_id = :'kari'), 5.0, 'til neste år');
select test.feiler(format($$update faktura.ferie_overforinger set status = 'avslatt' where id = %L$$, :'s1'), 'FA409');
select set_config('app.bruker_id', :'kari_b', false);
with d as (delete from faktura.ferie_overforinger where id = :'s1' returning 1) select test.er(count(*), 0::bigint, 'en godkjent overføring kan ikke trekkes') from d;
select test.er((select count(*) from faktura.revisjonslogg where tabell = 'ferie_overforinger'), 0::bigint, 'den ansatte ser ikke loggen');

\c :migrator
drop schema test cascade;
\echo '  ok'
