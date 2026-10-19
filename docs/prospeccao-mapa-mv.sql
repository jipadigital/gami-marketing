-- ============================================================
-- PROSPECÇÃO EM CAMPO (v32.34) — MV do mapa (empresas + coordenada)
-- ------------------------------------------------------------
-- A RPC mapa_empresas_cidade dá TIMEOUT em Campo Grande (590k corridas)
-- quando chamada pela REST/anon. Esta MV pré-agrega TODAS as cidades
-- (empresa + coord de coleta + nº de pedidos + último), igual à lógica
-- da RPC, mas materializada: a leitura vira instantânea (até CG).
-- Mesma estratégia da MV do raio-X: cria VAZIA (WITH NO DATA, instantâneo
-- no editor) e popula em segundo plano por pg_cron.
-- O app lê direto: /rest/v1/mv_prospeccao_mapa?cidade_slug=eq.<slug>
-- Seguro de rodar: cria do zero, não altera nada existente.
-- ============================================================

DROP MATERIALIZED VIEW IF EXISTS mv_prospeccao_mapa CASCADE;

CREATE MATERIALIZED VIEW mv_prospeccao_mapa AS
WITH base AS (
  SELECT
    c.cidade_slug,
    btrim(c.nome_passageiro)                        AS nome,
    NULLIF(c.raw->'coleta'->>'lat','')::numeric      AS lat,
    NULLIF(c.raw->'coleta'->>'lng','')::numeric      AS lng,
    NULLIF(btrim(c.raw->'coleta'->>'bairro'),'')     AS bairro,
    c.status_solicitacao                             AS st,
    c.data_hora_solicitacao                          AS dt
  FROM machine_corridas c
  WHERE c.data_hora_solicitacao >= now() - interval '180 days'
    AND btrim(COALESCE(c.nome_passageiro,'')) <> ''
),
agg AS (
  SELECT cidade_slug, nome,
    count(*)                          AS qtd,
    count(*) FILTER (WHERE st = 'F')  AS fin,
    max(dt)                           AS ultimo
  FROM base GROUP BY cidade_slug, nome
),
coord AS (  -- coord + bairro da corrida mais recente COM coordenada válida
  SELECT DISTINCT ON (cidade_slug, nome) cidade_slug, nome, lat, lng, bairro
  FROM base
  WHERE lat IS NOT NULL AND lng IS NOT NULL AND abs(lat) > 0.01 AND abs(lng) > 0.01
  ORDER BY cidade_slug, nome, dt DESC
),
bair AS (   -- bairro mais recente (mesmo sem coord)
  SELECT DISTINCT ON (cidade_slug, nome) cidade_slug, nome, bairro
  FROM base WHERE bairro IS NOT NULL
  ORDER BY cidade_slug, nome, dt DESC
)
SELECT
  a.cidade_slug,
  a.nome,
  co.lat,
  co.lng,
  COALESCE(co.bairro, b.bairro, '')  AS bairro,
  a.qtd                              AS qtd_pedidos,
  a.fin                              AS qtd_finalizadas,
  a.ultimo                           AS ultimo
FROM agg a
LEFT JOIN coord co ON co.cidade_slug = a.cidade_slug AND co.nome = a.nome
LEFT JOIN bair  b  ON b.cidade_slug  = a.cidade_slug AND b.nome  = a.nome
WITH NO DATA;

CREATE INDEX IF NOT EXISTS idx_mv_prosp_mapa_cidade ON mv_prospeccao_mapa (cidade_slug, qtd_pedidos DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_prosp_mapa_uk ON mv_prospeccao_mapa (cidade_slug, nome);

GRANT SELECT ON mv_prospeccao_mapa TO anon, authenticated;

-- Refresh (statement_timeout folgado; roda em background pelo cron, sem teto de HTTP)
CREATE OR REPLACE FUNCTION refresh_prospeccao_mapa()
RETURNS void LANGUAGE plpgsql
SET statement_timeout = '600s'
AS $ref$
BEGIN
  REFRESH MATERIALIZED VIEW mv_prospeccao_mapa;
END;
$ref$;

-- (Re)agenda: diário 06:40 UTC (após o sync) + bootstrap a cada 3min que se auto-desliga no 1º sucesso
DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('prospeccao_mapa_daily','prospeccao_mapa_bootstrap');
EXCEPTION WHEN OTHERS THEN NULL;
END $do$;

SELECT cron.schedule('prospeccao_mapa_daily', '40 6 * * *', $cron$ SELECT refresh_prospeccao_mapa(); $cron$);

SELECT cron.schedule('prospeccao_mapa_bootstrap', '*/3 * * * *', $cron$
  DO $b$
  BEGIN
    PERFORM refresh_prospeccao_mapa();
    -- popularam? desliga o bootstrap
    IF EXISTS (SELECT 1 FROM mv_prospeccao_mapa LIMIT 1) THEN
      PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'prospeccao_mapa_bootstrap';
    END IF;
  END $b$;
$cron$);
