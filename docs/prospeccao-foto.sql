-- ============================================================
-- PROSPECÇÃO EM CAMPO (v32.27) — foto da fachada na visita
-- ------------------------------------------------------------
-- Guarda a foto (comprimida no cliente, ~900px JPEG) como data URL
-- na própria visita. Seguro de rodar: só adiciona a coluna.
-- ============================================================

ALTER TABLE public.prospeccao_visitas ADD COLUMN IF NOT EXISTS foto text;
