-- RPC: empresas_raiox_cidade  (Raio-X das empresas) — v6, 28/09/2026
-- v6 acrescenta por empresa: HORA e DIA de pico (mode de hora/dow em America/Campo_Grande),
-- BAIRRO OPERACIONAL (bairro da coleta, preenche o que o cadastro deixa vazio) e TOP 3
-- BAIRROS DE ENTREGA (unnest das paradas). Tudo na MV, calculada em background por pg_cron
-- (não passa pelo teto do editor). Duas varreduras de machine_corridas (métricas+coleta, e
-- paradas); roda em <1-2 min no refresh (statement_timeout 600s).
--
-- Rodar TUDO no Supabase (SQL Editor) — volta rápido ("Success"); o resumo repopula em
-- ~poucos minutos (pg_cron), depois Ctrl+Shift+R.

-- 1) Estrutura (instantâneo) -------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS mv_empresas_raiox CASCADE;
CREATE MATERIALIZED VIEW mv_empresas_raiox AS
  WITH base AS (   -- varredura 1: campos leves + hora/dia + bairro da coleta (sem paradas)
    SELECT
      cidade_slug,
      btrim(nome_passageiro)                                          AS nome,
      data_hora_solicitacao                                          AS dt,
      status_solicitacao                                            AS st,
      COALESCE(valor_corrida,0)::numeric                             AS val,
      to_char(date_trunc('month', data_hora_solicitacao),'YYYY-MM')  AS ym,
      (extract(hour FROM data_hora_solicitacao AT TIME ZONE 'America/Campo_Grande'))::int AS hora,
      (extract(dow  FROM data_hora_solicitacao AT TIME ZONE 'America/Campo_Grande'))::int AS dow,
      NULLIF(btrim(raw->'coleta'->>'bairro'),'')                     AS bcol
    FROM machine_corridas
    WHERE data_hora_solicitacao >= date_trunc('month', now()) - interval '5 months'
      AND btrim(COALESCE(nome_passageiro,'')) <> ''
  ),
  agg AS (
    SELECT cidade_slug, nome,
      count(*) qtd, count(*) FILTER (WHERE st='F') fin, count(*) FILTER (WHERE st='C') canc,
      sum(val) FILTER (WHERE st='F') fat, min(dt) primeiro, max(dt) ultimo,
      mode() WITHIN GROUP (ORDER BY hora) hora_pico,
      mode() WITHIN GROUP (ORDER BY dow)  dia_pico,
      mode() WITHIN GROUP (ORDER BY bcol) bairro_op
    FROM base GROUP BY 1,2
  ),
  serie AS (
    SELECT cidade_slug, nome, jsonb_agg(jsonb_build_object('ym',ym,'n',n) ORDER BY ym) meses
    FROM ( SELECT cidade_slug, nome, ym, count(*) n FROM base GROUP BY 1,2,3 ) q
    GROUP BY 1,2
  ),
  entrega AS (   -- varredura 2: top 3 bairros pra onde a empresa entrega (paradas)
    SELECT cidade_slug, nome,
      string_agg(bairro || ' (' || n || ')', ', ' ORDER BY n DESC) bairros_entrega
    FROM (
      SELECT c.cidade_slug, btrim(c.nome_passageiro) AS nome,
        NULLIF(btrim(p->>'bairro'),'') AS bairro, count(*) n,
        row_number() OVER (PARTITION BY c.cidade_slug, btrim(c.nome_passageiro)
                           ORDER BY count(*) DESC) rn
      FROM machine_corridas c
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.raw->'paradas','[]'::jsonb)) p
      WHERE c.data_hora_solicitacao >= date_trunc('month', now()) - interval '5 months'
        AND btrim(COALESCE(c.nome_passageiro,'')) <> ''
        AND NULLIF(btrim(p->>'bairro'),'') IS NOT NULL
      GROUP BY c.cidade_slug, btrim(c.nome_passageiro), NULLIF(btrim(p->>'bairro'),'')
    ) q
    WHERE rn <= 3
    GROUP BY cidade_slug, nome
  )
  SELECT
    a.cidade_slug, a.nome,
    a.qtd::bigint  AS qtd_total,
    a.fin::bigint  AS qtd_finalizadas,
    a.canc::bigint AS qtd_canceladas,
    round(COALESCE(a.fat,0),2) AS faturamento,
    round(CASE WHEN a.fin>0 THEN a.fat/a.fin ELSE 0 END, 2) AS ticket,
    a.primeiro, a.ultimo, s.meses,
    a.hora_pico, a.dia_pico,
    COALESCE(a.bairro_op,'')       AS bairro_op,
    COALESCE(e.bairros_entrega,'') AS bairros_entrega
  FROM agg a
  LEFT JOIN serie   s ON s.cidade_slug = a.cidade_slug AND s.nome = a.nome
  LEFT JOIN entrega e ON e.cidade_slug = a.cidade_slug AND e.nome = a.nome
  WITH NO DATA;

CREATE INDEX IF NOT EXISTS idx_mv_raiox_cidade ON mv_empresas_raiox (cidade_slug, qtd_total DESC);

CREATE OR REPLACE FUNCTION refresh_raiox()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET statement_timeout TO '600s'
AS $ref$ BEGIN REFRESH MATERIALIZED VIEW mv_empresas_raiox; END; $ref$;

-- precisa dropar antes: a v6 mudou o tipo de retorno (colunas a mais)
DROP FUNCTION IF EXISTS empresas_raiox_cidade(text, integer, integer);
CREATE OR REPLACE FUNCTION empresas_raiox_cidade(
  p_cidade_slug text, p_meses int DEFAULT 6, p_min_pedidos int DEFAULT 1
)
RETURNS TABLE(
  nome text, bairro text, telefone text,
  qtd_total bigint, qtd_finalizadas bigint, qtd_canceladas bigint,
  faturamento numeric, ticket numeric,
  primeiro timestamptz, ultimo timestamptz, meses jsonb,
  hora_pico int, dia_pico int, bairros_entrega text
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
    COALESCE(NULLIF(m.bairro_op,''), NULLIF(btrim(e.bairro),''), '') AS bairro,
    COALESCE(e.telefone,'') AS telefone,
    m.qtd_total, m.qtd_finalizadas, m.qtd_canceladas,
    m.faturamento, m.ticket, m.primeiro, m.ultimo, m.meses,
    m.hora_pico, m.dia_pico, m.bairros_entrega
  FROM mv_empresas_raiox m
  LEFT JOIN emp e ON e.nk = lower(btrim(m.nome))
  WHERE m.cidade_slug = p_cidade_slug AND m.qtd_total >= p_min_pedidos
  ORDER BY m.qtd_total DESC;
$fn$;

-- 2) Repopular em background (pg_cron) --------------------------------------
SELECT cron.schedule('raiox_bootstrap', '*/3 * * * *',
  'DO $b$ BEGIN PERFORM refresh_raiox(); PERFORM cron.unschedule(''raiox_bootstrap''); END $b$;');
-- (o job diário raiox_daily continua valendo; chama refresh_raiox pra esta MV nova)
