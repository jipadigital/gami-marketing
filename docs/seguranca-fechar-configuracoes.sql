-- ============================================================================
-- FECHAR configuracoes PARA O ANÔNIMO (lote R7 , 09/11/2026)
-- ----------------------------------------------------------------------------
-- configuracoes guarda estado interno (pulse, clima, ranking, badges) por chave.
-- Valor baixo (sem PII real), mas pra fechar 100% o anônimo. A ESCRITA já está
-- travada (vai pelo supabase-write). A LEITURA passou a ir pelo proxy (R7).
--
-- >>> RODE SÓ DEPOIS de testar: deslogar, recarregar (boot), logar de novo e
--     confirmar que direção/mural/clima/pulse/ranking carregam normalmente. <<<
-- Se algo sumir no boot, NÃO rode e me avise (a leitura pré-login precisa de ajuste).
-- ============================================================================

ALTER TABLE public.configuracoes ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE pol record;
BEGIN
  FOR pol IN SELECT policyname FROM pg_policies
             WHERE schemaname='public' AND tablename='configuracoes'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.configuracoes;', pol.policyname);
  END LOOP;
END $$;

REVOKE ALL ON public.configuracoes FROM anon;
REVOKE ALL ON public.configuracoes FROM authenticated;

-- Conferência (como anon deve dar permission denied / 0 linhas):
-- SELECT * FROM public.configuracoes LIMIT 1;
