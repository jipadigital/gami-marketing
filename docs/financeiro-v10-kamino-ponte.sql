-- ============================================================
-- FINANCEIRO v10 (16/11/2026): PONTE DO ESPELHO DO KAMINO PARA TODAS AS TELAS
--
-- O dono quer "todos os dados do Kamino na nossa plataforma". O espelho (v9, fin_kmn_*) já
-- tem tudo; esta ponte copia cada lançamento espelhado para as tabelas que as telas antigas
-- usam:
--   * fin_lancamentos (origem 'kamino_api')  -> Painel, Pagar, Receber, Relatórios (DRE, fluxo)
--   * fin_pessoas                            -> Cadastros > Pessoas
--   * fin_ctl_cobrancas + fin_ctl_cob_receb  -> Controles > Empresas (semanal)  [recebimentos]
--
-- Regras:
--  * O Kamino é a fonte. O que veio dele NÃO se edita aqui (nem baixa manual): muda no Kamino,
--    o espelho vê, a ponte atualiza. Tudo auditado.
--  * Mudou cidade/semana/empresa/valor de uma cobrança no Kamino: a antiga é cancelada com o
--    motivo "Alterado no Kamino" e nasce outra (a tabela de cobranças não aceita reescrever).
--  * Recebimento que mudou ou foi desfeito no Kamino: o antigo é ESTORNADO, nunca apagado.
--  * Sumiu do Kamino: lançamento e cobrança cancelados com o motivo "Excluído no Kamino".
--  * Pendente de ponte = fin_kmn_lanc.ponte_hash diferente do hash atual. O kamino-sync chama
--    fin_kmn_ponte_pendentes() a cada rodada; erro numa linha não trava as outras.
--
-- Rode INTEIRO no SQL Editor do projeto gami-financeiro (vyjjdirlgvysbalrmmih). Idempotente.
-- ============================================================

ALTER TABLE fin_kmn_lanc ADD COLUMN IF NOT EXISTS ponte_hash text;
ALTER TABLE fin_kmn_lanc ADD COLUMN IF NOT EXISTS ponte_erro text;

-- assinatura do estado que a ponte já copiou (hash + se sumiu)
CREATE OR REPLACE FUNCTION fin__kmn_ponte_alvo(l fin_kmn_lanc) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT l.hash || CASE WHEN l.sumiu_em IS NOT NULL THEN ':sumiu' ELSE '' END $$;

-- ---------- 1) fin_lancamentos + fin_pessoas ----------
CREATE OR REPLACE FUNCTION fin__kmn_ponte_lanc(l fin_kmn_lanc) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE d jsonb := l.dados; v_pessoa bigint; v_valor numeric; v_status text; v_chave text;
BEGIN
  v_valor := coalesce(CASE WHEN l.data_pagamento IS NOT NULL THEN l.valor_pago END, l.valor);
  v_chave := CASE l.tipo WHEN 'pagar' THEN 'KP:' ELSE 'KR:' END || l.kamino_id;
  IF v_valor IS NULL OR v_valor <= 0 THEN
    -- valor zerado no Kamino: se já existia aqui, cancela; senão não há o que mostrar
    UPDATE fin_lancamentos SET status = 'cancelado', cancelado_por = 'kamino', cancelado_em = now(),
           motivo_cancelamento = 'Valor zerado no Kamino', situacao = d->>'situacao', raw = d
     WHERE origem = 'kamino_api' AND chave = v_chave AND status <> 'cancelado';
    RETURN;
  END IF;
  -- pessoa: pelo nome (o CPF/CNPJ vem mascarado do espelho, de propósito)
  IF fin_norm(l.pessoa) IS NOT NULL THEN
    SELECT id INTO v_pessoa FROM fin_pessoas WHERE nome_norm = fin_norm(l.pessoa) ORDER BY id LIMIT 1;
    IF v_pessoa IS NULL THEN
      INSERT INTO fin_pessoas (nome, cliente, fornecedor, criado_por)
      VALUES (left(btrim(l.pessoa), 200), l.tipo = 'receber', l.tipo = 'pagar', 'sistema:kamino') RETURNING id INTO v_pessoa;
    END IF;
  END IF;
  v_status := CASE WHEN l.sumiu_em IS NOT NULL THEN 'cancelado'
                   WHEN l.data_pagamento IS NOT NULL THEN 'pago' ELSE 'pendente' END;
  INSERT INTO fin_lancamentos (origem, chave, tipo, pessoa, pessoa_doc, pessoa_norm, pessoa_id, descricao, categoria, unidade, conta_nome,
                               classificacao_id, unidade_id, conta_id, centro_custo_id, forma, nf_numero, observacao,
                               valor, vencimento, competencia, data_pagamento, situacao, status, cancelado_por, cancelado_em, motivo_cancelamento,
                               raw, criado_por)
  VALUES ('kamino_api', v_chave, l.tipo, l.pessoa, d->>'pessoa_doc', fin_norm(l.pessoa), v_pessoa, d->>'descricao', l.classificacao, l.unidade, d->>'conta',
    (SELECT id FROM fin_classificacoes c WHERE fin_norm(c.nome) = fin_norm(l.classificacao) OR fin_norm(coalesce(c.codigo,'')||' '||c.nome) = fin_norm(l.classificacao) ORDER BY c.id LIMIT 1),
    (SELECT id FROM fin_unidades u WHERE fin_norm(u.nome) = fin_norm(l.unidade) LIMIT 1),
    (SELECT id FROM fin_contas c WHERE fin_norm(c.nome) = fin_norm(d->>'conta') OR fin_norm(d->>'forma') LIKE '%' || fin_norm(c.nome) LIMIT 1),
    (SELECT id FROM fin_centros_custo c WHERE fin_norm(c.nome) = fin_norm(coalesce(d->>'centro_custo','Geral')) LIMIT 1),
    left(d->>'forma', 60), d->>'nf', d->>'obs',
    v_valor, l.vencimento, coalesce(fin__kd(d->>'competencia'), l.vencimento), l.data_pagamento, d->>'situacao', v_status,
    CASE WHEN v_status = 'cancelado' THEN 'kamino' END, CASE WHEN v_status = 'cancelado' THEN now() END,
    CASE WHEN v_status = 'cancelado' THEN 'Excluído no Kamino' END, d, 'sistema:kamino')
  ON CONFLICT (origem, chave) DO UPDATE SET
    pessoa = EXCLUDED.pessoa, pessoa_doc = EXCLUDED.pessoa_doc, pessoa_norm = EXCLUDED.pessoa_norm, pessoa_id = EXCLUDED.pessoa_id,
    descricao = EXCLUDED.descricao, categoria = EXCLUDED.categoria, unidade = EXCLUDED.unidade, conta_nome = EXCLUDED.conta_nome,
    classificacao_id = EXCLUDED.classificacao_id, unidade_id = EXCLUDED.unidade_id, conta_id = EXCLUDED.conta_id, centro_custo_id = EXCLUDED.centro_custo_id,
    forma = EXCLUDED.forma, nf_numero = EXCLUDED.nf_numero, observacao = EXCLUDED.observacao,
    valor = EXCLUDED.valor, vencimento = EXCLUDED.vencimento, competencia = EXCLUDED.competencia, data_pagamento = EXCLUDED.data_pagamento,
    situacao = EXCLUDED.situacao, status = EXCLUDED.status, cancelado_por = EXCLUDED.cancelado_por, cancelado_em = EXCLUDED.cancelado_em,
    motivo_cancelamento = EXCLUDED.motivo_cancelamento, raw = EXCLUDED.raw;
END $$;

-- ---------- 2) Controles > Empresas (semanal) ----------
CREATE OR REPLACE FUNCTION fin__kmn_ponte_cob(l fin_kmn_lanc) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE d jsonb := l.dados; v_un bigint; v_sem date; v_val numeric; v_desc numeric; v_chave text; v_pref text;
        v_cob bigint; r record; v_receb numeric;
BEGIN
  IF l.tipo <> 'receber' THEN RETURN; END IF;
  v_pref := 'KMN:' || l.kamino_id || ':';
  v_un := (SELECT id FROM fin_unidades u WHERE fin_norm(u.nome) = fin_norm(l.unidade) LIMIT 1);
  v_sem := coalesce(fin__kd(d->>'competencia'), l.vencimento);
  IF v_sem IS NOT NULL THEN v_sem := v_sem - ((extract(isodow FROM v_sem)::int) - 1); END IF; -- segunda-feira
  v_val := l.valor;
  -- excluído no Kamino, sem cidade, sem semana, sem valor ou sem empresa: cancela o que existir e sai
  IF l.sumiu_em IS NOT NULL OR v_un IS NULL OR v_sem IS NULL OR v_val IS NULL OR v_val < 0 OR length(btrim(coalesce(l.pessoa,''))) < 2 THEN
    UPDATE fin_ctl_cobrancas SET status = 'cancelada', cancelado_motivo = CASE WHEN l.sumiu_em IS NOT NULL THEN 'Excluído no Kamino' ELSE 'Sem cidade/semana/valor no Kamino' END,
           cancelado_por = 'sistema:kamino', cancelado_em = now()
     WHERE origem = 'kamino' AND chave LIKE v_pref || '%' AND status = 'ativa';
    RETURN;
  END IF;
  v_desc := least(greatest(coalesce((d->>'desconto')::numeric, 0), 0), v_val);
  v_chave := v_pref || md5(v_un || '|' || v_sem || '|' || fin_norm(l.pessoa) || '|' || v_val);
  -- a cobrança desta versão (cidade/semana/empresa/valor)
  SELECT id INTO v_cob FROM fin_ctl_cobrancas WHERE chave = v_chave AND status = 'ativa';
  IF v_cob IS NULL THEN
    -- mudou o essencial no Kamino: cancela a anterior (nunca reescreve)
    UPDATE fin_ctl_cobrancas SET status = 'cancelada', cancelado_motivo = 'Alterado no Kamino (cidade, semana, empresa ou valor)',
           cancelado_por = 'sistema:kamino', cancelado_em = now()
     WHERE origem = 'kamino' AND chave LIKE v_pref || '%' AND status = 'ativa';
    IF EXISTS (SELECT 1 FROM fin_ctl_cobrancas WHERE chave = v_chave) THEN v_chave := v_chave || ':v' || l.versao; END IF;
    -- multa_pct 0: no Kamino o valor cobrado já é o final (juros/multa, se houve, vêm no valor recebido)
    INSERT INTO fin_ctl_cobrancas (unidade_id, semana_ini, semana_fim, empresa, empresa_norm, valor, desconto, desconto_motivo, multa_pct, vencimento,
                                   nome_no_banco, observacao, origem, chave, criado_por)
    VALUES (v_un, v_sem, v_sem + 6, left(btrim(l.pessoa), 200), fin_norm(l.pessoa), v_val, v_desc,
            CASE WHEN v_desc > 0 THEN 'Desconto dado no Kamino' END, 0, l.vencimento, NULL,
            'Kamino #' || l.kamino_id || coalesce(' · ' || (d->>'descricao'), ''), 'kamino', v_chave, 'sistema:kamino')
    ON CONFLICT (chave) DO NOTHING
    RETURNING id INTO v_cob;
    IF v_cob IS NULL THEN SELECT id INTO v_cob FROM fin_ctl_cobrancas WHERE chave = v_chave; END IF;
  ELSIF (SELECT desconto FROM fin_ctl_cobrancas WHERE id = v_cob) IS DISTINCT FROM v_desc OR
        (SELECT vencimento FROM fin_ctl_cobrancas WHERE id = v_cob) IS DISTINCT FROM l.vencimento THEN
    UPDATE fin_ctl_cobrancas SET desconto = v_desc, desconto_motivo = CASE WHEN v_desc > 0 THEN 'Desconto dado no Kamino' END,
           vencimento = l.vencimento, atualizado_por = 'sistema:kamino', atualizado_em = now()
     WHERE id = v_cob;
  END IF;
  -- recebimento: o que o Kamino diz que entrou
  v_receb := CASE WHEN l.data_pagamento IS NOT NULL THEN coalesce(l.valor_pago, l.valor) END;
  FOR r IN SELECT * FROM fin_ctl_cob_receb WHERE cobranca_id = v_cob AND origem = 'kamino' AND NOT estornado LOOP
    IF v_receb IS NULL OR v_receb <= 0 OR r.valor <> v_receb OR r.data <> l.data_pagamento THEN
      UPDATE fin_ctl_cob_receb SET estornado = true, estorno_motivo = 'Alterado ou desfeito no Kamino', estornado_por = 'sistema:kamino', estornado_em = now()
       WHERE id = r.id;
    END IF;
  END LOOP;
  IF v_receb > 0 AND NOT EXISTS (SELECT 1 FROM fin_ctl_cob_receb WHERE cobranca_id = v_cob AND origem = 'kamino' AND NOT estornado) THEN
    INSERT INTO fin_ctl_cob_receb (cobranca_id, valor, data, forma, observacao, origem, criado_por)
    VALUES (v_cob, v_receb, l.data_pagamento, left(coalesce(d->>'forma', 'Kamino'), 60), 'Recebido segundo o Kamino #' || l.kamino_id, 'kamino', 'sistema:kamino');
  END IF;
END $$;

-- ---------- 3) Processa os pendentes (chamada pelo kamino-sync a cada rodada) ----------
CREATE OR REPLACE FUNCTION fin_kmn_ponte_pendentes(p_limite int DEFAULT 500)
RETURNS jsonb LANGUAGE plpgsql SET statement_timeout = '120s' AS $$
DECLARE l fin_kmn_lanc%ROWTYPE; n int := 0; e int := 0; v_msg text;
BEGIN
  PERFORM set_config('fin.ator', 'sistema:kamino', true);
  FOR l IN SELECT * FROM fin_kmn_lanc x WHERE x.ponte_hash IS DISTINCT FROM fin__kmn_ponte_alvo(x)
             ORDER BY x.id LIMIT greatest(1, least(coalesce(p_limite, 500), 2000)) LOOP
    BEGIN
      PERFORM fin__kmn_ponte_lanc(l);
      PERFORM fin__kmn_ponte_cob(l);
      PERFORM set_config('fin.kmn', '1', true);
      UPDATE fin_kmn_lanc SET ponte_hash = fin__kmn_ponte_alvo(l), ponte_erro = NULL WHERE id = l.id;
      PERFORM set_config('fin.kmn', '', true);
      n := n + 1;
    EXCEPTION WHEN OTHERS THEN
      -- uma linha com problema não trava as outras; fica marcada pra olhar
      v_msg := left(SQLERRM, 300);
      PERFORM set_config('fin.kmn', '1', true);
      UPDATE fin_kmn_lanc SET ponte_hash = fin__kmn_ponte_alvo(l), ponte_erro = v_msg WHERE id = l.id;
      PERFORM set_config('fin.kmn', '', true);
      e := e + 1;
    END;
  END LOOP;
  RETURN jsonb_build_object('copiados', n, 'erros', e,
    'faltam', (SELECT count(*) FROM fin_kmn_lanc x WHERE x.ponte_hash IS DISTINCT FROM fin__kmn_ponte_alvo(x)));
END $$;

-- ---------- 4) O que veio do Kamino não se mexe à mão ----------
CREATE OR REPLACE FUNCTION fin_trg_lanc_kmn_trava() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.origem = 'kamino_api' AND coalesce(current_setting('fin.ator', true), '') <> 'sistema:kamino' THEN
    RAISE EXCEPTION 'FINANCEIRO: este lançamento veio do Kamino. Corrija no Kamino: a mudança chega aqui sozinha.';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION fin_trg_baixa_kmn_trava() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM fin_lancamentos WHERE id = NEW.lancamento_id AND origem = 'kamino_api') THEN
    RAISE EXCEPTION 'FINANCEIRO: este lançamento veio do Kamino. A baixa é feita no Kamino.';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION fin_trg_cob_kmn_trava() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'fin_ctl_cobrancas' THEN
    IF OLD.origem = 'kamino' AND coalesce(current_setting('fin.ator', true), '') <> 'sistema:kamino' THEN
      RAISE EXCEPTION 'FINANCEIRO: esta cobrança veio do Kamino. Corrija no Kamino: a mudança chega aqui sozinha.';
    END IF;
    RETURN NEW;
  END IF;
  -- recebimento manual numa cobrança do Kamino: não (o recebimento vem do Kamino)
  IF TG_OP = 'INSERT' AND coalesce(current_setting('fin.ator', true), '') <> 'sistema:kamino'
     AND EXISTS (SELECT 1 FROM fin_ctl_cobrancas WHERE id = NEW.cobranca_id AND origem = 'kamino') THEN
    RAISE EXCEPTION 'FINANCEIRO: esta cobrança veio do Kamino. O recebimento é registrado no Kamino.';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.origem = 'kamino' AND coalesce(current_setting('fin.ator', true), '') <> 'sistema:kamino' THEN
    RAISE EXCEPTION 'FINANCEIRO: recebimento do Kamino só muda pelo Kamino.';
  END IF;
  RETURN NEW;
END $$;
DO $do$ BEGIN
  DROP TRIGGER IF EXISTS fin_lanc_kmn_trava ON fin_lancamentos;
  CREATE TRIGGER fin_lanc_kmn_trava BEFORE UPDATE ON fin_lancamentos FOR EACH ROW EXECUTE FUNCTION fin_trg_lanc_kmn_trava();
  DROP TRIGGER IF EXISTS fin_baixa_kmn_trava ON fin_baixas;
  CREATE TRIGGER fin_baixa_kmn_trava BEFORE INSERT ON fin_baixas FOR EACH ROW EXECUTE FUNCTION fin_trg_baixa_kmn_trava();
  DROP TRIGGER IF EXISTS fin_cob_kmn_trava ON fin_ctl_cobrancas;
  CREATE TRIGGER fin_cob_kmn_trava BEFORE UPDATE ON fin_ctl_cobrancas FOR EACH ROW EXECUTE FUNCTION fin_trg_cob_kmn_trava();
  DROP TRIGGER IF EXISTS fin_cob_receb_kmn_trava ON fin_ctl_cob_receb;
  CREATE TRIGGER fin_cob_receb_kmn_trava BEFORE INSERT OR UPDATE ON fin_ctl_cob_receb FOR EACH ROW EXECUTE FUNCTION fin_trg_cob_kmn_trava();
END $do$;

-- ---------- Funções: só a service key executa ----------
DO $do$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname LIKE 'fin\_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $do$;

-- Conferência rápida (rode depois): quantos faltam copiar
-- SELECT fin_kmn_ponte_pendentes(0);
