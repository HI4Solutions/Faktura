-- 0107_paaminnelse_konto.sql
-- Påminnelser husker kontoen og avsenderen fakturaen skal ha (null: organisasjonens
-- standard), slik gjentakelsene gjør. Fakturaen som sendes fra påminnelsen, får dem, så den
-- ikke går til standardkontoen når en annen konto er valgt. En konto som slettes, gir
-- standardkontoen igjen.

alter table faktura.paaminnelser
  add column konto_id uuid,
  add column avsender text check (avsender in ('firma', 'innehaver')),
  add foreign key (org_id, konto_id) references faktura.kontoer(org_id, id) on delete set null (konto_id);

grant insert (konto_id, avsender), update (konto_id, avsender) on faktura.paaminnelser to faktura_app;

-- Påminnelsene som finnes, får de faste valgene fra produktene sine (det første produktet som
-- har fast konto eller avsender, som i fakturaskjemaet). Det var det fakturaen fikk når den
-- ble åpnet i det fulle skjemaet.
with valg as (
  select p.id,
         (select pr.konto_id
            from unnest(p.produkter) with ordinality u(id, n)
            join faktura.produkter pr on pr.id = u.id and pr.org_id = p.org_id
           where pr.konto_id is not null or pr.standardkonto
           order by u.n limit 1) as konto_id,
         (select pr.avsender
            from unnest(p.produkter) with ordinality u(id, n)
            join faktura.produkter pr on pr.id = u.id and pr.org_id = p.org_id
           where pr.avsender is not null
           order by u.n limit 1) as avsender
    from faktura.paaminnelser p
)
update faktura.paaminnelser p
   set konto_id = v.konto_id, avsender = v.avsender
  from valg v
 where v.id = p.id and (v.konto_id is not null or v.avsender is not null);
