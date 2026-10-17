-- 0121_skatteberegning.sql
-- Skatteberegningen i årsoppgjøret (server/src/skatteberegning.ts, aarsoppgjor.ts).
--
-- Forslaget til betalbar skatt og utsatt skatt regnes fra regnskapet når årsoppgjøret vises. Her
-- ligger det brukeren selv legger inn for året (skatteberegning): andre permanente forskjeller,
-- andre midlertidige forskjeller ved inngangen og utgangen av året, fremførbart underskudd ved
-- inngangen til året (når det ikke skal regnes fra året før) og om en utsatt skattefordel skal
-- balanseføres. utsatt_skatt er den utsatte skatten 31. desember som føres i årsoppgjøret
-- (negativ: utsatt skattefordel); null betyr at årsoppgjøret ikke fører utsatt skatt.

alter table faktura.aarsoppgjor
  add column skatteberegning jsonb not null default '{}'::jsonb check (jsonb_typeof(skatteberegning) = 'object'),
  add column utsatt_skatt numeric(14,2);

grant insert (skatteberegning, utsatt_skatt), update (skatteberegning, utsatt_skatt) on faktura.aarsoppgjor to faktura_app;
