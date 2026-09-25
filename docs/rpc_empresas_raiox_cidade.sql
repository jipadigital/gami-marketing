-- RPC: empresas_raiox_cidade  (Raio-X das empresas / relatório completo) — 25/09/2026
-- Uma linha por empresa (nome_passageiro) com tudo que dá pra tabular pro PDF/impressão:
-- total de pedidos, finalizadas, canceladas, faturamento, ticket, primeiro/último pedido,
-- telefone (join machine_empresas por nome) e a série MÊS A MÊS (jsonb) dos últimos N meses.
-- A tendência (subindo/estável/caindo) é calculada no cliente a partir da série.
--
-- Só serve pra cidades que estão no espelho machine_corridas (hoje: campo-grande). As demais
-- caem no fallback ao vivo do cliente (~45 dias).
--
-- Rodar no Supabase (SQL Editor) — CREATE OR REPLACE, pode rodar por cima.

CREATE OR REPLACE FUNCTION empresas_raiox_cidade(
  p_cidade_slug text,
  p_meses       int DEFAULT 6,
  p_min_pedidos int DEFAULT 1
)
RETURNS TABLE(
  nome            text,
  bairro          text,
  telefone        text,
  qtd_total       bigint,
  qtd_finalizadas bigint,
  qtd_canceladas  bigint,
  faturamento     numeric,
  ticket          numeric,
  primeiro        timestamptz,
  ultimo          timestamptz,
  meses           jsonb
)
LANGUAGE sql STABLE
AS $fn$
  WITH base AS (
    SELECT
      btrim(c.nome_passageiro)                                          AS nome,
      NULLIF(btrim(c.raw->'coleta'->>'bairro'),'')                      AS bairro,
      c.status_solicitacao                                             AS st,
      COALESCE(c.valor_corrida,0)::numeric                             AS val,
      c.data_hora_solicitacao                                         AS dt,
      to_char(date_trunc('month', c.data_hora_solicitacao),'YYYY-MM')  AS ym
    FROM machine_corridas c
    WHERE c.cidade_slug = p_cidade_slug
      AND c.data_hora_solicitacao >= date_trunc('month', now()) - ((p_meses-1) || ' months')::interval
      AND btrim(COALESCE(c.nome_passageiro,'')) <> ''
  ),
  agg AS (
    SELECT nome,
      count(*)                            AS qtd,
      count(*) FILTER (WHERE st='F')      AS fin,
      count(*) FILTER (WHERE st='C')      AS canc,
      sum(val) FILTER (WHERE st='F')      AS fat,
      min(dt) AS primeiro, max(dt) AS ultimo
    FROM base GROUP BY nome
  ),
  serie AS (
    SELECT nome, jsonb_agg(jsonb_build_object('ym',ym,'n',n) ORDER BY ym) AS meses
    FROM ( SELECT nome, ym, count(*) AS n FROM base GROUP BY nome, ym ) q
    GROUP BY nome
  ),
  bair AS (
    SELECT DISTINCT ON (nome) nome, bairro
    FROM base WHERE bairro IS NOT NULL ORDER BY nome, dt DESC
  ),
  emp AS (  -- 1 telefone por nome (evita duplicar a linha quando ha 2 cadastros com o mesmo nome)
    SELECT DISTINCT ON (lower(btrim(nome))) lower(btrim(nome)) AS nk, telefone
    FROM machine_empresas
    WHERE cidade_slug = p_cidade_slug
    ORDER BY lower(btrim(nome)), (telefone IS NULL OR btrim(telefone) = ''), nome
  )
  SELECT
    a.nome,
    COALESCE(b.bairro,'')                                  AS bairro,
    COALESCE(e.telefone,'')                                AS telefone,
    a.qtd                                                  AS qtd_total,
    a.fin                                                  AS qtd_finalizadas,
    a.canc                                                 AS qtd_canceladas,
    round(COALESCE(a.fat,0),2)                             AS faturamento,
    round(CASE WHEN a.fin>0 THEN COALESCE(a.fat,0)/a.fin ELSE 0 END, 2) AS ticket,
    a.primeiro, a.ultimo,
    s.meses
  FROM agg a
  LEFT JOIN serie s ON s.nome = a.nome
  LEFT JOIN bair  b ON b.nome = a.nome
  LEFT JOIN emp   e ON e.nk   = lower(btrim(a.nome))
  WHERE a.qtd >= p_min_pedidos
  ORDER BY a.qtd DESC;
$fn$;
