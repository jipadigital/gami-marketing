-- ============================================================
-- LTV , camada de dados v2 (base do estudo CAC x LTV do Matheus)
-- ------------------------------------------------------------
-- Pré-calcula, por PARCEIRO e CIDADE, as métricas de LTV a partir das corridas
-- FINALIZADAS (status 'F') da Machine. Modelo do deck: base = valor_corrida,
-- margem de contribuição = 14%. LTV gerado = GMV × 14%.
-- v2: + VISÃO MENSAL (empresas ativas por mês) + exclui cidade encerrada (Vitória/
--     Cuiabá) + ignora nomes-coringa (Empresa/Cliente/Teste/Particular) que inflam.
-- Dados de ~03/abril/2026 em diante. Refresh CONCURRENTLY (não trava). RE-RODAR (substitui a v1).
-- ============================================================

-- filtro comum (CTE não dá em MV; repetimos o WHERE)
-- WHERE: finalizada + nome válido + não-coringa + cidade ativa

-- 1) MV por parceiro
DROP MATERIALIZED VIEW IF EXISTS public.mv_ltv_empresa CASCADE;
CREATE MATERIALIZED VIEW public.mv_ltv_empresa AS
SELECT
  cidade_slug,
  lower(btrim(nome_passageiro))                                        AS parceiro_key,
  max(nome_passageiro)                                                 AS parceiro,
  count(*)::int                                                        AS pedidos,
  round(sum(coalesce(valor_corrida,0))::numeric, 2)                    AS gmv,
  min(data_hora_solicitacao)                                           AS primeiro_pedido,
  max(data_hora_solicitacao)                                           AS ultimo_pedido,
  greatest(1, ceil( extract(epoch from (max(data_hora_solicitacao) - min(data_hora_solicitacao)))
                    / (30*86400) )::int )                              AS meses_ativos,
  round( (sum(coalesce(valor_corrida,0)) / nullif(count(*),0))::numeric, 2 ) AS ticket_medio,
  round( (sum(coalesce(valor_corrida,0)) * 0.14)::numeric, 2 )         AS ltv_atual,
  ( max(data_hora_solicitacao) >= now() - interval '30 days' )         AS ativo
FROM public.machine_corridas
WHERE status_solicitacao = 'F'
  AND nome_passageiro IS NOT NULL AND btrim(nome_passageiro) <> ''
  AND lower(btrim(nome_passageiro)) NOT IN ('empresa','cliente','teste','particular','-')
  AND cidade_slug NOT IN ('vitoria','cuiaba')
GROUP BY cidade_slug, lower(btrim(nome_passageiro));
CREATE UNIQUE INDEX mv_ltv_empresa_pk ON public.mv_ltv_empresa (cidade_slug, parceiro_key);
CREATE INDEX mv_ltv_empresa_cidade    ON public.mv_ltv_empresa (cidade_slug);

-- 2) MV mensal , EMPRESAS ATIVAS POR MÊS (distintas que pediram no mês) + pedidos + GMV
DROP MATERIALIZED VIEW IF EXISTS public.mv_ltv_mes CASCADE;
CREATE MATERIALIZED VIEW public.mv_ltv_mes AS
SELECT
  cidade_slug,
  to_char(date_trunc('month', data_hora_solicitacao), 'YYYY-MM')       AS mes,
  count(DISTINCT lower(btrim(nome_passageiro)))::int                   AS parceiros_ativos,
  count(*)::bigint                                                     AS pedidos,
  round(sum(coalesce(valor_corrida,0))::numeric, 2)                    AS gmv,
  round(sum(coalesce(valor_corrida,0)) * 0.14, 2)                      AS margem_14
FROM public.machine_corridas
WHERE status_solicitacao = 'F'
  AND nome_passageiro IS NOT NULL AND btrim(nome_passageiro) <> ''
  AND lower(btrim(nome_passageiro)) NOT IN ('empresa','cliente','teste','particular','-')
  AND cidade_slug NOT IN ('vitoria','cuiaba')
GROUP BY cidade_slug, date_trunc('month', data_hora_solicitacao);
CREATE UNIQUE INDEX mv_ltv_mes_pk ON public.mv_ltv_mes (cidade_slug, mes);

-- 3) resumo por cidade (view leve sobre a MV de parceiro)
CREATE OR REPLACE VIEW public.v_ltv_cidade AS
SELECT
  cidade_slug,
  count(*)::int                                   AS parceiros,
  count(*) FILTER (WHERE ativo)::int              AS parceiros_ativos,
  sum(gmv)                                        AS gmv_total,
  round(sum(gmv) * 0.14, 2)                       AS margem_total,
  round(avg(ticket_medio), 2)                     AS ticket_medio,
  sum(pedidos)::bigint                            AS pedidos,
  round(avg(ltv_atual), 2)                        AS ltv_medio_parceiro,
  min(primeiro_pedido)                            AS desde,
  max(ultimo_pedido)                              AS ate
FROM public.mv_ltv_empresa
GROUP BY cidade_slug;

-- SEGURANÇA: só o servidor (service key) lê.
REVOKE ALL ON public.mv_ltv_empresa FROM anon;
REVOKE ALL ON public.mv_ltv_mes     FROM anon;
REVOKE ALL ON public.v_ltv_cidade   FROM anon;

-- refresh sem travar (CONCURRENTLY) das duas MVs + agendamento diário 06:55 UTC
CREATE OR REPLACE FUNCTION public.refresh_ltv() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $ref$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_ltv_empresa;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_ltv_mes;
END; $ref$;

DO $cron$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname='ltv_daily';
    PERFORM cron.schedule('ltv_daily', '55 6 * * *', $job$ SELECT public.refresh_ltv(); $job$);
  END IF;
END $cron$;

-- conferência:
--   SELECT * FROM public.mv_ltv_mes ORDER BY cidade_slug, mes;
--   SELECT * FROM public.v_ltv_cidade ORDER BY gmv_total DESC;
