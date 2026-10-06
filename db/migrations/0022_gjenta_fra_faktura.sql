-- 0022_gjenta_fra_faktura.sql
-- En faktura kan gjøres gjentakende mens den lages. Valget lagres på fakturaen (gjenta),
-- og gjentakelsen opprettes når fakturaen utstedes, uansett hvor den sendes fra
-- (skjemaet, fakturaen, flere utkast på én gang, planlagt sending). Gjentakelsen får
-- fakturaens kunde, linjer (med rabatt), notat, referanse, avsender, konto og kopimottakere.
--
-- gjenta: {"intervall": "maaned"|"kvartal"|"aar", "neste_forfall": "2026-11-20",
--          "send_dager_foer": 14, "slutt_dato": null}
-- Uten neste_forfall: ett intervall etter fakturaens forfall. Uten send_dager_foer:
-- organisasjonens standard.

alter table faktura.fakturaer
  add column gjenta jsonb check (gjenta is null or gjenta ->> 'intervall' in ('maaned', 'kvartal', 'aar'));
grant insert (gjenta), update (gjenta) on faktura.fakturaer to faktura_app;

create function faktura.faktura_gjenta() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  neste date;
  dager int;
  g_id uuid;
begin
  if not (old.status = 'utkast' and new.status <> 'utkast' and new.type = 'faktura'
          and new.gjenta is not null and new.gjentakelse_id is null) then
    return new;
  end if;

  neste := coalesce((new.gjenta ->> 'neste_forfall')::date,
                    faktura.neste_forfall(new.forfallsdato, new.gjenta ->> 'intervall', extract(day from new.forfallsdato)::int));
  -- Ellers ville gjentakelsen lage en ny faktura for samme periode med en gang.
  if neste <= new.forfallsdato then
    raise exception 'Neste forfall for gjentakelsen må være etter forfallsdatoen på fakturaen (%)', to_char(new.forfallsdato, 'DD.MM.YYYY')
      using errcode = 'FA400';
  end if;
  if (new.gjenta ->> 'slutt_dato')::date < neste then
    raise exception 'Sluttdatoen for gjentakelsen er før neste forfall' using errcode = 'FA400';
  end if;
  dager := coalesce((new.gjenta ->> 'send_dager_foer')::int,
                    (select o.standard_dager_foer_forfall from faktura.organisasjoner o where o.id = new.org_id), 14);

  insert into faktura.gjentakelser (org_id, kunde_id, linjer, intervall, forfall_dag, neste_forfall, send_dager_foer,
                                    slutt_dato, aktiv, deres_referanse, konto_id, avsender, kopi_til, kommentar, opprettet_av)
  values (new.org_id, new.kunde_id,
          (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                    'produkt_id', l.produkt_id, 'beskrivelse', l.beskrivelse, 'antall', l.antall, 'enhet', l.enhet,
                    'enhetspris', l.enhetspris, 'mva_sats', l.mva_sats,
                    'rabatt_prosent', l.rabatt_prosent, 'rabatt_belop', l.rabatt_belop)) order by l.rekke, l.opprettet)
             from faktura.faktura_linjer l where l.faktura_id = new.id),
          new.gjenta ->> 'intervall',
          -- Forfallsdagen holdes: forfall den 31. gir den 30. i april, men den 31. i juli.
          case when new.gjenta ? 'neste_forfall' and new.gjenta ->> 'neste_forfall' is not null
               then extract(day from neste) else extract(day from new.forfallsdato) end::int,
          neste, dager,
          (new.gjenta ->> 'slutt_dato')::date, true,
          -- Referansen fra utkastet (ikke kundens standard, som brukes når den mangler)
          old.deres_referanse, new.konto_id, new.avsender, new.kopi_til, new.kommentar,
          coalesce(faktura.bruker_id(), new.opprettet_av))
  returning id into g_id;
  new.gjentakelse_id := g_id;
  return new;
end $$;

-- Navnet sorterer før «fakturaer_laas», som slipper alt gjennom for utkast.
create trigger fakturaer_gjenta before update on faktura.fakturaer
  for each row execute function faktura.faktura_gjenta();
