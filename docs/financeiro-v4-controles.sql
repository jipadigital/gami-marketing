-- ============================================================
-- FINANCEIRO GÂMI v4: CONTROLES (no lugar das planilhas das meninas) (09/11/2026)
-- ------------------------------------------------------------
-- 1ª leva: EMPRESAS (cobrança semanal com multa) e CRÉDITOS (créditos na carteira).
-- Todas as cidades (fin_unidades); quem tem acesso ao financeiro vê todas.
--
-- Regras para NÃO PERDER NADA e não dar brecha:
--  * nada se apaga (DELETE/TRUNCATE bloqueados); erro se corrige CANCELANDO (com motivo) e lançando de novo
--  * valor, empresa/beneficiário, semana e cidade não mudam depois de lançados
--  * recebimento não se apaga: estorna com motivo
--  * QUEM LANÇOU NÃO CONFERE o próprio lançamento (segregação de função)
--  * conferência é um registro novo e permanente (histórico de quem conferiu o quê)
--  * importar a mesma planilha de novo não duplica (chave por cidade+semana+empresa / conteúdo)
--  * tudo auditado na cadeia de hash; RLS + REVOKE: só a função do servidor enxerga
-- Rodar DEPOIS do v1/v2/v3 (ou do COMPLETO). Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS fin_ctl_importacoes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo           text NOT NULL CHECK (tipo IN ('empresas','creditos')),
  unidade_id     bigint NOT NULL REFERENCES fin_unidades(id),
  arquivo_nome   text,
  arquivo_sha256 text NOT NULL,
  arquivo_bytes  integer,
  conteudo_b64   text,                         -- planilha original guardada como PROVA
  abas           jsonb,
  qtd_linhas     integer NOT NULL DEFAULT 0,
  qtd_novas      integer NOT NULL DEFAULT 0,
  importado_por  text NOT NULL,
  importado_em   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_ctl_imp_uk ON fin_ctl_importacoes (tipo, unidade_id, arquivo_sha256);

-- ---------------- EMPRESAS: cobrança semanal ----------------
CREATE TABLE IF NOT EXISTS fin_ctl_cobrancas (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unidade_id       bigint NOT NULL REFERENCES fin_unidades(id),
  semana_ini       date NOT NULL,
  semana_fim       date NOT NULL,
  empresa          text NOT NULL CHECK (length(btrim(empresa)) BETWEEN 2 AND 200),
  empresa_norm     text NOT NULL,
  empresa_doc      text CHECK (empresa_doc IS NULL OR empresa_doc ~ '^[0-9]{11}$' OR empresa_doc ~ '^[0-9]{14}$'),
  valor            numeric(14,2) NOT NULL CHECK (valor >= 0 AND valor <= 10000000),
  desconto         numeric(14,2) NOT NULL DEFAULT 0 CHECK (desconto >= 0),
  desconto_motivo  text,
  multa_pct        numeric(5,2) NOT NULL DEFAULT 3 CHECK (multa_pct BETWEEN 0 AND 20),
  isento_multa     boolean NOT NULL DEFAULT false,
  isencao_motivo   text,
  isencao_por      text,
  vencimento       date,
  nome_no_banco    text,
  observacao       text,
  origem           text NOT NULL CHECK (origem IN ('manual','planilha','kamino','machine')),
  importacao_id    uuid REFERENCES fin_ctl_importacoes(id),
  chave            text NOT NULL,
  status           text NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','cancelada')),
  cancelado_motivo text,
  cancelado_por    text,
  cancelado_em     timestamptz,
  criado_por       text NOT NULL,
  criado_em        timestamptz NOT NULL DEFAULT now(),
  atualizado_por   text,
  atualizado_em    timestamptz,
  CHECK (semana_fim >= semana_ini AND semana_fim - semana_ini <= 13),
  CHECK (desconto <= valor)
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_ctl_cob_chave ON fin_ctl_cobrancas (chave);
CREATE INDEX IF NOT EXISTS fin_ctl_cob_sem ON fin_ctl_cobrancas (unidade_id, semana_ini);
CREATE INDEX IF NOT EXISTS fin_ctl_cob_emp ON fin_ctl_cobrancas (empresa_norm);

CREATE TABLE IF NOT EXISTS fin_ctl_cob_receb (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cobranca_id    bigint NOT NULL REFERENCES fin_ctl_cobrancas(id),
  valor          numeric(14,2) NOT NULL CHECK (valor > 0 AND valor <= 10000000),
  data           date NOT NULL,
  forma          text,
  nome_no_banco  text,
  extrato_id     bigint REFERENCES fin_extrato(id),
  observacao     text,
  origem         text NOT NULL DEFAULT 'manual',
  estornado      boolean NOT NULL DEFAULT false,
  estorno_motivo text,
  estornado_por  text,
  estornado_em   timestamptz,
  criado_por     text NOT NULL,
  criado_em      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_ctl_rec_cob ON fin_ctl_cob_receb (cobranca_id);

-- ---------------- CRÉDITOS na carteira ----------------
CREATE TABLE IF NOT EXISTS fin_ctl_creditos (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unidade_id       bigint NOT NULL REFERENCES fin_unidades(id),
  data             date NOT NULL,
  hora             time,
  valor            numeric(14,2) NOT NULL CHECK (valor > 0 AND valor <= 1000000),
  beneficiario     text NOT NULL CHECK (length(btrim(beneficiario)) BETWEEN 2 AND 200),   -- quem recebeu o crédito (entregador ou empresa)
  beneficiario_norm text NOT NULL,
  beneficiario_tipo text NOT NULL CHECK (beneficiario_tipo IN ('entregador','empresa','outro')),
  entregador_id    text CHECK (entregador_id IS NULL OR entregador_id ~ '^[0-9A-Za-z_-]{1,40}$'),   -- ID na Machine
  empresa          text,                         -- empresa ligada (quando o crédito é do entregador por causa de uma loja)
  os               text,
  operador         text,                         -- quem lançou o crédito na Machine
  motivo           text NOT NULL CHECK (motivo IN ('pagamento_semanal','bonus_acao','bonus_inicio','cortesia','reembolso','ajuste','zeragem','teste','outro')),
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
  atualizado_em    timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_ctl_cred_chave ON fin_ctl_creditos (chave);
CREATE INDEX IF NOT EXISTS fin_ctl_cred_data ON fin_ctl_creditos (unidade_id, data);
CREATE INDEX IF NOT EXISTS fin_ctl_cred_benef ON fin_ctl_creditos (beneficiario_norm);

-- ---------------- CONFERÊNCIAS (permanentes) ----------------
CREATE TABLE IF NOT EXISTS fin_ctl_conferencias (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tabela        text NOT NULL CHECK (tabela IN ('fin_ctl_cobrancas','fin_ctl_creditos')),
  registro_id   bigint NOT NULL,
  status        text NOT NULL CHECK (status IN ('ok','divergente')),
  observacao    text,
  conferido_por text NOT NULL,
  conferido_em  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_ctl_conf_reg ON fin_ctl_conferencias (tabela, registro_id, id DESC);

-- ---------------- Guardas ----------------
-- Cobrança: identidade (cidade, semana, empresa, valor, origem, chave) é imutável; cancelada congela.
CREATE OR REPLACE FUNCTION fin_trg_ctl_cob_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'cancelada' THEN RAISE EXCEPTION 'FINANCEIRO: cobrança cancelada não muda mais'; END IF;
  IF NEW.unidade_id <> OLD.unidade_id OR NEW.semana_ini <> OLD.semana_ini OR NEW.semana_fim <> OLD.semana_fim
     OR NEW.empresa <> OLD.empresa OR NEW.empresa_norm <> OLD.empresa_norm OR NEW.valor <> OLD.valor
     OR NEW.origem <> OLD.origem OR NEW.chave <> OLD.chave OR NEW.criado_por <> OLD.criado_por OR NEW.criado_em <> OLD.criado_em
     OR NEW.empresa_doc IS DISTINCT FROM OLD.empresa_doc AND OLD.empresa_doc IS NOT NULL THEN
    RAISE EXCEPTION 'FINANCEIRO: cidade, semana, empresa e valor não mudam (cancele e lance de novo)';
  END IF;
  RETURN NEW;
END $$;
-- Recebimento: só pode ser estornado (uma vez)
CREATE OR REPLACE FUNCTION fin_trg_ctl_rec_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.estornado THEN RAISE EXCEPTION 'FINANCEIRO: recebimento estornado não muda mais'; END IF;
  IF (to_jsonb(NEW) - ARRAY['estornado','estorno_motivo','estornado_por','estornado_em','extrato_id'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['estornado','estorno_motivo','estornado_por','estornado_em','extrato_id']) THEN
    RAISE EXCEPTION 'FINANCEIRO: recebimento não se edita (estorne e lance de novo)';
  END IF;
  RETURN NEW;
END $$;
-- Crédito: identidade imutável; cancelado congela
CREATE OR REPLACE FUNCTION fin_trg_ctl_cred_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'cancelado' THEN RAISE EXCEPTION 'FINANCEIRO: crédito cancelado não muda mais'; END IF;
  IF NEW.unidade_id <> OLD.unidade_id OR NEW.data <> OLD.data OR NEW.valor <> OLD.valor OR NEW.beneficiario <> OLD.beneficiario
     OR NEW.beneficiario_norm <> OLD.beneficiario_norm OR NEW.origem <> OLD.origem OR NEW.chave <> OLD.chave
     OR NEW.criado_por <> OLD.criado_por OR NEW.criado_em <> OLD.criado_em THEN
    RAISE EXCEPTION 'FINANCEIRO: data, valor e beneficiário do crédito não mudam (cancele e lance de novo)';
  END IF;
  RETURN NEW;
END $$;

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fin_ctl_importacoes','fin_ctl_cobrancas','fin_ctl_cob_receb','fin_ctl_creditos','fin_ctl_conferencias'] LOOP
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
  FOREACH t IN ARRAY ARRAY['fin_ctl_importacoes','fin_ctl_conferencias'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_noupd ON %1$s', t);
    EXECUTE format('CREATE TRIGGER %1$s_noupd BEFORE UPDATE ON %1$s FOR EACH ROW EXECUTE FUNCTION fin_trg_bloqueia_update()', t);
  END LOOP;
  DROP TRIGGER IF EXISTS fin_ctl_cobrancas_guard ON fin_ctl_cobrancas;
  CREATE TRIGGER fin_ctl_cobrancas_guard BEFORE UPDATE ON fin_ctl_cobrancas FOR EACH ROW EXECUTE FUNCTION fin_trg_ctl_cob_guard();
  DROP TRIGGER IF EXISTS fin_ctl_cob_receb_guard ON fin_ctl_cob_receb;
  CREATE TRIGGER fin_ctl_cob_receb_guard BEFORE UPDATE ON fin_ctl_cob_receb FOR EACH ROW EXECUTE FUNCTION fin_trg_ctl_rec_guard();
  DROP TRIGGER IF EXISTS fin_ctl_creditos_guard ON fin_ctl_creditos;
  CREATE TRIGGER fin_ctl_creditos_guard BEFORE UPDATE ON fin_ctl_creditos FOR EACH ROW EXECUTE FUNCTION fin_trg_ctl_cred_guard();
END $do$;

-- ---------------- Views (a conta que a planilha fazia, agora certa) ----------------
-- Planilha: MULTA 3% = A RECEBER bruto + 3% do líquido (ignorava o desconto) e "JUROS" era o saldo.
-- Aqui: líquido = valor − desconto; multa = 3% do líquido SÓ se venceu sem pagar ou pagou depois do vencimento
-- (e não foi isentada com motivo); saldo = líquido + multa − recebido.
-- A CONFERÊNCIA SÓ VALE para a versão conferida: qualquer mudança depois (edição, recebimento novo,
-- estorno) derruba a conferência e a cobrança volta para "falta conferir" (conf_desatualizada = true).
-- A multa usa a data em que o recebido ACUMULADO cobriu o líquido (ajuste pequeno depois não gera multa).
DROP VIEW IF EXISTS fin_ctl_v_cobrancas;
CREATE VIEW fin_ctl_v_cobrancas AS
WITH ra AS (
  SELECT cobranca_id, data, valor, criado_em, estornado_em, estornado,
         sum(valor) FILTER (WHERE NOT estornado) OVER (PARTITION BY cobranca_id ORDER BY data, id) AS acumulado
  FROM fin_ctl_cob_receb
), r AS (
  SELECT ra.cobranca_id,
         coalesce(sum(ra.valor) FILTER (WHERE NOT ra.estornado), 0) AS recebido,
         max(ra.data) FILTER (WHERE NOT ra.estornado) AS ultimo_receb,
         count(*) FILTER (WHERE NOT ra.estornado) AS qtd_receb,
         greatest(max(ra.criado_em), max(ra.estornado_em)) AS ultima_mudanca_receb
  FROM ra GROUP BY ra.cobranca_id
), cf AS (
  SELECT DISTINCT ON (registro_id) registro_id, status AS conf_status, conferido_por, conferido_em
  FROM fin_ctl_conferencias WHERE tabela = 'fin_ctl_cobrancas' ORDER BY registro_id, id DESC
), b AS (
  SELECT c.*, u.nome AS unidade_nome, u.cidade_slug,
         round(c.valor - c.desconto, 2) AS liquido,
         coalesce(r.recebido, 0) AS recebido, r.ultimo_receb, coalesce(r.qtd_receb, 0) AS qtd_receb,
         (SELECT min(ra.data) FROM ra WHERE ra.cobranca_id = c.id AND NOT ra.estornado AND ra.acumulado >= round(c.valor - c.desconto, 2)) AS data_quitacao,
         greatest(c.criado_em, c.atualizado_em, r.ultima_mudanca_receb) AS ultima_mudanca,
         CASE WHEN cf.conferido_em >= greatest(c.criado_em, c.atualizado_em, r.ultima_mudanca_receb) THEN cf.conf_status END AS conf_status,
         cf.conf_status AS conf_status_anterior,
         (cf.conferido_em IS NOT NULL AND cf.conferido_em < greatest(c.criado_em, c.atualizado_em, r.ultima_mudanca_receb)) AS conf_desatualizada,
         cf.conferido_por, cf.conferido_em
  FROM fin_ctl_cobrancas c
  JOIN fin_unidades u ON u.id = c.unidade_id
  LEFT JOIN r ON r.cobranca_id = c.id
  LEFT JOIN cf ON cf.registro_id = c.id
), b2 AS (
  SELECT b.*, (b.vencimento IS NOT NULL AND NOT b.isento_multa AND b.liquido > 0 AND
              ((b.data_quitacao IS NULL AND b.vencimento < fin_hoje()) OR b.data_quitacao > b.vencimento)) AS com_multa
  FROM b
)
SELECT b.*,
  CASE WHEN com_multa THEN round(liquido * multa_pct / 100, 2) ELSE 0 END AS multa,
  round(liquido + CASE WHEN com_multa THEN round(liquido * multa_pct / 100, 2) ELSE 0 END - recebido, 2) AS saldo,
  CASE WHEN status = 'cancelada' THEN 'cancelada'
       WHEN recebido >= liquido + CASE WHEN com_multa THEN round(liquido * multa_pct / 100, 2) ELSE 0 END AND liquido > 0 THEN 'quitada'
       WHEN liquido = 0 THEN 'quitada'
       WHEN recebido > 0 THEN 'parcial'
       WHEN vencimento IS NOT NULL AND vencimento < fin_hoje() THEN 'vencida'
       ELSE 'aberta' END AS situacao
FROM b2 b;
REVOKE ALL ON fin_ctl_v_cobrancas FROM PUBLIC, anon, authenticated;
GRANT SELECT ON fin_ctl_v_cobrancas TO service_role;

DROP VIEW IF EXISTS fin_ctl_v_creditos;
CREATE VIEW fin_ctl_v_creditos AS
SELECT c.*, u.nome AS unidade_nome, u.cidade_slug,
       CASE WHEN cf.conferido_em >= coalesce(c.atualizado_em, c.criado_em) THEN cf.conf_status END AS conf_status,
       cf.conf_status AS conf_status_anterior,
       (cf.conferido_em IS NOT NULL AND cf.conferido_em < coalesce(c.atualizado_em, c.criado_em)) AS conf_desatualizada,
       cf.conferido_por, cf.conferido_em
FROM fin_ctl_creditos c
JOIN fin_unidades u ON u.id = c.unidade_id
LEFT JOIN LATERAL (SELECT status AS conf_status, conferido_por, conferido_em FROM fin_ctl_conferencias
                   WHERE tabela = 'fin_ctl_creditos' AND registro_id = c.id ORDER BY id DESC LIMIT 1) cf ON true;
REVOKE ALL ON fin_ctl_v_creditos FROM PUBLIC, anon, authenticated;
GRANT SELECT ON fin_ctl_v_creditos TO service_role;

-- ---------------- Escrita (só por RPC, com ator) ----------------
CREATE OR REPLACE FUNCTION fin_ctl_txt(p text, n int) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT nullif(left(btrim(coalesce(p,'')), n), '') $$;

-- Lança/edita cobrança. Edição só nos campos livres (desconto, vencimento, nome no banco, observação, multa).
-- p_gestor vem do SERVIDOR (papel validado na sessão): desconto/vencimento/multa depois de lançada = só gestor.
DROP FUNCTION IF EXISTS fin_ctl_cob_salvar(text, bigint, jsonb);
CREATE OR REPLACE FUNCTION fin_ctl_cob_salvar(p_ator text, p_id bigint, p_d jsonb, p_gestor boolean)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_id bigint; v_c fin_ctl_cobrancas; v_emp text; v_norm text; v_doc text; v_ini date; v_fim date; v_un bigint; v_desc numeric; v_n int;
        v_isento boolean := coalesce((p_d->>'isento_multa')::boolean, false); v_pct numeric; v_venc date := nullif(p_d->>'vencimento','')::date;
BEGIN
  PERFORM fin_set_ator(p_ator);
  v_desc := coalesce((p_d->>'desconto')::numeric, 0);
  IF v_desc < 0 THEN RAISE EXCEPTION 'Desconto inválido'; END IF;
  IF v_desc > 0 AND length(coalesce(fin_ctl_txt(p_d->>'desconto_motivo', 300), '')) < 5 THEN RAISE EXCEPTION 'Desconto precisa de motivo (mín. 5 letras)'; END IF;
  IF v_isento AND length(coalesce(fin_ctl_txt(p_d->>'isencao_motivo', 300), '')) < 10 THEN
    RAISE EXCEPTION 'Isenção de multa precisa de motivo (mín. 10 letras)';
  END IF;
  IF p_id IS NULL THEN
    v_pct := coalesce((p_d->>'multa_pct')::numeric, 3);
    IF NOT coalesce(p_gestor, false) AND (v_isento OR v_pct <> 3) THEN RAISE EXCEPTION 'Isentar ou mudar a multa é com o gestor'; END IF;
    v_emp := fin_ctl_txt(p_d->>'empresa', 200); v_norm := fin_norm(v_emp);
    v_doc := nullif(regexp_replace(coalesce(p_d->>'empresa_doc',''), '\D', '', 'g'), '');
    v_ini := (p_d->>'semana_ini')::date; v_fim := coalesce((p_d->>'semana_fim')::date, v_ini + 6); v_un := (p_d->>'unidade_id')::bigint;
    IF v_emp IS NULL OR length(v_emp) < 2 THEN RAISE EXCEPTION 'Empresa obrigatória'; END IF;
    IF v_ini IS NULL OR v_un IS NULL THEN RAISE EXCEPTION 'Cidade e semana obrigatórias'; END IF;
    IF NOT EXISTS (SELECT 1 FROM fin_unidades WHERE id = v_un AND ativo) THEN RAISE EXCEPTION 'Cidade inválida'; END IF;
    IF EXISTS (SELECT 1 FROM fin_ctl_cobrancas WHERE unidade_id = v_un AND semana_ini = v_ini AND status = 'ativa'
               AND (empresa_norm = v_norm OR (v_doc IS NOT NULL AND empresa_doc = v_doc)))
       AND NOT coalesce((p_d->>'permitir_repetida')::boolean, false) THEN
      RAISE EXCEPTION 'Essa empresa já tem cobrança nessa semana nessa cidade (confira antes de lançar outra)';
    END IF;
    SELECT count(*) + 1 INTO v_n FROM fin_ctl_cobrancas WHERE chave LIKE 'M|' || v_un || '|' || v_ini || '|' || coalesce(v_doc, v_norm) || '|%';
    INSERT INTO fin_ctl_cobrancas (unidade_id, semana_ini, semana_fim, empresa, empresa_norm, empresa_doc, valor, desconto, desconto_motivo,
      multa_pct, isento_multa, isencao_motivo, isencao_por, vencimento, nome_no_banco, observacao, origem, chave, criado_por)
    VALUES (v_un, v_ini, v_fim, v_emp, v_norm, v_doc, (p_d->>'valor')::numeric, v_desc, fin_ctl_txt(p_d->>'desconto_motivo', 300),
      v_pct, v_isento, fin_ctl_txt(p_d->>'isencao_motivo', 300), CASE WHEN v_isento THEN p_ator END,
      v_venc, fin_ctl_txt(p_d->>'nome_no_banco', 200), fin_ctl_txt(p_d->>'observacao', 1000), 'manual',
      'M|' || v_un || '|' || v_ini || '|' || coalesce(v_doc, v_norm) || '|' || v_n, p_ator)
    RETURNING id INTO v_id;
    RETURN jsonb_build_object('ok', true, 'id', v_id);
  END IF;
  SELECT * INTO v_c FROM fin_ctl_cobrancas WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cobrança não encontrada'; END IF;
  IF v_desc > v_c.valor THEN RAISE EXCEPTION 'Desconto maior que o valor'; END IF;
  v_pct := coalesce((p_d->>'multa_pct')::numeric, v_c.multa_pct);
  IF v_c.vencimento IS NOT NULL AND v_venc IS NULL THEN RAISE EXCEPTION 'O vencimento não pode ser apagado'; END IF;
  -- o que mexe em dinheiro, depois de lançado, só o gestor muda
  IF NOT coalesce(p_gestor, false) AND (v_desc <> v_c.desconto OR v_isento <> v_c.isento_multa OR v_pct <> v_c.multa_pct
       OR (v_c.vencimento IS NOT NULL AND v_venc <> v_c.vencimento)) THEN
    RAISE EXCEPTION 'Desconto, vencimento e multa de uma cobrança já lançada só o gestor muda';
  END IF;
  UPDATE fin_ctl_cobrancas SET desconto = v_desc, desconto_motivo = CASE WHEN v_desc > 0 THEN fin_ctl_txt(p_d->>'desconto_motivo', 300) END,
    multa_pct = v_pct, isento_multa = v_isento, isencao_motivo = CASE WHEN v_isento THEN fin_ctl_txt(p_d->>'isencao_motivo', 300) END,
    isencao_por = CASE WHEN v_isento THEN CASE WHEN isento_multa THEN isencao_por ELSE p_ator END END,
    vencimento = v_venc, nome_no_banco = fin_ctl_txt(p_d->>'nome_no_banco', 200),
    empresa_doc = coalesce(empresa_doc, nullif(regexp_replace(coalesce(p_d->>'empresa_doc',''), '\D', '', 'g'), '')),
    observacao = fin_ctl_txt(p_d->>'observacao', 1000), atualizado_por = p_ator, atualizado_em = now()
  WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'id', p_id);
END $$;

-- Uma linha do extrato só pode "pagar" um recebimento ativo
CREATE UNIQUE INDEX IF NOT EXISTS fin_ctl_rec_extrato_uk ON fin_ctl_cob_receb (extrato_id) WHERE extrato_id IS NOT NULL AND NOT estornado;

CREATE OR REPLACE FUNCTION fin_ctl_cob_receber(p_ator text, p_cobranca bigint, p_d jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_c fin_ctl_v_cobrancas; v_id bigint; v_valor numeric := (p_d->>'valor')::numeric; v_ext bigint := nullif(p_d->>'extrato_id','')::bigint; v_e record;
BEGIN
  PERFORM fin_set_ator(p_ator);
  PERFORM 1 FROM fin_ctl_cobrancas WHERE id = p_cobranca FOR UPDATE;   -- trava contra cancelamento em paralelo
  SELECT * INTO v_c FROM fin_ctl_v_cobrancas WHERE id = p_cobranca;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cobrança não encontrada'; END IF;
  IF v_c.status = 'cancelada' THEN RAISE EXCEPTION 'Cobrança cancelada'; END IF;
  IF v_valor IS NULL OR v_valor <= 0 THEN RAISE EXCEPTION 'Valor inválido'; END IF;
  IF (p_d->>'data') IS NULL THEN RAISE EXCEPTION 'Data do recebimento obrigatória'; END IF;
  IF (p_d->>'data')::date > fin_hoje() THEN RAISE EXCEPTION 'Recebimento no futuro'; END IF;
  IF v_valor > v_c.saldo + 0.009 AND length(coalesce(fin_ctl_txt(p_d->>'observacao', 500), '')) < 10 THEN
    RAISE EXCEPTION 'Valor maior que o saldo (%): explique na observação', v_c.saldo;
  END IF;
  IF v_ext IS NOT NULL THEN
    SELECT * INTO v_e FROM fin_extrato WHERE id = v_ext;
    IF NOT FOUND OR v_e.valor <= 0 THEN RAISE EXCEPTION 'Linha do extrato inválida (tem que ser uma entrada)'; END IF;
    IF v_e.data <> (p_d->>'data')::date THEN RAISE EXCEPTION 'A data do recebimento tem que ser a data da linha do extrato (%)', v_e.data; END IF;
  END IF;
  INSERT INTO fin_ctl_cob_receb (cobranca_id, valor, data, forma, nome_no_banco, extrato_id, observacao, criado_por)
  VALUES (p_cobranca, v_valor, (p_d->>'data')::date, fin_ctl_txt(p_d->>'forma', 30), fin_ctl_txt(p_d->>'nome_no_banco', 200),
          nullif(p_d->>'extrato_id','')::bigint, fin_ctl_txt(p_d->>'observacao', 500), p_ator)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

CREATE OR REPLACE FUNCTION fin_ctl_estornar_receb(p_ator text, p_id bigint, p_motivo text)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF length(coalesce(btrim(p_motivo), '')) < 10 THEN RAISE EXCEPTION 'Estorno precisa de motivo (mín. 10 letras)'; END IF;
  UPDATE fin_ctl_cob_receb SET estornado = true, estorno_motivo = left(btrim(p_motivo), 500), estornado_por = p_ator, estornado_em = now()
  WHERE id = p_id AND NOT estornado;
  IF NOT FOUND THEN RAISE EXCEPTION 'Recebimento não encontrado ou já estornado'; END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION fin_ctl_cred_salvar(p_ator text, p_id bigint, p_d jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_id bigint; v_b text; v_un bigint; v_dt date; v_n int; v_hora time; v_valor numeric;
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF p_id IS NULL THEN
    v_b := fin_ctl_txt(p_d->>'beneficiario', 200); v_un := (p_d->>'unidade_id')::bigint; v_dt := (p_d->>'data')::date;
    v_hora := nullif(p_d->>'hora','')::time; v_valor := (p_d->>'valor')::numeric;
    IF v_b IS NULL OR length(v_b) < 2 THEN RAISE EXCEPTION 'Quem recebeu o crédito é obrigatório'; END IF;
    IF v_un IS NULL OR v_dt IS NULL THEN RAISE EXCEPTION 'Cidade e data obrigatórias'; END IF;
    IF v_dt > fin_hoje() THEN RAISE EXCEPTION 'Crédito no futuro'; END IF;
    IF NOT EXISTS (SELECT 1 FROM fin_unidades WHERE id = v_un AND ativo) THEN RAISE EXCEPTION 'Cidade inválida'; END IF;
    IF (p_d->>'motivo') = 'outro' AND length(coalesce(fin_ctl_txt(p_d->>'observacao', 500), '')) < 10 THEN
      RAISE EXCEPTION 'Motivo "outro" precisa de observação (mín. 10 letras)';
    END IF;
    IF EXISTS (SELECT 1 FROM fin_ctl_creditos WHERE status = 'ativo' AND unidade_id = v_un AND data = v_dt AND beneficiario_norm = fin_norm(v_b)
               AND valor = v_valor AND hora IS NOT DISTINCT FROM v_hora)
       AND NOT coalesce((p_d->>'permitir_repetido')::boolean, false) THEN
      RAISE EXCEPTION 'Já existe um crédito igual (mesma pessoa, valor, dia e hora). Confira antes de lançar de novo';
    END IF;
    SELECT count(*) + 1 INTO v_n FROM fin_ctl_creditos
     WHERE chave LIKE 'M|' || v_un || '|' || v_dt || '|' || coalesce(v_hora::text, '-') || '|' || fin_norm(v_b) || '|' || v_valor || '|%';
    INSERT INTO fin_ctl_creditos (unidade_id, data, hora, valor, beneficiario, beneficiario_norm, beneficiario_tipo, entregador_id, empresa, os,
      operador, motivo, observacao, origem, chave, criado_por)
    VALUES (v_un, v_dt, v_hora, v_valor, v_b, fin_norm(v_b), coalesce(p_d->>'beneficiario_tipo', 'entregador'),
      fin_ctl_txt(p_d->>'entregador_id', 40), fin_ctl_txt(p_d->>'empresa', 200), fin_ctl_txt(p_d->>'os', 60), fin_ctl_txt(p_d->>'operador', 100),
      coalesce(p_d->>'motivo', 'outro'), fin_ctl_txt(p_d->>'observacao', 1000), 'manual',
      'M|' || v_un || '|' || v_dt || '|' || coalesce(v_hora::text, '-') || '|' || fin_norm(v_b) || '|' || v_valor || '|' || v_n, p_ator)
    RETURNING id INTO v_id;
    RETURN jsonb_build_object('ok', true, 'id', v_id);
  END IF;
  UPDATE fin_ctl_creditos SET beneficiario_tipo = coalesce(p_d->>'beneficiario_tipo', beneficiario_tipo),
    entregador_id = fin_ctl_txt(p_d->>'entregador_id', 40), empresa = fin_ctl_txt(p_d->>'empresa', 200), os = fin_ctl_txt(p_d->>'os', 60),
    operador = fin_ctl_txt(p_d->>'operador', 100), motivo = coalesce(p_d->>'motivo', motivo), observacao = fin_ctl_txt(p_d->>'observacao', 1000),
    hora = coalesce(nullif(p_d->>'hora','')::time, hora), atualizado_por = p_ator, atualizado_em = now()
  WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Crédito não encontrado'; END IF;
  RETURN jsonb_build_object('ok', true, 'id', p_id);
END $$;

CREATE OR REPLACE FUNCTION fin_ctl_cancelar(p_ator text, p_tabela text, p_id bigint, p_motivo text)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF length(coalesce(btrim(p_motivo), '')) < 10 THEN RAISE EXCEPTION 'Cancelamento precisa de motivo (mín. 10 letras)'; END IF;
  IF p_tabela = 'fin_ctl_cobrancas' THEN
    PERFORM 1 FROM fin_ctl_cobrancas WHERE id = p_id FOR UPDATE;   -- trava contra recebimento em paralelo
    IF EXISTS (SELECT 1 FROM fin_ctl_cob_receb WHERE cobranca_id = p_id AND NOT estornado) THEN
      RAISE EXCEPTION 'Essa cobrança tem recebimento: estorne o recebimento antes de cancelar';
    END IF;
    UPDATE fin_ctl_cobrancas SET status = 'cancelada', cancelado_motivo = left(btrim(p_motivo), 500), cancelado_por = p_ator, cancelado_em = now()
    WHERE id = p_id AND status = 'ativa';
  ELSIF p_tabela = 'fin_ctl_creditos' THEN
    UPDATE fin_ctl_creditos SET status = 'cancelado', cancelado_motivo = left(btrim(p_motivo), 500), cancelado_por = p_ator, cancelado_em = now()
    WHERE id = p_id AND status = 'ativo';
  ELSE RAISE EXCEPTION 'Tabela inválida'; END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Registro não encontrado ou já cancelado'; END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- Conferência: quem lançou não confere; divergente exige observação.
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

-- Importação das planilhas antigas (linhas já validadas no servidor). Não duplica: chave por conteúdo.
CREATE OR REPLACE FUNCTION fin_ctl_importar(p_ator text, p_tipo text, p_meta jsonb, p_linhas jsonb)
RETURNS jsonb LANGUAGE plpgsql SET statement_timeout = '180s' AS $$
DECLARE v_un bigint := (p_meta->>'unidade_id')::bigint; v_imp uuid; v_total int; v_novas int := 0; v_rec int := 0; l jsonb; v_id bigint;
        v_manual int := 0; v_div jsonb := '[]'::jsonb; v_exist record;
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF p_tipo NOT IN ('empresas','creditos') THEN RAISE EXCEPTION 'Tipo inválido'; END IF;
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
    IF p_tipo = 'empresas' THEN
      -- já existe esta linha (importação anterior)? se o valor mudou, avisa em vez de ignorar calado
      SELECT id, valor, desconto INTO v_exist FROM fin_ctl_cobrancas WHERE chave = 'P|' || v_un || '|' || (l->>'chave');
      IF FOUND THEN
        IF v_exist.valor <> (l->>'valor')::numeric AND jsonb_array_length(v_div) < 50 THEN
          v_div := v_div || jsonb_build_object('empresa', l->>'empresa', 'semana', l->>'semana_ini', 'no_sistema', v_exist.valor, 'na_planilha', (l->>'valor')::numeric);
        END IF;
        CONTINUE;
      END IF;
      -- já lançada À MÃO (mesma cidade/semana/empresa ativa)? não duplica
      IF EXISTS (SELECT 1 FROM fin_ctl_cobrancas WHERE unidade_id = v_un AND semana_ini = (l->>'semana_ini')::date AND status = 'ativa' AND origem <> 'planilha'
                 AND (empresa_norm = fin_norm(l->>'empresa') OR (nullif(l->>'empresa_doc','') IS NOT NULL AND empresa_doc = l->>'empresa_doc'))) THEN
        v_manual := v_manual + 1; CONTINUE;
      END IF;
      INSERT INTO fin_ctl_cobrancas (unidade_id, semana_ini, semana_fim, empresa, empresa_norm, empresa_doc, valor, desconto, desconto_motivo,
        vencimento, nome_no_banco, observacao, origem, importacao_id, chave, criado_por)
      VALUES (v_un, (l->>'semana_ini')::date, (l->>'semana_fim')::date, l->>'empresa', fin_norm(l->>'empresa'), nullif(l->>'empresa_doc',''),
        (l->>'valor')::numeric, coalesce((l->>'desconto')::numeric, 0), CASE WHEN coalesce((l->>'desconto')::numeric,0) > 0 THEN 'importado da planilha' END,
        nullif(l->>'vencimento','')::date, nullif(l->>'nome_no_banco',''), nullif(l->>'observacao',''), 'planilha', v_imp,
        'P|' || v_un || '|' || (l->>'chave'), p_ator)
      ON CONFLICT (chave) DO NOTHING RETURNING id INTO v_id;
      IF v_id IS NOT NULL THEN
        v_novas := v_novas + 1;
        IF coalesce((l->>'recebido')::numeric, 0) > 0 THEN
          INSERT INTO fin_ctl_cob_receb (cobranca_id, valor, data, nome_no_banco, observacao, origem, criado_por)
          VALUES (v_id, (l->>'recebido')::numeric, coalesce(nullif(l->>'data_receb','')::date, (l->>'semana_fim')::date + 1),
                  nullif(l->>'nome_no_banco',''), 'importado da planilha (data aproximada: a planilha não tinha a data do pagamento)', 'planilha', p_ator);
          v_rec := v_rec + 1;
        END IF;
      END IF;
      v_id := NULL;
    ELSE
      IF EXISTS (SELECT 1 FROM fin_ctl_creditos WHERE unidade_id = v_un AND data = (l->>'data')::date AND status = 'ativo' AND origem <> 'planilha'
                 AND beneficiario_norm = fin_norm(l->>'beneficiario') AND valor = (l->>'valor')::numeric
                 AND (hora IS NULL OR nullif(l->>'hora','') IS NULL OR hora = (l->>'hora')::time)) THEN
        v_manual := v_manual + 1; CONTINUE;
      END IF;
      INSERT INTO fin_ctl_creditos (unidade_id, data, hora, valor, beneficiario, beneficiario_norm, beneficiario_tipo, entregador_id, empresa, os,
        operador, motivo, observacao, origem, importacao_id, chave, criado_por)
      VALUES (v_un, (l->>'data')::date, nullif(l->>'hora','')::time, (l->>'valor')::numeric, l->>'beneficiario', fin_norm(l->>'beneficiario'),
        coalesce(l->>'beneficiario_tipo','entregador'), nullif(l->>'entregador_id',''), nullif(l->>'empresa',''), nullif(l->>'os',''),
        nullif(l->>'operador',''), coalesce(l->>'motivo','outro'), nullif(l->>'observacao',''), 'planilha', v_imp, 'P|' || v_un || '|' || (l->>'chave'), p_ator)
      ON CONFLICT (chave) DO NOTHING RETURNING id INTO v_id;
      IF v_id IS NOT NULL THEN v_novas := v_novas + 1; END IF;
      v_id := NULL;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'importacao_id', v_imp, 'linhas', v_total, 'novas', v_novas, 'repetidas', v_total - v_novas - v_manual,
                            'ja_lancadas_a_mao', v_manual, 'valor_diferente', v_div, 'recebimentos', v_rec);
END $$;

-- Resumos (painel de cada controle)
CREATE OR REPLACE FUNCTION fin_ctl_resumo_cob(p_unidade bigint, p_ini date, p_fim date)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH c AS (SELECT * FROM fin_ctl_v_cobrancas WHERE (p_unidade IS NULL OR unidade_id = p_unidade) AND semana_ini BETWEEN p_ini AND p_fim AND status = 'ativa')
  SELECT jsonb_build_object(
    'qtd', count(*), 'liquido', coalesce(sum(liquido),0), 'multa', coalesce(sum(multa),0), 'recebido', coalesce(sum(recebido),0),
    'saldo', coalesce(sum(saldo) FILTER (WHERE saldo > 0),0),
    'vencidas', count(*) FILTER (WHERE situacao = 'vencida'), 'vencidas_valor', coalesce(sum(saldo) FILTER (WHERE situacao = 'vencida'),0),
    'parciais', count(*) FILTER (WHERE situacao = 'parcial'), 'quitadas', count(*) FILTER (WHERE situacao = 'quitada'),
    'sem_conferencia', count(*) FILTER (WHERE conf_status IS NULL), 'divergentes', count(*) FILTER (WHERE conf_status = 'divergente'),
    'semanas', coalesce((SELECT jsonb_agg(x ORDER BY x.semana_ini DESC) FROM (
        SELECT semana_ini, min(semana_fim) AS semana_fim, count(*) AS qtd, sum(liquido) AS liquido, sum(recebido) AS recebido,
               sum(saldo) FILTER (WHERE saldo > 0) AS saldo, count(*) FILTER (WHERE situacao = 'vencida') AS vencidas,
               count(*) FILTER (WHERE conf_status IS NULL) AS sem_conferencia
        FROM c GROUP BY semana_ini) x), '[]'::jsonb))
  FROM c
$$;

CREATE OR REPLACE FUNCTION fin_ctl_resumo_cred(p_unidade bigint, p_ini date, p_fim date)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH c AS (SELECT * FROM fin_ctl_v_creditos WHERE (p_unidade IS NULL OR unidade_id = p_unidade) AND data BETWEEN p_ini AND p_fim AND status = 'ativo')
  SELECT jsonb_build_object(
    'qtd', count(*), 'valor', coalesce(sum(valor),0),
    'sem_conferencia', count(*) FILTER (WHERE conf_status IS NULL), 'divergentes', count(*) FILTER (WHERE conf_status = 'divergente'),
    'por_motivo', coalesce((SELECT jsonb_agg(x ORDER BY x.valor DESC) FROM (SELECT motivo, count(*) AS qtd, sum(valor) AS valor FROM c GROUP BY motivo) x), '[]'::jsonb),
    'por_operador', coalesce((SELECT jsonb_agg(x ORDER BY x.valor DESC) FROM (SELECT coalesce(operador,'(sem operador)') AS operador, count(*) AS qtd, sum(valor) AS valor FROM c GROUP BY 1) x), '[]'::jsonb),
    'maiores_beneficiarios', coalesce((SELECT jsonb_agg(x ORDER BY x.valor DESC) FROM (
        SELECT min(beneficiario) AS beneficiario, count(*) AS qtd, sum(valor) AS valor FROM c GROUP BY beneficiario_norm ORDER BY sum(valor) DESC LIMIT 10) x), '[]'::jsonb))
  FROM c
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
