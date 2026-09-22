-- RPC: empresas_churn_inteligente  (Churn Inteligente) — 22/09/2026
-- Diferente do "pararam de pedir (X dias)" (corte fixo que enche de falso positivo),
-- aqui a régua é o RITMO de CADA cliente. Só alerta quem está parado ALÉM do próprio
-- padrão. Usa o PERCENTIL 80 dos intervalos entre pedidos como "gap normal" do cliente
-- (robusto pra quem pede em rajada: ex. BELAITECH tem 5 dias de gap normal, então 5 dias
-- parada NÃO alerta; já quem pede todo dia e sumiu há 5 dias alerta).
--
-- Rodar no Supabase (SQL Editor). Depois o relatório "🎯 Churn inteligente" usa a função.

CREATE OR REPLACE FUNCTION empresas_churn_inteligente(
  p_cidade_slug   text,
  p_min_pedidos   int     DEFAULT 5,     -- histórico mínimo pra a cadência ser confiável
  p_fator         numeric DEFAULT 2.0,   -- alerta se gap atual > fator × gap normal (p80)
  p_lookback_dias int     DEFAULT 90,    -- janela pra medir o ritmo do cliente
  p_gap_min_dias  int     DEFAULT 3      -- piso: ignora quem parou há menos que isso
)
RETURNS TABLE(
  nome            text,
  telefone        text,
  bairro          text,
  ultimo_pedido   timestamptz,
  dias_sem_pedir  numeric,
  gap_normal_dias numeric,
  qtd_pedidos     bigint,
  razao           numeric
)
LANGUAGE sql STABLE
AS $fn$
  WITH base AS (
    SELECT c.nome_passageiro AS nome, c.data_hora_solicitacao AS dt
    FROM machine_corridas c
    WHERE c.cidade_slug = p_cidade_slug
      AND c.data_hora_solicitacao >= now() - (p_lookback_dias || ' days')::interval
      AND c.nome_passageiro IS NOT NULL
      AND btrim(c.nome_passageiro) <> ''
  ),
  gaps AS (
    SELECT
      nome, dt,
      EXTRACT(EPOCH FROM (dt - lag(dt) OVER (PARTITION BY nome ORDER BY dt))) / 86400.0 AS gap_dias
    FROM base
  ),
  stats AS (
    SELECT
      nome,
      count(*) AS qtd,
      max(dt)  AS ultimo,
      -- "gap normal" = percentil 80 dos intervalos entre pedidos (ignora o 1º, que é null)
      percentile_cont(0.8) WITHIN GROUP (ORDER BY gap_dias) FILTER (WHERE gap_dias IS NOT NULL) AS gap_normal
    FROM gaps
    GROUP BY nome
  ),
  calc AS (
    SELECT s.*, EXTRACT(EPOCH FROM (now() - s.ultimo)) / 86400.0 AS gap_atual
    FROM stats s
  )
  SELECT
    calc.nome,
    COALESCE(e.telefone, '')  AS telefone,
    COALESCE(NULLIF(btrim(e.bairro), ''), '—') AS bairro,
    calc.ultimo               AS ultimo_pedido,
    round(calc.gap_atual::numeric, 1)   AS dias_sem_pedir,
    round(calc.gap_normal::numeric, 1)  AS gap_normal_dias,
    calc.qtd                  AS qtd_pedidos,
    round((calc.gap_atual / NULLIF(calc.gap_normal, 0))::numeric, 1) AS razao
  FROM calc
  LEFT JOIN machine_empresas e
    ON e.cidade_slug = p_cidade_slug
   AND lower(btrim(e.nome)) = lower(btrim(calc.nome))
  WHERE calc.qtd >= p_min_pedidos
    AND calc.gap_normal IS NOT NULL
    AND calc.gap_normal > 0
    AND calc.gap_atual >= p_gap_min_dias
    AND calc.gap_atual > calc.gap_normal * p_fator
  ORDER BY (calc.gap_atual / NULLIF(calc.gap_normal, 0)) DESC, calc.gap_atual DESC;
$fn$;
