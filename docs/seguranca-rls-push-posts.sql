-- ============================================================
-- SEGURANÇA (parte 2 - FINAL): remover as políticas ANTIGAS que
-- deixavam qualquer um ESCREVER em push/posts.
--
-- Diagnóstico mostrou: RLS já está LIGADO nas 3, mas existem políticas
-- permissivas de ESCRITA (ALL / INSERT / UPDATE / DELETE pro public).
-- Basta DROPAR essas e manter só a de leitura (SELECT).
--
-- Depois disto: a chave pública só LÊ; escrita só pelo servidor (service key).
-- Nada quebra (o app já grava pelo servidor desde a v33.22).
-- 27/10/2026
-- ============================================================

-- push_subscriptions: tira a política "ALL" permissiva
DROP POLICY IF EXISTS "p_push_subs_all" ON push_subscriptions;

-- push_agendados: tira a política "ALL" permissiva
DROP POLICY IF EXISTS "p_push_ag_all" ON push_agendados;

-- posts_agendados: tira as permissivas de escrita (mantém leitura)
DROP POLICY IF EXISTS "Permitir todos escreverem posts_agendados" ON posts_agendados;
DROP POLICY IF EXISTS "Permitir todos atualizarem posts_agendados" ON posts_agendados;
DROP POLICY IF EXISTS "Permitir todos apagarem posts_agendados" ON posts_agendados;

-- (limpeza opcional) remove as políticas de leitura DUPLICADAS, deixa só *_sel
DROP POLICY IF EXISTS "push_subscriptions_anon_select" ON push_subscriptions;
DROP POLICY IF EXISTS "push_agendados_anon_select" ON push_agendados;
DROP POLICY IF EXISTS "posts_agendados_anon_select" ON posts_agendados;
DROP POLICY IF EXISTS "Permitir todos lerem posts_agendados" ON posts_agendados;

-- Confere: deve sobrar só as políticas *_sel (SELECT) em cada tabela.
-- SELECT tablename, policyname, cmd FROM pg_policies
--   WHERE tablename IN ('push_subscriptions','push_agendados','posts_agendados') ORDER BY 1,3;
