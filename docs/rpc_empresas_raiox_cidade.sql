-- RPC: empresas_raiox_cidade  (Raio-X das empresas) — v4, 28/09/2026
-- MUDANÇA: agora lê de uma MATERIALIZED VIEW pré-calculada (mv_empresas_raiox), então
-- responde INSTANTÂNEO. A v3 agregava as ~592k corridas de Campo Grande a cada chamada e
-- estourava o statement_timeout quando o cache esfriava (HTTP 500). A MV é calculada 1x
-- (aqui) e atualizada por refresh_raiox() (rodar num cron/na mão quando quiser dados frescos).
--
-- Telefone e bairro vêm do cadastro (join leve por cidade). A série mês a mês (6 meses) fica
-- no jsonb 'meses'. Cobre as cidades que estão no espelho machine_corridas (hoje campo-grande);
-- as demais continuam no fallback ao vivo do cliente.
--
-- Rodar TUDO isto no Supabase (SQL Editor). A criação da MV varre a tabela uma vez (~30s);
-- por isso o statement_timeout sobe pra 120s só neste script.

SET statement_timeout TO '120s';

CREATE INDEX IF NOT EXISTS idx_mc_cidade_data
  ON machine_corridas (cidade_slug, data_hora_solicitacao);

-- Resumo por (cidade, empresa) dos últimos 6 meses — recalculado só no refresh.
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
    cidade_slug,
    nome,
    sum(n)::bigint    AS qtd_total,
    sum(fin)::bigint  AS qtd_finalizadas,
    sum(canc)::bigint AS qtd_canceladas,
    round(sum(fat),2) AS faturamento,
    round(CASE WHEN sum(fin)>0 THEN sum(fat)/sum(fin) ELSE 0 END, 2) AS ticket,
    min(primeiro)     AS primeiro,
    max(ultimo)       AS ultimo,
    jsonb_agg(jsonb_build_object('ym',ym,'n',n) ORDER BY ym) AS meses
  FROM mes
  GROUP BY cidade_slug, nome;

CREATE INDEX IF NOT EXISTS idx_mv_raiox_cidade ON mv_empresas_raiox (cidade_slug, qtd_total DESC);

-- Atualiza o resumo (rodar quando quiser dados frescos; leva ~30s, mas fora do caminho do usuário).
CREATE OR REPLACE FUNCTION refresh_raiox()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout TO '120s'
AS $ref$
BEGIN
  REFRESH MATERIALIZED VIEW mv_empresas_raiox;
END;
$ref$;

-- Leitura do relatório: instantânea (lê a MV + junta telefone/bairro do cadastro).
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
  WITH emp AS (
    SELECT DISTINCT ON (lower(btrim(nome))) lower(btrim(nome)) AS nk, telefone, bairro
    FROM machine_empresas
    WHERE cidade_slug = p_cidade_slug
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
  WHERE m.cidade_slug = p_cidade_slug
    AND m.qtd_total >= p_min_pedidos
  ORDER BY m.qtd_total DESC;
$fn$;
