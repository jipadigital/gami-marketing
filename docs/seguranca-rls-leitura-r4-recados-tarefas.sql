-- ============================================================
-- SEGURANÇA etapa 3 (R4 conteúdo interno): fechar a LEITURA de `recados`
-- (mural: texto + autor) e `tarefas` (texto da tarefa + pessoa) pela chave
-- pública, mais a RPC `tarefas_minhas` (devolvia tarefa de qualquer pessoa).
-- RODAR SÓ DEPOIS da v33.38 no ar E de você TESTAR: mural (recados aparecem
-- e postam) e o painel de tarefas (listar, criar, concluir, delegar).
--
-- Escrita de recados/tarefas já vai pelo servidor (etapa 2). Aqui dropamos a
-- policy de SELECT e garantimos RLS; o app lê pelo proxy supabase-read.
-- REVERSÍVEL: recriar policy *_sel; GRANT EXECUTE tarefas_minhas TO anon.
-- 27/10/2026
-- ============================================================

-- Tabelas: recados + tarefas (RLS sem policy de SELECT)
DO $$
DECLARE t text; p record;
BEGIN
  FOREACH t IN ARRAY ARRAY['recados','tarefas'] LOOP
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t);
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- RPC tarefas_minhas: tira EXECUTE do público (app chama pelo proxy)
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.proname, oidvectortypes(p.proargtypes) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname = 'tarefas_minhas'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated', f.proname, f.args);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role', f.proname, f.args);
  END LOOP;
END $$;

-- CONFERE: GET direto em recados/tarefas pela chave pública deve voltar [];
-- tarefas_minhas direto = permission denied/404.
-- Teste no app (logado): mural e tarefas iguais.
