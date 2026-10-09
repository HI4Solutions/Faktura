-- Ekstratimer uten overtid (server/src/arbeidstid.ts): en føring kan merkes som timer uten
-- overtidstillegg, f.eks. etter avtale med den ansatte (fleksitid, eller ekstra timer den ansatte
-- selv vil jobbe). De regnes ikke med i grensene for overtid per dag og per uke, og lønnes som
-- vanlige timer: med timelønnen, eller med timesatsen for dem med fastlønn (lønnsarten
-- «ekstratimer»). En føring er altså enten overtid i sin helhet (overtid_prosent), uten
-- overtid, eller vanlig (overtiden regnes ut av grensene).
alter table faktura.timeforinger
  add column uten_overtid boolean not null default false,
  add constraint timeforinger_uten_overtid check (not (uten_overtid and overtid_prosent is not null));
grant insert (uten_overtid), update (uten_overtid) on faktura.timeforinger to faktura_app;

-- Som før (0065), og valget uten overtid kan heller ikke endres når timene er lønnet.
create or replace function faktura.timer_lonnet() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.lonnskjoring_id is null or not exists (select 1 from faktura.organisasjoner where id = old.org_id) then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Timene er lønnet og kan ikke slettes. Åpne lønnskjøringen igjen først.' using errcode = 'FA409';
  end if;
  if new.lonnskjoring_id is not distinct from old.lonnskjoring_id
     and (new.dato, new.timer, new.overtid_prosent, new.uten_overtid, new.status)
         is distinct from (old.dato, old.timer, old.overtid_prosent, old.uten_overtid, old.status) then
    raise exception 'Timene er lønnet og kan ikke endres. Åpne lønnskjøringen igjen først.' using errcode = 'FA409';
  end if;
  return new;
end $$;
