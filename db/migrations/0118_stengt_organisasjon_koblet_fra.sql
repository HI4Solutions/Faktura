-- En organisasjon som stenges (slett_organisasjon når regnskapsmaterialet skal oppbevares), kobles
-- også fra Skatteetaten, Altinn og NAV, som «Koble fra» i innstillingene: tilgangen slettes, så
-- ingen bakgrunnsjobb henter skattekort, sykmeldinger, krav eller frister for den. Systembrukeren i
-- Altinn fjerner kunden selv. Organisasjoner som er stengt fra før, kobles fra nederst.

create or replace function faktura.slett_organisasjon(_org uuid, _grunn text)
returns faktura.slettede_organisasjoner
language plpgsql security definer set search_path = '' as $$
declare
  o faktura.organisasjoner;
  logg faktura.slettede_organisasjoner;
  _antall int;
  _siste date;
  _lonn int;
  _siste_lonn date;
  _bilag int;
  _siste_bilag date;
  _plattform boolean := faktura.er_betrodd();
  _meg faktura.brukere;
begin
  select * into o from faktura.organisasjoner where id = _org for update;
  if not found or o.slettet_at is not null then raise exception 'Fant ikke organisasjonen' using errcode = 'FA404'; end if;
  if not _plattform and faktura.rolle(_org) is distinct from 'eier' then
    raise exception 'Bare eieren kan slette organisasjonen' using errcode = 'FA403';
  end if;
  if length(btrim(coalesce(_grunn, ''))) < 3 then raise exception 'Skriv hvorfor organisasjonen slettes' using errcode = 'FA400'; end if;
  select * into _meg from faktura.brukere where id = faktura.bruker_id();

  select count(*), max(fakturadato) into _antall, _siste from faktura.fakturaer where org_id = _org and fakturanummer is not null;
  select count(*), max(utbetalingsdato) into _lonn, _siste_lonn from faktura.lonnskjoringer where org_id = _org and status = 'godkjent';
  select count(*), max(dato) into _bilag, _siste_bilag from faktura.bilag where org_id = _org;
  insert into faktura.slettede_organisasjoner (id, navn, orgnr, type, slettet_av, slettet_av_navn, slettet_av_epost, av_plattformen, grunn,
                                               antall_fakturaer, oppbevares_til)
  values (o.id, o.navn, o.orgnr, o.type, _meg.id, _meg.navn, _meg.epost, _plattform, btrim(_grunn), _antall,
          case when _antall > 0 or _lonn > 0 or _bilag > 0
               then make_date(extract(year from greatest(_siste, _siste_lonn, _siste_bilag))::int + 5, 12, 31) end)
  returning * into logg;

  if _antall = 0 and _lonn = 0 and _bilag = 0 then
    -- Uten regnskapsmateriale slettes alt. Filene (vedlegg og logo) ryddes av workeren.
    if o.logo_sti is not null then insert into faktura.slettede_filer (sti) values (o.logo_sti) on conflict do nothing; end if;
    delete from faktura.vedlegg where org_id = _org;
    delete from faktura.fakturaer where org_id = _org;  -- bare utkast
    delete from faktura.gjentakelser where org_id = _org;
    delete from faktura.kunder where org_id = _org;
    delete from faktura.produkter where org_id = _org;
    delete from faktura.lonnskjoringer where org_id = _org;  -- bare utkast (slippene før de ansatte)
    delete from faktura.organisasjoner where id = _org;
    delete from faktura.revisjonslogg where org_id = _org;
  else
    -- Stenges: ingen tilgang og ingenting sendes; regnskapsmaterialet oppbevares.
    update faktura.organisasjoner
       set slettet_at = now(), slettet_av = _meg.id, slettet_grunn = btrim(_grunn), oppbevares_til = logg.oppbevares_til, purring_auto = false
     where id = _org;
    delete from faktura.fakturaer where org_id = _org and status = 'utkast';
    delete from faktura.vedlegg where org_id = _org and faktura_id is null;
    delete from faktura.lonnskjoringer where org_id = _org and status = 'utkast';
    update faktura.gjentakelser set aktiv = false where org_id = _org and aktiv;
    update faktura.paaminnelser set aktiv = false where org_id = _org and aktiv;
    delete from faktura.invitasjoner where org_id = _org;
    delete from faktura.org_tilgang where klient_org_id = _org or byraa_org_id = _org;
    delete from faktura.medlemmer where org_id = _org;
    -- Koblet fra Skatteetaten, Altinn og NAV (som «Koble fra»).
    delete from faktura.skattekort_tilgang where org_id = _org;
  end if;
  return logg;
end $$;

delete from faktura.skattekort_tilgang t
 using faktura.organisasjoner o
 where o.id = t.org_id and o.slettet_at is not null;
