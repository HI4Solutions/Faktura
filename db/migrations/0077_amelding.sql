-- A-meldingen (server/src/amelding.ts, server/src/ameldingRuter.ts): den månedlige rapporteringen av
-- lønn, forskuddstrekk, arbeidsgiveravgift og arbeidsforhold til a-ordningen (Skatteetaten, NAV
-- og SSB). Meldingen for en måned lages av de godkjente lønnskjøringene med utbetaling i måneden
-- og arbeidsforholdene som er aktive i den. Den sendes til Skatteetatens API med systembrukeren i
-- Altinn (tilgangspakken «A-ordningen»), eller lastes ned som XML og lastes opp på
-- skatteetaten.no. Fødselsnumrene leser bare workeren, så workeren lager fila og sender meldingen.

-- Arbeidsforholdet på den ansatte: yrkeskoden (7 siffer, SSBs yrkeskoder etter STYRK-08), typen
-- arbeidsforhold, arbeidstidsordningen, årsaken til sluttdatoen, og datoene lønnen og
-- stillingsprosenten sist ble endret (settes av seg selv når de endres; uten dato gjelder
-- ansettelsesdatoen). Ansettelsesformen er ansettelsestype (fast, midlertidig, tilkalling).
alter table faktura.ansatte
  add column yrkeskode text check (yrkeskode is null or yrkeskode ~ '^\d{7}$'),
  add column arbeidsforhold_type text not null default 'ordinaertArbeidsforhold'
    check (arbeidsforhold_type in ('ordinaertArbeidsforhold', 'maritimtArbeidsforhold', 'frilanserOppdragstakerHonorarPersonerMm')),
  add column arbeidstidsordning text not null default 'ikkeSkift'
    check (arbeidstidsordning in ('ikkeSkift', 'andreSkift', 'skift365', 'doegnkontinuerligSkiftOgTurnus355',
                                  'helkontinuerligSkiftOgAndreOrdninger336', 'offshore336')),
  add column aarsak_sluttdato text
    check (aarsak_sluttdato is null or aarsak_sluttdato in ('arbeidstakerHarSagtOppSelv', 'arbeidsgiverHarSagtOppArbeidstaker',
           'kontraktEngasjementEllerVikariatErUtloept', 'byttetLoenssystemEllerRegnskapsfoerer',
           'endringIOrganisasjonsstrukturEllerByttetJobbInternt', 'arbeidsforholdetSkulleAldriVaertRapportert')),
  add column siste_lonnsendring date,
  add column siste_stillingsendring date;
grant select (yrkeskode, arbeidsforhold_type, arbeidstidsordning, aarsak_sluttdato, siste_lonnsendring, siste_stillingsendring),
      insert (yrkeskode, arbeidsforhold_type, arbeidstidsordning, aarsak_sluttdato, siste_lonnsendring, siste_stillingsendring),
      update (yrkeskode, arbeidsforhold_type, arbeidstidsordning, aarsak_sluttdato, siste_lonnsendring, siste_stillingsendring)
  on faktura.ansatte to faktura_app;
grant select (yrkeskode, arbeidsforhold_type, arbeidstidsordning, aarsak_sluttdato, siste_lonnsendring, siste_stillingsendring)
  on faktura.ansatte to faktura_system;

-- Lønnen (månedslønn, timelønn eller lønnstype) eller stillingsprosenten endres: datoen settes til
-- i dag, med mindre den settes samtidig.
create function faktura.ansatt_endringsdatoer() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.maanedslonn, new.timelonn, new.lonnstype) is distinct from (old.maanedslonn, old.timelonn, old.lonnstype)
     and new.siste_lonnsendring is not distinct from old.siste_lonnsendring then
    new.siste_lonnsendring := faktura.i_dag();
  end if;
  if new.stillingsprosent is distinct from old.stillingsprosent
     and new.siste_stillingsendring is not distinct from old.siste_stillingsendring then
    new.siste_stillingsendring := faktura.i_dag();
  end if;
  return new;
end $$;
create trigger ansatte_endringsdatoer before update on faktura.ansatte
  for each row execute function faktura.ansatt_endringsdatoer();

-- Virksomheten (underenheten i Enhetsregisteret) arbeidsforholdene rapporteres under, og
-- pensjonsinnretningen (organisasjonsnummeret til OTP-leverandøren), som må være med når det er OTP.
alter table faktura.lonn_oppsett
  add column virksomhet_orgnr text check (virksomhet_orgnr is null or faktura.orgnr_gyldig(virksomhet_orgnr)),
  add column pensjonsinnretning_orgnr text check (pensjonsinnretning_orgnr is null or faktura.orgnr_gyldig(pensjonsinnretning_orgnr));
grant insert (virksomhet_orgnr, pensjonsinnretning_orgnr), update (virksomhet_orgnr, pensjonsinnretning_orgnr)
  on faktura.lonn_oppsett to faktura_app;

-- A-meldingene: én rad for hver fil som lages og hver innsending. meldings_id er meldingens ID i
-- a-ordningen; erstatter: meldingen den erstatter (en rettet a-melding for samme måned).
-- innsending: fil (XML til opplasting på skatteetaten.no) eller api (Skatteetatens API).
-- status: lages (workeren lager fila eller sender), klar (fila er klar), levert (fila er merket
-- som lastet opp), sendt (Skatteetaten tok imot meldingen; tilbakemeldingen venter), mottatt
-- (tilbakemeldingen sier mottatt, med eller uten avvik), avvist (tilbakemeldingen sier avvist),
-- feil (kunne ikke lages eller sendes). oppsummering: antallet og summene (uten fødselsnumre).
create table faktura.ameldinger (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references faktura.organisasjoner(id) on delete cascade,
  maaned date not null check (maaned = date_trunc('month', maaned)::date),
  meldings_id text not null default gen_random_uuid()::text,
  erstatter text,
  innsending text not null check (innsending in ('fil', 'api')),
  status text not null default 'lages' check (status in ('lages', 'klar', 'levert', 'sendt', 'mottatt', 'avvist', 'feil')),
  oppsummering jsonb,
  fil_sti text,
  forsendelse_id text,
  dialog_id text,
  tilbakemelding jsonb,
  feil text check (feil is null or length(feil) <= 2000),
  laget_av uuid default faktura.bruker_id() references faktura.brukere(id) on delete set null,
  opprettet timestamptz not null default now(),
  oppdatert timestamptz not null default now(),
  sendt_at timestamptz,
  sjekket timestamptz,
  unique (org_id, id),
  unique (meldings_id)
);
create index ameldinger_org_maaned on faktura.ameldinger (org_id, maaned, opprettet desc);
create trigger ameldinger_oppdatert before update on faktura.ameldinger
  for each row execute function faktura.sett_oppdatert();
create trigger ameldinger_org_id before update on faktura.ameldinger
  for each row execute function faktura.org_id_uendret();
create trigger ameldinger_revisjon after insert or update or delete on faktura.ameldinger
  for each row execute function faktura.revider();

alter table faktura.ameldinger enable row level security;
create policy ameldinger_les on faktura.ameldinger for select using (faktura.kan(org_id, 'personal_les'));
create policy ameldinger_system on faktura.ameldinger for all using (faktura.er_system()) with check (faktura.er_system());
grant select on faktura.ameldinger to faktura_app;
grant select, update (status, oppsummering, fil_sti, forsendelse_id, dialog_id, tilbakemelding, feil, sendt_at, sjekket)
  on faktura.ameldinger to faktura_system;

-- Eier eller administrator bestiller en a-melding for måneden (fila eller innsendingen): raden
-- lages, og workeren gjør resten. Erstatter den en melding som er levert (sendt, mottatt eller
-- levert som fil), er det den siste av dem. En måned med en melding som lages (en time) eller venter
-- på tilbakemelding (to dager), får ikke en ny før den er ferdig.
create function faktura.bestill_amelding(_org uuid, _maaned date, _innsending text, _erstatt boolean default true)
returns faktura.ameldinger
language plpgsql security definer set search_path = '' as $$
declare
  m faktura.ameldinger;
  forrige text;
begin
  perform faktura.krev(_org, 'personal');
  if _maaned is null or _maaned <> date_trunc('month', _maaned)::date then
    raise exception 'Velg en måned' using errcode = 'FA400';
  end if;
  if _innsending not in ('fil', 'api') then
    raise exception 'Ukjent innsending' using errcode = 'FA400';
  end if;
  if not exists (select 1 from faktura.organisasjoner where id = _org and orgnr is not null) then
    raise exception 'Organisasjonen mangler organisasjonsnummer' using errcode = 'FA400';
  end if;
  if exists (select 1 from faktura.ameldinger where org_id = _org and maaned = _maaned
              and ((status = 'lages' and opprettet > now() - interval '1 hour')
                   or (status = 'sendt' and innsending = 'api' and sendt_at > now() - interval '2 days'))) then
    raise exception 'A-meldingen for måneden lages eller venter på tilbakemelding fra Skatteetaten. Vent til den er ferdig.' using errcode = 'FA409';
  end if;
  if _erstatt then
    select meldings_id into forrige from faktura.ameldinger
     where org_id = _org and maaned = _maaned and status in ('levert', 'sendt', 'mottatt')
     order by opprettet desc limit 1;
  end if;
  insert into faktura.ameldinger (org_id, maaned, innsending, erstatter)
  values (_org, _maaned, _innsending, forrige)
  returning * into m;
  return m;
end $$;
revoke execute on function faktura.bestill_amelding(uuid, date, text, boolean) from public;
grant execute on function faktura.bestill_amelding(uuid, date, text, boolean) to faktura_app;

-- Eier eller administrator merker fila som lastet opp på skatteetaten.no (eller ikke): en ny
-- melding for måneden erstatter da den.
create function faktura.amelding_levert(_org uuid, _id uuid, _levert boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform faktura.krev(_org, 'personal');
  update faktura.ameldinger set status = case when _levert then 'levert' else 'klar' end
   where org_id = _org and id = _id and innsending = 'fil' and status in ('klar', 'levert');
  if not found then
    raise exception 'Fant ikke a-meldingsfila' using errcode = 'FA404';
  end if;
end $$;
revoke execute on function faktura.amelding_levert(uuid, uuid, boolean) from public;
grant execute on function faktura.amelding_levert(uuid, uuid, boolean) to faktura_app;

-- Tilgangen i Altinn: tilgangspakkene systembrukeren har fått (eller er bedt om), og en
-- endringsforespørsel når systemet trenger flere (f.eks. «A-ordningen» for a-meldingen).
alter table faktura.skattekort_tilgang
  add column pakker text[] not null default '{urn:altinn:accesspackage:lonn}',
  add column endring_status text check (endring_status in ('venter', 'ny', 'godkjent', 'avslatt', 'avvist', 'utlopt', 'feil')),
  add column endring_id uuid,
  add column endring_url text check (endring_url is null or endring_url like 'https://%'),
  add column endring_pakker text[],
  add column endring_feil text;
grant insert (pakker), update (pakker, endring_status, endring_id, endring_url, endring_pakker, endring_feil)
  on faktura.skattekort_tilgang to faktura_system;

-- Eier eller administrator ber om at tilgangen i Altinn utvides med tilgangspakkene systemet
-- trenger nå (workeren lager endringsforespørselen). Tilgangen må være godkjent.
create function faktura.be_om_utvidet_tilgang(_org uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform faktura.krev(_org, 'personal');
  update faktura.skattekort_tilgang
     set endring_status = 'venter', endring_id = null, endring_url = null, endring_pakker = null, endring_feil = null
   where org_id = _org and status = 'godkjent';
  if not found then
    raise exception 'Gi tilgang i Altinn først' using errcode = 'FA409';
  end if;
end $$;
revoke execute on function faktura.be_om_utvidet_tilgang(uuid) from public;
grant execute on function faktura.be_om_utvidet_tilgang(uuid) to faktura_app;
