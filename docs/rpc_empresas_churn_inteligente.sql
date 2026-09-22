-- RPC: empresas_churn_inteligente  (Churn Inteligente) — v2, 22/09/2026
-- Régua = ritmo de CADA cliente, medido em DIAS ATIVOS (dias em que a empresa pediu),
-- não por pedido individual. Isso corrige o cliente que faz vários pedidos de uma vez
-- (rajada), que fazia o "gap normal" dar 0 e a razão explodir. gap_normal = percentil 80
-- dos intervalos entre dias ativos (o "maior gap normal" do cliente). Só alerta quem
-- está parado > fator × esse gap normal.
--
-- Rodar no Supabase (SQL Editor) — CREATE OR REPLACE, pode rodar por cima da versão antiga.

CREATE OR REPLACE FUNCTION empresas_churn_inteligente(
  p_cidade_slug   text,
  p_min_pedidos   int     DEFAULT 5,     -- total mínimo de pedidos (histórico)
  p_fator         numeric DEFAULT 2.0,   -- alerta se parado > fator × gap normal
  p_lookback_dias int     DEFAULT 90,    -- janela pra medir o ritmo
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
    SELECT c.nome_passageiro AS nome, c.data_hora_solicitacao AS dt,
           date_trunc('day', c.data_hora_solicitacao) AS dia
    FROM machine_corridas c
    WHERE c.cidade_slug = p_cidade_slug
      AND c.data_hora_solicitacao >= now() - (p_lookback_dias || ' days')::interval
      AND c.nome_passageiro IS NOT NULL
      AND btrim(c.nome_passageiro) <> ''
  ),
  dias AS (  -- dias DISTINTOS em que a empresa pediu
    SELECT DISTINCT nome, dia FROM base
  ),
  gaps AS (  -- intervalo (em dias) entre dias ativos consecutivos
    SELECT nome, dia,
      EXTRACT(EPOCH FROM (dia - lag(dia) OVER (PARTITION BY nome ORDER BY dia))) / 86400.0 AS gap_dias
    FROM dias
  ),
  cad AS (
    SELECT nome,
      count(*) AS dias_ativos,
      percentile_cont(0.8) WITHIN GROUP (ORDER BY gap_dias) FILTER (WHERE gap_dias IS NOT NULL) AS gap_normal
    FROM gaps GROUP BY nome
  ),
  tot AS (  -- total de pedidos + último pedido (timestamp real)
    SELECT nome, count(*) AS qtd, max(dt) AS ultimo_ts
    FROM base GROUP BY nome
  ),
  calc AS (
    SELECT c.nome, c.dias_ativos, c.gap_normal, t.qtd, t.ultimo_ts,
      EXTRACT(EPOCH FROM (now() - t.ultimo_ts)) / 86400.0 AS gap_atual
    FROM cad c JOIN tot t ON t.nome = c.nome
  )
  SELECT
    calc.nome,
    COALESCE(e.telefone, '')  AS telefone,
    COALESCE(NULLIF(btrim(e.bairro), ''), '—') AS bairro,
    calc.ultimo_ts            AS ultimo_pedido,
    round(calc.gap_atual::numeric, 1)   AS dias_sem_pedir,
    round(calc.gap_normal::numeric, 1)  AS gap_normal_dias,
    calc.qtd                  AS qtd_pedidos,
    round((calc.gap_atual / NULLIF(calc.gap_normal, 0))::numeric, 1) AS razao
  FROM calc
  LEFT JOIN machine_empresas e
    ON e.cidade_slug = p_cidade_slug
   AND lower(btrim(e.nome)) = lower(btrim(calc.nome))
  WHERE calc.qtd >= p_min_pedidos
    AND calc.dias_ativos >= 3           -- precisa de histórico de dias pra ter cadência
    AND calc.gap_normal IS NOT NULL
    AND calc.gap_normal > 0
    AND calc.gap_atual >= p_gap_min_dias
    AND calc.gap_atual > calc.gap_normal * p_fator
  ORDER BY (calc.gap_atual / NULLIF(calc.gap_normal, 0)) DESC, calc.gap_atual DESC;
$fn$;
