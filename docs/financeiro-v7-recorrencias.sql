-- ============================================================
-- FINANCEIRO GÂMI v7: CONTAS RECORRENTES (pagar e receber) (12/11/2026)
-- ------------------------------------------------------------
-- Conta marcada como RECORRENTE (aluguel, internet, salário, mensalidade de cliente...) vira um
-- MODELO. O banco gera sozinho cada vencimento até o fim do mês seguinte (rodada diária + na hora
-- em que cria), então a conta do mês sempre aparece na Central e na Lista pra elas darem baixa.
--  * frequência: semanal, quinzenal, mensal, bimestral, trimestral, semestral, anual
--  * sem fim (padrão) ou com data final
--  * valor fixo ou VARIÁVEL (luz, água, comissão): gera com o valor previsto marcado
--    "confirmar valor", até alguém confirmar/editar ou dar baixa
--  * nunca duplica: cada ocorrência tem número (recorrencia_id, recorrencia_seq) único
--  * mudar o modelo, pausar ou encerrar: só gestor, auditado; encerrar cancela as futuras com motivo
--  * nada se apaga (mesmas travas das outras fin_*)
-- Rodar depois do v6. Idempotente.
-- ============================================================
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS fin_recorrencias (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo             text NOT NULL CHECK (tipo IN ('pagar','receber')),
  modelo           jsonb NOT NULL,              -- campos do lançamento (pessoa, classificação, unidade, rateio...)
  valor            numeric(14,2) NOT NULL CHECK (valor > 0),
  valor_variavel   boolean NOT NULL DEFAULT false,
  frequencia       text NOT NULL CHECK (frequencia IN ('semanal','quinzenal','mensal','bimestral','trimestral','semestral','anual')),
  inicio           date NOT NULL,               -- 1º vencimento
  competencia_inicio date NOT NULL,             -- competência do 1º (as próximas andam junto)
  fim              date,                        -- último vencimento permitido (NULL = sem fim)
  status           text NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','pausada','encerrada')),
  gerados          integer NOT NULL DEFAULT 0,  -- próxima ocorrência a gerar (0 = a do início)
  ultimo_venc      date,
  criado_por       text NOT NULL,
  criado_em        timestamptz NOT NULL DEFAULT now(),
  atualizado_por   text,
  atualizado_em    timestamptz,
  encerrado_por    text,
  encerrado_em     timestamptz,
  motivo           text,
  CHECK (fim IS NULL OR fim >= inicio)
);
CREATE INDEX IF NOT EXISTS fin_rec_status ON fin_recorrencias (status);

ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS recorrencia_id bigint REFERENCES fin_recorrencias(id);
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS recorrencia_seq integer;
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS valor_a_confirmar boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS fin_lanc_rec_uk ON fin_lancamentos (recorrencia_id, recorrencia_seq) WHERE recorrencia_id IS NOT NULL;

-- identidade da recorrência não muda; status só pelos caminhos certos
CREATE OR REPLACE FUNCTION fin_trg_rec_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tipo <> OLD.tipo OR NEW.frequencia <> OLD.frequencia OR NEW.inicio <> OLD.inicio
     OR NEW.criado_por <> OLD.criado_por OR NEW.criado_em <> OLD.criado_em THEN
    RAISE EXCEPTION 'FINANCEIRO: tipo, frequência e início da recorrência não mudam (encerre e crie outra)';
  END IF;
  IF OLD.status = 'encerrada' AND NEW.status <> 'encerrada' THEN
    RAISE EXCEPTION 'FINANCEIRO: recorrência encerrada não volta (crie outra)';
  END IF;
  IF NEW.gerados < OLD.gerados THEN RAISE EXCEPTION 'FINANCEIRO: contador da recorrência não volta'; END IF;
  IF NEW.status = 'encerrada' AND OLD.status <> 'encerrada' AND length(btrim(coalesce(NEW.motivo,''))) < 10 THEN
    RAISE EXCEPTION 'FINANCEIRO: encerrar exige motivo (mín. 10 caracteres)';
  END IF;
  NEW.atualizado_em := now();
  RETURN NEW;
END $$;

-- valor previsto de conta variável: deixa de ser "a confirmar" quando o valor muda ou quando é pago
CREATE OR REPLACE FUNCTION fin_trg_lanc_rec_valor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.valor_a_confirmar AND NEW.valor_a_confirmar AND coalesce(current_setting('fin.rec_auto', true), '') <> '1'
     AND (NEW.valor IS DISTINCT FROM OLD.valor OR NEW.status = 'pago') THEN
    NEW.valor_a_confirmar := false;
  END IF;
  IF NEW.recorrencia_id IS DISTINCT FROM OLD.recorrencia_id OR NEW.recorrencia_seq IS DISTINCT FROM OLD.recorrencia_seq THEN
    RAISE EXCEPTION 'FINANCEIRO: vínculo com a recorrência não muda';
  END IF;
  RETURN NEW;
END $$;

DO $do$
BEGIN
  EXECUTE 'DROP TRIGGER IF EXISTS fin_recorrencias_nodel ON fin_recorrencias';
  EXECUTE 'CREATE TRIGGER fin_recorrencias_nodel BEFORE DELETE ON fin_recorrencias FOR EACH ROW EXECUTE FUNCTION fin_trg_bloqueia_delete()';
  EXECUTE 'DROP TRIGGER IF EXISTS fin_recorrencias_notrunc ON fin_recorrencias';
  EXECUTE 'CREATE TRIGGER fin_recorrencias_notrunc BEFORE TRUNCATE ON fin_recorrencias FOR EACH STATEMENT EXECUTE FUNCTION fin_trg_bloqueia_delete()';
  EXECUTE 'DROP TRIGGER IF EXISTS fin_recorrencias_audit ON fin_recorrencias';
  EXECUTE 'CREATE TRIGGER fin_recorrencias_audit AFTER INSERT OR UPDATE ON fin_recorrencias FOR EACH ROW EXECUTE FUNCTION fin_trg_audit()';
  EXECUTE 'DROP TRIGGER IF EXISTS fin_recorrencias_guard ON fin_recorrencias';
  EXECUTE 'CREATE TRIGGER fin_recorrencias_guard BEFORE UPDATE ON fin_recorrencias FOR EACH ROW EXECUTE FUNCTION fin_trg_rec_guard()';
  EXECUTE 'DROP TRIGGER IF EXISTS fin_lanc_rec_valor ON fin_lancamentos';
  EXECUTE 'CREATE TRIGGER fin_lanc_rec_valor BEFORE UPDATE ON fin_lancamentos FOR EACH ROW EXECUTE FUNCTION fin_trg_lanc_rec_valor()';
  EXECUTE 'ALTER TABLE fin_recorrencias ENABLE ROW LEVEL SECURITY';
  EXECUTE 'REVOKE ALL ON fin_recorrencias FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE ON fin_recorrencias TO service_role';
END $do$;

-- view dos lançamentos: mesmas colunas da v2 + as da recorrência NO FIM (CREATE OR REPLACE só aceita acrescentar no fim)
CREATE OR REPLACE VIEW fin_v_lanc WITH (security_invoker = true) AS
SELECT l.id, l.origem, l.tipo, l.status,
  CASE WHEN l.status = 'pendente' AND l.vencimento < (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN 'atrasado' ELSE l.status END AS situacao_calc,
  l.pessoa_id, coalesce(p.nome, l.pessoa) AS pessoa_nome, p.documento AS pessoa_doc,
  l.descricao, l.observacao,
  l.classificacao_id, coalesce(c.nome, l.categoria) AS classificacao_nome, c.grupo AS classificacao_grupo, c.subgrupo AS classificacao_subgrupo, c.dre_linha,
  l.centro_custo_id, cc.nome AS centro_custo_nome,
  l.unidade_id, coalesce(u.nome, l.unidade) AS unidade_nome,
  l.conta_id, coalesce(ct.nome, l.conta_nome) AS conta_nome,
  l.forma, l.valor, l.juros, l.multa, l.desconto, l.retencao, l.retencao_tipo,
  (l.valor + l.juros + l.multa - l.desconto - l.retencao) AS valor_final,
  l.vencimento, l.competencia, l.data_pagamento,
  l.nf_numero, l.codigo_barras, l.pix_copia_cola,
  l.grupo_parcela, l.parcela_num, l.parcela_total, l.rateio,
  l.criado_por, l.criado_em, l.atualizado_em, l.cancelado_por, l.motivo_cancelamento,
  b.id AS baixa_id, b.conta_id AS baixa_conta_id, b.origem AS baixa_origem, b.por AS baixa_por,
  cn.extrato_id,
  (SELECT count(*) FROM fin_anexos a WHERE a.lancamento_id = l.id) AS anexos,
  l.recorrencia_id, l.recorrencia_seq, l.valor_a_confirmar
FROM fin_lancamentos l
LEFT JOIN fin_pessoas p ON p.id = l.pessoa_id
LEFT JOIN fin_classificacoes c ON c.id = l.classificacao_id
LEFT JOIN fin_centros_custo cc ON cc.id = l.centro_custo_id
LEFT JOIN fin_unidades u ON u.id = l.unidade_id
LEFT JOIN fin_contas ct ON ct.id = l.conta_id
LEFT JOIN fin_baixas b ON b.lancamento_id = l.id AND NOT b.estornada
LEFT JOIN fin_conciliacoes cn ON cn.lancamento_id = l.id AND cn.ativo;
REVOKE ALL ON fin_v_lanc FROM PUBLIC, anon, authenticated;
GRANT SELECT ON fin_v_lanc TO service_role;

-- ------------------------------------------------------------
-- datas: k-ésima ocorrência a partir do início (sempre do início: 31/01 → 28/02 → 31/03, sem "escorregar")
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_rec_venc(p_inicio date, p_freq text, p_k integer) RETURNS date
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_freq
    WHEN 'semanal'    THEN p_inicio + 7 * p_k
    WHEN 'quinzenal'  THEN p_inicio + 14 * p_k
    WHEN 'mensal'     THEN (p_inicio + make_interval(months => p_k))::date
    WHEN 'bimestral'  THEN (p_inicio + make_interval(months => 2 * p_k))::date
    WHEN 'trimestral' THEN (p_inicio + make_interval(months => 3 * p_k))::date
    WHEN 'semestral'  THEN (p_inicio + make_interval(months => 6 * p_k))::date
    WHEN 'anual'      THEN (p_inicio + make_interval(years => p_k))::date
  END
$$;
-- lista das recorrências (depois da função de datas, que ela usa)
CREATE OR REPLACE VIEW fin_v_recorrencias WITH (security_invoker = true) AS
SELECT r.id, r.tipo, r.status, r.frequencia, r.valor, r.valor_variavel, r.inicio, r.fim, r.gerados, r.ultimo_venc,
  r.modelo, r.criado_por, r.criado_em, r.atualizado_por, r.atualizado_em, r.encerrado_por, r.encerrado_em, r.motivo,
  coalesce(p.nome, '') AS pessoa_nome, c.nome AS classificacao_nome, u.nome AS unidade_nome,
  r.modelo->>'descricao' AS descricao,
  CASE WHEN r.status = 'ativa' THEN fin_rec_venc(r.inicio, r.frequencia, r.gerados) END AS proximo_venc,
  (SELECT count(*) FROM fin_lancamentos l WHERE l.recorrencia_id = r.id AND l.status = 'pendente') AS pendentes,
  (SELECT count(*) FROM fin_lancamentos l WHERE l.recorrencia_id = r.id AND l.status = 'pago') AS pagos,
  (SELECT count(*) FROM fin_lancamentos l WHERE l.recorrencia_id = r.id AND l.status = 'pendente'
     AND l.vencimento < (now() AT TIME ZONE 'America/Sao_Paulo')::date) AS atrasados,
  (SELECT min(l.vencimento) FROM fin_lancamentos l WHERE l.recorrencia_id = r.id AND l.status = 'pendente') AS proximo_pendente
FROM fin_recorrencias r
LEFT JOIN fin_pessoas p ON p.id = nullif(r.modelo->>'pessoa_id','')::bigint
LEFT JOIN fin_classificacoes c ON c.id = nullif(r.modelo->>'classificacao_id','')::bigint
LEFT JOIN fin_unidades u ON u.id = nullif(r.modelo->>'unidade_id','')::bigint;
REVOKE ALL ON fin_v_recorrencias FROM PUBLIC, anon, authenticated;
GRANT SELECT ON fin_v_recorrencias TO service_role;

-- até onde gerar: fim do mês seguinte (a conta do mês e a do próximo sempre aparecem)
CREATE OR REPLACE FUNCTION fin_rec_horizonte() RETURNS date LANGUAGE sql STABLE AS $$
  SELECT (date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo')::date) + interval '2 months - 1 day')::date
$$;

-- valida o modelo (mesmas regras do lançamento) e devolve só os campos aceitos
CREATE OR REPLACE FUNCTION fin__rec_modelo(m jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
  IF m IS NULL OR jsonb_typeof(m) <> 'object' THEN RAISE EXCEPTION 'Modelo inválido'; END IF;
  IF nullif(m->>'pessoa_id','') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fin_pessoas WHERE id = (m->>'pessoa_id')::bigint) THEN RAISE EXCEPTION 'Pessoa inválida'; END IF;
  IF nullif(m->>'classificacao_id','') IS NULL THEN RAISE EXCEPTION 'Classificação obrigatória'; END IF;
  IF NOT EXISTS (SELECT 1 FROM fin_classificacoes WHERE id = (m->>'classificacao_id')::bigint) THEN RAISE EXCEPTION 'Classificação inválida'; END IF;
  IF nullif(m->>'unidade_id','') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fin_unidades WHERE id = (m->>'unidade_id')::bigint) THEN RAISE EXCEPTION 'Unidade inválida'; END IF;
  IF nullif(m->>'conta_id','') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fin_contas WHERE id = (m->>'conta_id')::uuid) THEN RAISE EXCEPTION 'Conta inválida'; END IF;
  PERFORM fin__valida_rateio(m->'rateio');
  FOR k IN SELECT jsonb_object_keys(m) LOOP
    IF k NOT IN ('pessoa_id','descricao','classificacao_id','centro_custo_id','unidade_id','conta_id','forma','retencao','retencao_tipo',
                 'nf_numero','codigo_barras','pix_copia_cola','observacao','rateio') THEN
      m := m - k;
    END IF;
  END LOOP;
  RETURN m;
END $$;

-- ------------------------------------------------------------
-- GERADOR: cria as ocorrências que faltam de UMA recorrência (até o horizonte, máx. 60 por rodada)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin__rec_gerar_uma(p_ator text, p_id bigint) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE r fin_recorrencias; m jsonb; k int; v date; c date; n int := 0; lim date := fin_rec_horizonte();
BEGIN
  SELECT * INTO r FROM fin_recorrencias WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'ativa' THEN RETURN 0; END IF;
  m := r.modelo; k := r.gerados;
  LOOP
    v := fin_rec_venc(r.inicio, r.frequencia, k);
    IF r.fim IS NOT NULL AND v > r.fim THEN
      UPDATE fin_recorrencias SET status = 'encerrada', encerrado_por = 'sistema:recorrencia', encerrado_em = now(),
        motivo = 'Chegou à data final (' || to_char(r.fim, 'DD/MM/YYYY') || ')', atualizado_por = p_ator WHERE id = p_id;
      EXIT;
    END IF;
    EXIT WHEN v > lim OR n >= 60;
    c := fin_rec_venc(r.competencia_inicio, r.frequencia, k);
    INSERT INTO fin_lancamentos (origem, chave, tipo, pessoa_id, pessoa, descricao, classificacao_id, centro_custo_id, unidade_id, conta_id,
      forma, valor, juros, multa, desconto, retencao, retencao_tipo, vencimento, competencia, nf_numero, codigo_barras, pix_copia_cola,
      observacao, rateio, status, criado_por, recorrencia_id, recorrencia_seq, valor_a_confirmar)
    VALUES ('manual', 'R:' || r.id || ':' || k, r.tipo, nullif(m->>'pessoa_id','')::bigint,
      (SELECT nome FROM fin_pessoas WHERE id = nullif(m->>'pessoa_id','')::bigint),
      nullif(btrim(m->>'descricao'),''), nullif(m->>'classificacao_id','')::bigint, nullif(m->>'centro_custo_id','')::bigint,
      nullif(m->>'unidade_id','')::bigint, nullif(m->>'conta_id','')::uuid, nullif(m->>'forma',''),
      r.valor, 0, 0, 0, coalesce((m->>'retencao')::numeric, 0), nullif(m->>'retencao_tipo',''), v, c,
      nullif(m->>'nf_numero',''), nullif(m->>'codigo_barras',''), nullif(m->>'pix_copia_cola',''), nullif(btrim(m->>'observacao'),''),
      fin__valida_rateio(m->'rateio'), 'pendente', r.criado_por, r.id, k, r.valor_variavel)
    ON CONFLICT DO NOTHING;
    k := k + 1; n := n + 1;
  END LOOP;
  IF k > r.gerados THEN
    UPDATE fin_recorrencias SET gerados = k, ultimo_venc = fin_rec_venc(r.inicio, r.frequencia, k - 1), atualizado_por = p_ator WHERE id = p_id;
  END IF;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION fin_rec_gerar_todas(p_ator text DEFAULT 'sistema:recorrencia') RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE r record; n int := 0; q int := 0;
BEGIN
  PERFORM fin_set_ator(p_ator);
  FOR r IN SELECT id FROM fin_recorrencias WHERE status = 'ativa' ORDER BY id LOOP
    n := n + fin__rec_gerar_uma(p_ator, r.id); q := q + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'recorrencias', q, 'gerados', n);
END $$;

-- ------------------------------------------------------------
-- RPCs
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_rec_criar(p_ator text, p_tipo text, p_modelo jsonb, p_valor numeric, p_variavel boolean,
                                         p_freq text, p_inicio date, p_comp date, p_fim date) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_id bigint; n int; hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF p_tipo NOT IN ('pagar','receber') THEN RAISE EXCEPTION 'Tipo inválido'; END IF;
  IF p_valor IS NULL OR p_valor <= 0 OR p_valor > 1e9 THEN RAISE EXCEPTION 'Valor inválido'; END IF;
  IF p_inicio IS NULL THEN RAISE EXCEPTION 'Primeiro vencimento obrigatório'; END IF;
  IF p_inicio < hoje - 62 THEN RAISE EXCEPTION 'Primeiro vencimento muito antigo (até 2 meses pra trás)'; END IF;
  IF p_inicio > hoje + 730 THEN RAISE EXCEPTION 'Primeiro vencimento muito longe'; END IF;
  IF p_fim IS NOT NULL AND p_fim < p_inicio THEN RAISE EXCEPTION 'Data final antes do primeiro vencimento'; END IF;
  INSERT INTO fin_recorrencias (tipo, modelo, valor, valor_variavel, frequencia, inicio, competencia_inicio, fim, criado_por)
  VALUES (p_tipo, fin__rec_modelo(p_modelo), round(p_valor, 2), coalesce(p_variavel, false), p_freq, p_inicio, coalesce(p_comp, p_inicio), p_fim, p_ator)
  RETURNING id INTO v_id;
  n := fin__rec_gerar_uma(p_ator, v_id);
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'gerados', n,
    'ids', (SELECT coalesce(jsonb_agg(id ORDER BY recorrencia_seq), '[]') FROM fin_lancamentos WHERE recorrencia_id = v_id));
END $$;

-- Gestor muda o modelo/valor/fim. p_aplicar = também nas ocorrências já geradas que estão pendentes e vencem de hoje em diante.
CREATE OR REPLACE FUNCTION fin_rec_salvar(p_ator text, p_id bigint, p_modelo jsonb, p_valor numeric, p_variavel boolean,
                                          p_fim date, p_aplicar boolean) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE r fin_recorrencias; m jsonb; n_upd int := 0; n_canc int := 0; hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  PERFORM fin_set_ator(p_ator);
  SELECT * INTO r FROM fin_recorrencias WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Recorrência não encontrada'; END IF;
  IF r.status = 'encerrada' THEN RAISE EXCEPTION 'Recorrência encerrada não muda'; END IF;
  IF p_valor IS NULL OR p_valor <= 0 OR p_valor > 1e9 THEN RAISE EXCEPTION 'Valor inválido'; END IF;
  IF p_fim IS NOT NULL AND p_fim < r.inicio THEN RAISE EXCEPTION 'Data final antes do primeiro vencimento'; END IF;
  m := fin__rec_modelo(p_modelo);
  UPDATE fin_recorrencias SET modelo = m, valor = round(p_valor, 2), valor_variavel = coalesce(p_variavel, false), fim = p_fim, atualizado_por = p_ator
  WHERE id = p_id;
  -- ocorrências pendentes depois da nova data final: canceladas com motivo
  IF p_fim IS NOT NULL THEN
    UPDATE fin_lancamentos SET status = 'cancelado', cancelado_por = p_ator, cancelado_em = now(),
      motivo_cancelamento = 'Recorrência #' || p_id || ' agora termina em ' || to_char(p_fim, 'DD/MM/YYYY')
    WHERE recorrencia_id = p_id AND status = 'pendente' AND vencimento > p_fim;
    GET DIAGNOSTICS n_canc = ROW_COUNT;
  END IF;
  IF coalesce(p_aplicar, false) THEN
    PERFORM set_config('fin.rec_auto', '1', true);
    UPDATE fin_lancamentos SET
      pessoa_id = nullif(m->>'pessoa_id','')::bigint,
      pessoa = coalesce((SELECT nome FROM fin_pessoas WHERE id = nullif(m->>'pessoa_id','')::bigint), pessoa),
      descricao = nullif(btrim(m->>'descricao'),''), classificacao_id = nullif(m->>'classificacao_id','')::bigint,
      centro_custo_id = nullif(m->>'centro_custo_id','')::bigint, unidade_id = nullif(m->>'unidade_id','')::bigint,
      conta_id = nullif(m->>'conta_id','')::uuid, forma = nullif(m->>'forma',''), valor = round(p_valor, 2),
      retencao = coalesce((m->>'retencao')::numeric, 0), retencao_tipo = nullif(m->>'retencao_tipo',''),
      nf_numero = nullif(m->>'nf_numero',''), codigo_barras = nullif(m->>'codigo_barras',''), pix_copia_cola = nullif(m->>'pix_copia_cola',''),
      observacao = nullif(btrim(m->>'observacao'),''), rateio = fin__valida_rateio(m->'rateio'),
      valor_a_confirmar = coalesce(p_variavel, false), atualizado_por = p_ator
    WHERE recorrencia_id = p_id AND status = 'pendente' AND vencimento >= hoje;
    GET DIAGNOSTICS n_upd = ROW_COUNT;
    PERFORM set_config('fin.rec_auto', '', true);
  END IF;
  PERFORM fin__rec_gerar_uma(p_ator, p_id);
  RETURN jsonb_build_object('ok', true, 'atualizados', n_upd, 'cancelados', n_canc);
END $$;

-- pausar | retomar | encerrar. Retomar pula os vencimentos que passaram durante a pausa.
-- Encerrar cancela (com o motivo) as ocorrências pendentes que vencem de hoje em diante, se p_cancelar_futuros.
CREATE OR REPLACE FUNCTION fin_rec_status(p_ator text, p_id bigint, p_acao text, p_motivo text, p_cancelar_futuros boolean) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE r fin_recorrencias; k int; n int := 0; hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  PERFORM fin_set_ator(p_ator);
  SELECT * INTO r FROM fin_recorrencias WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Recorrência não encontrada'; END IF;
  IF length(btrim(coalesce(p_motivo,''))) < 10 THEN RAISE EXCEPTION 'Diga o motivo (mínimo 10 letras)'; END IF;
  IF p_acao = 'pausar' THEN
    IF r.status <> 'ativa' THEN RAISE EXCEPTION 'Só recorrência ativa pode ser pausada'; END IF;
    UPDATE fin_recorrencias SET status = 'pausada', motivo = p_motivo, atualizado_por = p_ator WHERE id = p_id;
  ELSIF p_acao = 'retomar' THEN
    IF r.status <> 'pausada' THEN RAISE EXCEPTION 'Só recorrência pausada pode ser retomada'; END IF;
    k := r.gerados;
    WHILE fin_rec_venc(r.inicio, r.frequencia, k) < hoje AND k < r.gerados + 1000 LOOP k := k + 1; END LOOP;
    UPDATE fin_recorrencias SET status = 'ativa', gerados = k, motivo = p_motivo, atualizado_por = p_ator WHERE id = p_id;
    PERFORM fin__rec_gerar_uma(p_ator, p_id);
  ELSIF p_acao = 'encerrar' THEN
    IF r.status = 'encerrada' THEN RAISE EXCEPTION 'Já está encerrada'; END IF;
    UPDATE fin_recorrencias SET status = 'encerrada', encerrado_por = p_ator, encerrado_em = now(), motivo = p_motivo, atualizado_por = p_ator WHERE id = p_id;
    IF coalesce(p_cancelar_futuros, false) THEN
      UPDATE fin_lancamentos SET status = 'cancelado', cancelado_por = p_ator, cancelado_em = now(),
        motivo_cancelamento = 'Recorrência #' || p_id || ' encerrada: ' || left(p_motivo, 200)
      WHERE recorrencia_id = p_id AND status = 'pendente' AND vencimento >= hoje;
      GET DIAGNOSTICS n = ROW_COUNT;
    END IF;
  ELSE
    RAISE EXCEPTION 'Ação inválida';
  END IF;
  RETURN jsonb_build_object('ok', true, 'cancelados', n);
END $$;

-- "o valor deste mês confere" (conta variável): grava o valor do mês e tira o aviso
CREATE OR REPLACE FUNCTION fin_rec_confirmar_valor(p_ator text, p_id bigint, p_valor numeric) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE l fin_lancamentos;
BEGIN
  PERFORM fin_set_ator(p_ator);
  SELECT * INTO l FROM fin_lancamentos WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lançamento não encontrado'; END IF;
  IF l.status <> 'pendente' THEN RAISE EXCEPTION 'Só lançamento pendente'; END IF;
  IF p_valor IS NULL OR p_valor <= 0 OR p_valor > 1e9 THEN RAISE EXCEPTION 'Valor inválido'; END IF;
  IF l.desconto + l.retencao >= p_valor + l.juros + l.multa THEN RAISE EXCEPTION 'Desconto/retenção maior que o valor'; END IF;
  UPDATE fin_lancamentos SET valor = round(p_valor, 2), valor_a_confirmar = false, atualizado_por = p_ator WHERE id = p_id;
  RETURN jsonb_build_object('ok', true);
END $$;

-- Rodada diária (antes das regras): gera as contas do mês seguinte quando o mês vira
DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'fin_recorrencias_diarias';
  PERFORM cron.schedule('fin_recorrencias_diarias', '0 8 * * *', $c$SELECT fin_rec_gerar_todas('sistema:cron')$c$);
EXCEPTION WHEN undefined_table OR invalid_schema_name THEN NULL;
END $do$;

DO $do$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname LIKE 'fin\_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $do$;
