-- Betalingsfilen fra lønnskjøringen (server/src/betalingsfil.ts): en godkjent kjøring lastes ned som
-- en ISO 20022-betalingsfil (pain.001, lønn: SALA) som lastes opp og godkjennes i nettbanken. Hver
-- ansatt får nettolønnen til kontonummeret sitt på utbetalingsdatoen, fra lønnskontoen.
--
-- lonn_oppsett: lønnskontoen lønnen betales fra (ellers organisasjonens kontonummer), BIC for banken
-- den er i (bankene krever den i fila), og formatet (pain.001.001.03, som alle norske banker tar
-- imot, eller .09).
-- lonnskjoringer: når betalingsfila sist ble lastet ned, av hvem og hvor mange ganger (appen
-- advarer før den lastes ned igjen, så lønnen ikke betales to ganger).

alter table faktura.lonn_oppsett
  add column lonnskonto text check (lonnskonto is null or faktura.kontonr_gyldig(lonnskonto)),
  add column bank_bic text check (bank_bic is null or bank_bic ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$'),
  add column betalingsfil_format text not null default 'pain.001.001.03'
    check (betalingsfil_format in ('pain.001.001.03', 'pain.001.001.09'));
grant insert (lonnskonto, bank_bic, betalingsfil_format),
      update (lonnskonto, bank_bic, betalingsfil_format)
  on faktura.lonn_oppsett to faktura_app;

alter table faktura.lonnskjoringer
  add column betalingsfil_lastet timestamptz,
  add column betalingsfil_av uuid references faktura.brukere(id) on delete set null,
  add column betalingsfil_antall int not null default 0 check (betalingsfil_antall >= 0);

-- Betalingsfila lastes ned (de som ser lønnen, når kjøringen er godkjent): merker kjøringen og gir
-- når den ble lastet ned før (null første gang).
create function faktura.lonn_betalingsfil(_kjoring uuid) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  k faktura.lonnskjoringer;
begin
  select * into k from faktura.lonnskjoringer where id = _kjoring for update;
  if k.id is null then raise exception 'Fant ikke lønnskjøringen' using errcode = 'FA404'; end if;
  perform faktura.krev(k.org_id, 'personal_les');
  if k.status <> 'godkjent' then
    raise exception 'Godkjenn lønnen før betalingsfila lastes ned' using errcode = 'FA409';
  end if;
  update faktura.lonnskjoringer
     set betalingsfil_lastet = now(), betalingsfil_av = faktura.bruker_id(), betalingsfil_antall = betalingsfil_antall + 1
   where id = k.id;
  return k.betalingsfil_lastet;
end $$;
revoke execute on function faktura.lonn_betalingsfil(uuid) from public;
grant execute on function faktura.lonn_betalingsfil(uuid) to faktura_app;
