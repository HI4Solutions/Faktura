-- 0124_slett_utlopt.sql
-- Regnskapsmaterialet i stengte organisasjoner slettes når oppbevaringstiden er ute.
--
-- En organisasjon med utstedte fakturaer, godkjente lønnskjøringer eller bilag stenges i stedet for
-- å slettes (slett_organisasjon, 0118), og materialet oppbevares til oppbevares_til: 31.12. fem år
-- etter det siste (bokføringsloven § 13). Etter det sletter workeren organisasjonen helt hver
-- morgen (server/src/oppbevaring.ts): fakturaene, bilagene, lønnen, de ansatte og alt annet,
-- revisjonsloggen og utboksen. Raden i slettede_organisasjoner blir stående som logg over
-- slettingen, uten navnet og e-postadressen til den som slettet (og uten navnet når det var en
-- privatperson). Filene i Cloud Storage slettes etterpå; bøttas oppbevaringsregel (seks år fra
-- hver fil ble laget) kan holde dem litt lenger, og da prøver workeren igjen neste morgen til de er
-- borte (filer_slettet_at).
--
-- Låsene på bokført materiale (triggerne under) slipper gjennom slettingen når organisasjonen er
-- stengt og oppbevaringstiden er ute; ingen andre har tilgang til en stengt organisasjon.

alter table faktura.slettede_organisasjoner
  add column materiale_slettet_at timestamptz,
  add column filer_slettet_at timestamptz;

-- Organisasjonen er stengt og oppbevaringstiden er ute, eller den er allerede slettet (når radene
-- slettes sammen med den).
create function faktura.materiale_kan_slettes(_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (
    select 1 from faktura.organisasjoner o
     where o.id = _org and (o.slettet_at is null or o.oppbevares_til is null or o.oppbevares_til >= faktura.i_dag()))
$$;

-- Låsene på bokført materiale, med unntaket for slettingen (resten som før).

-- Lønnsslippene og -linjene i en godkjent lønnskjøring (som i 0065).
create or replace function faktura.lonn_laast()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  k uuid;
begin
  -- Stengt organisasjon der oppbevaringstiden er ute: regnskapsmaterialet slettes (slett_utlopt_materiale).
  if tg_op <> 'INSERT' and faktura.materiale_kan_slettes(old.org_id) then return coalesce(new, old); end if;
  if tg_table_name = 'lonnsslipper' then
    k := coalesce(new.kjoring_id, old.kjoring_id);
  else
    select s.kjoring_id into k from faktura.lonnsslipper s where s.id = coalesce(new.slipp_id, old.slipp_id);
  end if;
  if exists (select 1 from faktura.lonnskjoringer where id = k and status = 'godkjent') then
    raise exception 'Lønnskjøringen er godkjent og kan ikke endres. Åpne den igjen først.' using errcode = 'FA409';
  end if;
  return coalesce(new, old);
end $$;

-- En bokført utgift (som i 0090).
create or replace function faktura.utgifter_foer()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $$
begin
  -- Stengt organisasjon der oppbevaringstiden er ute: regnskapsmaterialet slettes (slett_utlopt_materiale).
  if tg_op <> 'INSERT' and faktura.materiale_kan_slettes(old.org_id) then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then
    if old.status = 'bokfort' then
      raise exception 'Utgiften er bokført. Angre bokføringen først.' using errcode = 'FA409';
    end if;
    return old;
  end if;
  if old.status = 'bokfort' and new.status = 'bokfort' and coalesce(current_setting('faktura.utgift_funksjon', true), '') <> 'on'
     and (new.type, new.leverandor, new.orgnr, new.fakturanummer, new.dato, new.forfallsdato, new.kid, new.kontonr, new.belop,
          new.valuta, new.beskrivelse, new.betaling, new.betalt_dato, new.behandling, new.anlegg_kategori, new.levetid_mnd,
          new.periode_fra, new.antall_maaneder, new.vurdering, new.utland, new.ai)
         is distinct from
         (old.type, old.leverandor, old.orgnr, old.fakturanummer, old.dato, old.forfallsdato, old.kid, old.kontonr, old.belop,
          old.valuta, old.beskrivelse, old.betaling, old.betalt_dato, old.behandling, old.anlegg_kategori, old.levetid_mnd,
          old.periode_fra, old.antall_maaneder, old.vurdering, old.utland, old.ai) then
    raise exception 'Utgiften er bokført. Angre bokføringen for å endre den.' using errcode = 'FA409';
  end if;
  return new;
end $$;

-- Linjene i en bokført utgift (som i 0090).
create or replace function faktura.utgift_linjer_foer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
begin
  -- Stengt organisasjon der oppbevaringstiden er ute: regnskapsmaterialet slettes (slett_utlopt_materiale).
  if tg_op <> 'INSERT' and faktura.materiale_kan_slettes(old.org_id) then return coalesce(new, old); end if;
  if exists (select 1 from faktura.utgifter where id = coalesce(new.utgift_id, old.utgift_id) and status = 'bokfort') then
    raise exception 'Utgiften er bokført. Angre bokføringen for å endre den.' using errcode = 'FA409';
  end if;
  return coalesce(new, old);
end $$;

-- Et anleggsmiddel med bokførte bilag (som i 0095).
create or replace function faktura.anleggsmidler_foer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  bokfort boolean;
begin
  -- Stengt organisasjon der oppbevaringstiden er ute: regnskapsmaterialet slettes (slett_utlopt_materiale).
  if tg_op <> 'INSERT' and faktura.materiale_kan_slettes(old.org_id) then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('anleggsmidler:' || new.org_id::text, 0));
    new.nummer := coalesce((select max(nummer) from faktura.anleggsmidler where org_id = new.org_id), 0) + 1;
    return new;
  end if;
  bokfort := exists (select 1 from faktura.anleggshendelser where anleggsmiddel_id = old.id and not reversert);
  if tg_op = 'DELETE' then
    if bokfort then
      raise exception 'Anleggsmiddelet har bokførte bilag. Reverser dem først, eller registrer salg eller utrangering.' using errcode = 'FA409';
    end if;
    if exists (select 1 from faktura.mva_justeringslinjer l join faktura.bilag b on b.id = l.bilag_id
                where l.anleggsmiddel_id = old.id and b.reverserer is null and b.reversert_av is null) then
      raise exception 'Anleggsmiddelet har en bokført mva-justering. Angre den først (Regnskap → Mva).' using errcode = 'FA409';
    end if;
    return old;
  end if;
  new.nummer := old.nummer;
  if bokfort and (new.kategori, new.kostpris, new.anskaffet, new.avskrives_fra, new.konto, new.tidligere_til, new.tidligere_avskrevet)
                 is distinct from (old.kategori, old.kostpris, old.anskaffet, old.avskrives_fra, old.konto, old.tidligere_til, old.tidligere_avskrevet) then
    raise exception 'Anleggsmiddelet har bokførte bilag: kategorien, kostprisen, datoene og kontoen kan ikke endres. Reverser bilagene først, eller bruk nedskrivning.'
      using errcode = 'FA409';
  end if;
  if old.avgang_dato is not null and new.avgang_dato is not null
     and (new.levetid_mnd, new.restverdi, new.avskrivningskonto, new.mva_inngaende, new.mva_fradrag, new.mva_felles, new.mva_bruk)
         is distinct from (old.levetid_mnd, old.restverdi, old.avskrivningskonto, old.mva_inngaende, old.mva_fradrag, old.mva_felles, old.mva_bruk) then
    raise exception 'Anleggsmiddelet er solgt eller utrangert' using errcode = 'FA409';
  end if;
  return new;
end $$;

-- En periodisering med bokførte bilag (som i 0087).
create or replace function faktura.periodiseringer_foer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  bokfort boolean;
  sist date;
begin
  -- Stengt organisasjon der oppbevaringstiden er ute: regnskapsmaterialet slettes (slett_utlopt_materiale).
  if tg_op <> 'INSERT' and faktura.materiale_kan_slettes(old.org_id) then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('periodiseringer:' || new.org_id::text, 0));
    new.nummer := coalesce((select max(nummer) from faktura.periodiseringer where org_id = new.org_id), 0) + 1;
    return new;
  end if;
  bokfort := exists (select 1 from faktura.periodiseringsposter where periodisering_id = old.id and not reversert);
  if tg_op = 'DELETE' then
    if bokfort then
      raise exception 'Periodiseringen har bokførte bilag. Reverser dem først.' using errcode = 'FA409';
    end if;
    return old;
  end if;
  new.nummer := old.nummer;
  if bokfort and (new.type, new.belop, new.fra, new.resultatkonto, new.balansekonto, new.start)
                 is distinct from (old.type, old.belop, old.fra, old.resultatkonto, old.balansekonto, old.start) then
    raise exception 'Periodiseringen har bokførte bilag: typen, beløpet, den første måneden, kontoene og starten kan ikke endres. Reverser bilagene først.'
      using errcode = 'FA409';
  end if;
  select max(maaned) into sist from faktura.periodiseringsposter where periodisering_id = old.id and type = 'maaned' and not reversert;
  if sist is not null and (new.fra + make_interval(months => new.antall_maaneder - 1))::date < sist then
    raise exception 'Månedene som er bokført, må være med i periodiseringen' using errcode = 'FA409';
  end if;
  return new;
end $$;

-- Sletter alt om en stengt organisasjon når oppbevaringstiden er ute (bare workeren). Det som
-- viser til fakturaene og bilagene, slettes før dem, og slippene før de ansatte; resten følger
-- organisasjonen.
create function faktura.slett_utlopt_materiale(_org uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o faktura.organisasjoner;
  _fakturaer int;
  _bilag int;
  _lonn int;
begin
  if not faktura.er_system() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  select * into o from faktura.organisasjoner where id = _org for update;
  if not found then raise exception 'Fant ikke organisasjonen' using errcode = 'FA404'; end if;
  if not faktura.materiale_kan_slettes(_org) then
    raise exception 'Oppbevaringstiden for % er ikke ute', o.navn using errcode = 'FA409';
  end if;
  select count(*) into _fakturaer from faktura.fakturaer where org_id = _org and fakturanummer is not null;
  select count(*) into _bilag from faktura.bilag where org_id = _org;
  select count(*) into _lonn from faktura.lonnskjoringer where org_id = _org and status = 'godkjent';

  -- Utstedte fakturaer kan bare slettes av eieren av tabellene, med dette flagget (faktura_laas).
  perform set_config('faktura.sletter', 'on', true);
  delete from faktura.eposter where org_id = _org;
  delete from faktura.purringer where org_id = _org;
  delete from faktura.betalinger where org_id = _org;
  delete from faktura.fakturaer where org_id = _org;
  delete from faktura.vedlegg where org_id = _org;
  delete from faktura.gjentakelser where org_id = _org;
  delete from faktura.kunder where org_id = _org;
  delete from faktura.produkter where org_id = _org;
  delete from faktura.lonnskjoringer where org_id = _org;
  delete from faktura.yrkesskader where org_id = _org;
  delete from faktura.nav_refusjoner where org_id = _org;
  delete from faktura.afp_premier where org_id = _org;
  delete from faktura.bankposter where org_id = _org;
  delete from faktura.mva_justeringer where org_id = _org;
  delete from faktura.utgifter where org_id = _org;
  delete from faktura.anleggsmidler where org_id = _org;
  delete from faktura.periodiseringer where org_id = _org;
  delete from faktura.bilag where org_id = _org;
  delete from faktura.organisasjoner where id = _org;
  delete from faktura.revisjonslogg where org_id = _org;
  delete from faktura.utboks where org_id = _org;

  update faktura.slettede_organisasjoner
     set materiale_slettet_at = now(), slettet_av_navn = null, slettet_av_epost = null,
         navn = case when type = 'privatperson' then 'Privatperson' else navn end
   where id = _org;
  return jsonb_build_object('navn', o.navn, 'fakturaer', _fakturaer, 'bilag', _bilag, 'lonnskjoringer', _lonn);
end $$;

-- De stengte organisasjonene der oppbevaringstiden er ute (bare workeren).
create function faktura.utlopt_materiale(_antall int default 20) returns setof uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  if not faktura.er_system() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  return query
  select o.id from faktura.organisasjoner o
   where o.slettet_at is not null and o.oppbevares_til < faktura.i_dag()
   order by o.oppbevares_til, o.id
   limit _antall;
end $$;

-- Slettede organisasjoner der filene i Cloud Storage ikke er borte ennå: de der materialet er
-- slettet, og de som ble slettet helt med en gang (uten noe å oppbevare). Bare workeren.
create function faktura.filer_til_sletting(_antall int default 50) returns setof uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  if not faktura.er_system() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  return query
  select s.id from faktura.slettede_organisasjoner s
   where s.filer_slettet_at is null
     and (s.materiale_slettet_at is not null or s.oppbevares_til is null)
     and not exists (select 1 from faktura.organisasjoner o where o.id = s.id)
   order by s.slettet_at, s.id
   limit _antall;
end $$;

-- Filene er borte. Hendelsene i utboksen for organisasjonen slettes samtidig: de har ingen mottaker
-- lenger, og slett_organisasjon lar dem ligge når den sletter alt med en gang.
create function faktura.filer_slettet(_org uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not faktura.er_system() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  if exists (select 1 from faktura.organisasjoner where id = _org) then
    raise exception 'Organisasjonen er ikke slettet' using errcode = 'FA409';
  end if;
  delete from faktura.utboks where org_id = _org;
  update faktura.slettede_organisasjoner set filer_slettet_at = now() where id = _org;
end $$;

revoke all on function faktura.materiale_kan_slettes(uuid), faktura.slett_utlopt_materiale(uuid),
  faktura.utlopt_materiale(int), faktura.filer_til_sletting(int), faktura.filer_slettet(uuid) from public;
-- Låsene kjører som den som endrer (utgifter_foer er ikke security definer).
grant execute on function faktura.materiale_kan_slettes(uuid) to faktura_app, faktura_system;
grant execute on function faktura.slett_utlopt_materiale(uuid), faktura.utlopt_materiale(int),
  faktura.filer_til_sletting(int), faktura.filer_slettet(uuid) to faktura_system;
