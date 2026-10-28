-- ============================================================
-- AJUSTE FIXO DOS PONTOS DE HOJE (compensacao)
-- Login e mural ja foram lancados exatos (backfill-pontos-hoje.sql).
-- As TAREFAS/pulse/versiculo do dia nao tem como reconstruir (o sistema
-- nao guarda "quem concluiu quando"; so vivia no log que se perdeu hoje).
-- Entao este script da um AJUSTE FIXO, igual pra todos que trabalharam hoje
-- (= logaram hoje), pra ninguem sair perdendo.
--
-- SEGURO: idempotente (NOT EXISTS, nao duplica). Fuso America/Campo_Grande.
-- TROQUE o valor abaixo se quiser (5, 10, 15...).
-- ============================================================

DO $$
DECLARE
  hoje  date := (now() AT TIME ZONE 'America/Campo_Grande')::date;
  valor int  := 20;   -- <<< PONTOS DE AJUSTE POR PESSOA (muda aqui se quiser)
  n int := 0;
BEGIN
  INSERT INTO pontos_log (pessoa_id, pessoa_nome, tipo_acao, categoria, pontos, descricao, origem, data_acao)
  SELECT DISTINCT ON (a.pessoa_id)
         a.pessoa_id, a.pessoa_nome, 'ajuste_sistema', 'engajamento', valor,
         'Ajuste do sistema (pontos de hoje nao gravados por falha)', 'backfill', hoje
  FROM acessos_log a
  WHERE a.sucesso = true
    AND (a.criado_em AT TIME ZONE 'America/Campo_Grande')::date = hoje
    AND a.pessoa_id IS NOT NULL AND a.pessoa_id <> '?'
    AND NOT EXISTS (
      SELECT 1 FROM pontos_log p
      WHERE p.pessoa_id = a.pessoa_id AND p.tipo_acao = 'ajuste_sistema' AND p.data_acao = hoje
    )
  ORDER BY a.pessoa_id, a.criado_em;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'Ajuste de % pts aplicado a % pessoas (dia %)', valor, n, hoje;
END $$;

-- CONFERENCIA: total de hoje por pessoa
SELECT pessoa_nome, SUM(pontos) AS pts_hoje, COUNT(*) AS lancamentos
FROM pontos_log
WHERE data_acao = (now() AT TIME ZONE 'America/Campo_Grande')::date
GROUP BY pessoa_nome
ORDER BY pts_hoje DESC;
