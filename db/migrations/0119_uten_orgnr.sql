-- 0119_uten_orgnr.sql
-- Organisasjoner uten organisasjonsnummer (privatpersoner, og foretak som ikke har lagt det inn)
-- har bare fakturaene: funksjonene i Faktura-modulen, men ikke EHF (Peppol krever
-- organisasjonsnummer). Personal, Lønn og Regnskap krever organisasjonsnummer.
--
-- Regelen ligger i har_funksjon, så appen (mine_organisasjoner), API-et (funksjoner.ts),
-- modulene (har_modul) og bakgrunnsjobbene følger den. Det som er slått på i Administrasjon,
-- virker straks organisasjonsnummeret er lagt inn (legg_inn_orgnr). En privatperson som får
-- organisasjonsnummer (f.eks. et enkeltpersonforetak), blir da foretak.

-- ---------------------------------------------------------------------------
-- Funksjonene som virker uten organisasjonsnummer
-- ---------------------------------------------------------------------------

alter table faktura.funksjoner add column uten_orgnr boolean not null default false;
comment on column faktura.funksjoner.uten_orgnr is
  'Virker uten organisasjonsnummer (privatperson): fakturaene og det som hører til dem, ikke EHF';
update faktura.funksjoner set uten_orgnr = true where modul = 'faktura' and kode <> 'ehf';

-- Som i 0046 (stengt organisasjon: ingen funksjoner), og uten organisasjonsnummer bare
-- funksjonene som virker uten.
create or replace function faktura.har_funksjon(_org uuid, _kode text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select x.slettet_at is null
                          and (x.orgnr is not null or f.uten_orgnr)
                          and o.aktiv
                          and (f.krever is null
                               or coalesce((select k.aktiv from faktura.org_funksjoner k where k.org_id = _org and k.kode = f.krever), false))
                     from faktura.organisasjoner x
                     join faktura.org_funksjoner o on o.org_id = x.id and o.kode = _kode
                     join faktura.funksjoner f on f.kode = o.kode
                    where x.id = _org), false)
$$;

-- Funksjonsoversikten i administrasjonen (som i 0110), med hvilke funksjoner som virker uten
-- organisasjonsnummer.
create or replace function faktura.admin_funksjoner() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not faktura.er_betrodd() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  return jsonb_build_object(
    'moduler', (select coalesce(jsonb_agg(jsonb_build_object('kode', m.kode, 'navn', m.navn, 'beskrivelse', m.beskrivelse,
                                                              'kjerne', m.kjerne, 'krever', m.krever) order by m.rekkefolge), '[]'::jsonb)
                  from faktura.moduler m),
    'funksjoner', (select coalesce(jsonb_agg(jsonb_build_object('kode', f.kode, 'navn', f.navn, 'beskrivelse', f.beskrivelse, 'krever', f.krever,
                                                                 'standard', f.standard, 'modul', f.modul, 'uten_orgnr', f.uten_orgnr)
                                             order by m.rekkefolge, f.rekkefolge), '[]'::jsonb)
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

-- ---------------------------------------------------------------------------
-- Organisasjonsnummeret legges inn senere
-- ---------------------------------------------------------------------------

-- Som i 0002, men en privatperson blir foretak når organisasjonsnummeret legges inn
-- (legg_inn_orgnr; appen kan ikke endre typen selv).
create or replace function faktura.org_foer_endring() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.orgnr is distinct from old.orgnr and old.verifisering = 'verifisert' then
    raise exception 'Organisasjonsnummeret kan ikke endres etter verifisering' using errcode = 'FA409';
  end if;
  if new.type is distinct from old.type
     and not (old.type = 'privatperson' and new.type = 'foretak' and new.orgnr is not null) then
    raise exception 'Organisasjonstypen kan ikke endres' using errcode = 'FA400';
  end if;
  return new;
end $$;

-- Eier og administrator legger inn organisasjonsnummeret når det mangler, og en privatperson blir
-- da foretak (f.eks. et nytt enkeltpersonforetak). Uten organisasjonsnummer kan ingen være
-- verifisert (sett_verifisering), så det er foretaket som verifiseres etterpå.
create function faktura.legg_inn_orgnr(_org uuid, _orgnr text) returns faktura.organisasjoner
language plpgsql security definer set search_path = '' as $$
declare
  o faktura.organisasjoner;
begin
  perform faktura.krev(_org, 'admin');
  if _orgnr is null or not faktura.orgnr_gyldig(_orgnr) then
    raise exception 'Ugyldig organisasjonsnummer' using errcode = 'FA400';
  end if;
  select * into o from faktura.organisasjoner where id = _org and slettet_at is null for update;
  if o.id is null then
    raise exception 'Fant ikke organisasjonen' using errcode = 'FA404';
  end if;
  if o.orgnr is not null then
    raise exception 'Organisasjonen har organisasjonsnummer fra før' using errcode = 'FA409';
  end if;
  update faktura.organisasjoner
     set type = case when type = 'privatperson' then 'foretak' else type end,
         orgnr = _orgnr
   where id = _org
  returning * into o;
  return o;
end $$;
revoke all on function faktura.legg_inn_orgnr(uuid, text) from public;
grant execute on function faktura.legg_inn_orgnr(uuid, text) to faktura_app;
