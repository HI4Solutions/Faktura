-- 0055_ai_personal.sql
-- AI-assistenten for personalmodulen (server/src/aiPersonal.ts): også den ansatte (rollen
-- ansatt) kan bruke assistenten, med tale eller tekst, for sitt eget fravær, sine vakter, timer
-- og ferie. API-et avgjør hva hver bruker får (fakturaer, personal eller begge), og alt som
-- endrer noe, utføres med de vanlige rutene og brukerens egen tilgang. Bruken telles som før.

create or replace function faktura.ai_krev(_org uuid, _funksjon text) returns void
language plpgsql stable set search_path = '' as $$
begin
  perform faktura.krev(_org, case _funksjon when 'faktura' then 'skriv' when 'assistent' then 'medlem' when 'lonnsslipp' then 'personal' else 'bokfor' end);
end $$;
