-- Revisjonsloggen for tabellene som har kommet med lønnen siden 0074: a-meldingene (summene per
-- inntektsmottaker), lønnsbilagene, lønnshistorikken og inntektsmeldingene til NAV. Loggen for dem
-- er, som for de ansatte og lønnskjøringene, bare for dem som ser lønnen; inntektsmeldingene
-- (sykefravær) bare for eier og administrator, som fraværet.
drop policy revisjonslogg_les on faktura.revisjonslogg;
create policy revisjonslogg_les on faktura.revisjonslogg for select
  using (faktura.kan(org_id, 'les')
         and (coalesce(tabell, '') not in ('ansatte', 'ansatt_tillegg', 'fravaer', 'arbeidsplaner', 'ferie_overforinger', 'vaktbytter',
                                           'lonnskjoringer', 'lonn_inngaende', 'timebank_poster', 'avspasering_soknader',
                                           'ameldinger', 'bilag', 'lonnsendringer', 'nav_inntektsmeldinger')
              or faktura.kan(org_id, 'personal_les'))
         and (coalesce(tabell, '') not in ('fravaer', 'ferie_overforinger', 'avspasering_soknader', 'vaktbytter', 'nav_inntektsmeldinger')
              or faktura.kan(org_id, 'personal')));
