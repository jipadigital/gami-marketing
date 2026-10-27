-- ============================================================
-- SEGURANÇA (parte 2): travar escrita de push + posts agendados
-- Versão em comandos SIMPLES (sem bloco DO), pra qualquer erro aparecer
-- claro e não derrubar o resto. RODE TUDO. Se alguma linha der ERRO
-- (vermelho), me mande o texto do erro que eu ajusto.
--
-- push_subscriptions / push_agendados: o app já grava pelo servidor (v33.22).
-- posts_agendados: já é gravado só por functions (service key).
-- Então travar aqui NÃO quebra nada. Leitura (SELECT) segue liberada.
-- REVERSÍVEL: ALTER TABLE x DISABLE ROW LEVEL SECURITY;
-- 27/10/2026
-- ============================================================

-- push_subscriptions
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS push_subscriptions_sel ON push_subscriptions;
CREATE POLICY push_subscriptions_sel ON push_subscriptions FOR SELECT TO anon, authenticated USING (true);

-- push_agendados
ALTER TABLE push_agendados ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS push_agendados_sel ON push_agendados;
CREATE POLICY push_agendados_sel ON push_agendados FOR SELECT TO anon, authenticated USING (true);

-- posts_agendados
ALTER TABLE posts_agendados ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS posts_agendados_sel ON posts_agendados;
CREATE POLICY posts_agendados_sel ON posts_agendados FOR SELECT TO anon, authenticated USING (true);

-- Confere depois (deve listar as 3 com rowsecurity = true):
-- SELECT relname, relrowsecurity FROM pg_class
--   WHERE relname IN ('push_subscriptions','push_agendados','posts_agendados');
