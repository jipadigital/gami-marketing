-- RPC: empresas_raiox_cidade  (Raio-X das empresas / relatório completo) — v3, 28/09/2026
-- Uma linha por empresa (nome_passageiro) com tudo que dá pra tabular pro PDF/impressão:
-- total de pedidos, finalizadas, canceladas, faturamento, ticket, primeiro/último pedido,
-- telefone + bairro (do cadastro machine_empresas) e a série MÊS A MÊS (jsonb).
-- A tendência (subindo/estável/caindo) é calculada no cliente a partir da série.
--
-- PERFORMANCE: Campo Grande tem ~590k corridas (quase tudo cabe em 6 meses). A v1 estourava o
-- timeout porque extraía JSON linha a linha; a v2 ainda fazia 2 passadas. Esta v3:
--   1) NÃO toca em raw (bairro/telefone vêm do cadastro),
--   2) faz UMA passada: agrega por (nome, mês) e depois rola pro total (conjunto pequeno),
--   3) a própria função sobe o statement_timeout pra 30s (o padrão do PostgREST corta antes).
-- Índice deixa o corte por data eficiente.
--
-- Só serve pra cidades no espelho machine_corridas (hoje: campo-grande). As demais caem no
-- fallback ao vivo do cliente (~45 dias).
--
-- Rodar no Supabase (SQL Editor) — cria o índice (1x) e a função (CREATE OR REPLACE).

CREATE INDEX IF NOT EXISTS idx_mc_cidade_data
  ON machine_corridas (cidade_slug, data_hora_solicitacao);

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
SET statement_timeout TO '30s'
AS $fn$
  WITH mes AS (  -- UMA passada: contagens por (empresa, mês). Sem tocar em raw.
    SELECT
      btrim(c.nome_passageiro)                                         AS nome,
      to_char(date_trunc('month', c.data_hora_solicitacao),'YYYY-MM')  AS ym,
      count(*)                                                        AS n,
      count(*) FILTER (WHERE c.status_solicitacao='F')                AS fin,
      count(*) FILTER (WHERE c.status_solicitacao='C')                AS canc,
      sum(COALESCE(c.valor_corrida,0)) FILTER (WHERE c.status_solicitacao='F') AS fat,
      min(c.data_hora_solicitacao)                                    AS primeiro,
      max(c.data_hora_solicitacao)                                    AS ultimo
    FROM machine_corridas c
    WHERE c.cidade_slug = p_cidade_slug
      AND c.data_hora_solicitacao >= date_trunc('month', now()) - ((p_meses-1) || ' months')::interval
      AND btrim(COALESCE(c.nome_passageiro,'')) <> ''
    GROUP BY 1, 2
  ),
  agg AS (  -- rola do (empresa,mês) pro total da empresa (conjunto pequeno)
    SELECT nome,
      sum(n)        AS qtd,
      sum(fin)      AS fin,
      sum(canc)     AS canc,
      sum(fat)      AS fat,
      min(primeiro) AS primeiro,
      max(ultimo)   AS ultimo,
      jsonb_agg(jsonb_build_object('ym',ym,'n',n) ORDER BY ym) AS meses
    FROM mes GROUP BY nome
  ),
  emp AS (  -- bairro + telefone do cadastro, 1 por nome (evita duplicar quando há 2 cadastros)
    SELECT DISTINCT ON (lower(btrim(nome))) lower(btrim(nome)) AS nk, telefone, bairro
    FROM machine_empresas
    WHERE cidade_slug = p_cidade_slug
    ORDER BY lower(btrim(nome)), (telefone IS NULL OR btrim(telefone) = ''), nome
  )
  SELECT
    a.nome,
    COALESCE(NULLIF(btrim(e.bairro),''),'')  AS bairro,
    COALESCE(e.telefone,'')                  AS telefone,
    a.qtd                                    AS qtd_total,
    a.fin                                    AS qtd_finalizadas,
    a.canc                                   AS qtd_canceladas,
    round(COALESCE(a.fat,0),2)               AS faturamento,
    round(CASE WHEN a.fin>0 THEN COALESCE(a.fat,0)/a.fin ELSE 0 END, 2) AS ticket,
    a.primeiro, a.ultimo,
    a.meses
  FROM agg a
  LEFT JOIN emp e ON e.nk = lower(btrim(a.nome))
  WHERE a.qtd >= p_min_pedidos
  ORDER BY a.qtd DESC;
$fn$;
