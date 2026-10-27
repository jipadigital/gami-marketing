-- ============================================================
-- SEGURANÇA etapa 3 (R3, PII do time): fechar a LEITURA de `pessoas`
-- (nome, email, telefone, cargo) pela chave pública. As tabelas de ponto
-- já estão fechadas pra leitura anon; aqui só confirmamos (idempotente).
-- RODAR SÓ DEPOIS da v33.36 no ar E de você TESTAR: diretório do time,
-- perfil no login, permissões, e as telas de ponto (admin e do colaborador).
--
-- pessoas e ponto_* já têm a ESCRITA trancada (etapa 2). Aqui dropamos a
-- policy de SELECT (que liberava o anon) e garantimos RLS ligada. O app lê
-- pelo proxy supabase-read (service role, ignora RLS); as functions do
-- servidor (login.js etc.) já usam service key, então seguem iguais.
-- REVERSÍVEL: recriar policy *_sel (FOR SELECT TO anon USING(true)).
-- 27/10/2026
-- ============================================================

DO $$
DECLARE t text; p record;
BEGIN
  FOREACH t IN ARRAY ARRAY['pessoas','ponto_registros','ponto_log_admin','ponto_config'] LOOP
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t);
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- CONFERE: GET direto com a chave pública em pessoas deve voltar [] (vazio).
--   SELECT tablename, count(*) FROM pg_policies
--     WHERE tablename IN ('pessoas','ponto_registros','ponto_log_admin','ponto_config') GROUP BY 1;
-- Teste no app (logado): diretório do time, perfil, permissões e ponto iguais.
-- ATENÇÃO: se algum nome aparecer em branco ou o login não puxar o perfil,
-- é leitura de pessoas que não passou pelo proxy — me avisa ANTES de deixar travado.
