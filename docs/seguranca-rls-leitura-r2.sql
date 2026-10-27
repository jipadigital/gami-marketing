-- ============================================================
-- SEGURANÇA etapa 3 (R2): fechar a LEITURA da Machine e das RPCs
-- comerciais pela chave pública. RODAR SÓ DEPOIS da v33.35 no ar E de
-- você TESTAR os dashboards (métricas por cidade, mapa de empresas,
-- telefones de cliente/motorista, onboarding, churn, raio-x, motoboys).
--
-- Agora o app lê essas tabelas e RPCs pelo proxy supabase-read (service
-- role). Aqui a gente tira o acesso da chave pública:
--   • tabelas machine_*: liga RLS sem política → anon lê 0 linhas
--     (service_role ignora RLS e segue; a sincronização usa service key).
--   • 22 RPCs: REVOKE EXECUTE do público → anon não chama mais
--     (service_role mantém; o proxy chama por ele).
-- REVERSÍVEL: recriar policy *_sel / GRANT EXECUTE ... TO anon.
-- 27/10/2026
-- ============================================================

-- PASSO 1 — tabelas da Machine (dado de corrida, telefones de cliente e motorista)
DO $$
DECLARE t text; p record;
BEGIN
  FOREACH t IN ARRAY ARRAY['machine_corridas','machine_empresas','machine_condutores','machine_sync_log'] LOOP
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t);
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- PASSO 2 — RPCs comerciais/Machine: tira EXECUTE do público, mantém service_role
DO $$
DECLARE f record;
  nomes text[] := ARRAY[
    'acoes_gestor_semana','calendario_demanda_rede','clientes_onboarding','contar_corridas_por_cidade',
    'empresas_ativas_periodos','empresas_atividade_real','empresas_churn_inteligente','empresas_fantasmas',
    'empresas_pararam_30d','empresas_pararam_60d','empresas_pararam_90d','empresas_pararam_intervalo',
    'empresas_periodo_comparado','empresas_raiox_cidade','indicadores_cidade','mapa_empresas_cidade',
    'metricas_mensais_cidade','metricas_semanais_cidade','motoboys_atividade_real','motoboys_periodo_comparado',
    'prospeccao_sinal_machine','ranking_cidades_mes'
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

-- CONFERE tabelas (GET direto com a chave pública deve voltar [] vazio):
--   SELECT tablename, count(*) FROM pg_policies WHERE tablename LIKE 'machine_%' GROUP BY 1;
-- CONFERE RPC (chamada direta com a chave pública deve dar 404/permission denied):
--   SELECT proname FROM pg_proc WHERE proname = ANY(ARRAY['empresas_atividade_real','mapa_empresas_cidade']);
-- Teste no app (logado): dashboards de cidade, mapa e listas devem continuar iguais.
