-- ============================================================
-- SEGURANÇA etapa 3 (R1): fechar a LEITURA das tabelas COMERCIAIS pela
-- chave pública. RODAR SÓ DEPOIS da v33.34 no ar E de você TESTAR que o
-- CRM e o mapa de prospecção ainda carregam (agora leem pelo proxy
-- supabase-read, não mais direto com a chave pública).
--
-- Como funciona: a RLS dessas tabelas já está LIGADA (etapa 2). Aqui a
-- gente só REMOVE a política de SELECT que liberava o anon. Sem política
-- de SELECT + RLS ligada = anon lê 0 linhas. O proxy usa o service_role,
-- que IGNORA RLS, então segue lendo. Resultado: só usuário Gâmi logado
-- (via proxy) enxerga esses dados; forasteiro com a chave não vê nada.
-- REVERSÍVEL: recriar a policy *_sel (FOR SELECT TO anon USING(true)).
-- 27/10/2026
-- ============================================================

-- TABELAS comerciais: dropa TODAS as políticas (some a de SELECT; escrita
-- já estava bloqueada). RLS continua ligada.
DO $$
DECLARE t text; p record;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'crm_leads','crm_atividades','crm_tarefas','crm_checklist','crm_metas','crm_scripts','crm_config',
    'prospeccao_lojas','prospeccao_visitas','prospeccao_rotas'
  ] LOOP
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t);
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);  -- garante ligada
  END LOOP;
END $$;

-- MATERIALIZED VIEWS não têm RLS; o controle é por GRANT. Tira o anon/authenticated
-- e mantém o service_role (o proxy).
REVOKE SELECT ON public.mv_prospeccao_mapa FROM anon, authenticated;
REVOKE SELECT ON public.mv_empresas_raiox  FROM anon, authenticated;
GRANT  SELECT ON public.mv_prospeccao_mapa TO service_role;
GRANT  SELECT ON public.mv_empresas_raiox  TO service_role;

-- CONFERE (as tabelas não devem ter mais nenhuma policy):
-- SELECT tablename, count(*) FROM pg_policies
--   WHERE tablename IN ('crm_leads','prospeccao_lojas') GROUP BY 1;
-- Teste depois: GET direto com a chave pública em crm_leads deve voltar [] (vazio);
-- o app (logado, via proxy) deve continuar mostrando os leads e o mapa.
