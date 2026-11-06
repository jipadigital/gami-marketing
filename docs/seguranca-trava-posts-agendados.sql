-- ============================================================================
-- TRAVA DE SEGURANÇA: posts_agendados (achado na auditoria de 06/11/2026)
-- ----------------------------------------------------------------------------
-- PROBLEMA: a chave PÚBLICA lia posts_agendados direto (419 linhas): calendário
-- de posts do Instagram, legendas, URLs de mídia, @ das contas, quem agendou.
-- Dado interno de marketing, não deveria ser público.
--
-- PRÉ-REQUISITO (já no deploy de 06/11): as functions posts-agenda.js e
-- posts-publicar.js passaram a usar a SERVICE KEY (SUPA_SERVICE_KEY) primeiro,
-- então ignoram RLS. O painel "Central de Marketing" lê os posts por essas
-- functions (/.netlify/functions/posts-agenda), NÃO pela chave pública.
--
-- >>> RODAR SÓ DEPOIS de confirmar no painel que os agendamentos ainda carregam. <<<
--
-- CONSERTO: manter RLS ligada e remover TODAS as políticas (inclusive a de
-- leitura anon). Sem política de SELECT, o anon lê 0 linhas; o service_role das
-- functions ignora RLS e continua lendo/gravando normalmente.
-- ============================================================================

ALTER TABLE public.posts_agendados ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'posts_agendados'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.posts_agendados;', pol.policyname);
    RAISE NOTICE 'Policy removida: %', pol.policyname;
  END LOOP;
END $$;

-- Conferência: deve voltar 0 linhas (nenhuma policy sobrou).
-- SELECT policyname, cmd FROM pg_policies
-- WHERE schemaname='public' AND tablename='posts_agendados';
