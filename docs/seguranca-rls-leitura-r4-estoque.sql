-- ============================================================
-- SEGURANÇA etapa 3 (R4 estoque): fechar o vazamento de PII de CLIENTE
-- nas vendas de brinde. `estoque_vendas`/`estoque_vendas_agrupadas`
-- devolvem cliente_nome e cliente_telefone; a tabela `estoque_mov` também
-- estava legível direto pela chave pública. RODAR SÓ DEPOIS da v33.37 no
-- ar E de você TESTAR a tela de Estoque (saldos, vitrine, histórico de
-- vendas, dashboard, distribuição por cidade).
--
-- As RPCs de leitura do estoque agora vão pelo proxy supabase-read
-- (service role). Aqui tiramos o EXECUTE do público e trancamos a leitura
-- da tabela. As RPCs de ESCRITA (estoque_registrar_entrada/venda) também são
-- fechadas (PASSO 3): o app agora registra entrada/venda pelo servidor
-- (supabase-write, sessão), então o anon não chama mais , fecha a brecha de
-- inserir venda/entrada falsa pela chave pública.
-- REVERSÍVEL: GRANT EXECUTE ... TO anon; recriar policy *_sel.
-- 27/10/2026
-- ============================================================

-- PASSO 1 — RPCs de leitura do estoque: tira EXECUTE do público, mantém service_role
DO $$
DECLARE f record;
  nomes text[] := ARRAY[
    'estoque_saldo','estoque_vendas','estoque_dashboard','estoque_vitrine',
    'estoque_distribuicao_cidades','estoque_vendas_agrupadas'
  ];
BEGIN
  FOR f IN
    SELECT p.proname, oidvectortypes(p.proargtypes) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname = ANY(nomes)
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated', f.proname, f.args);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role', f.proname, f.args);
  END LOOP;
END $$;

-- PASSO 2 — tabela estoque_mov (vendas com nome/telefone de cliente): RLS sem policy.
-- Escrita já vai por service key (patch) e por RPC definer (entrada/venda), que ignoram RLS.
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='estoque_mov' LOOP
    EXECUTE format('DROP POLICY %I ON public.estoque_mov', p.policyname);
  END LOOP;
  ALTER TABLE public.estoque_mov ENABLE ROW LEVEL SECURITY;
END $$;

-- PASSO 3 — RPCs de ESCRITA do estoque: tira EXECUTE do público (agora o app
-- registra entrada/venda pelo servidor supabase-write com sessão).
DO $$
DECLARE f record;
  nomes text[] := ARRAY['estoque_registrar_entrada','estoque_registrar_venda'];
BEGIN
  FOR f IN
    SELECT p.proname, oidvectortypes(p.proargtypes) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname = ANY(nomes)
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated', f.proname, f.args);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role', f.proname, f.args);
  END LOOP;
END $$;

-- CONFERE: GET direto em estoque_mov pela chave pública deve voltar [];
-- chamar estoque_vendas/estoque_registrar_venda pela chave pública = permission denied/404.
-- Teste no app (logado): tela de Estoque igual, E registrar entrada+venda funcionando.
