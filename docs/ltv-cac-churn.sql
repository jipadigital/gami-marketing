-- ============================================================
-- LTV , Fase 2: CAC + CHURN (reunião Matheus Fedrizzi, 04/11/2026)
-- ------------------------------------------------------------
-- Acrescenta ao estudo LTV (ver docs/ltv-mv.sql) as métricas que o Matheus definiu:
--  1) NOVOS ATIVADOS / mês  (empresa cujo 1º pedido caiu no mês) , denominador do CAC
--  2) CAC = (custo vendas+marketing informado) / novos ativados, por cidade/mês
--  3) LOGO CHURN   = % de empresas ativas no mês anterior que NÃO pediram no mês atual
--  4) CHURN MONETÁRIO = queda LÍQUIDA de GMV do cohort ativo no mês anterior (N-1 menos N)
--
-- Base: corridas FINALIZADAS ('F') da Machine, mesmos filtros/limpezas do ltv-mv.sql
-- (exclui Vitória/Cuiabá e nomes-coringa). Dados ~abril/2026 em diante -> ABRIL infla
-- "novos" (todo mundo parece novo no 1º mês do espelho); confiável de MAIO em diante, só
-- meses FECHADOS. Custo (vendas+mkt) NÃO vem da Machine: é input em crm_ltv_custos.
-- Refresh CONCURRENTLY (não trava leitura). Pode re-rodar à vontade.
-- ============================================================

-- 1) MV empresa × mês (grão fino que faltava: pra churn eu preciso saber QUAIS empresas,
--    não só quantas). pedidos + GMV por parceiro/cidade/mês.
DROP MATERIALIZED VIEW IF EXISTS public.mv_ltv_empresa_mes CASCADE;
CREATE MATERIALIZED VIEW public.mv_ltv_empresa_mes AS
SELECT
  cidade_slug,
  lower(btrim(nome_passageiro))                                  AS parceiro_key,
  max(nome_passageiro)                                           AS parceiro,
  to_char(date_trunc('month', data_hora_solicitacao), 'YYYY-MM') AS mes,
  count(*)::int                                                  AS pedidos,
  round(sum(coalesce(valor_corrida,0))::numeric, 2)             AS gmv
FROM public.machine_corridas
WHERE status_solicitacao = 'F'
  AND nome_passageiro IS NOT NULL AND btrim(nome_passageiro) <> ''
  AND lower(btrim(nome_passageiro)) NOT IN ('empresa','cliente','teste','particular','-')
  AND cidade_slug NOT IN ('vitoria','cuiaba')
GROUP BY cidade_slug, lower(btrim(nome_passageiro)), date_trunc('month', data_hora_solicitacao);
CREATE UNIQUE INDEX mv_ltv_empresa_mes_pk ON public.mv_ltv_empresa_mes (cidade_slug, parceiro_key, mes);
CREATE INDEX mv_ltv_empresa_mes_cm        ON public.mv_ltv_empresa_mes (cidade_slug, mes);

-- 2) Custo de vendas+marketing por cidade/mês (INPUT do Matheus, via formulário na aba LTV).
--    Só o servidor (service key) escreve/lê. mes no formato 'YYYY-MM'.
CREATE TABLE IF NOT EXISTS public.crm_ltv_custos (
  cidade_slug    text NOT NULL,
  mes            text NOT NULL CHECK (mes ~ '^\d{4}-\d{2}$'),
  custo          numeric NOT NULL DEFAULT 0,
  atualizado_em  timestamptz NOT NULL DEFAULT now(),
  atualizado_por text,
  PRIMARY KEY (cidade_slug, mes)
);
ALTER TABLE public.crm_ltv_custos ENABLE ROW LEVEL SECURITY;  -- sem policy p/ anon = só service key

-- 3) NOVOS ATIVADOS por cidade/mês = empresas cujo 1º mês de pedido é esse mês.
CREATE OR REPLACE VIEW public.v_ltv_novos_mes AS
WITH primeiros AS (
  SELECT cidade_slug, parceiro_key, min(mes) AS mes
  FROM public.mv_ltv_empresa_mes
  GROUP BY cidade_slug, parceiro_key
)
SELECT cidade_slug, mes, count(*)::int AS novos_ativados
FROM primeiros
GROUP BY cidade_slug, mes;

-- 4) CHURN (logo + monetário) do mês N vs mês anterior N-1, por cidade.
--    cohort = empresas ativas em N-1. logo_churn = % que não pediu em N.
--    churn_monetario = GMV(N-1) do cohort menos GMV(N) do mesmo cohort (queda líquida).
CREATE OR REPLACE VIEW public.v_ltv_churn_mes AS
WITH em AS (
  SELECT cidade_slug, parceiro_key, mes, gmv FROM public.mv_ltv_empresa_mes
),
pares AS (
  SELECT DISTINCT
    cidade_slug,
    mes AS mes_atual,
    to_char((to_date(mes || '-01','YYYY-MM-DD') - interval '1 month'),'YYYY-MM') AS mes_ant
  FROM em
)
SELECT
  p.cidade_slug,
  p.mes_atual                                                              AS mes,
  p.mes_ant,
  count(DISTINCT a.parceiro_key)::int                                      AS ativos_anterior,
  count(DISTINCT a.parceiro_key) FILTER (WHERE b.parceiro_key IS NULL)::int AS churnados,
  round( (count(DISTINCT a.parceiro_key) FILTER (WHERE b.parceiro_key IS NULL)::numeric
          / nullif(count(DISTINCT a.parceiro_key),0)) * 100, 1)            AS logo_churn_pct,
  round(coalesce(sum(a.gmv),0),2)                                          AS gmv_ant_cohort,
  round(coalesce(sum(b.gmv),0),2)                                          AS gmv_atual_cohort,
  round(coalesce(sum(a.gmv),0) - coalesce(sum(b.gmv),0), 2)                AS churn_monetario
FROM pares p
JOIN public.mv_ltv_empresa_mes a
     ON a.cidade_slug = p.cidade_slug AND a.mes = p.mes_ant
LEFT JOIN public.mv_ltv_empresa_mes b
     ON b.cidade_slug = p.cidade_slug AND b.parceiro_key = a.parceiro_key AND b.mes = p.mes_atual
GROUP BY p.cidade_slug, p.mes_atual, p.mes_ant;

-- 5) CAC por cidade/mês = custo informado / novos ativados.
CREATE OR REPLACE VIEW public.v_ltv_cac_mes AS
SELECT
  n.cidade_slug,
  n.mes,
  n.novos_ativados,
  c.custo,
  CASE WHEN n.novos_ativados > 0 AND c.custo IS NOT NULL
       THEN round((c.custo / n.novos_ativados)::numeric, 2) END AS cac
FROM public.v_ltv_novos_mes n
LEFT JOIN public.crm_ltv_custos c
       ON c.cidade_slug = n.cidade_slug AND c.mes = n.mes;

-- 6) Visão única por cidade/mês (o que a aba LTV consome): ativas, GMV, margem, novos,
--    custo, CAC, logo churn e churn monetário.
CREATE OR REPLACE VIEW public.v_ltv_metricas_mes AS
SELECT
  m.cidade_slug,
  m.mes,
  m.parceiros_ativos,
  m.pedidos,
  m.gmv,
  m.margem_14,
  coalesce(n.novos_ativados,0)   AS novos_ativados,
  cac.custo,
  cac.cac,
  ch.ativos_anterior,
  ch.churnados,
  ch.logo_churn_pct,
  ch.churn_monetario
FROM public.mv_ltv_mes m
LEFT JOIN public.v_ltv_novos_mes  n   ON n.cidade_slug = m.cidade_slug AND n.mes = m.mes
LEFT JOIN public.v_ltv_cac_mes    cac ON cac.cidade_slug = m.cidade_slug AND cac.mes = m.mes
LEFT JOIN public.v_ltv_churn_mes  ch  ON ch.cidade_slug = m.cidade_slug AND ch.mes = m.mes;

-- SEGURANÇA: só o servidor (service key) lê/escreve.
REVOKE ALL ON public.mv_ltv_empresa_mes FROM anon;
REVOKE ALL ON public.crm_ltv_custos     FROM anon;
REVOKE ALL ON public.v_ltv_novos_mes    FROM anon;
REVOKE ALL ON public.v_ltv_churn_mes    FROM anon;
REVOKE ALL ON public.v_ltv_cac_mes      FROM anon;
REVOKE ALL ON public.v_ltv_metricas_mes FROM anon;

-- 7) Refresh: inclui a MV nova. Substitui a função (mantém as 2 MVs antigas + a nova).
CREATE OR REPLACE FUNCTION public.refresh_ltv() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $ref$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_ltv_empresa;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_ltv_mes;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_ltv_empresa_mes;
END; $ref$;

-- conferência (JP, meses fechados):
--   SELECT mes, parceiros_ativos, novos_ativados, custo, cac, logo_churn_pct, churn_monetario
--   FROM public.v_ltv_metricas_mes WHERE cidade_slug='joao-pessoa' ORDER BY mes;
