-- RPC: mapa_empresas_cidade  (Mapa de calor / Zona quente) — 25/09/2026
-- Agrega as corridas por EMPRESA (nome_passageiro) numa cidade e devolve, pra cada uma,
-- a coordenada de COLETA (onde o motoboy pega = onde a empresa que pede fica), o bairro,
-- o volume de pedidos, finalizadas/canceladas, faturamento e o ultimo pedido.
-- Serve pro mapa de calor (peso = qtd_pedidos) + ranking por bairro + lista de top empresas.
--
-- A coordenada vem do JSON bruto: raw->'coleta'->>'lat'/'lng'/'bairro'. Cobertura ~100%.
-- coord representativa = a da corrida MAIS RECENTE que tem coordenada (o endereco de coleta
-- da empresa e estavel). Empresa sem nenhuma coord ainda entra no ranking por bairro.
--
-- Rodar no Supabase (SQL Editor) — CREATE OR REPLACE, pode rodar por cima.

CREATE OR REPLACE FUNCTION mapa_empresas_cidade(
  p_cidade_slug text,
  p_dias        int DEFAULT 90,
  p_min_pedidos int DEFAULT 1
)
RETURNS TABLE(
  nome            text,
  lat             numeric,
  lng             numeric,
  bairro          text,
  qtd_pedidos     bigint,
  qtd_finalizadas bigint,
  qtd_canceladas  bigint,
  valor_total     numeric,
  ultimo          timestamptz
)
LANGUAGE sql STABLE
AS $fn$
  WITH base AS (
    SELECT
      btrim(c.nome_passageiro)                              AS nome,
      NULLIF(c.raw->'coleta'->>'lat','')::numeric           AS lat,
      NULLIF(c.raw->'coleta'->>'lng','')::numeric           AS lng,
      NULLIF(btrim(c.raw->'coleta'->>'bairro'),'')          AS bairro,
      c.status_solicitacao                                  AS st,
      COALESCE(c.valor_corrida,0)::numeric                  AS val,
      c.data_hora_solicitacao                               AS dt
    FROM machine_corridas c
    WHERE c.cidade_slug = p_cidade_slug
      AND c.data_hora_solicitacao >= now() - (p_dias || ' days')::interval
      AND btrim(COALESCE(c.nome_passageiro,'')) <> ''
  ),
  agg AS (
    SELECT nome,
      count(*)                              AS qtd,
      count(*) FILTER (WHERE st = 'F')      AS fin,
      count(*) FILTER (WHERE st = 'C')      AS canc,
      sum(val) FILTER (WHERE st = 'F')      AS valor,
      max(dt)                               AS ultimo
    FROM base GROUP BY nome
  ),
  coord AS (  -- coord + bairro da corrida mais recente COM coordenada valida
    SELECT DISTINCT ON (nome) nome, lat, lng, bairro
    FROM base
    WHERE lat IS NOT NULL AND lng IS NOT NULL
      AND abs(lat) > 0.01 AND abs(lng) > 0.01
    ORDER BY nome, dt DESC
  ),
  bair AS (   -- bairro da corrida mais recente (mesmo sem coord), pro ranking
    SELECT DISTINCT ON (nome) nome, bairro
    FROM base WHERE bairro IS NOT NULL
    ORDER BY nome, dt DESC
  )
  SELECT
    a.nome,
    co.lat,
    co.lng,
    COALESCE(co.bairro, b.bairro, '')       AS bairro,
    a.qtd                                    AS qtd_pedidos,
    a.fin                                    AS qtd_finalizadas,
    a.canc                                   AS qtd_canceladas,
    round(COALESCE(a.valor,0), 2)            AS valor_total,
    a.ultimo                                 AS ultimo
  FROM agg a
  LEFT JOIN coord co ON co.nome = a.nome
  LEFT JOIN bair  b  ON b.nome  = a.nome
  WHERE a.qtd >= p_min_pedidos
  ORDER BY a.qtd DESC;
$fn$;
