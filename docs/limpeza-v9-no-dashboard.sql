-- ============================================================
-- LIMPEZA (16/11/2026): o financeiro-v9 foi rodado por engano no banco do DASHBOARD
-- (projeto gami-marketing, tdbyzsouhrhmhpctttps). Isto remove SÓ o que o v9 criou lá.
--
-- RODE APENAS NO PROJETO "gami-marketing". Travas de segurança:
--  1) se não existir a tabela usuarios_login (que só existe no dashboard), PARA;
--  2) se o espelho tiver QUALQUER linha (o do financeiro de verdade tem), PARA.
-- Tudo numa transação: ou sai tudo, ou nada.
-- ============================================================
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.usuarios_login') IS NULL THEN
    RAISE EXCEPTION 'PARADO: este não é o banco do dashboard (gami-marketing). Nada foi apagado.';
  END IF;
  IF to_regclass('public.fin_kmn_lanc') IS NOT NULL AND EXISTS (SELECT 1 FROM fin_kmn_lanc) THEN
    RAISE EXCEPTION 'PARADO: o espelho tem dados, este parece o banco do financeiro. Nada foi apagado.';
  END IF;
  IF to_regclass('public.fin_kmn_pessoas') IS NOT NULL AND EXISTS (SELECT 1 FROM fin_kmn_pessoas) THEN
    RAISE EXCEPTION 'PARADO: há pessoas no espelho, este parece o banco do financeiro. Nada foi apagado.';
  END IF;
END $$;

-- tarefa agendada
DO $$ BEGIN PERFORM cron.unschedule('fin_kmn_diarias'); EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- views
DROP VIEW IF EXISTS fin_kmn_v_mudancas;
DROP VIEW IF EXISTS fin_kmn_v;

-- coluna que o v9 acrescentou nos alertas
ALTER TABLE fin_alertas DROP COLUMN IF EXISTS kmn_lanc_id;

-- tabelas (as que apontam pro espelho primeiro)
DROP TABLE IF EXISTS fin_kmn_conf;
DROP TABLE IF EXISTS fin_kmn_versoes;
DROP TABLE IF EXISTS fin_kmn_lanc;
DROP TABLE IF EXISTS fin_kmn_pessoas_versoes;
DROP TABLE IF EXISTS fin_kmn_pessoas;
DROP TABLE IF EXISTS fin_kmn_sync;

-- funções do v9
DROP FUNCTION IF EXISTS fin_kmn_regras_diarias();
DROP FUNCTION IF EXISTS fin_kmn_resumo(text, text, date, date);
DROP FUNCTION IF EXISTS fin_kmn_conferir(text, bigint[], text, text);
DROP FUNCTION IF EXISTS fin_kmn_pessoas_aplicar(jsonb, boolean);
DROP FUNCTION IF EXISTS fin_kmn_sumiram(text, bigint[], boolean);
DROP FUNCTION IF EXISTS fin_kmn_aplicar(text, jsonb, boolean);
DROP FUNCTION IF EXISTS fin__kmn_regras(bigint, jsonb, text[], text);
DROP FUNCTION IF EXISTS fin__kmn_eh_folha(text);
DROP FUNCTION IF EXISTS fin__kmn_mesma_pessoa(text, text);
DROP FUNCTION IF EXISTS fin__kmn_alerta(text, text, text, text, jsonb, bigint, numeric);
DROP FUNCTION IF EXISTS fin_trg_kmn_guard();
DROP FUNCTION IF EXISTS fin__kn(text);
DROP FUNCTION IF EXISTS fin__kd(text);

-- (as 2 linhas de configuração kmn_* ficam: fin_config é permanente por regra antifraude e
--  elas não fazem nada sem as tabelas)

COMMIT;

-- Conferência: deve voltar 0 linhas
SELECT relname FROM pg_class WHERE relname LIKE 'fin_kmn%';
