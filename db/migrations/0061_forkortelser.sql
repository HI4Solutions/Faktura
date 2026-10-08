-- 0061_forkortelser.sql
-- Forkortelser for de ansatte og rollehaverne (f.eks. «AB» for Anne Berg), der plassen er trang:
-- bemanningskalenderen og vaktplanen per dag og måned. Forkortelsen lages av seg selv fra
-- initialene (en ledig variant når de er i bruk), og kan endres i ansattskjemaet; tømmes feltet,
-- lages den på nytt. Den er unik i organisasjonen (store og små bokstaver regnes likt).

alter table faktura.ansatte add column forkortelse text
  check (forkortelse is null or (char_length(forkortelse) between 1 and 6 and forkortelse !~ '[[:space:]]'));
grant select (forkortelse), insert (forkortelse), update (forkortelse) on faktura.ansatte to faktura_app;

-- En ledig forkortelse i organisasjonen: initialene (AB), så tre bokstaver (ABE, ANB), så med tall
-- (AB2, AB3 …). Første ord i fornavnet og etternavnet; _unntatt er personen selv.
create function faktura.ny_forkortelse(_org uuid, _fornavn text, _etternavn text, _unntatt uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  f text := upper(coalesce((regexp_split_to_array(btrim(coalesce(_fornavn, '')), '[[:space:]-]+'))[1], ''));
  e text := upper(coalesce((regexp_split_to_array(btrim(coalesce(_etternavn, '')), '[[:space:]-]+'))[1], ''));
  start text;
  kandidat text;
  n int := 2;
begin
  start := coalesce(nullif(left(f, 1) || left(e, 1), ''), 'X');
  foreach kandidat in array array[start, left(f, 1) || left(e, 2), left(f, 2) || left(e, 1)] loop
    if char_length(kandidat) >= char_length(start)
       and not exists (select 1 from faktura.ansatte a
                        where a.org_id = _org and upper(a.forkortelse) = upper(kandidat) and a.id is distinct from _unntatt) then
      return kandidat;
    end if;
  end loop;
  loop
    kandidat := start || n;
    exit when not exists (select 1 from faktura.ansatte a
                           where a.org_id = _org and upper(a.forkortelse) = upper(kandidat) and a.id is distinct from _unntatt);
    n := n + 1;
  end loop;
  return kandidat;
end $$;

-- Forkortelsen til de som finnes, i rekkefølgen de ble lagt inn.
do $$
declare
  r record;
begin
  for r in select id, org_id, fornavn, etternavn from faktura.ansatte order by org_id, ansattnummer, opprettet loop
    update faktura.ansatte set forkortelse = faktura.ny_forkortelse(r.org_id, r.fornavn, r.etternavn, r.id) where id = r.id;
  end loop;
end $$;

create unique index ansatte_forkortelse_idx on faktura.ansatte (org_id, upper(forkortelse));

-- Uten forkortelse (ny person, eller feltet er tømt) lages den; en som er i bruk, avvises med navnet.
create function faktura.ansatt_forkortelse() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  annen text;
begin
  new.forkortelse := nullif(btrim(new.forkortelse), '');
  if new.forkortelse is null then
    new.forkortelse := faktura.ny_forkortelse(new.org_id, new.fornavn, new.etternavn, new.id);
  elsif tg_op = 'INSERT' or upper(new.forkortelse) is distinct from upper(old.forkortelse) then
    select a.fornavn || ' ' || a.etternavn into annen
      from faktura.ansatte a
     where a.org_id = new.org_id and upper(a.forkortelse) = upper(new.forkortelse) and a.id <> new.id;
    if found then
      raise exception 'Forkortelsen «%» er i bruk av %', new.forkortelse, annen using errcode = 'FA409';
    end if;
  end if;
  return new;
end $$;
create trigger ansatte_forkortelse before insert or update of forkortelse on faktura.ansatte
  for each row execute function faktura.ansatt_forkortelse();

revoke all on function faktura.ny_forkortelse(uuid, text, text, uuid), faktura.ansatt_forkortelse() from public;
