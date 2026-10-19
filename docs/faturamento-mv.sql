-- ============================================================
-- FATURAMENTO por cidade/DIA (DADOS SENSÍVEIS) — v32.45
-- ------------------------------------------------------------
-- Soma o valor das corridas FINALIZADAS (status 'F') por cidade e DIA,
-- últimos ~7 meses. Granularidade diária permite: (a) totais mensais
-- (os 5 meses), (b) comparação do MÊS ATÉ AGORA (ex: 01–19/09 × 01–19/10).
-- Pré-agregada (MV) pra ler rápido até Campo Grande, sem timeout.
-- SEGURANÇA: anon/authenticated NÃO leem (REVOKE); só a service key
-- (via a função Netlify faturamento.js, que valida a allowlist).
-- Cria VAZIA (WITH NO DATA) + pg_cron popula.
-- ============================================================

DROP MATERIALIZED VIEW IF EXISTS mv_faturamento_mensal CASCADE;  -- substituída pela diária
DROP MATERIALIZED VIEW IF EXISTS mv_faturamento_diario CASCADE;

CREATE MATERIALIZED VIEW mv_faturamento_diario AS
SELECT
  cidade_slug,
  (data_hora_solicitacao)::date                                         AS dia,
  round(sum(valor_corrida) FILTER (WHERE status_solicitacao = 'F'), 2)  AS faturamento,
  count(*)                 FILTER (WHERE status_solicitacao = 'F')      AS pedidos
FROM machine_corridas
WHERE data_hora_solicitacao >= date_trunc('month', now()) - interval '7 months'
GROUP BY cidade_slug, (data_hora_solicitacao)::date
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_fatdia_uk ON mv_faturamento_diario (cidade_slug, dia);

-- 🔒 Trava: só service_role lê.
REVOKE ALL ON mv_faturamento_diario FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION refresh_faturamento_diario()
RETURNS void LANGUAGE plpgsql SET statement_timeout = '600s'
AS $ref$ BEGIN REFRESH MATERIALIZED VIEW mv_faturamento_diario; END; $ref$;

-- (Re)agenda: diário 06:50 UTC + bootstrap a cada 3min que se auto-desliga no 1º sucesso.
-- (Também limpa os jobs antigos da MV mensal, se existirem.)
DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job
   WHERE jobname IN ('faturamento_daily','faturamento_bootstrap','faturamento_dia_daily','faturamento_dia_bootstrap');
EXCEPTION WHEN OTHERS THEN NULL;
END $do$;

SELECT cron.schedule('faturamento_dia_daily', '50 6 * * *', $cron$ SELECT refresh_faturamento_diario(); $cron$);

SELECT cron.schedule('faturamento_dia_bootstrap', '*/3 * * * *', $cron$
  DO $b$
  BEGIN
    PERFORM refresh_faturamento_diario();
    IF EXISTS (SELECT 1 FROM mv_faturamento_diario LIMIT 1) THEN
      PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'faturamento_dia_bootstrap';
    END IF;
  END $b$;
$cron$);
