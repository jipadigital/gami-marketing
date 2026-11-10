-- ============================================================
-- FINANCEIRO GÂMI v5: AS OUTRAS PLANILHAS DAS MENINAS (10/11/2026)
-- ------------------------------------------------------------
-- Cada planilha vira uma tela própria, com as MESMAS colunas da planilha:
--   bag              BAGS: nome, quant, forma, valor unitário, pagamentos (1º, 2º...), pago em nome de quem
--   camiseta         CAMISETAS: idem + tamanho
--   moto_novo        MOTOBOYS NOVOS: nome, valor (taxa), data, pago em nome de quem
--   motoboy_semanal  MOTOBOYS: semana, nome, faturamento, % da Gâmi (21), valor a pagar, total do entregador
--   desconto_banco   DESCONTOS dentro do banco (saídas do Cora): nome, valor, motivo, data
--   desconto_fora    DESCONTOS fora do banco: favorecido, valor, motivo, data, responsável
-- Mesmas travas do resto: nada se apaga (cancelar com motivo), valor/nome não mudam depois de lançados,
-- quem lança não confere ("CONFIRMAÇÃO"/"ok" da planilha vira conferência de OUTRA pessoa), pagamento
-- não se edita (estorna), tudo auditado, RLS + REVOKE. Rodar depois do v4. Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS fin_ctl_registros (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo             text NOT NULL CHECK (tipo IN ('bag','camiseta','moto_novo','motoboy_semanal','desconto_banco','desconto_fora')),
  unidade_id       bigint NOT NULL REFERENCES fin_unidades(id),
  data             date NOT NULL,                 -- data do pedido/lançamento (motoboy_semanal: início da semana)
  semana_ini       date,
  semana_fim       date,
  nome             text NOT NULL CHECK (length(btrim(nome)) BETWEEN 2 AND 200),
  nome_norm        text NOT NULL,
  quantidade       integer CHECK (quantidade IS NULL OR quantidade BETWEEN 1 AND 1000),
  tamanho          text,
  forma            text CHECK (forma IS NULL OR forma IN ('pix','dinheiro','cartao','boleto','cortesia','desconto_semanal','outro')),
  valor_unitario   numeric(14,2) CHECK (valor_unitario IS NULL OR valor_unitario >= 0),
  valor            numeric(14,2) NOT NULL CHECK (valor >= 0 AND valor <= 10000000),   -- total devido / valor do desconto / faturamento
  percentual       numeric(5,2) CHECK (percentual IS NULL OR percentual BETWEEN 0 AND 100),
  valor_gami       numeric(14,2),
  valor_entregador numeric(14,2),
  motivo           text,
  responsavel      text,
  pago_por         text,                          -- "PAGAMENTO EM NOME DE QUEM"
  observacao       text,
  origem           text NOT NULL CHECK (origem IN ('manual','planilha','machine')),
  importacao_id    uuid REFERENCES fin_ctl_importacoes(id),
  chave            text NOT NULL,
  status           text NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','cancelado')),
  cancelado_motivo text,
  cancelado_por    text,
  cancelado_em     timestamptz,
  criado_por       text NOT NULL,
  criado_em        timestamptz NOT NULL DEFAULT now(),
  atualizado_por   text,
  atualizado_em    timestamptz,
  CHECK (tipo <> 'motoboy_semanal' OR (semana_ini IS NOT NULL AND semana_fim IS NOT NULL AND semana_fim >= semana_ini))
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_ctl_reg_chave ON fin_ctl_registros (chave);
CREATE INDEX IF NOT EXISTS fin_ctl_reg_tipo ON fin_ctl_registros (tipo, unidade_id, data);
CREATE INDEX IF NOT EXISTS fin_ctl_reg_nome ON fin_ctl_registros (nome_norm);

-- pagamentos (bags/camisetas podem ser pagos em partes: "VALOR DO 1º PAG", depois o resto)
CREATE TABLE IF NOT EXISTS fin_ctl_reg_pag (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  registro_id    bigint NOT NULL REFERENCES fin_ctl_registros(id),
  valor          numeric(14,2) NOT NULL CHECK (valor > 0 AND valor <= 10000000),
  data           date NOT NULL,
  forma          text,
  pago_por       text,
  observacao     text,
  origem         text NOT NULL DEFAULT 'manual',
  estornado      boolean NOT NULL DEFAULT false,
  estorno_motivo text,
  estornado_por  text,
  estornado_em   timestamptz,
  criado_por     text NOT NULL,
  criado_em      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_ctl_regpag_reg ON fin_ctl_reg_pag (registro_id);

-- conferências e importações passam a aceitar as planilhas novas
DO $do$
BEGIN
  ALTER TABLE fin_ctl_conferencias DROP CONSTRAINT IF EXISTS fin_ctl_conferencias_tabela_check;
  ALTER TABLE fin_ctl_conferencias ADD CONSTRAINT fin_ctl_conferencias_tabela_check CHECK (tabela IN ('fin_ctl_cobrancas','fin_ctl_creditos','fin_ctl_registros'));
  ALTER TABLE fin_ctl_importacoes DROP CONSTRAINT IF EXISTS fin_ctl_importacoes_tipo_check;
  ALTER TABLE fin_ctl_importacoes ADD CONSTRAINT fin_ctl_importacoes_tipo_check CHECK (tipo IN ('empresas','creditos','bag','camiseta','moto_novo','motoboy_semanal','descontos'));
END $do$;

-- Guardas: identidade (tipo, cidade, data, nome, valor) não muda; cancelado congela; pagamento só estorna
CREATE OR REPLACE FUNCTION fin_trg_ctl_reg_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'cancelado' THEN RAISE EXCEPTION 'FINANCEIRO: registro cancelado não muda mais'; END IF;
  IF NEW.tipo <> OLD.tipo OR NEW.unidade_id <> OLD.unidade_id OR NEW.data <> OLD.data OR NEW.nome <> OLD.nome OR NEW.nome_norm <> OLD.nome_norm
     OR NEW.valor <> OLD.valor OR NEW.quantidade IS DISTINCT FROM OLD.quantidade OR NEW.valor_unitario IS DISTINCT FROM OLD.valor_unitario
     OR NEW.semana_ini IS DISTINCT FROM OLD.semana_ini OR NEW.percentual IS DISTINCT FROM OLD.percentual
     OR NEW.valor_gami IS DISTINCT FROM OLD.valor_gami OR NEW.valor_entregador IS DISTINCT FROM OLD.valor_entregador
     OR NEW.origem <> OLD.origem OR NEW.chave <> OLD.chave OR NEW.criado_por <> OLD.criado_por OR NEW.criado_em <> OLD.criado_em THEN
    RAISE EXCEPTION 'FINANCEIRO: data, nome e valores não mudam (cancele e lance de novo)';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION fin_trg_ctl_regpag_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.estornado THEN RAISE EXCEPTION 'FINANCEIRO: pagamento estornado não muda mais'; END IF;
  IF (to_jsonb(NEW) - ARRAY['estornado','estorno_motivo','estornado_por','estornado_em']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['estornado','estorno_motivo','estornado_por','estornado_em']) THEN
    RAISE EXCEPTION 'FINANCEIRO: pagamento não se edita (estorne e lance de novo)';
  END IF;
  RETURN NEW;
END $$;

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fin_ctl_registros','fin_ctl_reg_pag'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_nodel ON %1$s', t);
    EXECUTE format('CREATE TRIGGER %1$s_nodel BEFORE DELETE ON %1$s FOR EACH ROW EXECUTE FUNCTION fin_trg_bloqueia_delete()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_notrunc ON %1$s', t);
    EXECUTE format('CREATE TRIGGER %1$s_notrunc BEFORE TRUNCATE ON %1$s FOR EACH STATEMENT EXECUTE FUNCTION fin_trg_bloqueia_delete()', t);
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %s TO service_role', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_audit ON %1$s', t);
    EXECUTE format('CREATE TRIGGER %1$s_audit AFTER INSERT OR UPDATE ON %1$s FOR EACH ROW EXECUTE FUNCTION fin_trg_audit()', t);
  END LOOP;
  DROP TRIGGER IF EXISTS fin_ctl_registros_guard ON fin_ctl_registros;
  CREATE TRIGGER fin_ctl_registros_guard BEFORE UPDATE ON fin_ctl_registros FOR EACH ROW EXECUTE FUNCTION fin_trg_ctl_reg_guard();
  DROP TRIGGER IF EXISTS fin_ctl_reg_pag_guard ON fin_ctl_reg_pag;
  CREATE TRIGGER fin_ctl_reg_pag_guard BEFORE UPDATE ON fin_ctl_reg_pag FOR EACH ROW EXECUTE FUNCTION fin_trg_ctl_regpag_guard();
END $do$;

-- View: pago, saldo e conferência (que cai se algo mudar depois, igual às outras)
DROP VIEW IF EXISTS fin_ctl_v_registros;
CREATE VIEW fin_ctl_v_registros AS
WITH p AS (
  SELECT registro_id, coalesce(sum(valor) FILTER (WHERE NOT estornado), 0) AS pago, count(*) FILTER (WHERE NOT estornado) AS qtd_pag,
         max(data) FILTER (WHERE NOT estornado) AS ultimo_pag, greatest(max(criado_em), max(estornado_em)) AS ultima_mudanca_pag
  FROM fin_ctl_reg_pag GROUP BY registro_id
), cf AS (
  SELECT DISTINCT ON (registro_id) registro_id, status AS conf_status, conferido_por, conferido_em
  FROM fin_ctl_conferencias WHERE tabela = 'fin_ctl_registros' ORDER BY registro_id, id DESC
)
SELECT r.*, u.nome AS unidade_nome, u.cidade_slug,
       coalesce(p.pago, 0) AS pago, coalesce(p.qtd_pag, 0) AS qtd_pag, p.ultimo_pag,
       CASE WHEN r.tipo IN ('bag','camiseta','moto_novo') THEN round(r.valor - coalesce(p.pago, 0), 2) END AS saldo,
       CASE WHEN r.status = 'cancelado' THEN 'cancelado'
            WHEN r.tipo NOT IN ('bag','camiseta','moto_novo') THEN 'lancado'
            WHEN r.valor = 0 THEN 'cortesia'
            WHEN coalesce(p.pago, 0) >= r.valor THEN 'pago'
            WHEN coalesce(p.pago, 0) > 0 THEN 'parcial'
            ELSE 'pendente' END AS situacao,
       CASE WHEN cf.conferido_em >= greatest(r.criado_em, r.atualizado_em, p.ultima_mudanca_pag) THEN cf.conf_status END AS conf_status,
       (cf.conferido_em IS NOT NULL AND cf.conferido_em < greatest(r.criado_em, r.atualizado_em, p.ultima_mudanca_pag)) AS conf_desatualizada,
       cf.conferido_por, cf.conferido_em
FROM fin_ctl_registros r
JOIN fin_unidades u ON u.id = r.unidade_id
LEFT JOIN p ON p.registro_id = r.id
LEFT JOIN cf ON cf.registro_id = r.id;
REVOKE ALL ON fin_ctl_v_registros FROM PUBLIC, anon, authenticated;
GRANT SELECT ON fin_ctl_v_registros TO service_role;

-- ---------------- Escrita ----------------
-- Lança (p_id NULL) ou corrige campos livres (forma, tamanho, pago por, motivo, responsável, observação).
CREATE OR REPLACE FUNCTION fin_ctl_reg_salvar(p_ator text, p_id bigint, p_d jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_tipo text := p_d->>'tipo'; v_un bigint; v_dt date; v_nome text; v_valor numeric; v_qtd int; v_unit numeric; v_pct numeric;
        v_ini date; v_fim date; v_n int; v_id bigint; v_gami numeric; v_ent numeric; v_base text; v_pago numeric;
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF p_id IS NOT NULL THEN
    UPDATE fin_ctl_registros SET forma = coalesce(nullif(p_d->>'forma',''), forma), tamanho = fin_ctl_txt(p_d->>'tamanho', 40),
      pago_por = fin_ctl_txt(p_d->>'pago_por', 200), motivo = coalesce(fin_ctl_txt(p_d->>'motivo', 300), motivo),
      responsavel = fin_ctl_txt(p_d->>'responsavel', 100), observacao = fin_ctl_txt(p_d->>'observacao', 1000),
      atualizado_por = p_ator, atualizado_em = now()
    WHERE id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Registro não encontrado'; END IF;
    RETURN jsonb_build_object('ok', true, 'id', p_id);
  END IF;
  IF v_tipo NOT IN ('bag','camiseta','moto_novo','motoboy_semanal','desconto_banco','desconto_fora') THEN RAISE EXCEPTION 'Tipo inválido'; END IF;
  v_un := (p_d->>'unidade_id')::bigint; v_nome := fin_ctl_txt(p_d->>'nome', 200);
  IF v_un IS NULL OR NOT EXISTS (SELECT 1 FROM fin_unidades WHERE id = v_un AND ativo) THEN RAISE EXCEPTION 'Escolha a cidade'; END IF;
  IF v_nome IS NULL OR length(v_nome) < 2 THEN RAISE EXCEPTION 'Nome obrigatório'; END IF;
  IF v_tipo = 'motoboy_semanal' THEN
    v_ini := (p_d->>'semana_ini')::date; IF v_ini IS NULL THEN RAISE EXCEPTION 'Semana obrigatória'; END IF;
    v_fim := coalesce((p_d->>'semana_fim')::date, v_ini + 6); v_dt := v_ini;
    v_valor := (p_d->>'valor')::numeric; v_pct := coalesce((p_d->>'percentual')::numeric, 21);
    v_gami := round(v_valor * v_pct / 100, 2); v_ent := round(v_valor - v_gami, 2);
  ELSE
    v_dt := (p_d->>'data')::date; IF v_dt IS NULL THEN RAISE EXCEPTION 'Data obrigatória'; END IF;
    IF v_dt > fin_hoje() THEN RAISE EXCEPTION 'Data no futuro'; END IF;
    IF v_tipo IN ('bag','camiseta') THEN
      v_qtd := coalesce((p_d->>'quantidade')::int, 1); v_unit := (p_d->>'valor_unitario')::numeric;
      IF v_unit IS NULL OR v_unit < 0 THEN RAISE EXCEPTION 'Valor unitário obrigatório'; END IF;
      v_valor := round(v_qtd * v_unit, 2);
      IF (p_d->>'forma') = 'cortesia' THEN
        v_valor := 0; v_unit := 0;
        IF length(coalesce(fin_ctl_txt(p_d->>'observacao', 500), '')) < 10 THEN RAISE EXCEPTION 'Cortesia/doação precisa de observação (mín. 10 letras): para quem e por quê'; END IF;
      END IF;
    ELSE
      v_valor := (p_d->>'valor')::numeric;
    END IF;
  END IF;
  IF v_valor IS NULL OR v_valor < 0 THEN RAISE EXCEPTION 'Valor inválido'; END IF;
  IF v_tipo IN ('desconto_banco','desconto_fora') AND (v_valor = 0 OR fin_ctl_txt(p_d->>'motivo', 300) IS NULL) THEN RAISE EXCEPTION 'Desconto precisa de valor e motivo'; END IF;
  IF v_tipo = 'desconto_fora' AND fin_ctl_txt(p_d->>'responsavel', 100) IS NULL THEN RAISE EXCEPTION 'Desconto fora do banco precisa do responsável'; END IF;
  -- repetido? (mesma planilha, cidade, data, nome e valor)
  IF EXISTS (SELECT 1 FROM fin_ctl_registros WHERE status = 'ativo' AND tipo = v_tipo AND unidade_id = v_un AND data = v_dt
             AND nome_norm = fin_norm(v_nome) AND valor = v_valor) AND NOT coalesce((p_d->>'permitir_repetido')::boolean, false) THEN
    RAISE EXCEPTION 'Já existe um lançamento igual (mesmo nome, valor e data). Confira antes de lançar de novo';
  END IF;
  v_base := 'M|' || v_tipo || '|' || v_un || '|' || v_dt || '|' || fin_norm(v_nome) || '|' || v_valor;
  SELECT count(*) + 1 INTO v_n FROM fin_ctl_registros WHERE chave LIKE v_base || '|%';
  INSERT INTO fin_ctl_registros (tipo, unidade_id, data, semana_ini, semana_fim, nome, nome_norm, quantidade, tamanho, forma, valor_unitario, valor,
    percentual, valor_gami, valor_entregador, motivo, responsavel, pago_por, observacao, origem, chave, criado_por)
  VALUES (v_tipo, v_un, v_dt, v_ini, v_fim, v_nome, fin_norm(v_nome), v_qtd, fin_ctl_txt(p_d->>'tamanho', 40), nullif(p_d->>'forma',''), v_unit, v_valor,
    CASE WHEN v_tipo = 'motoboy_semanal' THEN v_pct END, v_gami, v_ent, fin_ctl_txt(p_d->>'motivo', 300), fin_ctl_txt(p_d->>'responsavel', 100),
    fin_ctl_txt(p_d->>'pago_por', 200), fin_ctl_txt(p_d->>'observacao', 1000), 'manual', v_base || '|' || v_n, p_ator)
  RETURNING id INTO v_id;
  -- pagou na hora? (o "VALOR DO 1º PAG" da planilha)
  v_pago := (p_d->>'valor_pago')::numeric;
  IF v_tipo IN ('bag','camiseta','moto_novo') AND v_pago > 0 THEN
    INSERT INTO fin_ctl_reg_pag (registro_id, valor, data, forma, pago_por, criado_por)
    VALUES (v_id, v_pago, coalesce((p_d->>'data_pagamento')::date, v_dt), nullif(p_d->>'forma',''), fin_ctl_txt(p_d->>'pago_por', 200), p_ator);
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

CREATE OR REPLACE FUNCTION fin_ctl_reg_pagar(p_ator text, p_registro bigint, p_d jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_r fin_ctl_v_registros; v_id bigint; v_valor numeric := (p_d->>'valor')::numeric;
BEGIN
  PERFORM fin_set_ator(p_ator);
  PERFORM 1 FROM fin_ctl_registros WHERE id = p_registro FOR UPDATE;
  SELECT * INTO v_r FROM fin_ctl_v_registros WHERE id = p_registro;
  IF NOT FOUND THEN RAISE EXCEPTION 'Registro não encontrado'; END IF;
  IF v_r.status = 'cancelado' THEN RAISE EXCEPTION 'Registro cancelado'; END IF;
  IF v_r.tipo NOT IN ('bag','camiseta','moto_novo') THEN RAISE EXCEPTION 'Esta planilha não tem pagamento'; END IF;
  IF v_valor IS NULL OR v_valor <= 0 THEN RAISE EXCEPTION 'Valor inválido'; END IF;
  IF (p_d->>'data') IS NULL OR (p_d->>'data')::date > fin_hoje() THEN RAISE EXCEPTION 'Data inválida'; END IF;
  IF v_valor > coalesce(v_r.saldo, 0) + 0.009 THEN RAISE EXCEPTION 'Valor maior que o que falta pagar (%)', v_r.saldo; END IF;
  INSERT INTO fin_ctl_reg_pag (registro_id, valor, data, forma, pago_por, observacao, criado_por)
  VALUES (p_registro, v_valor, (p_d->>'data')::date, nullif(p_d->>'forma',''), fin_ctl_txt(p_d->>'pago_por', 200), fin_ctl_txt(p_d->>'observacao', 500), p_ator)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

CREATE OR REPLACE FUNCTION fin_ctl_reg_estornar_pag(p_ator text, p_id bigint, p_motivo text)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF length(coalesce(btrim(p_motivo), '')) < 10 THEN RAISE EXCEPTION 'Estorno precisa de motivo (mín. 10 letras)'; END IF;
  UPDATE fin_ctl_reg_pag SET estornado = true, estorno_motivo = left(btrim(p_motivo), 500), estornado_por = p_ator, estornado_em = now()
  WHERE id = p_id AND NOT estornado;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pagamento não encontrado ou já estornado'; END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- cancelar e conferir passam a aceitar as planilhas novas
CREATE OR REPLACE FUNCTION fin_ctl_cancelar(p_ator text, p_tabela text, p_id bigint, p_motivo text)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF length(coalesce(btrim(p_motivo), '')) < 10 THEN RAISE EXCEPTION 'Cancelamento precisa de motivo (mín. 10 letras)'; END IF;
  IF p_tabela = 'fin_ctl_cobrancas' THEN
    PERFORM 1 FROM fin_ctl_cobrancas WHERE id = p_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM fin_ctl_cob_receb WHERE cobranca_id = p_id AND NOT estornado) THEN
      RAISE EXCEPTION 'Essa cobrança tem recebimento: estorne o recebimento antes de cancelar';
    END IF;
    UPDATE fin_ctl_cobrancas SET status = 'cancelada', cancelado_motivo = left(btrim(p_motivo), 500), cancelado_por = p_ator, cancelado_em = now()
    WHERE id = p_id AND status = 'ativa';
  ELSIF p_tabela = 'fin_ctl_creditos' THEN
    UPDATE fin_ctl_creditos SET status = 'cancelado', cancelado_motivo = left(btrim(p_motivo), 500), cancelado_por = p_ator, cancelado_em = now()
    WHERE id = p_id AND status = 'ativo';
  ELSIF p_tabela = 'fin_ctl_registros' THEN
    PERFORM 1 FROM fin_ctl_registros WHERE id = p_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM fin_ctl_reg_pag WHERE registro_id = p_id AND NOT estornado) THEN
      RAISE EXCEPTION 'Esse lançamento tem pagamento: estorne o pagamento antes de cancelar';
    END IF;
    UPDATE fin_ctl_registros SET status = 'cancelado', cancelado_motivo = left(btrim(p_motivo), 500), cancelado_por = p_ator, cancelado_em = now()
    WHERE id = p_id AND status = 'ativo';
  ELSE RAISE EXCEPTION 'Tabela inválida'; END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Registro não encontrado ou já cancelado'; END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION fin_ctl_conferir(p_ator text, p_tabela text, p_ids bigint[], p_status text, p_obs text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_id bigint; v_autor text; v_ok int := 0; v_pulados int := 0;
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF p_status NOT IN ('ok','divergente') THEN RAISE EXCEPTION 'Status inválido'; END IF;
  IF p_status = 'divergente' AND length(coalesce(btrim(p_obs), '')) < 10 THEN RAISE EXCEPTION 'Divergência precisa de observação (mín. 10 letras)'; END IF;
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL OR array_length(p_ids, 1) > 500 THEN RAISE EXCEPTION 'Selecione de 1 a 500 registros'; END IF;
  FOREACH v_id IN ARRAY p_ids LOOP
    IF p_tabela = 'fin_ctl_cobrancas' THEN SELECT criado_por INTO v_autor FROM fin_ctl_cobrancas WHERE id = v_id AND status = 'ativa';
    ELSIF p_tabela = 'fin_ctl_creditos' THEN SELECT criado_por INTO v_autor FROM fin_ctl_creditos WHERE id = v_id AND status = 'ativo';
    ELSIF p_tabela = 'fin_ctl_registros' THEN SELECT criado_por INTO v_autor FROM fin_ctl_registros WHERE id = v_id AND status = 'ativo';
    ELSE RAISE EXCEPTION 'Tabela inválida'; END IF;
    IF NOT FOUND THEN v_pulados := v_pulados + 1; CONTINUE; END IF;
    IF v_autor = p_ator THEN
      IF array_length(p_ids, 1) = 1 THEN RAISE EXCEPTION 'Quem lançou não pode conferir o próprio lançamento'; END IF;
      v_pulados := v_pulados + 1; CONTINUE;
    END IF;
    INSERT INTO fin_ctl_conferencias (tabela, registro_id, status, observacao, conferido_por)
    VALUES (p_tabela, v_id, p_status, fin_ctl_txt(p_obs, 1000), p_ator);
    v_ok := v_ok + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'conferidos', v_ok, 'pulados', v_pulados);
END $$;

-- Importação das planilhas (linhas já validadas no servidor). Não duplica; avisa o que mudou e o que já foi lançado à mão.
CREATE OR REPLACE FUNCTION fin_ctl_reg_importar(p_ator text, p_tipo text, p_meta jsonb, p_linhas jsonb)
RETURNS jsonb LANGUAGE plpgsql SET statement_timeout = '180s' AS $$
DECLARE v_un bigint := (p_meta->>'unidade_id')::bigint; v_imp uuid; v_total int; v_novas int := 0; v_pag int := 0; v_manual int := 0;
        v_div jsonb := '[]'::jsonb; l jsonb; v_id bigint; v_ex record; v_tipo text;
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF p_tipo NOT IN ('bag','camiseta','moto_novo','motoboy_semanal','descontos') THEN RAISE EXCEPTION 'Tipo inválido'; END IF;
  IF NOT EXISTS (SELECT 1 FROM fin_unidades WHERE id = v_un) THEN RAISE EXCEPTION 'Cidade inválida'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('fin_ctl_import:' || p_tipo || ':' || v_un));
  IF EXISTS (SELECT 1 FROM fin_ctl_importacoes WHERE tipo = p_tipo AND unidade_id = v_un AND arquivo_sha256 = p_meta->>'sha256') THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Esta planilha já foi importada para essa cidade.');
  END IF;
  v_total := jsonb_array_length(p_linhas);
  INSERT INTO fin_ctl_importacoes (tipo, unidade_id, arquivo_nome, arquivo_sha256, arquivo_bytes, conteudo_b64, abas, qtd_linhas, importado_por)
  VALUES (p_tipo, v_un, p_meta->>'arquivo_nome', p_meta->>'sha256', (p_meta->>'bytes')::int, p_meta->>'conteudo_b64', p_meta->'abas', v_total, p_ator)
  RETURNING id INTO v_imp;
  FOR l IN SELECT * FROM jsonb_array_elements(p_linhas) LOOP
    v_tipo := l->>'tipo';
    IF v_tipo NOT IN ('bag','camiseta','moto_novo','motoboy_semanal','desconto_banco','desconto_fora') THEN RAISE EXCEPTION 'Tipo de linha inválido'; END IF;
    SELECT id, valor INTO v_ex FROM fin_ctl_registros WHERE chave = 'P|' || v_un || '|' || (l->>'chave');
    IF FOUND THEN
      IF v_ex.valor <> (l->>'valor')::numeric AND jsonb_array_length(v_div) < 50 THEN
        v_div := v_div || jsonb_build_object('nome', l->>'nome', 'data', l->>'data', 'no_sistema', v_ex.valor, 'na_planilha', (l->>'valor')::numeric);
      END IF;
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM fin_ctl_registros WHERE tipo = v_tipo AND unidade_id = v_un AND data = (l->>'data')::date AND status = 'ativo'
               AND origem <> 'planilha' AND nome_norm = fin_norm(l->>'nome') AND valor = (l->>'valor')::numeric) THEN
      v_manual := v_manual + 1; CONTINUE;
    END IF;
    INSERT INTO fin_ctl_registros (tipo, unidade_id, data, semana_ini, semana_fim, nome, nome_norm, quantidade, tamanho, forma, valor_unitario, valor,
      percentual, valor_gami, valor_entregador, motivo, responsavel, pago_por, observacao, origem, importacao_id, chave, criado_por)
    VALUES (v_tipo, v_un, (l->>'data')::date, nullif(l->>'semana_ini','')::date, nullif(l->>'semana_fim','')::date, l->>'nome', fin_norm(l->>'nome'),
      nullif(l->>'quantidade','')::int, nullif(l->>'tamanho',''), nullif(l->>'forma',''), nullif(l->>'valor_unitario','')::numeric, (l->>'valor')::numeric,
      nullif(l->>'percentual','')::numeric, nullif(l->>'valor_gami','')::numeric, nullif(l->>'valor_entregador','')::numeric,
      nullif(l->>'motivo',''), nullif(l->>'responsavel',''), nullif(l->>'pago_por',''), nullif(l->>'observacao',''), 'planilha', v_imp,
      'P|' || v_un || '|' || (l->>'chave'), p_ator)
    RETURNING id INTO v_id;
    v_novas := v_novas + 1;
    IF coalesce((l->>'valor_pago')::numeric, 0) > 0 THEN
      INSERT INTO fin_ctl_reg_pag (registro_id, valor, data, forma, pago_por, observacao, origem, criado_por)
      VALUES (v_id, (l->>'valor_pago')::numeric, coalesce(nullif(l->>'data_pagamento','')::date, (l->>'data')::date), nullif(l->>'forma',''),
              nullif(l->>'pago_por',''), 'importado da planilha', 'planilha', p_ator);
      v_pag := v_pag + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'importacao_id', v_imp, 'linhas', v_total, 'novas', v_novas, 'repetidas', v_total - v_novas - v_manual,
                            'ja_lancadas_a_mao', v_manual, 'valor_diferente', v_div, 'pagamentos', v_pag);
END $$;

-- Abas (meses/semanas) com totais: a "barra de abas" da planilha
CREATE OR REPLACE FUNCTION fin_ctl_reg_abas(p_tipos text[], p_unidade bigint)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  -- motoboys: uma aba por SEMANA; as outras planilhas: uma aba por MÊS
  SELECT coalesce(jsonb_agg(x ORDER BY x.ini DESC), '[]'::jsonb) FROM (
    SELECT g.ini, max(g.fim) AS fim, count(*) AS qtd, sum(g.valor) AS valor, count(*) FILTER (WHERE g.conf_status IS NULL) AS sem_conferencia
    FROM (SELECT CASE WHEN tipo = 'motoboy_semanal' THEN semana_ini ELSE date_trunc('month', data)::date END AS ini,
                 CASE WHEN tipo = 'motoboy_semanal' THEN semana_fim ELSE (date_trunc('month', data) + interval '1 month - 1 day')::date END AS fim,
                 valor, conf_status
          FROM fin_ctl_v_registros
          WHERE tipo = ANY(p_tipos) AND status = 'ativo' AND (p_unidade IS NULL OR unidade_id = p_unidade)) g
    GROUP BY g.ini
  ) x
$$;

DO $do$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname LIKE 'fin\_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $do$;
