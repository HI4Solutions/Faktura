-- 0028_bank_fra.sql
-- Innbetalinger fra banken bare fra og med en startdato: som standard dagen organisasjonen
-- ble opprettet (da den begynte med HI4 Faktura), eller en dato en administrator velger.
-- Eldre innbetalinger hentes ikke, og de som allerede er hentet, ryddes bort. Ellers kan en
-- husleie betalt før organisasjonen startet, bli foreslått på en ny faktura.

alter table faktura.organisasjoner add column bank_fra date;

-- Datoen innbetalingene hentes fra og med.
create function faktura.bank_fra(_org uuid) returns date
language sql stable set search_path = '' as $$
  select coalesce(o.bank_fra, (o.opprettet at time zone 'Europe/Oslo')::date) from faktura.organisasjoner o where o.id = _org
$$;

-- Rydder bort innbetalinger fra før startdatoen: de som ikke er registrert, og de som ble
-- registrert på en faktura av seg selv (betalingen tas bort og står i revisjonsloggen). Det
-- en person har registrert, blir stående. Workeren kjører den ved hver henting.
create function faktura.rydd_banktransaksjoner(_org uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  fra date := faktura.bank_fra(_org);
  t record;
  n int;
begin
  perform faktura.krev(_org, 'bokfor');
  if fra is null then return 0; end if;
  for t in select id from faktura.banktransaksjoner
            where org_id = _org and dato < fra and status = 'koblet' and behandlet_av is null loop
    begin
      perform faktura.angre_banktransaksjon(t.id);
    exception when sqlstate 'FA409' then null; -- fakturaen er kreditert: blir stående
    end;
  end loop;
  delete from faktura.banktransaksjoner where org_id = _org and dato < fra and status <> 'koblet';
  get diagnostics n = row_count;
  return n;
end $$;

-- Ny startdato (null: dagen organisasjonen ble opprettet). Flyttes den bakover, hentes
-- kontoene på nytt fra den nye datoen. Returnerer hvor mange innbetalinger som ble fjernet.
create function faktura.sett_bank_fra(_org uuid, _fra date) returns int
language plpgsql security definer set search_path = '' as $$
declare
  for_ date;
begin
  perform faktura.krev(_org, 'admin');
  if _fra > faktura.i_dag() then raise exception 'Startdatoen kan ikke være fram i tid' using errcode = 'FA400'; end if;
  for_ := faktura.bank_fra(_org);
  update faktura.organisasjoner set bank_fra = _fra where id = _org;
  if faktura.bank_fra(_org) < for_ then
    update faktura.bankkoblinger
       set hent_fra = null,
           kontoer = (select coalesce(jsonb_agg((x - 'hent_fra') order by n), '[]')
                        from jsonb_array_elements(kontoer) with ordinality as e(x, n))
     where org_id = _org;
  end if;
  return faktura.rydd_banktransaksjoner(_org);
end $$;

revoke all on function faktura.bank_fra(uuid), faktura.rydd_banktransaksjoner(uuid), faktura.sett_bank_fra(uuid, date) from public;
grant execute on function faktura.bank_fra(uuid), faktura.sett_bank_fra(uuid, date) to faktura_app;
grant execute on function faktura.rydd_banktransaksjoner(uuid) to faktura_system;
