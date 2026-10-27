-- ============================================================
-- SEGURANÇA (parte 2): travar escrita de push + posts agendados
-- RODAR SÓ DEPOIS da v33.22 estar no ar (push já roteado pelo servidor).
--
-- push_subscriptions / push_agendados: agora o app grava pelo servidor
--   (Netlify function, service key). Então travar aqui NÃO quebra nada.
-- posts_agendados: já é gravado só por functions (service key). Travar é seguro.
--
-- Leitura (SELECT) continua liberada pra chave pública, o dashboard lê normal.
-- REVERSÍVEL: troque ENABLE por DISABLE em qualquer uma se precisar.
-- 27/10/2026
-- ============================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['push_subscriptions','push_agendados','posts_agendados'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I;', t||'_anon_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO anon, authenticated USING (true);', t||'_anon_select', t);
  END LOOP;
END $$;

-- Teste rápido depois: abra o dashboard logado e a aba "Minha agenda".
--   A inscrição de push roda sozinha; se aparecer erro no console, me avise
--   que eu reverto na hora (é só o push, não afeta login nem dados).
