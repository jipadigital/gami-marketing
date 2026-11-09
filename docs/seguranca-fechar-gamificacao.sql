-- ============================================================================
-- FECHAR GAMIFICAÇÃO/INTERNO PARA O ANÔNIMO (lote R6 , 09/11/2026)
-- ----------------------------------------------------------------------------
-- A chave anônima ainda LIA estas tabelas (nome de funcionário + pontos/ações):
--   pontos_log, desafios_admin, badges_desbloqueadas, pulse_votos, stories_log,
--   estoque_itens, e a VIEW ranking_mensal.
--
-- PRÉ-REQUISITO (já no deploy de 09/11): o cliente passou a ler essas tabelas
-- pelo proxy (supabase-read, com a service key, atrás de sessão). Então, depois
-- de confirmar no dashboard que ranking/pontos/badges/mural/estoque continuam
-- aparecendo, pode rodar este SQL que o app NÃO quebra.
--
-- >>> RODE SÓ DEPOIS DE TESTAR O DASHBOARD LOGADO. <<<
-- ============================================================================

-- 1) TABELAS: liga RLS, remove TODAS as policies (sem SELECT policy o anon lê 0),
--    e revoga os privilégios do anon/authenticated (defesa em profundidade).
DO $$
DECLARE
  t text;
  pol record;
  tabelas text[] := ARRAY['pontos_log','desafios_admin','badges_desbloqueadas','pulse_votos','stories_log','estoque_itens'];
BEGIN
  FOREACH t IN ARRAY tabelas LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I;', pol.policyname, t);
    END LOOP;
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM authenticated;', t);
    RAISE NOTICE 'fechado: %', t;
  END LOOP;
END $$;

-- 2) VIEW ranking_mensal: view não tem RLS; fecha por REVOKE do grant de leitura.
--    O proxy (service_role) continua lendo.
REVOKE ALL ON public.ranking_mensal FROM anon;
REVOKE ALL ON public.ranking_mensal FROM authenticated;

-- Conferência (como anon, deve dar permission denied / 0 linhas):
-- SELECT * FROM public.pontos_log LIMIT 1;
-- SELECT * FROM public.ranking_mensal LIMIT 1;
