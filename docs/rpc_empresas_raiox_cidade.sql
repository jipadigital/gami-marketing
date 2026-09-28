-- RPC: empresas_raiox_cidade  (Raio-X das empresas) — v5, 28/09/2026
-- Por que v5: a v4 criava a MATERIALIZED VIEW já com dados, mas isso varre ~1,2 GB (Campo
-- Grande, o campo raw é gordo) e estoura o teto do SQL Editor do Supabase ("upstream timeout").
-- v5: no editor só rodam comandos INSTANTÂNEOS (MV vazia + funções). O cálculo pesado (o
-- REFRESH) roda em SEGUNDO PLANO via pg_cron, que não tem teto de HTTP. Um job "bootstrap"
-- popula em ~poucos minutos e se apaga sozinho; um job diário mantém atualizado.
--
-- Rodar TUDO isto no Supabase (SQL Editor). Deve voltar rápido ("Success"). Espere ~3-5 min
-- pro relatório encher (o bootstrap roda em background), depois Ctrl+Shift+R.

-- 1) Estrutura (instantâneo) -------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS mv_empresas_raiox CASCADE;
CREATE MATERIALIZED VIEW mv_empresas_raiox AS
  WITH mes AS (
    SELECT
      cidade_slug,
      btrim(nome_passageiro)                                          AS nome,
      to_char(date_trunc('month', data_hora_solicitacao),'YYYY-MM')   AS ym,
      count(*)                                                       AS n,
      count(*) FILTER (WHERE status_solicitacao='F')                 AS fin,
      count(*) FILTER (WHERE status_solicitacao='C')                 AS canc,
      sum(COALESCE(valor_corrida,0)) FILTER (WHERE status_solicitacao='F') AS fat,
      min(data_hora_solicitacao)                                     AS primeiro,
      max(data_hora_solicitacao)                                     AS ultimo
    FROM machine_corridas
    WHERE data_hora_solicitacao >= date_trunc('month', now()) - interval '5 months'
      AND btrim(COALESCE(nome_passageiro,'')) <> ''
    GROUP BY 1, 2, 3
  )
  SELECT
    cidade_slug, nome,
    sum(n)::bigint    AS qtd_total,
    sum(fin)::bigint  AS qtd_finalizadas,
    sum(canc)::bigint AS qtd_canceladas,
    round(sum(fat),2) AS faturamento,
    round(CASE WHEN sum(fin)>0 THEN sum(fat)/sum(fin) ELSE 0 END, 2) AS ticket,
    min(primeiro)     AS primeiro,
    max(ultimo)       AS ultimo,
    jsonb_agg(jsonb_build_object('ym',ym,'n',n) ORDER BY ym) AS meses
  FROM mes
  GROUP BY cidade_slug, nome
  WITH NO DATA;   -- <<< cria VAZIA (instantâneo); o pg_cron popula depois

CREATE INDEX IF NOT EXISTS idx_mv_raiox_cidade ON mv_empresas_raiox (cidade_slug, qtd_total DESC);

CREATE OR REPLACE FUNCTION refresh_raiox()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET statement_timeout TO '300s'
AS $ref$ BEGIN REFRESH MATERIALIZED VIEW mv_empresas_raiox; END; $ref$;

CREATE OR REPLACE FUNCTION empresas_raiox_cidade(
  p_cidade_slug text, p_meses int DEFAULT 6, p_min_pedidos int DEFAULT 1
)
RETURNS TABLE(
  nome text, bairro text, telefone text,
  qtd_total bigint, qtd_finalizadas bigint, qtd_canceladas bigint,
  faturamento numeric, ticket numeric,
  primeiro timestamptz, ultimo timestamptz, meses jsonb
)
LANGUAGE sql STABLE
AS $fn$
  WITH emp AS (
    SELECT DISTINCT ON (lower(btrim(nome))) lower(btrim(nome)) AS nk, telefone, bairro
    FROM machine_empresas WHERE cidade_slug = p_cidade_slug
    ORDER BY lower(btrim(nome)), (telefone IS NULL OR btrim(telefone) = ''), nome
  )
  SELECT
    m.nome,
    COALESCE(NULLIF(btrim(e.bairro),''),'') AS bairro,
    COALESCE(e.telefone,'')                 AS telefone,
    m.qtd_total, m.qtd_finalizadas, m.qtd_canceladas,
    m.faturamento, m.ticket, m.primeiro, m.ultimo, m.meses
  FROM mv_empresas_raiox m
  LEFT JOIN emp e ON e.nk = lower(btrim(m.nome))
  WHERE m.cidade_slug = p_cidade_slug AND m.qtd_total >= p_min_pedidos
  ORDER BY m.qtd_total DESC;
$fn$;

-- 2) Cálculo pesado em SEGUNDO PLANO (pg_cron, sem teto de HTTP) --------------
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- mantém atualizado todo dia às 06:30 UTC (03:30 BR)
SELECT cron.schedule('raiox_daily', '30 6 * * *', 'SELECT refresh_raiox();');

-- popula AGORA: roda a cada 3 min e se apaga sozinho no 1º sucesso
SELECT cron.schedule('raiox_bootstrap', '*/3 * * * *',
  'DO $b$ BEGIN PERFORM refresh_raiox(); PERFORM cron.unschedule(''raiox_bootstrap''); END $b$;');

-- Se em ~10 min o relatório não encher, rode manualmente pra ver o erro:
--   SELECT refresh_raiox();
-- E pra parar o bootstrap na mão (caso não tenha se apagado):
--   SELECT cron.unschedule('raiox_bootstrap');
