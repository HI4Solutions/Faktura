-- 0110_moduler.sql
-- Fire moduler som plattformadministratoren gir organisasjonene tilgang til: Faktura, Personal,
-- Lønn og Regnskap (Plattform → Organisasjoner, i organisasjonen). Bemanning (0044) deles i
-- Personal (ansatte og timer, vaktplan) og Lønn, og Faktura blir en modul som kan slås av:
-- fakturaene, kundene og produktene er nå funksjonen «faktura», som de andre fakturafunksjonene
-- bygger på (som vaktplanen bygger på ansatte og timer).
--
-- Hver modul har en kjerne, funksjonen modulen står og faller med: faktura, ansatte, lonn og
-- regnskap. Modulen er på når kjernen er på; funksjonene i modulen slås av og på som før. Lønn
-- bygger på Personal (lønnen regnes ut fra de ansatte og timene).
--
-- De som finnes fra før, beholder alt: organisasjonene får fakturaene slått på, og brukerne som
-- ba om Bemanning, får Personal og Lønn.

-- ---------------------------------------------------------------------------
-- Modulene
-- ---------------------------------------------------------------------------

alter table faktura.moduler add column krever text references faktura.moduler(kode);

insert into faktura.moduler (kode, navn, beskrivelse, rekkefolge) values
  ('personal', 'Personal', 'Ansatte og timeføring, vaktplan og turnus, tavle, fravær og vikarer, ferie og bemanningskalender', 2),
  ('lonn', 'Lønn', 'Lønnskjøring og lønnsslipper, skattekort, a-melding, reiser og utlegg, sykepenger og refusjon fra NAV', 3);
update faktura.moduler set krever = 'personal' where kode = 'lonn';
update faktura.moduler set rekkefolge = 4 where kode = 'regnskap';
update faktura.moduler
   set beskrivelse = 'Fakturaer og kreditnotaer, kunder og produkter, EHF, innbetalinger fra banken, gjentakende fakturaer, påminnelser og rapporter'
 where kode = 'faktura';

update faktura.funksjoner set modul = 'personal' where kode in ('ansatte', 'vaktplan');
update faktura.funksjoner set modul = 'lonn' where kode = 'lonn';

-- De som ba om (eller fikk) Bemanning, har Personal og Lønn.
insert into faktura.bruker_moduler (bruker_id, modul)
select b.bruker_id, m.kode from faktura.bruker_moduler b cross join (values ('personal'), ('lonn')) m (kode)
 where b.modul = 'bemanning'
on conflict do nothing;
delete from faktura.moduler where kode = 'bemanning';

-- ---------------------------------------------------------------------------
-- Fakturaene som funksjon, og kjernen i hver modul
-- ---------------------------------------------------------------------------

insert into faktura.funksjoner (kode, navn, beskrivelse, rekkefolge, krever, modul, standard)
values ('faktura', 'Fakturaer', 'Fakturaer og kreditnotaer, kunder og produkter', 0, null, 'faktura', true);
insert into faktura.org_funksjoner (org_id, kode, aktiv)
select o.id, 'faktura', true from faktura.organisasjoner o
on conflict do nothing;

-- Fakturafunksjonene bygger på fakturaene. Bank, AI og import brukes også av de andre modulene
-- (banken av regnskapet, importen til de ansatte), så de står for seg selv.
update faktura.funksjoner set krever = 'faktura' where kode in ('ehf', 'gjentakende', 'flere', 'paaminnelser', 'rapporter', 'google_disk');

alter table faktura.moduler add column kjerne text references faktura.funksjoner(kode);
update faktura.moduler m
   set kjerne = case m.kode when 'faktura' then 'faktura' when 'personal' then 'ansatte' when 'lonn' then 'lonn' when 'regnskap' then 'regnskap' end;
alter table faktura.moduler alter column kjerne set not null;

-- Om organisasjonen har modulen (kjernen er på, og modulen den bygger på).
create function faktura.har_modul(_org uuid, _modul text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select faktura.har_funksjon(_org, m.kjerne)
                          and (m.krever is null or faktura.har_funksjon(_org, (select k.kjerne from faktura.moduler k where k.kode = m.krever)))
                     from faktura.moduler m where m.kode = _modul), false)
$$;

-- Modulene organisasjonen har (for appen og API-et).
create function faktura.org_modulliste(_org uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(m.kode order by m.rekkefolge), '{}') from faktura.moduler m where faktura.har_modul(_org, m.kode)
$$;

revoke all on function faktura.har_modul(uuid, text), faktura.org_modulliste(uuid) from public;
grant execute on function faktura.har_modul(uuid, text), faktura.org_modulliste(uuid) to faktura_app, faktura_system;

-- Modulene en bruker godkjennes med: med modulen de bygger på (Lønn tar med Personal).
create or replace function faktura.sett_bruker_moduler(_bruker uuid, _moduler text[]) returns text[]
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(cardinality(_moduler), 0) = 0 then raise exception 'Velg minst én modul' using errcode = 'FA400'; end if;
  if exists (select 1 from unnest(_moduler) k where k not in (select kode from faktura.moduler)) then
    raise exception 'Ukjent modul' using errcode = 'FA400';
  end if;
  _moduler := _moduler || coalesce((select array_agg(m.krever) from faktura.moduler m where m.kode = any (_moduler) and m.krever is not null), '{}');
  delete from faktura.bruker_moduler where bruker_id = _bruker and modul <> all (_moduler);
  insert into faktura.bruker_moduler (bruker_id, modul) select _bruker, k from unnest(_moduler) k on conflict do nothing;
  return faktura.bruker_modulliste(_bruker);
end $$;
revoke all on function faktura.sett_bruker_moduler(uuid, text[]) from public;

-- Funksjonsoversikten i administrasjonen (som i 0046): modulene med kjernen og hva de bygger på.
create or replace function faktura.admin_funksjoner() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  return jsonb_build_object(
    'moduler', (select coalesce(jsonb_agg(jsonb_build_object('kode', m.kode, 'navn', m.navn, 'beskrivelse', m.beskrivelse,
                                                              'kjerne', m.kjerne, 'krever', m.krever) order by m.rekkefolge), '[]'::jsonb)
                  from faktura.moduler m),
    'funksjoner', (select coalesce(jsonb_agg(jsonb_build_object('kode', f.kode, 'navn', f.navn, 'beskrivelse', f.beskrivelse, 'krever', f.krever,
                                                                 'standard', f.standard, 'modul', f.modul) order by m.rekkefolge, f.rekkefolge), '[]'::jsonb)
                     from faktura.funksjoner f join faktura.moduler m on m.kode = f.modul),
    'organisasjoner', (select coalesce(jsonb_agg(jsonb_build_object(
                                 'id', o.id, 'navn', o.navn, 'orgnr', o.orgnr, 'type', o.type, 'verifisering', o.verifisering,
                                 'aktive', (select coalesce(jsonb_agg(x.kode order by f.rekkefolge), '[]'::jsonb)
                                              from faktura.org_funksjoner x join faktura.funksjoner f on f.kode = x.kode
                                             where x.org_id = o.id and x.aktiv),
                                 'endret', (select max(x.endret) from faktura.org_funksjoner x where x.org_id = o.id and x.endret_av is not null))
                               order by o.navn), '[]'::jsonb)
                         from faktura.organisasjoner o where o.slettet_at is null)
  );
end $$;

-- Funksjonslista til en organisasjon som ikke finnes (slettet), er null, så API-et ikke svarer at
-- fakturaene er slått av (de er en funksjon nå): da avgjør tilgangen at det ikke er noe å se, som
-- før (funksjoner.ts).
create or replace function faktura.org_funksjonsliste(_org uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select case when exists (select 1 from faktura.organisasjoner x where x.id = _org)
              then coalesce((select array_agg(f.kode order by f.rekkefolge) from faktura.funksjoner f where faktura.har_funksjon(_org, f.kode)), '{}') end
$$;
