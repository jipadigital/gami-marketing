-- ============================================================================
-- TRAVA DE SEGURANÇA: RPC ltv_periodo (achado na auditoria de 06/11/2026)
-- ----------------------------------------------------------------------------
-- PROBLEMA: a função ltv_periodo(p_cidade_slug, p_de, p_ate) estava EXECUTÁVEL
-- pela chave PÚBLICA (anon). Testado: retornava 1000 linhas de FATURAMENTO por
-- empresa (dado financeiro sensível) pra qualquer um com a chave do site, mesmo
-- sem login. As MVs base (mv_ltv_empresa*) já estavam 401; o furo era só o RPC,
-- que é SECURITY DEFINER e estava com EXECUTE concedido a PUBLIC.
--
-- CONSERTO: revogar EXECUTE de PUBLIC/anon/authenticated e conceder só ao
-- service_role. O painel de LTV NÃO quebra: a function ltv.js chama o RPC com a
-- SUPA_SERVICE_KEY (service_role), que mantém o acesso. Loop em pg_proc pra pegar
-- qualquer sobrecarga (overload) da função.
-- ============================================================================

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'ltv_periodo'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC;', r.sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon;', r.sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated;', r.sig);
    EXECUTE format('GRANT  EXECUTE ON FUNCTION %s TO service_role;', r.sig);
    RAISE NOTICE 'Travado: %', r.sig;
  END LOOP;
END $$;

-- Conferência (opcional): deve listar só service_role com EXECUTE.
-- SELECT p.proname, array_to_string(p.proacl, ' | ') AS acl
-- FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
-- WHERE n.nspname='public' AND p.proname='ltv_periodo';
