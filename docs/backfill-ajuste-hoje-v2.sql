-- ============================================================
-- AJUSTE DE HOJE v2 — pega quem o v1 deixou de fora
-- O v1 deu +20 so pra quem teve LOGIN novo hoje (acessos_log). Quem ficou
-- logado pelo cache (sem login novo) mas trabalhou (postou no mural, etc.)
-- ficou sem. Este complemento da +20 pra TODO MUNDO que teve QUALQUER
-- atividade hoje (qualquer linha no pontos_log de hoje) e ainda nao recebeu
-- o ajuste. Idempotente: NOT EXISTS, nao duplica, nao mexe em quem ja tem.
-- Fuso America/Campo_Grande.
-- ============================================================

DO $$
DECLARE
  hoje  date := (now() AT TIME ZONE 'America/Campo_Grande')::date;
  valor int  := 20;
  n int := 0;
BEGIN
  INSERT INTO pontos_log (pessoa_id, pessoa_nome, tipo_acao, categoria, pontos, descricao, origem, data_acao)
  SELECT src.pessoa_id, src.pessoa_nome, 'ajuste_sistema', 'engajamento', valor,
         'Ajuste do sistema (pontos de hoje nao gravados por falha)', 'backfill', hoje
  FROM (
    SELECT DISTINCT ON (p.pessoa_id) p.pessoa_id, p.pessoa_nome
    FROM pontos_log p
    WHERE p.data_acao = hoje
      AND p.tipo_acao <> 'ajuste_sistema'
      AND p.pessoa_id IS NOT NULL AND p.pessoa_id <> '?'
    ORDER BY p.pessoa_id, p.pessoa_nome
  ) src
  WHERE NOT EXISTS (
    SELECT 1 FROM pontos_log x
    WHERE x.pessoa_id = src.pessoa_id AND x.tipo_acao = 'ajuste_sistema' AND x.data_acao = hoje
  );
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'Complemento +% aplicado a % pessoas que faltavam (dia %)', valor, n, hoje;
END $$;

-- CONFERENCIA: total de hoje por pessoa
SELECT pessoa_nome, SUM(pontos) AS pts_hoje, COUNT(*) AS lancamentos
FROM pontos_log
WHERE data_acao = (now() AT TIME ZONE 'America/Campo_Grande')::date
GROUP BY pessoa_nome
ORDER BY pts_hoje DESC;
