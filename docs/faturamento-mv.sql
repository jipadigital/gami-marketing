-- ============================================================
-- FATURAMENTO por cidade/mês (DADOS SENSÍVEIS) — v32.42
-- ------------------------------------------------------------
-- Soma o valor das corridas FINALIZADAS (status 'F') por cidade e mês,
-- últimos 8 meses. Pré-agregada (MV) pra ler instantâneo até Campo Grande.
-- SEGURANÇA: o anon/authenticated NÃO lê esta MV (REVOKE). Só a service
-- key (via a função Netlify faturamento.js, que valida a allowlist) lê.
-- Cria VAZIA (WITH NO DATA) + pg_cron popula, como as outras MVs.
-- ============================================================

DROP MATERIALIZED VIEW IF EXISTS mv_faturamento_mensal CASCADE;

CREATE MATERIALIZED VIEW mv_faturamento_mensal AS
SELECT
  cidade_slug,
  to_char(date_trunc('month', data_hora_solicitacao), 'YYYY-MM')            AS ano_mes,
  round(sum(valor_corrida) FILTER (WHERE status_solicitacao = 'F'), 2)      AS faturamento,
  count(*)                 FILTER (WHERE status_solicitacao = 'F')          AS pedidos
FROM machine_corridas
WHERE data_hora_solicitacao >= date_trunc('month', now()) - interval '8 months'
GROUP BY cidade_slug, to_char(date_trunc('month', data_hora_solicitacao), 'YYYY-MM')
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_fat_uk ON mv_faturamento_mensal (cidade_slug, ano_mes);

-- 🔒 Trava: ninguém com a chave pública lê. Só service_role (bypassa).
REVOKE ALL ON mv_faturamento_mensal FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION refresh_faturamento_mensal()
RETURNS void LANGUAGE plpgsql SET statement_timeout = '600s'
AS $ref$ BEGIN REFRESH MATERIALIZED VIEW mv_faturamento_mensal; END; $ref$;

-- (Re)agenda: diário 06:50 UTC + bootstrap a cada 3min que se auto-desliga no 1º sucesso
DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('faturamento_daily','faturamento_bootstrap');
EXCEPTION WHEN OTHERS THEN NULL;
END $do$;

SELECT cron.schedule('faturamento_daily', '50 6 * * *', $cron$ SELECT refresh_faturamento_mensal(); $cron$);

SELECT cron.schedule('faturamento_bootstrap', '*/3 * * * *', $cron$
  DO $b$
  BEGIN
    PERFORM refresh_faturamento_mensal();
    IF EXISTS (SELECT 1 FROM mv_faturamento_mensal LIMIT 1) THEN
      PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'faturamento_bootstrap';
    END IF;
  END $b$;
$cron$);
