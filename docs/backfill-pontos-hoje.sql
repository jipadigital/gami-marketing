-- ============================================================
-- BACKFILL DOS PONTOS DE HOJE
-- Motivo: o proxy de escrita nao aceitava operacao 'insert' (so upsert/patch/
--         delete/rpc), entao o log de pontos caia no fallback anon, que a RLS
--         bloqueia -> ninguem pontuou hoje. Corrigido no app (v33.54).
-- Este script REFAZ os pontos de hoje a partir das tabelas que guardaram o
-- que aconteceu de fato (login, mural) + tarefas em melhor esforco.
--
-- SEGURO: idempotente (NOT EXISTS por pessoa+acao+dia, nao duplica), roda
-- no SQL Editor do Supabase (service role). Fuso: America/Campo_Grande.
-- Pode rodar o arquivo inteiro de uma vez.
-- ============================================================

-- 1) LOGIN DIARIO (2 pts, 1x/dia) + 2) MURAL (1 pt, 1x/dia) -> exatos
DO $$
DECLARE
  hoje date := (now() AT TIME ZONE 'America/Campo_Grande')::date;
  n_login int := 0; n_mural int := 0;
BEGIN
  -- LOGIN: quem logou com sucesso hoje
  INSERT INTO pontos_log (pessoa_id, pessoa_nome, tipo_acao, categoria, pontos, descricao, origem, data_acao)
  SELECT DISTINCT ON (a.pessoa_id)
         a.pessoa_id, a.pessoa_nome, 'login_diario', 'engajamento', 2, 'Login no dashboard', 'backfill', hoje
  FROM acessos_log a
  WHERE a.sucesso = true
    AND (a.criado_em AT TIME ZONE 'America/Campo_Grande')::date = hoje
    AND a.pessoa_id IS NOT NULL AND a.pessoa_id <> '?'
    AND NOT EXISTS (
      SELECT 1 FROM pontos_log p
      WHERE p.pessoa_id = a.pessoa_id AND p.tipo_acao = 'login_diario' AND p.data_acao = hoje
    )
  ORDER BY a.pessoa_id, a.criado_em;
  GET DIAGNOSTICS n_login = ROW_COUNT;

  -- MURAL: quem postou recado hoje (le as colunas via jsonb, tolera naming)
  INSERT INTO pontos_log (pessoa_id, pessoa_nome, tipo_acao, categoria, pontos, descricao, origem, data_acao)
  SELECT DISTINCT ON (q.aut)
         q.aut, q.nom, 'comentou_mural_de', 'cultura', 1, 'Escreveu no mural', 'backfill', hoje
  FROM (
    SELECT COALESCE(to_jsonb(r)->>'autorId', to_jsonb(r)->>'autor_id', to_jsonb(r)->>'pessoa_id') AS aut,
           COALESCE(to_jsonb(r)->>'autor', to_jsonb(r)->>'pessoa_nome', 'Colaborador') AS nom,
           COALESCE(to_jsonb(r)->>'created_at', to_jsonb(r)->>'criado_em')::timestamptz AS ts
    FROM recados r
  ) q
  WHERE q.aut IS NOT NULL
    AND (q.ts AT TIME ZONE 'America/Campo_Grande')::date = hoje
    AND NOT EXISTS (
      SELECT 1 FROM pontos_log p
      WHERE p.pessoa_id = q.aut AND p.tipo_acao = 'comentou_mural_de' AND p.data_acao = hoje
    )
  ORDER BY q.aut, q.ts;
  GET DIAGNOSTICS n_mural = ROW_COUNT;

  RAISE NOTICE 'OK login_diario=% | comentou_mural_de=% (dia %)', n_login, n_mural, hoje;
END $$;

-- 3) TAREFAS CONCLUIDAS (1 pt cada) -> MELHOR ESFORCO
-- A tabela nao guarda "quem concluiu quando" por pessoa (so o array concluida_por
-- + um carimbo de alteracao da tarefa). Creditamos cada pessoa do concluida_por
-- das tarefas mexidas HOJE. Bloco a prova de erro: se a coluna nao existir,
-- so avisa e segue (nao derruba o resto).
DO $$
DECLARE
  hoje date := (now() AT TIME ZONE 'America/Campo_Grande')::date;
  n_tar int := 0;
BEGIN
  INSERT INTO pontos_log (pessoa_id, pessoa_nome, tipo_acao, categoria, pontos, descricao, origem, data_acao)
  SELECT x.pid,
         COALESCE((SELECT pe.nome FROM pessoas pe WHERE pe.id = x.pid), 'Colaborador'),
         'tarefa_concluida', 'engajamento', 1, 'Tarefa concluida', 'backfill', hoje
  FROM (
    SELECT DISTINCT jsonb_array_elements_text(
             CASE jsonb_typeof(to_jsonb(t)->'concluida_por')
               WHEN 'array' THEN to_jsonb(t)->'concluida_por' ELSE '[]'::jsonb END
           ) AS pid
    FROM tarefas t
    WHERE (COALESCE(
             to_jsonb(t)->>'atualizado_em', to_jsonb(t)->>'updated_at',
             to_jsonb(t)->>'concluida_em',  to_jsonb(t)->>'created_at',
             to_jsonb(t)->>'criado_em'
           )::timestamptz AT TIME ZONE 'America/Campo_Grande')::date = hoje
  ) x
  WHERE x.pid IS NOT NULL AND x.pid <> ''
    AND NOT EXISTS (
      SELECT 1 FROM pontos_log p
      WHERE p.pessoa_id = x.pid AND p.tipo_acao = 'tarefa_concluida'
        AND p.data_acao = hoje AND p.origem = 'backfill'
    );
  GET DIAGNOSTICS n_tar = ROW_COUNT;
  RAISE NOTICE 'OK tarefa_concluida (melhor esforco)=% (dia %)', n_tar, hoje;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Tarefas puladas (coluna/estrutura diferente): %', SQLERRM;
END $$;

-- ============================================================
-- CONFERENCIA: o que entrou hoje por pessoa
-- ============================================================
SELECT pessoa_nome, tipo_acao, SUM(pontos) AS pts, COUNT(*) AS qtd
FROM pontos_log
WHERE data_acao = (now() AT TIME ZONE 'America/Campo_Grande')::date
GROUP BY pessoa_nome, tipo_acao
ORDER BY pessoa_nome, tipo_acao;
