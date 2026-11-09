-- ============================================================================
-- CRÍTICO (09/11/2026) , FECHAR backups_diarios PARA O ANÔNIMO
-- ----------------------------------------------------------------------------
-- PROBLEMA: a tabela public.backups_diarios estava LEGÍVEL pela chave publicável
-- (anon). Cada linha guarda o backup diário COMPLETO: array `pessoas` (42) e,
-- pior, array `usuarios_login` (47) com `pin_hash`, `token_atual` (token de sessão
-- ATIVO), `token_recuperacao` e email. Qualquer um com a chave do site baixava o
-- hash do PIN e o token de sessão de TODA a equipe (= quebrar login offline e
-- sequestrar sessões). São ~61 backups diários expostos.
--
-- POR QUE É SEGURO FECHAR: o app NÃO lê essa tabela direto com a chave anônima.
-- A function download-backup.js lê com a SERVICE KEY (continua funcionando) e a
-- listagem usa a RPC listar_backups_diarios (já roteada pelo proxy). Então travar
-- o anon aqui não quebra nada.
--
-- O QUE FAZ: liga RLS, remove TODAS as policies (sem policy de SELECT o anon lê 0
-- linhas; o service_role ignora RLS) e, em defesa-em-profundidade, REVOGA os
-- privilégios dos papéis anon e authenticated na tabela.
-- ============================================================================

ALTER TABLE public.backups_diarios ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'backups_diarios'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.backups_diarios;', pol.policyname);
    RAISE NOTICE 'policy removida: %', pol.policyname;
  END LOOP;
END $$;

REVOKE ALL ON public.backups_diarios FROM anon;
REVOKE ALL ON public.backups_diarios FROM authenticated;

-- Conferência (deve dar permission denied / 0 linhas pra chave anônima):
-- SELECT * FROM public.backups_diarios LIMIT 1;   -- rode como anon pra testar
