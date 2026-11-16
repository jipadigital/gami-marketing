-- ============================================================
-- FINANCEIRO v11 (16/11/2026): RECORRÊNCIAS DO KAMINO + campos novos sem "falsa alteração"
--
-- 1) fin_kmn_aplicar: quando a ÚNICA diferença é um campo de metadado que passamos a ler agora
--    (ex.: "serie" = SequenciaParcelas), atualiza em silêncio: não cria versão, não conta como
--    "alterado", não mexe na conferência.
-- 2) Recorrências do Kamino (só leitura):
--    * pagar: agrupadas pela série do Kamino (SequenciaParcelas)
--    * receber: o Kamino não usa contrato/recorrência; a recorrência é a cobrança semanal de
--      cada empresa (agrupada por empresa + cidade)
-- 3) Alerta KMN_RECORRENTE_VALOR_FORA: parcela de uma conta recorrente com valor muito diferente
--    das outras (golpe: "aproveitar" a conta mensal pra pagar a mais).
--
-- Rode INTEIRO no SQL Editor do projeto gami-financeiro (vyjjdirlgvysbalrmmih). Idempotente.
-- ============================================================

CREATE OR REPLACE FUNCTION fin__kmn_so_metadado(p_mudou text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT coalesce(p_mudou, '{}') <@ ARRAY['serie'] AND coalesce(array_length(p_mudou,1),0) > 0 $$;

CREATE OR REPLACE FUNCTION fin_kmn_aplicar(p_tipo text, p_itens jsonb, p_silencioso boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public, extensions AS $$
DECLARE
  it jsonb; r fin_kmn_lanc%ROWTYPE; v_id bigint; v_d jsonb; v_mudou text[];
  n_novos int := 0; n_mud int := 0; n_iguais int := 0; n_meta int := 0;
BEGIN
  IF p_tipo NOT IN ('pagar','receber') THEN RAISE EXCEPTION 'FINANCEIRO: tipo inválido'; END IF;
  IF jsonb_typeof(p_itens) <> 'array' THEN RAISE EXCEPTION 'FINANCEIRO: itens inválidos'; END IF;
  PERFORM set_config('fin.ator', 'sistema:kamino', true);
  PERFORM set_config('fin.kmn', '1', true);
  FOR it IN SELECT value FROM jsonb_array_elements(p_itens) LOOP
    v_d := it->'dados';
    IF NOT ((it->>'kamino_id') ~ '^\d+$') OR coalesce(it->>'hash','') = '' OR coalesce(it->>'hash_conf','') = '' OR jsonb_typeof(v_d) <> 'object' THEN
      RAISE EXCEPTION 'FINANCEIRO: item do Kamino incompleto';
    END IF;
    SELECT * INTO r FROM fin_kmn_lanc WHERE tipo = p_tipo AND kamino_id = (it->>'kamino_id')::bigint FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO fin_kmn_lanc (tipo, kamino_id, dados, hash, hash_conf)
      VALUES (p_tipo, (it->>'kamino_id')::bigint, v_d, it->>'hash', it->>'hash_conf') RETURNING id INTO v_id;
      INSERT INTO fin_kmn_versoes (lanc_id, versao, hash, dados) VALUES (v_id, 1, it->>'hash', v_d);
      n_novos := n_novos + 1;
      IF NOT p_silencioso THEN PERFORM fin__kmn_regras(v_id, NULL, NULL, NULL); END IF;
    ELSIF r.hash = it->>'hash' THEN
      IF r.sumiu_em IS NOT NULL OR r.ultimo_visto < now() - interval '6 hours' THEN
        UPDATE fin_kmn_lanc SET ultimo_visto = now(), sumiu_em = NULL WHERE id = r.id;
      END IF;
      n_iguais := n_iguais + 1;
    ELSE
      SELECT array_agg(k ORDER BY k) INTO v_mudou FROM (
        SELECT key AS k FROM jsonb_each(v_d) UNION SELECT key FROM jsonb_each(r.dados)) z
       WHERE (v_d->z.k) IS DISTINCT FROM (r.dados->z.k);
      IF fin__kmn_so_metadado(v_mudou) AND r.hash_conf = it->>'hash_conf' THEN
        -- só um campo de leitura novo: atualiza a versão atual em silêncio (também a foto dela)
        UPDATE fin_kmn_lanc SET dados = v_d, hash = it->>'hash', ultimo_visto = now(), sumiu_em = NULL WHERE id = r.id;
        n_meta := n_meta + 1;
      ELSE
        UPDATE fin_kmn_lanc SET dados = v_d, hash = it->>'hash', hash_conf = it->>'hash_conf', versao = r.versao + 1,
               alterado_em = now(), ultimo_visto = now(), sumiu_em = NULL
         WHERE id = r.id;
        INSERT INTO fin_kmn_versoes (lanc_id, versao, hash, dados, mudou) VALUES (r.id, r.versao + 1, it->>'hash', v_d, v_mudou);
        n_mud := n_mud + 1;
        IF NOT p_silencioso THEN PERFORM fin__kmn_regras(r.id, r.dados, v_mudou, r.hash_conf); END IF;
      END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('novos', n_novos, 'mudaram', n_mud, 'iguais', n_iguais, 'metadado', n_meta);
END $$;

-- ---------------- Recorrências do Kamino ----------------
-- pagar: uma linha por série (SequenciaParcelas)
CREATE OR REPLACE VIEW fin_kmn_v_rec_pagar AS
WITH b AS (
  SELECT l.*, l.dados->>'serie' AS serie, coalesce(l.valor_pago, l.valor) AS v
    FROM fin_kmn_lanc l WHERE l.tipo = 'pagar' AND l.sumiu_em IS NULL AND coalesce(l.dados->>'serie','') <> ''
), g AS (
  SELECT serie,
         (array_agg(pessoa ORDER BY vencimento DESC NULLS LAST))[1] AS pessoa,
         count(DISTINCT pessoa_kmn_id) AS qtd_pessoas,
         (array_agg(dados->>'descricao' ORDER BY vencimento DESC NULLS LAST))[1] AS descricao,
         (array_agg(classificacao ORDER BY vencimento DESC NULLS LAST))[1] AS classificacao,
         (array_agg(unidade ORDER BY vencimento DESC NULLS LAST))[1] AS unidade,
         (array_agg(dados->>'forma' ORDER BY vencimento DESC NULLS LAST))[1] AS forma,
         count(*) AS parcelas,
         count(*) FILTER (WHERE data_pagamento IS NOT NULL) AS pagas,
         count(*) FILTER (WHERE data_pagamento IS NULL AND vencimento < (now() AT TIME ZONE 'America/Sao_Paulo')::date) AS atrasadas,
         count(*) FILTER (WHERE data_pagamento IS NULL AND vencimento >= (now() AT TIME ZONE 'America/Sao_Paulo')::date) AS futuras,
         min(vencimento) AS primeiro_venc, max(vencimento) AS ultimo_venc,
         min(vencimento) FILTER (WHERE data_pagamento IS NULL AND vencimento >= (now() AT TIME ZONE 'America/Sao_Paulo')::date) AS proximo_venc,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY v) AS valor_tipico,
         min(v) AS valor_min, max(v) AS valor_max,
         sum(v) FILTER (WHERE data_pagamento IS NOT NULL) AS total_pago,
         sum(v) FILTER (WHERE data_pagamento IS NULL) AS total_aberto,
         CASE WHEN count(*) > 1 THEN round((max(vencimento) - min(vencimento))::numeric / (count(*) - 1)) END AS intervalo_dias
    FROM b GROUP BY serie
)
SELECT g.*,
       CASE WHEN intervalo_dias IS NULL THEN 'única'
            WHEN intervalo_dias BETWEEN 5 AND 9 THEN 'semanal'
            WHEN intervalo_dias BETWEEN 12 AND 17 THEN 'quinzenal'
            WHEN intervalo_dias BETWEEN 25 AND 35 THEN 'mensal'
            WHEN intervalo_dias BETWEEN 80 AND 100 THEN 'trimestral'
            WHEN intervalo_dias BETWEEN 330 AND 400 THEN 'anual'
            ELSE 'a cada ~' || intervalo_dias || ' dias' END AS frequencia,
       (valor_tipico > 0 AND (valor_max > valor_tipico * 1.2 OR valor_min < valor_tipico * 0.8)) AS valor_varia
  FROM g;
REVOKE ALL ON fin_kmn_v_rec_pagar FROM PUBLIC, anon, authenticated;
GRANT SELECT ON fin_kmn_v_rec_pagar TO service_role;

-- receber: cobrança recorrente = mesma empresa na mesma cidade, semana a semana
CREATE OR REPLACE VIEW fin_kmn_v_rec_receber AS
WITH b AS (
  SELECT l.*, coalesce(l.valor_pago, l.valor) AS v FROM fin_kmn_lanc l
   WHERE l.tipo = 'receber' AND l.sumiu_em IS NULL AND l.pessoa IS NOT NULL
)
SELECT fin_norm(pessoa) || '|' || coalesce(unidade,'') AS chave,
       (array_agg(pessoa ORDER BY vencimento DESC NULLS LAST))[1] AS pessoa, unidade,
       count(*) AS cobrancas,
       count(*) FILTER (WHERE data_pagamento IS NOT NULL) AS recebidas,
       count(*) FILTER (WHERE data_pagamento IS NULL AND vencimento < (now() AT TIME ZONE 'America/Sao_Paulo')::date) AS atrasadas,
       min(vencimento) AS primeira, max(vencimento) AS ultima,
       round(avg(v), 2) AS valor_medio,
       sum(v) FILTER (WHERE data_pagamento IS NOT NULL) AS total_recebido,
       sum(v) FILTER (WHERE data_pagamento IS NULL AND vencimento < (now() AT TIME ZONE 'America/Sao_Paulo')::date) AS total_atrasado,
       CASE WHEN count(*) > 1 THEN round((max(vencimento) - min(vencimento))::numeric / (count(*) - 1)) END AS intervalo_dias
  FROM b GROUP BY fin_norm(pessoa), unidade;
REVOKE ALL ON fin_kmn_v_rec_receber FROM PUBLIC, anon, authenticated;
GRANT SELECT ON fin_kmn_v_rec_receber TO service_role;

-- ---------------- Alerta: parcela recorrente fora do valor de sempre ----------------
CREATE OR REPLACE FUNCTION fin__kmn_regra_recorrente(p_id bigint) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE l fin_kmn_lanc%ROWTYPE; v_tip numeric; v_qtd int; v_val numeric;
BEGIN
  SELECT * INTO l FROM fin_kmn_lanc WHERE id = p_id;
  IF l.tipo <> 'pagar' OR coalesce(l.dados->>'serie','') = '' THEN RETURN; END IF;
  v_val := coalesce(l.valor_pago, l.valor);
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY coalesce(x.valor_pago, x.valor)), count(*) INTO v_tip, v_qtd
    FROM fin_kmn_lanc x WHERE x.tipo = 'pagar' AND x.id <> l.id AND x.sumiu_em IS NULL AND x.dados->>'serie' = l.dados->>'serie';
  IF v_qtd >= 2 AND v_tip > 0 AND v_val > v_tip * 1.2 AND v_val - v_tip >= 50 THEN
    PERFORM fin__kmn_alerta('kmn_rec_valor:' || l.id || ':' || l.versao, 'KMN_RECORRENTE_VALOR_FORA', 'alto',
      'Pagamento Kamino #' || l.kamino_id || ' · ' || coalesce(l.pessoa,'?') || ': parcela de conta recorrente acima do valor de sempre',
      jsonb_build_object('valor_tipico', v_tip, 'parcelas_comparadas', v_qtd, 'classificacao', l.classificacao), l.id, v_val);
  END IF;
END $$;

-- fin__kmn_regras v11: as mesmas regras do v9 + a de recorrência
CREATE OR REPLACE FUNCTION fin__kmn_regras(p_id bigint, p_old jsonb, p_mudou text[], p_hash_conf_antigo text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  l fin_kmn_lanc%ROWTYPE;
  v_old_pago boolean; v_pago boolean; v_sens text[] := ARRAY['valor','valor_pago','pessoa','pessoa_doc','destino_hash','conta','data_pagamento'];
  v_nome text; v_qtd int; v_outros text;
BEGIN
  SELECT * INTO l FROM fin_kmn_lanc WHERE id = p_id;
  v_pago := l.data_pagamento IS NOT NULL;
  v_old_pago := p_old IS NOT NULL AND fin__kd(p_old->>'data_pagamento') IS NOT NULL;
  v_nome := (CASE l.tipo WHEN 'pagar' THEN 'Pagamento' ELSE 'Recebimento' END) || ' Kamino #' || l.kamino_id || ' · ' || coalesce(l.pessoa, '?');

  IF p_old IS NOT NULL THEN
    -- 1) mexeram em algo importante DEPOIS de pago/recebido
    IF v_old_pago AND p_mudou && v_sens THEN
      PERFORM fin__kmn_alerta('kmn_pos_pago:' || l.id || ':' || l.versao, 'KMN_ALTERADO_APOS_PAGO', 'critico',
        v_nome || ': alterado depois de ' || (CASE l.tipo WHEN 'pagar' THEN 'pago' ELSE 'recebido' END),
        jsonb_build_object('campos', p_mudou, 'antes', p_old, 'depois', l.dados), l.id, l.valor);
    END IF;
    -- 2) estava pago e voltou a pendente (estorno/desfazer)
    IF v_old_pago AND NOT v_pago THEN
      PERFORM fin__kmn_alerta('kmn_despago:' || l.id || ':' || l.versao, 'KMN_PAGAMENTO_DESFEITO', 'alto',
        v_nome || ': estava ' || (CASE l.tipo WHEN 'pagar' THEN 'pago' ELSE 'recebido' END) || ' e voltou a pendente',
        jsonb_build_object('antes', p_old, 'depois', l.dados), l.id, l.valor);
    END IF;
    -- 3) mudou depois de conferido (valor, favorecido, destino ou conta)
    IF p_hash_conf_antigo IS DISTINCT FROM l.hash_conf
       AND p_mudou && ARRAY['valor','valor_pago','pessoa','pessoa_doc','destino_hash','conta']
       AND EXISTS (SELECT 1 FROM fin_kmn_conf c WHERE c.lanc_id = l.id AND c.hash_conf = p_hash_conf_antigo AND c.resultado = 'ok') THEN
      PERFORM fin__kmn_alerta('kmn_pos_conf:' || l.id || ':' || l.versao, 'KMN_MUDOU_APOS_CONFERIDO', 'alto',
        v_nome || ': mudou no Kamino depois de conferido',
        jsonb_build_object('campos', p_mudou, 'antes', p_old, 'depois', l.dados), l.id, l.valor);
    END IF;
  END IF;

  IF l.tipo = 'pagar' AND v_pago AND (p_old IS NULL OR NOT v_old_pago OR p_mudou && ARRAY['destino_hash','pessoa_kmn_id']) THEN
    -- 4) o MESMO Pix/conta de destino recebendo como se fosse OUTRA pessoa (golpe clássico)
    IF l.destino_hash IS NOT NULL THEN
      SELECT string_agg(DISTINCT x.pessoa, ', '), count(DISTINCT x.pessoa_kmn_id) INTO v_outros, v_qtd
        FROM fin_kmn_lanc x
       WHERE x.tipo = 'pagar' AND x.destino_hash = l.destino_hash AND x.id <> l.id
         AND x.pessoa_kmn_id IS DISTINCT FROM l.pessoa_kmn_id AND x.data_pagamento IS NOT NULL;
      IF v_qtd > 0 THEN
        PERFORM fin__kmn_alerta('kmn_dest_multi:' || l.id || ':' || l.destino_hash, 'KMN_DESTINO_DE_OUTRA_PESSOA', 'critico',
          v_nome || ': o Pix/conta de destino já recebeu pagamentos em nome de outra pessoa',
          jsonb_build_object('destino', l.dados->>'destino_desc', 'outras_pessoas', v_outros), l.id, l.valor);
      END IF;
      -- 5) destino diferente do que essa pessoa sempre usou
      IF l.pessoa_kmn_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM fin_kmn_lanc x WHERE x.tipo = 'pagar' AND x.pessoa_kmn_id = l.pessoa_kmn_id AND x.id <> l.id
                       AND x.data_pagamento IS NOT NULL AND x.destino_hash IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM fin_kmn_lanc x WHERE x.tipo = 'pagar' AND x.pessoa_kmn_id = l.pessoa_kmn_id AND x.id <> l.id
                       AND x.data_pagamento IS NOT NULL AND x.destino_hash = l.destino_hash) THEN
        PERFORM fin__kmn_alerta('kmn_dest_novo:' || l.id || ':' || l.destino_hash, 'KMN_DESTINO_NOVO', 'alto',
          v_nome || ': pago num Pix/conta diferente do que essa pessoa sempre recebeu',
          jsonb_build_object('destino', l.dados->>'destino_desc'), l.id, l.valor);
      END IF;
    END IF;
    -- 6) favorecido é alguém do próprio financeiro (fora de salário/benefício)
    IF NOT fin__kmn_eh_folha(l.classificacao) AND EXISTS (
         SELECT 1 FROM fin_acesso a JOIN fin_equipe e ON e.pessoa_id = a.pessoa_id
          WHERE a.ativo AND fin__kmn_mesma_pessoa(e.nome, l.pessoa) AND split_part(fin_norm(l.pessoa),' ',2) <> '') THEN
      PERFORM fin__kmn_alerta('kmn_fin_fav:' || l.id, 'KMN_FAVORECIDO_DO_FINANCEIRO', 'alto',
        v_nome || ': o favorecido é alguém com acesso ao financeiro (fora de salário/benefício)',
        jsonb_build_object('classificacao', l.classificacao), l.id, l.valor);
    END IF;
  END IF;

  -- 7) possível pagamento em dobro (mesma pessoa, mesmo valor, até 7 dias de diferença)
  IF l.tipo = 'pagar' AND p_old IS NULL AND l.pessoa_kmn_id IS NOT NULL AND l.valor IS NOT NULL THEN
    SELECT count(*) INTO v_qtd FROM fin_kmn_lanc x
     WHERE x.tipo = 'pagar' AND x.id <> l.id AND x.pessoa_kmn_id = l.pessoa_kmn_id AND x.valor = l.valor AND x.sumiu_em IS NULL
       AND abs(coalesce(x.vencimento, x.data_pagamento) - coalesce(l.vencimento, l.data_pagamento)) <= 7;
    IF v_qtd > 0 THEN
      PERFORM fin__kmn_alerta('kmn_dup:' || l.id, 'KMN_POSSIVEL_DUPLICIDADE', 'medio',
        v_nome || ': mesma pessoa e mesmo valor em menos de 7 dias (' || v_qtd || ' outro[s])', NULL, l.id, l.valor);
    END IF;
  END IF;
  -- v11: parcela de conta recorrente fora do valor de sempre
  PERFORM fin__kmn_regra_recorrente(p_id);
END $$;

-- ---------------- Funções: só a service key executa ----------------
DO $do$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname LIKE 'fin\_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $do$;
