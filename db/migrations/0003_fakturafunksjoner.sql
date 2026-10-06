-- 0003_fakturafunksjoner.sql
-- Skrivingene som må være riktige hver gang: utstedelse med nummerserie,
-- kreditering (hel eller delvis), betaling, refusjon og gjentakelser.
-- Alle låser fakturaraden og gjør alt i én transaksjon. De kjører med eierens
-- rettigheter (security definer) og sjekker selv tilgangen med faktura.kan().

-- ---------------------------------------------------------------------------
-- Brukere og organisasjoner
-- ---------------------------------------------------------------------------

-- Kalles av API-et etter at Identity Platform-tokenet er verifisert.
create function faktura.registrer_bruker(_ekstern_id text, _epost text, _navn text default null)
returns faktura.brukere
language plpgsql security definer set search_path = '' as $$
declare
  b faktura.brukere;
begin
  insert into faktura.brukere (ekstern_id, epost, navn)
  values (_ekstern_id, lower(btrim(_epost)), _navn)
  on conflict (ekstern_id) do update
     set epost = excluded.epost,
         navn = coalesce(excluded.navn, faktura.brukere.navn)
  returning * into b;
  return b;
end $$;

create function faktura.opprett_organisasjon(_navn text, _orgnr text default null, _type text default 'foretak')
returns faktura.organisasjoner
language plpgsql security definer set search_path = '' as $$
declare
  o faktura.organisasjoner;
  bruker uuid := faktura.bruker_id();
begin
  if bruker is null then raise exception 'Ikke innlogget' using errcode = 'FA403'; end if;
  if _orgnr is not null and not faktura.orgnr_gyldig(_orgnr) then
    raise exception 'Ugyldig organisasjonsnummer' using errcode = 'FA400';
  end if;
  -- Misbruksvern: maks fem uverifiserte organisasjoner per bruker.
  if (select count(*) from faktura.organisasjoner
       where opprettet_av = bruker and verifisering = 'ny') >= 5 then
    raise exception 'Du har for mange uverifiserte organisasjoner' using errcode = 'FA429';
  end if;

  insert into faktura.organisasjoner (navn, orgnr, type, opprettet_av)
  values (btrim(_navn), _orgnr, _type, bruker)
  returning * into o;
  insert into faktura.nummerserier (org_id) values (o.id);
  insert into faktura.medlemmer (org_id, bruker_id, rolle) values (o.id, bruker, 'eier');
  return o;
end $$;

-- Startnummeret for fakturaer kan settes fritt til første faktura er utstedt.
create function faktura.sett_startnummer(_org uuid, _neste_fakturanummer bigint)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform faktura.krev(_org, 'admin');
  if exists (select 1 from faktura.fakturaer where org_id = _org and fakturanummer is not null) then
    raise exception 'Nummerserien kan ikke endres etter at første faktura er utstedt' using errcode = 'FA409';
  end if;
  update faktura.nummerserier set neste_fakturanummer = _neste_fakturanummer where org_id = _org;
end $$;

-- Settes bare av workeren etter Brønnøysund-sjekk og verifiseringsflyt, eller av
-- plattformens egne administratorer.
create function faktura.sett_verifisering(_org uuid, _status text, _metode text default null, _grunn text default null)
returns faktura.organisasjoner
language plpgsql security definer set search_path = '' as $$
declare
  o faktura.organisasjoner;
begin
  if not faktura.er_system() then raise exception 'Ingen tilgang' using errcode = 'FA403'; end if;
  update faktura.organisasjoner
     set verifisering = _status,
         verifisert_at = case when _status = 'verifisert' then now() else verifisert_at end,
         verifisert_metode = case when _status = 'verifisert' then _metode else verifisert_metode end,
         sperret_grunn = case when _status = 'sperret' then _grunn end,
         -- Verifiserte organisasjoner får standardgrensene fjernet.
         maks_fakturaer_mnd = case when _status = 'verifisert' then null else maks_fakturaer_mnd end,
         maks_belop_mnd = case when _status = 'verifisert' then null else maks_belop_mnd end
   where id = _org
  returning * into o;
  if not found then raise exception 'Fant ikke organisasjonen' using errcode = 'FA404'; end if;
  return o;
end $$;

-- ---------------------------------------------------------------------------
-- Medlemmer og invitasjoner
-- ---------------------------------------------------------------------------

-- Returnerer lenketokenet én gang; bare hashen lagres.
create function faktura.inviter_medlem(_org uuid, _epost text, _rolle text)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  token text := encode(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()), 'hex');
begin
  perform faktura.krev(_org, 'admin');
  insert into faktura.invitasjoner (org_id, epost, rolle, token_hash, invitert_av)
  values (_org, lower(btrim(_epost)), _rolle, sha256(convert_to(token, 'UTF8')), faktura.bruker_id());
  return token;
end $$;

create function faktura.aksepter_invitasjon(_token text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  inv faktura.invitasjoner;
  bruker faktura.brukere;
begin
  select * into bruker from faktura.brukere where id = faktura.bruker_id();
  if not found then raise exception 'Ikke innlogget' using errcode = 'FA403'; end if;

  select * into inv from faktura.invitasjoner
   where token_hash = sha256(convert_to(_token, 'UTF8')) for update;
  if not found or inv.akseptert_at is not null or inv.utloper < now() then
    raise exception 'Invitasjonen er ugyldig eller utløpt' using errcode = 'FA404';
  end if;
  if inv.epost <> bruker.epost then
    raise exception 'Invitasjonen gjelder en annen e-postadresse' using errcode = 'FA403';
  end if;

  insert into faktura.medlemmer (org_id, bruker_id, rolle) values (inv.org_id, bruker.id, inv.rolle)
  on conflict (org_id, bruker_id) do nothing;
  update faktura.invitasjoner set akseptert_av = bruker.id, akseptert_at = now() where id = inv.id;
  return inv.org_id;
end $$;

create function faktura.endre_rolle(_org uuid, _bruker uuid, _rolle text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform faktura.krev(_org, 'admin');
  if (_rolle = 'eier' or exists (select 1 from faktura.medlemmer
                                  where org_id = _org and bruker_id = _bruker and rolle = 'eier'))
     and not faktura.kan(_org, 'eier') then
    raise exception 'Bare en eier kan gi eller ta eierrollen' using errcode = 'FA403';
  end if;
  update faktura.medlemmer set rolle = _rolle where org_id = _org and bruker_id = _bruker;
  if not found then raise exception 'Fant ikke medlemmet' using errcode = 'FA404'; end if;
  if not exists (select 1 from faktura.medlemmer where org_id = _org and rolle = 'eier') then
    raise exception 'Organisasjonen må ha minst én eier' using errcode = 'FA409';
  end if;
end $$;

create function faktura.fjern_medlem(_org uuid, _bruker uuid)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  -- Alle kan melde seg ut selv; ellers kreves admin (og eier for å fjerne en eier).
  if _bruker <> faktura.bruker_id() then
    perform faktura.krev(_org, 'admin');
    if exists (select 1 from faktura.medlemmer where org_id = _org and bruker_id = _bruker and rolle = 'eier')
       and not faktura.kan(_org, 'eier') then
      raise exception 'Bare en eier kan fjerne en eier' using errcode = 'FA403';
    end if;
  end if;
  delete from faktura.medlemmer where org_id = _org and bruker_id = _bruker;
  if not found then raise exception 'Fant ikke medlemmet' using errcode = 'FA404'; end if;
  if not exists (select 1 from faktura.medlemmer where org_id = _org and rolle = 'eier') then
    raise exception 'Organisasjonen må ha minst én eier' using errcode = 'FA409';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Regnskapsførertilgang
-- ---------------------------------------------------------------------------

-- Kalles av en admin i enten klienten eller byrået. Er det klienten som
-- inviterer, må byrået akseptere, og omvendt. Klienten samtykker alltid.
create function faktura.opprett_tilgang(_min_org uuid, _annen_orgnr text, _rolle text default 'les', _utloper date default null)
returns faktura.org_tilgang
language plpgsql security definer set search_path = '' as $$
declare
  meg faktura.organisasjoner;
  annen faktura.organisasjoner;
  t faktura.org_tilgang;
begin
  perform faktura.krev(_min_org, 'admin');
  select * into meg from faktura.organisasjoner where id = _min_org;
  select * into annen from faktura.organisasjoner
   where orgnr = _annen_orgnr and verifisering = 'verifisert'
     and type = case meg.type when 'regnskapsbyraa' then 'foretak' else 'regnskapsbyraa' end;
  if not found then
    raise exception 'Fant ingen verifisert organisasjon med dette organisasjonsnummeret' using errcode = 'FA404';
  end if;

  insert into faktura.org_tilgang (klient_org_id, byraa_org_id, rolle, status, utloper, opprettet_av)
  values (
    case meg.type when 'regnskapsbyraa' then annen.id else meg.id end,
    case meg.type when 'regnskapsbyraa' then meg.id else annen.id end,
    _rolle,
    case meg.type when 'regnskapsbyraa' then 'forespurt' else 'invitert' end,
    _utloper,
    faktura.bruker_id())
  returning * into t;
  return t;
end $$;

create function faktura.svar_tilgang(_id uuid, _aksepter boolean)
returns faktura.org_tilgang
language plpgsql security definer set search_path = '' as $$
declare
  t faktura.org_tilgang;
begin
  select * into t from faktura.org_tilgang where id = _id for update;
  if not found then raise exception 'Fant ikke tilgangen' using errcode = 'FA404'; end if;
  if t.status = 'invitert' then
    perform faktura.krev(t.byraa_org_id, 'admin');
  elsif t.status = 'forespurt' then
    perform faktura.krev(t.klient_org_id, 'admin');
  else
    raise exception 'Tilgangen er allerede besvart' using errcode = 'FA409';
  end if;
  update faktura.org_tilgang
     set status = case when _aksepter then 'aktiv' else 'avslaatt' end,
         besvart_av = faktura.bruker_id(), besvart_at = now()
   where id = _id
  returning * into t;
  return t;
end $$;

-- Begge sider kan trekke tilgangen når som helst.
create function faktura.trekk_tilgang(_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  t faktura.org_tilgang;
begin
  select * into t from faktura.org_tilgang where id = _id for update;
  if not found then raise exception 'Fant ikke tilgangen' using errcode = 'FA404'; end if;
  if not (faktura.kan(t.klient_org_id, 'admin') or faktura.kan(t.byraa_org_id, 'admin')) then
    raise exception 'Ingen tilgang' using errcode = 'FA403';
  end if;
  update faktura.org_tilgang
     set status = 'trukket', trukket_av = faktura.bruker_id(), trukket_at = now()
   where id = _id and status in ('invitert', 'forespurt', 'aktiv');
end $$;

-- ---------------------------------------------------------------------------
-- Fakturaer
-- ---------------------------------------------------------------------------

-- Gjør et utkast om til en utstedt faktura. Trygg å gjenta: er fakturaen
-- allerede utstedt, returneres den uendret.
create function faktura.utsted(_id uuid)
returns faktura.fakturaer
language plpgsql security definer set search_path = '' as $$
declare
  f faktura.fakturaer;
  o faktura.organisasjoner;
  k faktura.kunder;
  nr bigint;
  dato date;
  s_eks numeric(14,2);
  s_mva numeric(14,2);
  mnd_antall int;
  mnd_belop numeric;
begin
  select * into f from faktura.fakturaer where id = _id for update;
  if not found then raise exception 'Fant ikke fakturaen' using errcode = 'FA404'; end if;
  perform faktura.krev(f.org_id, 'utsted');
  if f.status <> 'utkast' then return f; end if;

  if not exists (select 1 from faktura.faktura_linjer where faktura_id = _id) then
    raise exception 'Fakturaen må ha minst én linje' using errcode = 'FA400';
  end if;

  -- Lås organisasjonen: serialiserer utstedelser og grensesjekken per organisasjon.
  select * into o from faktura.organisasjoner where id = f.org_id for update;
  if o.verifisering = 'sperret' then
    raise exception 'Organisasjonen er sperret' using errcode = 'FA403';
  end if;
  if o.kontonr is null then
    raise exception 'Organisasjonen mangler kontonummer' using errcode = 'FA400';
  end if;

  update faktura.faktura_linjer
     set belop_eks = round(antall * enhetspris, 2),
         mva_belop = round(antall * enhetspris * mva_sats / 100, 2)
   where faktura_id = _id;
  select coalesce(sum(belop_eks), 0), coalesce(sum(mva_belop), 0) into s_eks, s_mva
    from faktura.faktura_linjer where faktura_id = _id;

  if f.type = 'faktura' and s_eks + s_mva < 0 then
    raise exception 'En faktura kan ikke ha negativ sum. Bruk kreditnota.' using errcode = 'FA400';
  end if;

  dato := coalesce(f.fakturadato, faktura.i_dag());

  -- Grenser for organisasjoner som ikke er verifisert ennå.
  if f.type = 'faktura' and (o.maks_fakturaer_mnd is not null or o.maks_belop_mnd is not null) then
    select count(*), coalesce(sum(sum_inkl_mva), 0) into mnd_antall, mnd_belop
      from faktura.fakturaer
     where org_id = f.org_id and type = 'faktura' and status <> 'utkast'
       and fakturadato >= date_trunc('month', dato)::date
       and fakturadato < (date_trunc('month', dato) + interval '1 month')::date;
    if o.maks_fakturaer_mnd is not null and mnd_antall >= o.maks_fakturaer_mnd then
      raise exception 'Grensen på % fakturaer per måned er nådd. Verifiser organisasjonen for å fjerne den.', o.maks_fakturaer_mnd
        using errcode = 'FA429';
    end if;
    if o.maks_belop_mnd is not null and mnd_belop + s_eks + s_mva > o.maks_belop_mnd then
      raise exception 'Grensen på % kr per måned er nådd. Verifiser organisasjonen for å fjerne den.', o.maks_belop_mnd
        using errcode = 'FA429';
    end if;
  end if;

  update faktura.nummerserier
     set neste_fakturanummer = neste_fakturanummer + 1
   where org_id = f.org_id
  returning neste_fakturanummer - 1 into nr;

  select * into k from faktura.kunder where id = f.kunde_id;

  update faktura.fakturaer
     set fakturanummer = nr,
         status = 'utstedt',
         fakturadato = dato,
         forfallsdato = coalesce(f.forfallsdato, dato + o.standard_forfall_dager),
         sum_eks_mva = s_eks,
         mva = s_mva,
         sum_inkl_mva = s_eks + s_mva,
         deres_referanse = coalesce(f.deres_referanse, k.deres_referanse),
         kid = case when o.bruk_kid then faktura.kid(k.kundenummer, nr) end,
         selger = jsonb_build_object(
           'navn', o.navn, 'orgnr', o.orgnr, 'mva_registrert', o.mva_registrert,
           'foretaksregisteret', o.foretaksregisteret, 'adresse', o.adresse, 'postnr', o.postnr,
           'poststed', o.poststed, 'land', o.land, 'telefon', o.telefon, 'epost', o.epost,
           'kontonr', o.kontonr, 'logo_sti', o.logo_sti, 'farge', o.farge),
         kunde = jsonb_build_object(
           'kundenummer', k.kundenummer, 'type', k.type, 'navn', k.navn, 'orgnr', k.orgnr,
           'adresse', k.adresse, 'postnr', k.postnr, 'poststed', k.poststed, 'land', k.land,
           'epost', k.epost),
         utstedt_at = now(),
         utstedt_av = faktura.bruker_id()
   where id = _id
  returning * into f;
  return f;
end $$;

-- Regner status på nytt ut fra innbetalinger og kreditering.
create function faktura.oppdater_betalingsstatus(_id uuid)
returns faktura.fakturaer
language plpgsql security definer set search_path = '' as $$
declare
  f faktura.fakturaer;
  betalt numeric(14,2);
  aa_betale numeric(14,2);
begin
  select * into f from faktura.fakturaer where id = _id;
  if f.type <> 'faktura' or f.status in ('utkast', 'kreditert') then return f; end if;

  select coalesce(sum(belop), 0) into betalt
    from faktura.betalinger where faktura_id = _id and type = 'betaling';
  aa_betale := f.sum_inkl_mva - f.kreditert_belop;

  update faktura.fakturaer
     set betalt_belop = betalt,
         status = case when betalt >= aa_betale - 0.005 then 'betalt' else 'utstedt' end,
         betalt_at = case when betalt >= aa_betale - 0.005 then coalesce(betalt_at, now()) end
   where id = _id
  returning * into f;
  return f;
end $$;

-- Lager og utsteder en kreditnota.
--   _linjer null: krediterer alt som gjenstår.
--   _linjer [{"linje_id": "...", "antall": 2}, ...]: delvis kreditering, antall i
--   samme fortegn som originallinjen og høyst det som gjenstår på linjen.
-- Originalen settes til «kreditert» først når hele fakturaen er kreditert.
create function faktura.krediter(_id uuid, _linjer jsonb default null)
returns faktura.fakturaer
language plpgsql security definer set search_path = '' as $$
declare
  f faktura.fakturaer;
  kn faktura.fakturaer;
  l record;
  q numeric;
  n int := 0;
  helt_kreditert boolean := true;
begin
  select * into f from faktura.fakturaer where id = _id for update;
  if not found then raise exception 'Fant ikke fakturaen' using errcode = 'FA404'; end if;
  perform faktura.krev(f.org_id, 'utsted');
  if f.type <> 'faktura' or f.status not in ('utstedt', 'betalt') then
    raise exception 'Bare utstedte fakturaer kan krediteres' using errcode = 'FA409';
  end if;

  if _linjer is not null then
    if jsonb_typeof(_linjer) <> 'array' or jsonb_array_length(_linjer) = 0 then
      raise exception 'Linjene må være en liste' using errcode = 'FA400';
    end if;
    if exists (select 1 from jsonb_array_elements(_linjer) e
                where not exists (select 1 from faktura.faktura_linjer
                                   where faktura_id = _id and id = (e ->> 'linje_id')::uuid)) then
      raise exception 'En av linjene hører ikke til fakturaen' using errcode = 'FA400';
    end if;
  end if;

  insert into faktura.fakturaer (org_id, kunde_id, type, kreditnota_for, fakturadato, forfallsdato,
                                 periode_fra, periode_til, deres_referanse, opprettet_av)
  values (f.org_id, f.kunde_id, 'kreditnota', f.id, faktura.i_dag(), faktura.i_dag(),
          f.periode_fra, f.periode_til, f.deres_referanse, faktura.bruker_id())
  returning * into kn;

  for l in
    select ol.*, ol.antall + coalesce((
             select sum(c.antall) from faktura.faktura_linjer c
               join faktura.fakturaer cf on cf.id = c.faktura_id
              where c.kreditert_linje_id = ol.id and cf.status <> 'utkast'), 0) as rest
      from faktura.faktura_linjer ol
     where ol.faktura_id = _id
     order by ol.rekke, ol.opprettet
  loop
    if _linjer is null then
      q := l.rest;
    else
      select (e ->> 'antall')::numeric into q
        from jsonb_array_elements(_linjer) e where (e ->> 'linje_id')::uuid = l.id;
      if q is not null and (sign(q) <> sign(l.antall) or abs(q) > abs(l.rest)) then
        raise exception 'Kan ikke kreditere % av «%»; % gjenstår', q, l.beskrivelse, l.rest using errcode = 'FA400';
      end if;
      q := coalesce(q, 0);
    end if;

    if l.rest - q <> 0 then helt_kreditert := false; end if;
    continue when q = 0;

    n := n + 1;
    insert into faktura.faktura_linjer (org_id, faktura_id, rekke, produkt_id, beskrivelse, antall,
                                        enhet, enhetspris, mva_sats, kreditert_linje_id)
    values (f.org_id, kn.id, n, l.produkt_id, l.beskrivelse, -q, l.enhet, l.enhetspris, l.mva_sats, l.id);
  end loop;

  if n = 0 then
    raise exception 'Det er ingenting igjen å kreditere' using errcode = 'FA409';
  end if;

  kn := faktura.utsted(kn.id);

  update faktura.fakturaer
     set kreditert_belop = kreditert_belop - kn.sum_inkl_mva,
         status = case when helt_kreditert then 'kreditert' else status end
   where id = _id;
  perform faktura.oppdater_betalingsstatus(_id);
  return kn;
end $$;

create function faktura.registrer_betaling(
  _id uuid, _belop numeric, _dato date, _notat text default null,
  _kilde text default 'manuell', _ekstern_ref text default null)
returns faktura.fakturaer
language plpgsql security definer set search_path = '' as $$
declare
  f faktura.fakturaer;
begin
  select * into f from faktura.fakturaer where id = _id for update;
  if not found then raise exception 'Fant ikke fakturaen' using errcode = 'FA404'; end if;
  perform faktura.krev(f.org_id, 'bokfor');

  -- Samme bankreferanse to ganger er samme betaling: returner uten å registrere på nytt.
  if _ekstern_ref is not null and exists (
       select 1 from faktura.betalinger
        where org_id = f.org_id and kilde = _kilde and ekstern_ref = _ekstern_ref) then
    return f;
  end if;

  if f.type <> 'faktura' or f.status not in ('utstedt', 'betalt') then
    raise exception 'Betaling kan bare registreres på en utstedt faktura' using errcode = 'FA409';
  end if;
  if _belop is null or _belop = 0 then
    raise exception 'Beløpet kan ikke være 0' using errcode = 'FA400';
  end if;
  if _dato is null or _dato > faktura.i_dag() then
    raise exception 'Betalingsdatoen kan ikke være fram i tid' using errcode = 'FA400';
  end if;

  insert into faktura.betalinger (org_id, faktura_id, type, belop, betalt_dato, notat, kilde, ekstern_ref, registrert_av)
  values (f.org_id, _id, 'betaling', round(_belop, 2), _dato, _notat, _kilde, _ekstern_ref, faktura.bruker_id());

  return faktura.oppdater_betalingsstatus(_id);
end $$;

create function faktura.registrer_refusjon(_id uuid, _belop numeric, _dato date, _notat text default null)
returns faktura.fakturaer
language plpgsql security definer set search_path = '' as $$
declare
  f faktura.fakturaer;
  betalt numeric(14,2);
begin
  select * into f from faktura.fakturaer where id = _id for update;
  if not found then raise exception 'Fant ikke fakturaen' using errcode = 'FA404'; end if;
  perform faktura.krev(f.org_id, 'bokfor');
  if f.type <> 'faktura' or f.status = 'utkast' then
    raise exception 'Refusjon kan bare registreres på en utstedt faktura' using errcode = 'FA409';
  end if;
  if _belop is null or _belop <= 0 then
    raise exception 'Beløpet må være over 0' using errcode = 'FA400';
  end if;
  if _dato is null or _dato > faktura.i_dag() then
    raise exception 'Refusjonsdatoen kan ikke være fram i tid' using errcode = 'FA400';
  end if;

  select coalesce(sum(belop), 0) into betalt
    from faktura.betalinger where faktura_id = _id and type = 'betaling';
  if round(_belop, 2) > betalt - f.refusjon_belop then
    raise exception 'Kan ikke refundere mer enn % kr', betalt - f.refusjon_belop using errcode = 'FA400';
  end if;

  insert into faktura.betalinger (org_id, faktura_id, type, belop, betalt_dato, notat, registrert_av)
  values (f.org_id, _id, 'refusjon', -round(_belop, 2), _dato, _notat, faktura.bruker_id());

  update faktura.fakturaer set refusjon_belop = refusjon_belop + round(_belop, 2)
   where id = _id
  returning * into f;
  return f;
end $$;

-- Lagrer hvor PDF-en ligger og hvem den ble sendt til, etter at workeren har sendt den.
create function faktura.marker_sendt(_id uuid, _pdf_sti text, _sendt_til text default null)
returns faktura.fakturaer
language plpgsql security definer set search_path = '' as $$
declare
  f faktura.fakturaer;
begin
  select * into f from faktura.fakturaer where id = _id for update;
  if not found then raise exception 'Fant ikke fakturaen' using errcode = 'FA404'; end if;
  perform faktura.krev(f.org_id, 'utsted');
  if f.status = 'utkast' then
    raise exception 'Fakturaen er ikke utstedt' using errcode = 'FA409';
  end if;
  update faktura.fakturaer
     set pdf_sti = coalesce(_pdf_sti, pdf_sti),
         sendt_til = coalesce(_sendt_til, sendt_til),
         sendt_at = case when _sendt_til is not null then now() else sendt_at end
   where id = _id
  returning * into f;
  return f;
end $$;

-- ---------------------------------------------------------------------------
-- Gjentakende fakturaer
-- ---------------------------------------------------------------------------

-- Lager et utkast fra en gjentakelse og flytter neste forfall ett intervall fram.
-- Returnerer null og slår av gjentakelsen hvis den er ferdig eller kunden er inaktiv.
-- Workeren utsteder og sender utkastet etterpå.
create function faktura.lag_fra_gjentakelse(_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  g faktura.gjentakelser;
  k faktura.kunder;
  f_id uuid;
  i_dag date := faktura.i_dag();
  linje jsonb;
  n int := 0;
begin
  select * into g from faktura.gjentakelser where id = _id for update;
  if not found then raise exception 'Fant ikke gjentakelsen' using errcode = 'FA404'; end if;
  perform faktura.krev(g.org_id, 'utsted');
  if not g.aktiv then return null; end if;

  select * into k from faktura.kunder where id = g.kunde_id;
  if (g.slutt_dato is not null and g.neste_forfall > g.slutt_dato) or not k.aktiv then
    update faktura.gjentakelser set aktiv = false where id = _id;
    return null;
  end if;

  insert into faktura.fakturaer (org_id, kunde_id, fakturadato, forfallsdato, periode_fra, periode_til,
                                 gjentakelse_id, deres_referanse, opprettet_av)
  values (g.org_id, g.kunde_id, i_dag, greatest(g.neste_forfall, i_dag), i_dag,
          faktura.periode_slutt(i_dag, g.intervall), g.id, g.deres_referanse, faktura.bruker_id())
  returning id into f_id;

  for linje in select * from jsonb_array_elements(g.linjer) loop
    n := n + 1;
    insert into faktura.faktura_linjer (org_id, faktura_id, rekke, produkt_id, beskrivelse, antall, enhet, enhetspris, mva_sats)
    values (g.org_id, f_id, n,
            (linje ->> 'produkt_id')::uuid,
            linje ->> 'beskrivelse',
            coalesce((linje ->> 'antall')::numeric, 1),
            coalesce(linje ->> 'enhet', 'stk'),
            (linje ->> 'enhetspris')::numeric,
            coalesce((linje ->> 'mva_sats')::numeric, 25));
  end loop;

  update faktura.gjentakelser
     set neste_forfall = faktura.neste_forfall(neste_forfall, intervall, forfall_dag),
         siste_faktura_id = f_id
   where id = _id;
  return f_id;
end $$;
