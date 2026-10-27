-- ============================================================
-- SEGURANÇA etapa 3 (R5, varredura final): fechar as exposições que a
-- auditoria achou , tabelas que o cliente quase não lê, então passaram
-- despercebidas, mas estavam legíveis pela chave pública:
--   • audit_log   , trilha de auditoria (quem fez o quê)
--   • acessos_log , log de acesso (logins)
--   • push_subscriptions , credenciais de push por aparelho (endpoint+chaves)
--   • push_agendados     , conteúdo de campanhas de push agendadas
--   • listar_backups_diarios (RPC) , metadados de backup (recon)
--
-- RODAR SÓ DEPOIS da v33.39 no ar E de você TESTAR: a tela de Auditoria
-- (abas Auditoria e Acessos carregam) e a tela de Backups (lista aparece).
-- Escrita de audit_log/acessos_log agora vai pelo servidor (supabase-write);
-- push_* já escrevia pelo servidor. A leitura passa pelo proxy supabase-read.
-- REVERSÍVEL: recriar policy *_sel; GRANT EXECUTE listar_backups_diarios TO anon.
-- 27/10/2026
-- ============================================================

-- Tabelas: RLS sem policy de SELECT (anon lê 0; service_role do proxy lê tudo)
DO $$
DECLARE t text; p record;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_log','acessos_log','push_subscriptions','push_agendados'] LOOP
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t);
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- RPC listar_backups_diarios: tira EXECUTE do público (app chama pelo proxy)
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.proname, oidvectortypes(p.proargtypes) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname = 'listar_backups_diarios'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated', f.proname, f.args);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role', f.proname, f.args);
  END LOOP;
END $$;

-- CONFERE: GET direto nas 4 tabelas pela chave pública deve voltar [];
-- listar_backups_diarios direto = permission denied/404.
-- Teste no app (logado): Auditoria, Acessos e Backups iguais.
