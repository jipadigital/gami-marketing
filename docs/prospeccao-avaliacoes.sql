-- ============================================================
-- PROSPECÇÃO EM CAMPO — avaliações do iFood (Power Data) no mapa
-- ------------------------------------------------------------
-- O mapa agora dimensiona o ponto CINZA (prospect) pela popularidade:
-- quanto mais avaliações no iFood, maior a bolinha. O popup mostra a
-- nota + nº de avaliações. Pra isso o import precisa guardar esses
-- 2 campos (o xlsx/CSV do iFood já traz: avaliacao, numero_avaliacoes).
--
-- Rodar 1x. Sem o dado, nada quebra: a bolinha fica no tamanho de
-- sempre (6) e o popup não mostra a linha ⭐. Depois, reimportar a
-- cidade (ou um UPDATE de backfill) preenche e o mapa passa a escalar.
-- Seguro: só ADD COLUMN, não mexe em dado existente.
-- ============================================================

ALTER TABLE public.prospeccao_lojas
  ADD COLUMN IF NOT EXISTS avaliacao          numeric(3,1),  -- nota média (ex 4.8)
  ADD COLUMN IF NOT EXISTS numero_avaliacoes  integer;       -- quantidade de avaliações

-- (opcional) índice pra ordenar/filtrar prospects por popularidade
CREATE INDEX IF NOT EXISTS idx_prospeccao_lojas_num_aval
  ON public.prospeccao_lojas (cidade_slug, numero_avaliacoes DESC NULLS LAST);
