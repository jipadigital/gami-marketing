-- ============================================================
-- SEGURANÇA (lote B): travar ESCRITA de estoque_itens, estoque_mov
-- e desafios_admin. RODAR SÓ DEPOIS da v33.32 no ar E de você TESTAR:
--   • cadastrar/editar/desativar um brinde (estoque_itens)
--   • registrar ENTRADA e VENDA (estoque_mov via RPC)
--   • editar uma venda (estoque_mov)
--   • criar/editar/encerrar um desafio (desafios_admin)
--
-- As escritas diretas do app já passam pelo servidor (service key).
-- Entrada/venda de estoque passam por RPC (estoque_registrar_entrada/
-- estoque_registrar_venda) — o PASSO 2 abaixo garante que essas RPCs
-- rodem como SECURITY DEFINER, então continuam inserindo em estoque_mov
-- mesmo com a chave pública travada.
-- REVERSÍVEL: ALTER TABLE x DISABLE ROW LEVEL SECURITY;
-- 27/10/2026
-- ============================================================

-- PASSO 1 — travar as 3 tabelas (só leitura pela chave pública)
DO $$
DECLARE t text; p record;
BEGIN
  FOREACH t IN ARRAY ARRAY['estoque_itens','estoque_mov','desafios_admin'] LOOP
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t);
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO anon, authenticated USING (true)', t||'_sel', t);
  END LOOP;
END $$;

-- PASSO 2 — garantir que as RPCs que mexem no estoque rodem como DEFINER
-- (dono da função = ignora RLS). Pega TODOS os overloads pelo nome.
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT n.nspname, p.proname, oidvectortypes(p.proargtypes) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public'
      AND p.proname IN ('estoque_registrar_entrada','estoque_registrar_venda')
  LOOP
    EXECUTE format('ALTER FUNCTION public.%I(%s) SECURITY DEFINER', f.proname, f.args);
  END LOOP;
END $$;

-- CONFERE (deve sobrar só *_sel em cada tabela):
-- SELECT tablename, policyname, cmd FROM pg_policies
--   WHERE tablename IN ('estoque_itens','estoque_mov','desafios_admin') ORDER BY 1,3;
-- CONFERE DEFINER (prosecdef = true):
-- SELECT proname, prosecdef FROM pg_proc
--   WHERE proname IN ('estoque_registrar_entrada','estoque_registrar_venda');

-- Teste depois: INSERT pela chave pública nas 3 tabelas deve dar 401;
-- o app deve continuar cadastrando/editando brinde, registrando entrada+
-- venda e criando/encerrando desafio normalmente.
