-- ============================================================
-- FINANCEIRO GÂMI v8: CORREÇÕES DA REVISÃO DE 12/11/2026 (antes das meninas testarem)
-- ------------------------------------------------------------
--  1. Caixa de entrada: "Lançar" não apaga mais os dados do documento (campo que não veio = fica como está)
--  2. Recorrência: código de barras, Pix copia e cola e nº da NF NÃO são copiados pros próximos meses
--  3. Recorrência: mudar o modelo ("aplicar nas pendentes") não passa por cima de mês editado/confirmado à mão
--  4. "Dividir em dois": divide desconto e retenção na proporção, leva código de barras/Pix, nunca deixa parte ≤ 0
--  5. Tirar a pessoa de um lançamento manual tira também o nome
--  6. Controles: quem editou, registrou recebimento ou pagamento da linha também não confirma a própria linha
--  7. Bags/camisetas/motoboys novos: pagamento não pode passar do valor da linha
-- Rodar depois do v7. Idempotente.
-- ============================================================
SET search_path = public, extensions;

-- 1) Caixa de entrada --------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_salvar_entrada(p_ator text, p_id bigint, d jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF p_id IS NULL THEN
    INSERT INTO fin_entradas (beneficiario, documento, vencimento, valor, linha_digitavel, observacao, status, por)
    VALUES (nullif(d->>'beneficiario',''), nullif(d->>'documento',''), nullif(d->>'vencimento','')::date, nullif(d->>'valor','')::numeric,
            nullif(d->>'linha_digitavel',''), nullif(d->>'observacao',''), coalesce(nullif(d->>'status',''),'pendente'), p_ator)
    RETURNING id INTO v_id;
  ELSE
    -- só muda o campo que VEIO no pedido (o "Lançar" manda só status + lançamento e não pode zerar o resto)
    UPDATE fin_entradas SET
      beneficiario    = CASE WHEN d ? 'beneficiario'    THEN nullif(d->>'beneficiario','')            ELSE beneficiario END,
      documento       = CASE WHEN d ? 'documento'       THEN nullif(d->>'documento','')               ELSE documento END,
      vencimento      = CASE WHEN d ? 'vencimento'      THEN nullif(d->>'vencimento','')::date        ELSE vencimento END,
      valor           = CASE WHEN d ? 'valor'           THEN nullif(d->>'valor','')::numeric          ELSE valor END,
      linha_digitavel = CASE WHEN d ? 'linha_digitavel' THEN nullif(d->>'linha_digitavel','')         ELSE linha_digitavel END,
      observacao      = CASE WHEN d ? 'observacao'      THEN nullif(d->>'observacao','')              ELSE observacao END,
      status = coalesce(nullif(d->>'status',''), status),
      lancamento_id = coalesce(nullif(d->>'lancamento_id','')::bigint, lancamento_id), motivo_arquivo = coalesce(nullif(d->>'motivo_arquivo',''), motivo_arquivo),
      atualizado_por = p_ator, atualizado_em = now()
    WHERE id = p_id RETURNING id INTO v_id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

-- 2) Recorrência: dados de pagamento do mês não viram modelo --------------------
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
  -- código de barras, Pix copia e cola e NF são de UM mês só: ficam fora do modelo
  FOR k IN SELECT jsonb_object_keys(m) LOOP
    IF k NOT IN ('pessoa_id','descricao','classificacao_id','centro_custo_id','unidade_id','conta_id','forma','retencao','retencao_tipo','observacao','rateio') THEN
      m := m - k;
    END IF;
  END LOOP;
  RETURN m;
END $$;
-- limpa modelos antigos que já tenham esses campos
UPDATE fin_recorrencias SET modelo = modelo - 'codigo_barras' - 'pix_copia_cola' - 'nf_numero', atualizado_por = 'sistema:v8'
WHERE modelo ?| ARRAY['codigo_barras','pix_copia_cola','nf_numero'];

-- 3) Recorrência: mês mexido à mão fica como está ----------------------------------
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS rec_editado boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION fin_trg_lanc_rec_valor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_auto boolean := coalesce(current_setting('fin.rec_auto', true), '') = '1';
BEGIN
  IF OLD.valor_a_confirmar AND NEW.valor_a_confirmar AND NOT v_auto
     AND (NEW.valor IS DISTINCT FROM OLD.valor OR NEW.status = 'pago') THEN
    NEW.valor_a_confirmar := false;
  END IF;
  -- alguém mexeu nesta ocorrência (editou, confirmou o valor, dividiu): o modelo não passa mais por cima dela
  IF NEW.recorrencia_id IS NOT NULL AND NOT v_auto AND OLD.status = 'pendente' AND NEW.status = 'pendente' THEN
    NEW.rec_editado := true;
  END IF;
  IF NEW.recorrencia_id IS DISTINCT FROM OLD.recorrencia_id OR NEW.recorrencia_seq IS DISTINCT FROM OLD.recorrencia_seq THEN
    RAISE EXCEPTION 'FINANCEIRO: vínculo com a recorrência não muda';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION fin_rec_salvar(p_ator text, p_id bigint, p_modelo jsonb, p_valor numeric, p_variavel boolean,
                                          p_fim date, p_aplicar boolean) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE r fin_recorrencias; m jsonb; n_upd int := 0; n_canc int := 0; n_mao int := 0; hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
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
  IF p_fim IS NOT NULL THEN
    UPDATE fin_lancamentos SET status = 'cancelado', cancelado_por = p_ator, cancelado_em = now(),
      motivo_cancelamento = 'Recorrência #' || p_id || ' agora termina em ' || to_char(p_fim, 'DD/MM/YYYY')
    WHERE recorrencia_id = p_id AND status = 'pendente' AND vencimento > p_fim;
    GET DIAGNOSTICS n_canc = ROW_COUNT;
  END IF;
  IF coalesce(p_aplicar, false) THEN
    SELECT count(*) INTO n_mao FROM fin_lancamentos WHERE recorrencia_id = p_id AND status = 'pendente' AND vencimento >= hoje AND rec_editado;
    PERFORM set_config('fin.rec_auto', '1', true);
    UPDATE fin_lancamentos SET
      pessoa_id = nullif(m->>'pessoa_id','')::bigint,
      pessoa = (SELECT nome FROM fin_pessoas WHERE id = nullif(m->>'pessoa_id','')::bigint),
      descricao = nullif(btrim(m->>'descricao'),''), classificacao_id = nullif(m->>'classificacao_id','')::bigint,
      centro_custo_id = nullif(m->>'centro_custo_id','')::bigint, unidade_id = nullif(m->>'unidade_id','')::bigint,
      conta_id = nullif(m->>'conta_id','')::uuid, forma = nullif(m->>'forma',''), valor = round(p_valor, 2),
      retencao = coalesce((m->>'retencao')::numeric, 0), retencao_tipo = nullif(m->>'retencao_tipo',''),
      observacao = nullif(btrim(m->>'observacao'),''), rateio = fin__valida_rateio(m->'rateio'),
      valor_a_confirmar = coalesce(p_variavel, false), atualizado_por = p_ator
    WHERE recorrencia_id = p_id AND status = 'pendente' AND vencimento >= hoje AND NOT rec_editado;
    GET DIAGNOSTICS n_upd = ROW_COUNT;
    PERFORM set_config('fin.rec_auto', '', true);
  END IF;
  PERFORM fin__rec_gerar_uma(p_ator, p_id);
  RETURN jsonb_build_object('ok', true, 'atualizados', n_upd, 'cancelados', n_canc, 'mexidos_a_mao', n_mao);
END $$;

-- 4) Dividir em dois ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_split_lancamento(p_ator text, p_id bigint, p_valor2 numeric, p_venc2 date) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE l fin_lancamentos; v_novo bigint; f numeric; d2 numeric; r2 numeric;
BEGIN
  PERFORM fin_set_ator(p_ator);
  SELECT * INTO l FROM fin_lancamentos WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lançamento não encontrado'; END IF;
  IF l.status <> 'pendente' THEN RAISE EXCEPTION 'Só lançamento pendente pode ser dividido'; END IF;
  IF p_valor2 IS NULL OR p_valor2 <= 0 OR p_valor2 >= l.valor THEN RAISE EXCEPTION 'Valor da 2ª parte deve ser maior que zero e menor que o total'; END IF;
  -- desconto e retenção vão junto, na mesma proporção do valor
  f := p_valor2 / l.valor; d2 := round(l.desconto * f, 2); r2 := round(l.retencao * f, 2);
  IF (l.valor - p_valor2) + l.juros + l.multa - (l.desconto - d2) - (l.retencao - r2) <= 0 OR p_valor2 - d2 - r2 <= 0 THEN
    RAISE EXCEPTION 'Com esse valor uma das partes ficaria zerada ou negativa';
  END IF;
  UPDATE fin_lancamentos SET valor = l.valor - p_valor2, desconto = l.desconto - d2, retencao = l.retencao - r2, atualizado_por = p_ator WHERE id = p_id;
  INSERT INTO fin_lancamentos (origem, chave, tipo, pessoa_id, pessoa, descricao, classificacao_id, centro_custo_id, unidade_id, conta_id,
    forma, valor, desconto, retencao, retencao_tipo, vencimento, competencia, nf_numero, codigo_barras, pix_copia_cola, observacao, rateio, status, criado_por)
  VALUES ('manual', 'M:'||gen_random_uuid(), l.tipo, l.pessoa_id, l.pessoa, coalesce(l.descricao,'')||' (split de #'||l.id||')',
    l.classificacao_id, l.centro_custo_id, l.unidade_id, l.conta_id, l.forma, p_valor2, d2, r2, l.retencao_tipo, coalesce(p_venc2, l.vencimento), l.competencia,
    l.nf_numero, l.codigo_barras, l.pix_copia_cola, l.observacao, l.rateio, 'pendente', p_ator)
  RETURNING id INTO v_novo;
  RETURN jsonb_build_object('ok', true, 'novo_id', v_novo);
END $$;

-- 5) Editar lançamento: tirar a pessoa tira o nome (nos manuais) ------------------------------------
CREATE OR REPLACE FUNCTION fin_editar_lancamento(p_ator text, p_id bigint, i jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE l fin_lancamentos;
BEGIN
  PERFORM fin_set_ator(p_ator);
  SELECT * INTO l FROM fin_lancamentos WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lançamento não encontrado'; END IF;
  IF l.status <> 'pendente' THEN RAISE EXCEPTION 'Só dá pra editar lançamento pendente (estorne a baixa antes)'; END IF;
  UPDATE fin_lancamentos SET
    pessoa_id = nullif(i->>'pessoa_id','')::bigint,
    pessoa = CASE WHEN l.origem = 'manual' THEN (SELECT nome FROM fin_pessoas WHERE id = nullif(i->>'pessoa_id','')::bigint)
                  ELSE coalesce((SELECT nome FROM fin_pessoas WHERE id = nullif(i->>'pessoa_id','')::bigint), pessoa) END,
    descricao = nullif(btrim(i->>'descricao'),''), classificacao_id = nullif(i->>'classificacao_id','')::bigint,
    centro_custo_id = nullif(i->>'centro_custo_id','')::bigint, unidade_id = nullif(i->>'unidade_id','')::bigint,
    conta_id = nullif(i->>'conta_id','')::uuid, forma = nullif(i->>'forma',''),
    valor = (i->>'valor')::numeric, juros = coalesce((i->>'juros')::numeric,0), multa = coalesce((i->>'multa')::numeric,0),
    desconto = coalesce((i->>'desconto')::numeric,0), retencao = coalesce((i->>'retencao')::numeric,0), retencao_tipo = nullif(i->>'retencao_tipo',''),
    vencimento = (i->>'vencimento')::date, competencia = coalesce(nullif(i->>'competencia','')::date, (i->>'vencimento')::date),
    nf_numero = nullif(i->>'nf_numero',''), codigo_barras = nullif(i->>'codigo_barras',''), pix_copia_cola = nullif(i->>'pix_copia_cola',''),
    observacao = nullif(btrim(i->>'observacao'),''), rateio = fin__valida_rateio(i->'rateio'), atualizado_por = p_ator
  WHERE id = p_id;
  RETURN jsonb_build_object('ok', true);
END $$;

-- 6) Controles: ninguém confere o que ele mesmo lançou, editou, recebeu ou pagou ---------------------
CREATE OR REPLACE FUNCTION fin_ctl_conferir(p_ator text, p_tabela text, p_ids bigint[], p_status text, p_obs text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_id bigint; v_autor text; v_edit text; v_mexeu boolean; v_ok int := 0; v_pulados int := 0;
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF p_status NOT IN ('ok','divergente') THEN RAISE EXCEPTION 'Status inválido'; END IF;
  IF p_status = 'divergente' AND length(coalesce(btrim(p_obs), '')) < 10 THEN RAISE EXCEPTION 'Divergência precisa de observação (mín. 10 letras)'; END IF;
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL OR array_length(p_ids, 1) > 500 THEN RAISE EXCEPTION 'Selecione de 1 a 500 registros'; END IF;
  FOREACH v_id IN ARRAY p_ids LOOP
    v_mexeu := false;
    IF p_tabela = 'fin_ctl_cobrancas' THEN
      SELECT criado_por, atualizado_por INTO v_autor, v_edit FROM fin_ctl_cobrancas WHERE id = v_id AND status = 'ativa';
      IF FOUND THEN v_mexeu := EXISTS (SELECT 1 FROM fin_ctl_cob_receb WHERE cobranca_id = v_id AND NOT estornado AND criado_por = p_ator); END IF;
    ELSIF p_tabela = 'fin_ctl_creditos' THEN
      SELECT criado_por, atualizado_por INTO v_autor, v_edit FROM fin_ctl_creditos WHERE id = v_id AND status = 'ativo';
    ELSIF p_tabela = 'fin_ctl_registros' THEN
      SELECT criado_por, atualizado_por INTO v_autor, v_edit FROM fin_ctl_registros WHERE id = v_id AND status = 'ativo';
      IF FOUND THEN v_mexeu := EXISTS (SELECT 1 FROM fin_ctl_reg_pag WHERE registro_id = v_id AND NOT estornado AND criado_por = p_ator); END IF;
    ELSE RAISE EXCEPTION 'Tabela inválida'; END IF;
    IF v_autor IS NULL THEN v_pulados := v_pulados + 1; CONTINUE; END IF;
    IF v_autor = p_ator OR v_edit = p_ator OR v_mexeu THEN
      IF array_length(p_ids, 1) = 1 THEN RAISE EXCEPTION 'Quem lançou, alterou ou registrou pagamento desta linha não pode conferir: peça a outra pessoa'; END IF;
      v_pulados := v_pulados + 1; CONTINUE;
    END IF;
    INSERT INTO fin_ctl_conferencias (tabela, registro_id, status, observacao, conferido_por)
    VALUES (p_tabela, v_id, p_status, fin_ctl_txt(p_obs, 1000), p_ator);
    v_ok := v_ok + 1;
    v_autor := NULL; v_edit := NULL;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'conferidos', v_ok, 'pulados', v_pulados);
END $$;

-- 7) Pagamento de bag/camiseta/motoboy novo não passa do valor da linha -------------------------------
CREATE OR REPLACE FUNCTION fin_trg_reg_pag_limite() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_valor numeric; v_pago numeric;
BEGIN
  SELECT valor INTO v_valor FROM fin_ctl_registros WHERE id = NEW.registro_id;
  SELECT coalesce(sum(valor), 0) INTO v_pago FROM fin_ctl_reg_pag WHERE registro_id = NEW.registro_id AND NOT estornado;
  IF v_pago + NEW.valor > coalesce(v_valor, 0) + 0.009 THEN
    RAISE EXCEPTION 'Pagamento maior que o valor da linha (valor %, já pago %)', v_valor, v_pago;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fin_ctl_reg_pag_limite ON fin_ctl_reg_pag;
CREATE TRIGGER fin_ctl_reg_pag_limite BEFORE INSERT ON fin_ctl_reg_pag FOR EACH ROW EXECUTE FUNCTION fin_trg_reg_pag_limite();

DO $do$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname LIKE 'fin\_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $do$;
