-- ============================================================
-- PROSPECÇÃO EM CAMPO (v32.30, Parte 2b-auto) — cruzamento AUTOMÁTICO
-- ------------------------------------------------------------
-- Função que atualiza o status das lojas cruzando com a Machine
-- (lê a MV mv_empresas_raiox, não reprocessa as ~590k corridas) e um
-- job pg_cron que roda todo dia às 07:00 UTC (depois do refresh da MV,
-- que é 06:30 UTC no raiox). Mesma regra do botão manual:
--   amarelo/prospect -> verde   (1º pedido confirmado, grava primeiro_pedido_em)
--   verde -> vermelho           (parou de pedir há mais de 21 dias)
--   vermelho -> verde           (voltou a pedir)
-- CONSERVADOR: só mexe em quem BATEU com a Machine (match por nome na
-- mesma cidade). Só Campo Grande está na MV hoje.
-- Seguro de rodar: cria/atualiza a função e (re)agenda o job.
-- ============================================================

CREATE OR REPLACE FUNCTION public.prospeccao_atualizar_status()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total integer := 0;
  v_n     integer := 0;
  v_churn interval := interval '21 days';
BEGIN
  -- 1) amarelo/prospect -> verde (a Machine confirma pedido)
  UPDATE prospeccao_lojas l
     SET status = 'ativa',
         primeiro_pedido_em = COALESCE(l.primeiro_pedido_em, m.primeiro::date),
         updated_at = now()
    FROM mv_empresas_raiox m
   WHERE l.ativo = true
     AND m.cidade_slug = l.cidade_slug
     AND lower(btrim(m.nome)) = lower(btrim(l.nome))
     AND m.qtd_total > 0
     AND l.status IN ('prospect','ativada');
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  -- 2) verde -> vermelho (parou de pedir há mais de 21 dias)
  UPDATE prospeccao_lojas l
     SET status = 'perdida', updated_at = now()
    FROM mv_empresas_raiox m
   WHERE l.ativo = true
     AND m.cidade_slug = l.cidade_slug
     AND lower(btrim(m.nome)) = lower(btrim(l.nome))
     AND m.qtd_total > 0
     AND l.status = 'ativa'
     AND m.ultimo < now() - v_churn;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  -- 3) vermelho -> verde (voltou a pedir)
  UPDATE prospeccao_lojas l
     SET status = 'ativa', updated_at = now()
    FROM mv_empresas_raiox m
   WHERE l.ativo = true
     AND m.cidade_slug = l.cidade_slug
     AND lower(btrim(m.nome)) = lower(btrim(l.nome))
     AND m.qtd_total > 0
     AND l.status = 'perdida'
     AND m.ultimo >= now() - v_churn;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  RETURN v_total; -- quantas lojas mudaram de status
END;
$$;

GRANT EXECUTE ON FUNCTION public.prospeccao_atualizar_status() TO anon, authenticated;

-- (Re)agenda o job diário às 07:00 UTC (depois do refresh da MV do raio-X)
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'prospeccao_status_daily';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'prospeccao_status_daily',
  '0 7 * * *',
  $cron$ SELECT public.prospeccao_atualizar_status(); $cron$
);
