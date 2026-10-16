-- Nullstilling av a-meldinger (0117_amelding_nullstilling.sql): hvilke meldinger som gjelder for
-- måneden (en avvist erstatning erstatter ingenting), at en ny melding erstatter den siste med
-- innhold som gjelder (ikke en nullstilling eller en som er erstattet), og nullstillingen (eier og
-- administrator; bare en melding som gjelder, og ikke mens måneden venter på Skatteetaten).

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
select id as u from faktura.registrer_bruker('uid-nullstill-eier', 'eier-nullstill@test.no') \gset
select set_config('app.bruker_id', :'u', false);
select id as org from faktura.opprett_organisasjon('Nullstilling AS', '915000169') \gset
select faktura.inviter_medlem(:'org', 'regn-nullstill@test.no', 'regnskap') as t_regn \gset
select id as u_regn from faktura.registrer_bruker('uid-nullstill-regn', 'regn-nullstill@test.no') \gset
select set_config('app.bruker_id', :'u_regn', false);
select faktura.aksepter_invitasjon(:'t_regn');
select set_config('app.bruker_id', :'u', false);

-- Den første meldingen avvises; den neste erstatter den ikke (en avvist melding er ikke mottatt).
select * from faktura.bestill_amelding(:'org', '2026-10-01', 'api') \gset m1_
\c :worker
update faktura.ameldinger set status = 'avvist', sendt_at = now() - interval '3 hours' where id = :'m1_id';
\c :api
select set_config('app.bruker_id', :'u', false);
select * from faktura.bestill_amelding(:'org', '2026-10-01', 'api') \gset m2_
select test.er((select erstatter from faktura.ameldinger where id = :'m2_id'), null::text, 'erstatter ikke den avviste');
\c :worker
update faktura.ameldinger set status = 'mottatt', sendt_at = now() - interval '2 hours' where id = :'m2_id';
-- En melding uten erstatning (som da appen trodde den mottatte var avvist): måneden er rapportert dobbelt.
\c :api
select set_config('app.bruker_id', :'u', false);
select * from faktura.bestill_amelding(:'org', '2026-10-01', 'api', false) \gset m3_
\c :worker
update faktura.ameldinger set status = 'mottatt', sendt_at = now() - interval '1 hour' where id = :'m3_id';
\c :api
select set_config('app.bruker_id', :'u_regn', false);
-- De som ser lønnen, ser hva som gjelder.
select test.er((select count(*)::int from faktura.ameldinger a where org_id = :'org' and status in ('levert', 'sendt', 'mottatt')
                  and faktura.amelding_erstattet_av(a.org_id, a.maaned, a.meldings_id) is null), 2, 'to meldinger gjelder');
select test.er(faktura.amelding_erstattet_av(:'org', '2026-10-01', :'m1_meldings_id'), null::uuid, 'den avviste er ikke erstattet');

-- Bare eier og administrator nullstiller, og bare en melding som gjelder.
select test.feiler(format($$select faktura.nullstill_amelding(%L, %L, 'api')$$, :'org', :'m2_id'), 'FA403');
select set_config('app.bruker_id', :'u', false);
select test.feiler(format($$select faktura.nullstill_amelding(%L, %L, 'post')$$, :'org', :'m2_id'), 'FA400');
select test.feiler(format($$select faktura.nullstill_amelding(%L, %L, 'api')$$, :'org', gen_random_uuid()), 'FA404');
select test.feiler(format($$select faktura.nullstill_amelding(%L, %L, 'api')$$, :'org', :'m1_id'), 'FA409');
-- Hjelpefunksjonen for det som pågår, er bare for databasefunksjonene.
select test.feiler(format($$select faktura.amelding_pagar(%L, '2026-10-01')$$, :'org'), '42501');

-- Nullstillingen: en 0-melding som erstatter den mottatte meldingen.
select * from faktura.nullstill_amelding(:'org', :'m2_id', 'api') \gset n1_
select test.er(:'n1_nullstilling', 't', 'en nullstilling');
select test.er(:'n1_erstatter', :'m2_meldings_id', 'erstatter den første mottatte');
select test.er(:'n1_status', 'lages', 'workeren lager den');
select test.er(:'n1_maaned', '2026-10-01', 'samme måned');
-- Mens den lages, får måneden ikke en ny melding eller en ny nullstilling.
select test.feiler(format($$select faktura.nullstill_amelding(%L, %L, 'api')$$, :'org', :'m3_id'), 'FA409');
select test.feiler(format($$select faktura.bestill_amelding(%L, '2026-10-01', 'api')$$, :'org'), 'FA409');
\c :worker
update faktura.ameldinger set status = 'mottatt', sendt_at = now() - interval '3 days' where id = :'n1_id';
\c :api
select set_config('app.bruker_id', :'u', false);
select test.er(faktura.amelding_erstattet_av(:'org', '2026-10-01', :'m2_meldings_id'), :'n1_id'::uuid, 'den første er nullstilt');
-- Den nullstilte meldingen og nullstillingen selv kan ikke nullstilles.
select test.feiler(format($$select faktura.nullstill_amelding(%L, %L, 'api')$$, :'org', :'m2_id'), 'FA409');
select test.feiler(format($$select faktura.nullstill_amelding(%L, %L, 'api')$$, :'org', :'n1_id'), 'FA409');

-- En ny melding erstatter den siste med innhold som gjelder (ikke nullstillingen).
select * from faktura.bestill_amelding(:'org', '2026-10-01', 'fil') \gset m4_
select test.er(:'m4_erstatter', :'m3_meldings_id', 'erstatter den som gjelder');
\c :worker
update faktura.ameldinger set status = 'feil', feil = 'Prøvde' where id = :'m4_id';

-- En nullstilling som avvises, erstatter ingenting: meldingen gjelder fortsatt og kan nullstilles igjen.
\c :api
select set_config('app.bruker_id', :'u', false);
select * from faktura.nullstill_amelding(:'org', :'m3_id', 'fil') \gset n2_
select test.er(:'n2_innsending', 'fil', 'som fil');
\c :worker
update faktura.ameldinger set status = 'avvist' where id = :'n2_id';
\c :api
select set_config('app.bruker_id', :'u', false);
select test.er(faktura.amelding_erstattet_av(:'org', '2026-10-01', :'m3_meldings_id'), null::uuid, 'avvist nullstilling erstatter ingenting');
select * from faktura.nullstill_amelding(:'org', :'m3_id', 'fil') \gset n3_
-- En fil som er lastet opp, gjelder: da er meldingen erstattet.
\c :worker
update faktura.ameldinger set status = 'klar', fil_sti = 'amelding/n3.xml' where id = :'n3_id';
\c :api
select set_config('app.bruker_id', :'u', false);
select test.er(faktura.amelding_erstattet_av(:'org', '2026-10-01', :'m3_meldings_id'), null::uuid, 'fila er ikke lastet opp ennå');
select faktura.amelding_levert(:'org', :'n3_id', true);
select test.er(faktura.amelding_erstattet_av(:'org', '2026-10-01', :'m3_meldings_id'), :'n3_id'::uuid, 'nullstilt med fila');
-- Bare nullstillinger gjelder nå: en ny melding erstatter ingen av dem.
select * from faktura.bestill_amelding(:'org', '2026-10-01', 'fil') \gset m5_
select test.er((select erstatter from faktura.ameldinger where id = :'m5_id'), null::text, 'ingen melding med innhold gjelder');

\c :migrator
drop schema test cascade;
\echo '  ok'
