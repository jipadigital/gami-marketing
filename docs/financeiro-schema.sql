-- ============================================================
-- MÓDULO FINANCEIRO GÂMI — CONFERÊNCIA ANTIFRAUDE (v1, 09/11/2026)
-- ------------------------------------------------------------
-- O que é: o extrato do banco (Cora etc) entra aqui e NUNCA mais some.
-- As conferentes conferem linha a linha (OK / divergente / suspeito),
-- o sistema roda regras antifraude e gera alertas, e tudo fica num log
-- de auditoria encadeado por hash (se alguém adulterar, a cadeia quebra).
--
-- PRINCÍPIOS DE BLINDAGEM
--  1. APPEND-ONLY: DELETE e TRUNCATE são bloqueados por trigger em TODAS as
--     tabelas fin_* (vale até pra service key). Extrato, importações,
--     conferências e auditoria também não aceitam UPDATE.
--  2. Correção = novo registro (nova conferência), nunca edição.
--  3. Toda escrita passa por RPC (transação única) que registra QUEM fez.
--  4. Auditoria com cadeia de hash SHA-256 (fin_verificar_cadeia()).
--  5. Importação idempotente: o mesmo arquivo não entra 2x (sha256) e a
--     mesma linha não duplica (hash da linha + nº de ocorrência).
--  6. Continuidade de saldo: se faltar linha entre um extrato e o próximo
--     (alguém apagou/escondeu), gera alerta CRÍTICO.
--  7. Segurança de acesso: RLS ligada SEM policy + REVOKE de anon/authenticated
--     em tabelas, views e funções. Só a service key (função Netlify
--     financeiro.js, que valida a sessão e o papel) enxerga.
--
-- Seguro rodar de novo por cima (IF NOT EXISTS / CREATE OR REPLACE).
-- Rodar INTEIRO no SQL Editor do Supabase.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ------------------------------------------------------------
-- 1) TABELAS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fin_config (
  chave          text PRIMARY KEY,
  valor          jsonb NOT NULL,
  descricao      text,
  atualizado_em  timestamptz NOT NULL DEFAULT now(),
  atualizado_por text
);

INSERT INTO fin_config (chave, valor, descricao) VALUES
  ('limite_dupla_conferencia', '5000', 'Saídas/entradas a partir deste valor (R$) precisam de 2 conferentes diferentes'),
  ('dias_para_conferir',       '5',    'Saída sem conferência depois de X dias vira alerta'),
  ('valor_min_benef_novo',     '500',  'Pagamento a favorecido nunca visto a partir deste valor (R$) gera alerta'),
  ('multiplo_media',           '2.5',  'Pagamento X vezes acima da média do favorecido gera alerta'),
  ('dias_sem_importar',        '7',    'Conta ativa sem extrato importado há X dias gera alerta'),
  ('exigir_lastro',            'false','Ligado = toda saída do banco precisa bater com um lançamento do Kamino (ligar quando os lançamentos estiverem entrando)')
ON CONFLICT (chave) DO NOTHING;

-- Quem acessa o módulo (além do super_admin, que sempre acessa).
-- papel: gestor (tudo menos acessos) | conferente (confere e importa extrato) | leitor (só vê)
CREATE TABLE IF NOT EXISTS fin_acesso (
  pessoa_id     text PRIMARY KEY,
  papel         text NOT NULL CHECK (papel IN ('gestor','conferente','leitor')),
  ativo         boolean NOT NULL DEFAULT true,
  criado_por    text NOT NULL,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_por text,
  atualizado_em timestamptz
);

CREATE TABLE IF NOT EXISTS fin_contas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome          text NOT NULL,
  banco         text,
  agencia       text,
  numero        text,
  cidade_slug   text,
  unidade       text,
  formato       text CHECK (formato IN ('ofx','csv')),  -- travado no 1º import (evita duplicar ao trocar formato)
  ativo         boolean NOT NULL DEFAULT true,
  criado_por    text NOT NULL,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_por text,
  atualizado_em timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_contas_nome_uk ON fin_contas (lower(nome));

CREATE TABLE IF NOT EXISTS fin_importacoes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conta_id       uuid REFERENCES fin_contas(id),
  tipo           text NOT NULL CHECK (tipo IN ('extrato','lancamentos')),
  formato        text NOT NULL,
  arquivo_nome   text,
  arquivo_sha256 text NOT NULL,
  arquivo_bytes  integer,
  conteudo       text,                 -- arquivo original guardado como PROVA
  periodo_ini    date,
  periodo_fim    date,
  saldo_final    numeric(14,2),        -- saldo informado pelo banco no arquivo
  saldo_data     date,
  qtd_linhas     integer NOT NULL DEFAULT 0,
  qtd_novas      integer NOT NULL DEFAULT 0,
  qtd_duplicadas integer NOT NULL DEFAULT 0,
  soma_creditos  numeric(14,2) NOT NULL DEFAULT 0,
  soma_debitos   numeric(14,2) NOT NULL DEFAULT 0,
  importado_por  text NOT NULL,
  importado_em   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_import_arquivo_uk ON fin_importacoes (coalesce(conta_id::text,'-'), tipo, arquivo_sha256);

CREATE TABLE IF NOT EXISTS fin_extrato (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conta_id         uuid NOT NULL REFERENCES fin_contas(id),
  data             date NOT NULL,
  valor            numeric(14,2) NOT NULL CHECK (valor <> 0),   -- + entrada / - saída
  descricao        text NOT NULL,
  documento        text,
  contraparte      text,
  contraparte_doc  text,
  contraparte_norm text,
  fitid            text,
  tipo_banco       text,
  hash             text NOT NULL,
  importacao_id    uuid NOT NULL REFERENCES fin_importacoes(id),
  criado_em        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conta_id, hash)
);
CREATE INDEX IF NOT EXISTS fin_extrato_conta_data ON fin_extrato (conta_id, data);
CREATE INDEX IF NOT EXISTS fin_extrato_norm ON fin_extrato (contraparte_norm);
CREATE INDEX IF NOT EXISTS fin_extrato_data ON fin_extrato (data);

-- Conferência: cada clique é um registro novo. Vale a ÚLTIMA de cada pessoa.
CREATE TABLE IF NOT EXISTS fin_conferencias (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  extrato_id    bigint NOT NULL REFERENCES fin_extrato(id),
  status        text NOT NULL CHECK (status IN ('ok','divergente','suspeito')),
  categoria     text,
  observacao    text,
  referencia    text,
  conferido_por text NOT NULL,
  conferido_em  timestamptz NOT NULL DEFAULT now(),
  idem_key      text UNIQUE,
  CHECK (status = 'ok' OR length(btrim(coalesce(observacao,''))) >= 10)
);
CREATE INDEX IF NOT EXISTS fin_conf_extrato ON fin_conferencias (extrato_id, conferido_por, id DESC);

-- Lançamentos (contas a pagar/receber do Kamino: CSV agora, API depois)
CREATE TABLE IF NOT EXISTS fin_lancamentos (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  origem         text NOT NULL CHECK (origem IN ('kamino_api','kamino_csv','manual')),
  chave          text NOT NULL,          -- id externo do Kamino OU hash do conteúdo
  tipo           text NOT NULL CHECK (tipo IN ('pagar','receber')),
  pessoa         text,
  pessoa_doc     text,
  pessoa_norm    text,
  descricao      text,
  categoria      text,
  unidade        text,
  conta_nome     text,
  valor          numeric(14,2) NOT NULL CHECK (valor > 0),
  vencimento     date,
  data_pagamento date,
  situacao       text,
  importacao_id  uuid REFERENCES fin_importacoes(id),
  raw            jsonb,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  atualizado_em  timestamptz,
  UNIQUE (origem, chave)
);
CREATE INDEX IF NOT EXISTS fin_lanc_valor ON fin_lancamentos (tipo, valor);

CREATE TABLE IF NOT EXISTS fin_conciliacoes (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  extrato_id      bigint NOT NULL REFERENCES fin_extrato(id),
  lancamento_id   bigint NOT NULL REFERENCES fin_lancamentos(id),
  metodo          text NOT NULL CHECK (metodo IN ('auto','manual')),
  ativo           boolean NOT NULL DEFAULT true,
  criado_por      text NOT NULL,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  desfeito_por    text,
  desfeito_em     timestamptz,
  motivo_desfazer text
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_conc_ext_uk  ON fin_conciliacoes (extrato_id)    WHERE ativo;
CREATE UNIQUE INDEX IF NOT EXISTS fin_conc_lanc_uk ON fin_conciliacoes (lancamento_id) WHERE ativo;

CREATE TABLE IF NOT EXISTS fin_alertas (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chave         text NOT NULL UNIQUE,     -- impede o mesmo alerta 2x
  regra         text NOT NULL,
  severidade    text NOT NULL CHECK (severidade IN ('critico','alto','medio','baixo')),
  titulo        text NOT NULL,
  detalhe       jsonb,
  conta_id      uuid REFERENCES fin_contas(id),
  extrato_id    bigint REFERENCES fin_extrato(id),
  lancamento_id bigint REFERENCES fin_lancamentos(id),
  valor         numeric(14,2),
  status        text NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','resolvido','falso_positivo','fraude_confirmada')),
  resolvido_por text,
  resolvido_em  timestamptz,
  justificativa text,
  criado_em     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_alertas_status ON fin_alertas (status, severidade);
CREATE INDEX IF NOT EXISTS fin_alertas_extrato ON fin_alertas (extrato_id);

-- Favorecidos confiáveis (silencia só o alerta de "favorecido novo"/"é da equipe")
CREATE TABLE IF NOT EXISTS fin_benef_confiaveis (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contraparte_norm text NOT NULL,
  nome_exibicao    text,
  motivo           text NOT NULL CHECK (length(btrim(motivo)) >= 10),
  ativo            boolean NOT NULL DEFAULT true,
  aprovado_por     text NOT NULL,
  aprovado_em      timestamptz NOT NULL DEFAULT now(),
  desativado_por   text,
  desativado_em    timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_benef_uk ON fin_benef_confiaveis (contraparte_norm) WHERE ativo;

-- Auditoria encadeada (blockchain-like): cada linha carrega o hash da anterior
CREATE TABLE IF NOT EXISTS fin_auditoria (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seq           bigint NOT NULL UNIQUE,
  ts            timestamptz NOT NULL DEFAULT clock_timestamp(),
  ator          text NOT NULL,
  acao          text NOT NULL,
  tabela        text NOT NULL,
  registro_id   text,
  antes         jsonb,
  depois        jsonb,
  hash_anterior text NOT NULL,
  hash          text NOT NULL
);

-- ------------------------------------------------------------
-- 2) HELPERS
-- ------------------------------------------------------------

-- Normaliza nome (maiúsculo, sem acento, só letras/números/espaço)
CREATE OR REPLACE FUNCTION fin_norm(t text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT nullif(btrim(regexp_replace(regexp_replace(
    translate(upper(coalesce(t,'')),
      'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ',
      'AAAAAEEEEIIIIOOOOOUUUUCN'),
    '[^A-Z0-9 ]', ' ', 'g'), '\s+', ' ', 'g')), '')
$$;

CREATE OR REPLACE FUNCTION fin_cfg_num(p text) RETURNS numeric
LANGUAGE sql STABLE AS $$ SELECT (valor #>> '{}')::numeric FROM fin_config WHERE chave = p $$;

CREATE OR REPLACE FUNCTION fin_cfg_bool(p text) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce((valor #>> '{}')::boolean, false) FROM fin_config WHERE chave = p $$;

CREATE OR REPLACE FUNCTION fin_set_ator(p text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p IS NULL OR btrim(p) = '' THEN RAISE EXCEPTION 'ator obrigatório'; END IF;
  PERFORM set_config('fin.ator', p, true);
END $$;

-- ------------------------------------------------------------
-- 3) TRIGGERS DE BLINDAGEM
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION fin_trg_bloqueia_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FINANCEIRO: exclusão proibida em % (registro permanente; corrija com um novo registro)', TG_TABLE_NAME;
END $$;

CREATE OR REPLACE FUNCTION fin_trg_bloqueia_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FINANCEIRO: % é imutável (não aceita edição)', TG_TABLE_NAME;
END $$;

-- Alerta: só pode sair de "aberto" uma vez, e só os campos de resolução mudam
CREATE OR REPLACE FUNCTION fin_trg_alerta_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'aberto' THEN RAISE EXCEPTION 'FINANCEIRO: alerta já resolvido não pode ser alterado'; END IF;
  IF NEW.chave IS DISTINCT FROM OLD.chave OR NEW.regra IS DISTINCT FROM OLD.regra
     OR NEW.severidade IS DISTINCT FROM OLD.severidade OR NEW.titulo IS DISTINCT FROM OLD.titulo
     OR NEW.detalhe IS DISTINCT FROM OLD.detalhe OR NEW.valor IS DISTINCT FROM OLD.valor
     OR NEW.extrato_id IS DISTINCT FROM OLD.extrato_id OR NEW.lancamento_id IS DISTINCT FROM OLD.lancamento_id
     OR NEW.conta_id IS DISTINCT FROM OLD.conta_id OR NEW.criado_em IS DISTINCT FROM OLD.criado_em THEN
    RAISE EXCEPTION 'FINANCEIRO: só a resolução do alerta pode ser registrada';
  END IF;
  IF NEW.status = 'aberto' THEN RAISE EXCEPTION 'FINANCEIRO: resolução inválida'; END IF;
  IF NEW.resolvido_por IS NULL OR length(btrim(coalesce(NEW.justificativa,''))) < 15 THEN
    RAISE EXCEPTION 'FINANCEIRO: resolução exige quem resolveu e justificativa (mín. 15 caracteres)';
  END IF;
  NEW.resolvido_em := now();
  RETURN NEW;
END $$;

-- Conciliação: só pode ser DESFEITA (ativo true -> false), uma vez
CREATE OR REPLACE FUNCTION fin_trg_conc_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (OLD.ativo AND NOT NEW.ativo) OR NEW.extrato_id <> OLD.extrato_id OR NEW.lancamento_id <> OLD.lancamento_id
     OR NEW.metodo <> OLD.metodo OR NEW.criado_por <> OLD.criado_por OR NEW.criado_em <> OLD.criado_em THEN
    RAISE EXCEPTION 'FINANCEIRO: conciliação só pode ser desfeita';
  END IF;
  IF NEW.desfeito_por IS NULL OR length(btrim(coalesce(NEW.motivo_desfazer,''))) < 10 THEN
    RAISE EXCEPTION 'FINANCEIRO: desfazer exige quem e motivo (mín. 10 caracteres)';
  END IF;
  NEW.desfeito_em := now();
  RETURN NEW;
END $$;

-- Favorecido confiável: só pode ser desativado
CREATE OR REPLACE FUNCTION fin_trg_benef_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (OLD.ativo AND NOT NEW.ativo) OR NEW.contraparte_norm <> OLD.contraparte_norm OR NEW.motivo <> OLD.motivo
     OR NEW.aprovado_por <> OLD.aprovado_por THEN
    RAISE EXCEPTION 'FINANCEIRO: favorecido confiável só pode ser desativado';
  END IF;
  IF NEW.desativado_por IS NULL THEN RAISE EXCEPTION 'FINANCEIRO: informe quem desativou'; END IF;
  NEW.desativado_em := now();
  RETURN NEW;
END $$;

-- Lançamentos: chave/origem/tipo nunca mudam (o resto pode ser atualizado pelo Kamino, e fica auditado)
CREATE OR REPLACE FUNCTION fin_trg_lanc_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.origem <> OLD.origem OR NEW.chave <> OLD.chave OR NEW.tipo <> OLD.tipo OR NEW.criado_em <> OLD.criado_em THEN
    RAISE EXCEPTION 'FINANCEIRO: identidade do lançamento não pode mudar';
  END IF;
  NEW.atualizado_em := now();
  RETURN NEW;
END $$;

-- Auditoria: grava antes/depois de TODA escrita, com o ator da transação
CREATE OR REPLACE FUNCTION fin_trg_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_antes jsonb; v_depois jsonb; v_id text;
BEGIN
  IF TG_OP = 'UPDATE' THEN v_antes := to_jsonb(OLD); END IF;
  v_depois := to_jsonb(NEW);
  IF TG_TABLE_NAME = 'fin_importacoes' THEN
    v_depois := v_depois - 'conteudo';
    IF v_antes IS NOT NULL THEN v_antes := v_antes - 'conteudo'; END IF;
  END IF;
  v_id := coalesce(v_depois->>'id', v_depois->>'chave', v_depois->>'pessoa_id');
  INSERT INTO fin_auditoria (seq, ator, acao, tabela, registro_id, antes, depois, hash_anterior, hash)
  VALUES (0, coalesce(nullif(current_setting('fin.ator', true),''), 'sistema:' || current_user),
          TG_OP, TG_TABLE_NAME, v_id, v_antes, v_depois, '', '');
  RETURN NEW;
END $$;

-- Cadeia de hash: serializa com lock e encadeia pela ordem de seq
CREATE OR REPLACE FUNCTION fin_trg_audit_hash() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, extensions AS $$
DECLARE v_prev text; v_seq bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('fin_auditoria_cadeia'));
  SELECT seq, hash INTO v_seq, v_prev FROM fin_auditoria ORDER BY seq DESC LIMIT 1;
  NEW.seq := coalesce(v_seq, 0) + 1;
  NEW.ts := clock_timestamp();
  NEW.hash_anterior := coalesce(v_prev, 'GENESIS');
  NEW.hash := encode(extensions.digest(
      NEW.hash_anterior || '|' || NEW.seq || '|' || extract(epoch FROM NEW.ts)::text || '|' || NEW.ator || '|' ||
      NEW.acao || '|' || NEW.tabela || '|' || coalesce(NEW.registro_id,'') || '|' ||
      coalesce(NEW.antes::text,'') || '|' || coalesce(NEW.depois::text,''), 'sha256'), 'hex');
  RETURN NEW;
END $$;

DO $do$
DECLARE t text;
BEGIN
  -- DELETE/TRUNCATE proibidos em tudo
  FOREACH t IN ARRAY ARRAY['fin_config','fin_acesso','fin_contas','fin_importacoes','fin_extrato','fin_conferencias',
                           'fin_lancamentos','fin_conciliacoes','fin_alertas','fin_benef_confiaveis','fin_auditoria'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_nodel ON %1$s', t);
    EXECUTE format('CREATE TRIGGER %1$s_nodel BEFORE DELETE ON %1$s FOR EACH ROW EXECUTE FUNCTION fin_trg_bloqueia_delete()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_notrunc ON %1$s', t);
    EXECUTE format('CREATE TRIGGER %1$s_notrunc BEFORE TRUNCATE ON %1$s FOR EACH STATEMENT EXECUTE FUNCTION fin_trg_bloqueia_delete()', t);
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %s TO service_role', t);
    -- service_role ignora RLS (BYPASSRLS); anon/authenticated não têm policy nenhuma = zero acesso
  END LOOP;

  -- Imutáveis (nem UPDATE)
  FOREACH t IN ARRAY ARRAY['fin_importacoes','fin_extrato','fin_conferencias','fin_auditoria'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_noupd ON %1$s', t);
    EXECUTE format('CREATE TRIGGER %1$s_noupd BEFORE UPDATE ON %1$s FOR EACH ROW EXECUTE FUNCTION fin_trg_bloqueia_update()', t);
  END LOOP;

  -- Auditoria em tudo (menos na própria auditoria)
  FOREACH t IN ARRAY ARRAY['fin_config','fin_acesso','fin_contas','fin_importacoes','fin_extrato','fin_conferencias',
                           'fin_lancamentos','fin_conciliacoes','fin_alertas','fin_benef_confiaveis'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_audit ON %1$s', t);
    EXECUTE format('CREATE TRIGGER %1$s_audit AFTER INSERT OR UPDATE ON %1$s FOR EACH ROW EXECUTE FUNCTION fin_trg_audit()', t);
  END LOOP;
END $do$;

-- A auditoria não pode ser alterada nem pela service key
REVOKE UPDATE ON fin_auditoria FROM service_role;
REVOKE UPDATE ON fin_extrato, fin_importacoes, fin_conferencias FROM service_role;

DROP TRIGGER IF EXISTS fin_auditoria_hash ON fin_auditoria;
CREATE TRIGGER fin_auditoria_hash BEFORE INSERT ON fin_auditoria FOR EACH ROW EXECUTE FUNCTION fin_trg_audit_hash();
DROP TRIGGER IF EXISTS fin_alertas_guard ON fin_alertas;
CREATE TRIGGER fin_alertas_guard BEFORE UPDATE ON fin_alertas FOR EACH ROW EXECUTE FUNCTION fin_trg_alerta_guard();
DROP TRIGGER IF EXISTS fin_conc_guard ON fin_conciliacoes;
CREATE TRIGGER fin_conc_guard BEFORE UPDATE ON fin_conciliacoes FOR EACH ROW EXECUTE FUNCTION fin_trg_conc_guard();
DROP TRIGGER IF EXISTS fin_benef_guard ON fin_benef_confiaveis;
CREATE TRIGGER fin_benef_guard BEFORE UPDATE ON fin_benef_confiaveis FOR EACH ROW EXECUTE FUNCTION fin_trg_benef_guard();
DROP TRIGGER IF EXISTS fin_lanc_guard ON fin_lancamentos;
CREATE TRIGGER fin_lanc_guard BEFORE UPDATE ON fin_lancamentos FOR EACH ROW EXECUTE FUNCTION fin_trg_lanc_guard();

-- ------------------------------------------------------------
-- 4) VIEW DO EXTRATO COM STATUS DE CONFERÊNCIA
--    Regra: vale a ÚLTIMA conferência de cada pessoa.
--    suspeito/divergente prevalecem sobre OK, até um gestor resolver o alerta.
--    Acima do limite precisa de 2 pessoas diferentes dando OK.
-- ------------------------------------------------------------
DROP VIEW IF EXISTS fin_v_extrato;
CREATE VIEW fin_v_extrato WITH (security_invoker = true) AS
WITH res AS (
  SELECT extrato_id, max(resolvido_em) AS resolvido_em,
         bool_or(status = 'fraude_confirmada') AS fraude
  FROM fin_alertas
  WHERE regra IN ('CONF_SUSPEITO','CONF_DIVERGENTE') AND status <> 'aberto' AND extrato_id IS NOT NULL
  GROUP BY extrato_id
),
ult AS (
  SELECT DISTINCT ON (c.extrato_id, c.conferido_por) c.*
  FROM fin_conferencias c
  ORDER BY c.extrato_id, c.conferido_por, c.id DESC
),
agg AS (
  SELECT u.extrato_id,
    count(*) FILTER (WHERE u.status = 'ok') AS n_ok,
    bool_or(u.status = 'suspeito'   AND u.conferido_em > coalesce(r.resolvido_em, '-infinity')) AS tem_susp,
    bool_or(u.status = 'divergente' AND u.conferido_em > coalesce(r.resolvido_em, '-infinity')) AS tem_div,
    bool_or(coalesce(r.fraude, false)) AS fraude,
    max(u.conferido_em) AS ultima_conf,
    jsonb_agg(jsonb_build_object('por', u.conferido_por, 'status', u.status, 'categoria', u.categoria,
              'obs', u.observacao, 'ref', u.referencia, 'em', u.conferido_em) ORDER BY u.conferido_em) AS confs,
    (array_agg(u.categoria ORDER BY u.conferido_em DESC) FILTER (WHERE u.categoria IS NOT NULL))[1] AS categoria
  FROM ult u LEFT JOIN res r ON r.extrato_id = u.extrato_id
  GROUP BY u.extrato_id
)
SELECT e.id, e.conta_id, c.nome AS conta_nome, c.cidade_slug, e.data, e.valor,
       CASE WHEN e.valor > 0 THEN 'entrada' ELSE 'saida' END AS tipo,
       e.descricao, e.documento, e.contraparte, e.contraparte_doc, e.contraparte_norm,
       e.importacao_id, e.criado_em,
       coalesce(a.n_ok, 0) AS n_ok,
       CASE WHEN abs(e.valor) >= coalesce(fin_cfg_num('limite_dupla_conferencia'), 5000) THEN 2 ELSE 1 END AS conf_necessarias,
       CASE
         WHEN coalesce(a.fraude, false) THEN 'fraude'
         WHEN a.tem_susp THEN 'suspeito'
         WHEN a.tem_div  THEN 'divergente'
         WHEN coalesce(a.n_ok, 0) >= (CASE WHEN abs(e.valor) >= coalesce(fin_cfg_num('limite_dupla_conferencia'), 5000) THEN 2 ELSE 1 END) THEN 'ok'
         WHEN coalesce(a.n_ok, 0) > 0 THEN 'aguardando_2a'
         ELSE 'pendente'
       END AS status,
       a.confs, a.categoria, a.ultima_conf,
       cc.lancamento_id,
       (SELECT count(*) FROM fin_alertas al WHERE al.extrato_id = e.id AND al.status = 'aberto') AS alertas_abertos
FROM fin_extrato e
JOIN fin_contas c ON c.id = e.conta_id
LEFT JOIN agg a ON a.extrato_id = e.id
LEFT JOIN fin_conciliacoes cc ON cc.extrato_id = e.id AND cc.ativo;

REVOKE ALL ON fin_v_extrato FROM PUBLIC, anon, authenticated;
GRANT SELECT ON fin_v_extrato TO service_role;

-- ------------------------------------------------------------
-- 5) REGRAS ANTIFRAUDE
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_novo_alerta(p_chave text, p_regra text, p_sev text, p_titulo text, p_detalhe jsonb,
                                           p_conta uuid, p_extrato bigint, p_lanc bigint, p_valor numeric)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  INSERT INTO fin_alertas (chave, regra, severidade, titulo, detalhe, conta_id, extrato_id, lancamento_id, valor)
  VALUES (p_chave, p_regra, p_sev, p_titulo, p_detalhe, p_conta, p_extrato, p_lanc, p_valor)
  ON CONFLICT (chave) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION fin_rodar_regras(p_ator text DEFAULT 'sistema:regras')
RETURNS jsonb LANGUAGE plpgsql SET statement_timeout = '120s' AS $$
DECLARE
  r record; n int := 0; tot jsonb := '{}'::jsonb; k int;
  v_lim numeric := coalesce(fin_cfg_num('limite_dupla_conferencia'), 5000);
  v_dias numeric := coalesce(fin_cfg_num('dias_para_conferir'), 5);
  v_novo numeric := coalesce(fin_cfg_num('valor_min_benef_novo'), 500);
  v_mult numeric := coalesce(fin_cfg_num('multiplo_media'), 2.5);
  v_semimp numeric := coalesce(fin_cfg_num('dias_sem_importar'), 7);
  v_inicio date;
BEGIN
  PERFORM fin_set_ator(p_ator);
  SELECT min(data) INTO v_inicio FROM fin_extrato;

  -- R1 DUPLICIDADE: mesmo favorecido + mesmo valor em menos de 7 dias (qualquer conta)
  k := 0;
  FOR r IN
    SELECT e2.id, e2.conta_id, e2.valor, e2.data, e2.contraparte, e1.id AS id1, e1.data AS data1, c1.nome AS conta1
    FROM fin_extrato e1
    JOIN fin_extrato e2 ON e2.contraparte_norm = e1.contraparte_norm AND e2.valor = e1.valor
                       AND (e2.data > e1.data OR (e2.data = e1.data AND e2.id > e1.id))
                       AND e2.data <= e1.data + 6   -- < 7 dias: não pega pagamento semanal fixo
    JOIN fin_contas c1 ON c1.id = e1.conta_id
    WHERE e1.valor <= -50 AND e1.contraparte_norm IS NOT NULL AND length(e1.contraparte_norm) >= 4
  LOOP
    k := k + fin_novo_alerta('DUP:'||r.id, 'DUPLICIDADE', 'alto',
      'Possível pagamento em duplicidade para '||coalesce(r.contraparte,'?'),
      jsonb_build_object('outro_extrato_id', r.id1, 'outra_data', r.data1, 'outra_conta', r.conta1,
        'explicacao', 'Mesmo favorecido e mesmo valor pagos 2 vezes em menos de 7 dias.'),
      r.conta_id, r.id, NULL, r.valor);
  END LOOP;
  tot := tot || jsonb_build_object('DUPLICIDADE', k);

  -- R2 FRACIONAMENTO: 3+ pagamentos ao mesmo favorecido no dia, ou 2+ abaixo do limite somando acima dele
  k := 0;
  FOR r IN
    SELECT contraparte_norm, data, min(conta_id::text)::uuid AS conta_id, count(*) AS qtd, sum(valor) AS soma,
           max(abs(valor)) AS maior, min(id) AS primeiro, max(contraparte) AS nome, array_agg(id ORDER BY id) AS ids
    FROM fin_extrato
    WHERE valor < 0 AND contraparte_norm IS NOT NULL AND length(contraparte_norm) >= 4
    GROUP BY contraparte_norm, data
    HAVING count(*) >= 3 OR (count(*) >= 2 AND abs(sum(valor)) >= v_lim AND max(abs(valor)) < v_lim)
  LOOP
    k := k + fin_novo_alerta('FRAC:'||r.contraparte_norm||':'||r.data, 'FRACIONAMENTO', 'alto',
      r.qtd||' pagamentos no mesmo dia para '||coalesce(r.nome,'?'),
      jsonb_build_object('ids', to_jsonb(r.ids), 'soma', abs(r.soma),
        'explicacao', 'Pagamento quebrado em partes no mesmo dia (pode ser pra fugir da dupla conferência).'),
      r.conta_id, r.primeiro, NULL, r.soma);
  END LOOP;
  tot := tot || jsonb_build_object('FRACIONAMENTO', k);

  -- R3 FAVORECIDO NOVO: valor relevante pra quem nunca recebeu (só depois de 60 dias de histórico, p/ não inundar no 1º import)
  k := 0;
  IF v_inicio IS NOT NULL THEN
    FOR r IN
      SELECT e.* FROM fin_extrato e
      WHERE e.valor <= -v_novo AND e.contraparte_norm IS NOT NULL AND e.data >= v_inicio + 60
        AND NOT EXISTS (SELECT 1 FROM fin_extrato x WHERE x.contraparte_norm = e.contraparte_norm AND x.valor < 0
                        AND (x.data < e.data OR (x.data = e.data AND x.id < e.id)))
        AND NOT EXISTS (SELECT 1 FROM fin_benef_confiaveis b WHERE b.ativo AND b.contraparte_norm = e.contraparte_norm)
    LOOP
      k := k + fin_novo_alerta('NOVO:'||r.id, 'FAVORECIDO_NOVO', 'medio',
        'Primeiro pagamento para '||coalesce(r.contraparte,'?'),
        jsonb_build_object('explicacao', 'Favorecido que nunca recebeu antes. Confirme quem é e se o serviço existe.'),
        r.conta_id, r.id, NULL, r.valor);
    END LOOP;
  END IF;
  tot := tot || jsonb_build_object('FAVORECIDO_NOVO', k);

  -- R4 FAVORECIDO É DA EQUIPE: pagamento pra nome igual ao de alguém cadastrado em pessoas
  k := 0;
  FOR r IN
    SELECT DISTINCT ON (e.id) e.*, p.nome AS pessoa_nome
    FROM fin_extrato e
    JOIN pessoas p ON fin_norm(p.nome) IS NOT NULL AND length(fin_norm(p.nome)) >= 8
      AND (e.contraparte_norm = fin_norm(p.nome)
           OR (length(e.contraparte_norm) >= 10 AND position(e.contraparte_norm IN fin_norm(p.nome)) = 1)
           OR position(fin_norm(p.nome) IN e.contraparte_norm) = 1)
    WHERE e.valor < 0 AND e.contraparte_norm IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM fin_benef_confiaveis b WHERE b.ativo AND b.contraparte_norm = e.contraparte_norm)
  LOOP
    k := k + fin_novo_alerta('EQUIPE:'||r.id, 'FAVORECIDO_EQUIPE', 'medio',
      'Pagamento para pessoa da equipe: '||r.pessoa_nome,
      jsonb_build_object('pessoa', r.pessoa_nome,
        'explicacao', 'O favorecido tem o nome de alguém da equipe. Confirme se é salário/reembolso previsto.'),
      r.conta_id, r.id, NULL, r.valor);
  END LOOP;
  tot := tot || jsonb_build_object('FAVORECIDO_EQUIPE', k);

  -- R5 ACIMA DA MÉDIA do favorecido (últimos 180 dias, mín. 3 pagamentos anteriores)
  k := 0;
  FOR r IN
    SELECT e.*, h.media, h.qtd FROM fin_extrato e
    JOIN LATERAL (
      SELECT avg(abs(x.valor)) AS media, count(*) AS qtd FROM fin_extrato x
      WHERE x.contraparte_norm = e.contraparte_norm AND x.valor < 0 AND x.id <> e.id
        AND x.data BETWEEN e.data - 180 AND e.data - 1
    ) h ON h.qtd >= 3 AND abs(e.valor) > h.media * v_mult
    WHERE e.valor < 0 AND e.contraparte_norm IS NOT NULL AND abs(e.valor) >= 200
  LOOP
    k := k + fin_novo_alerta('MEDIA:'||r.id, 'ACIMA_DA_MEDIA', 'medio',
      'Pagamento '||round(abs(r.valor)/nullif(r.media,0),1)||'x acima do normal para '||coalesce(r.contraparte,'?'),
      jsonb_build_object('media_anterior', round(r.media,2), 'qtd_anteriores', r.qtd,
        'explicacao', 'Valor muito acima do que esse favorecido costuma receber.'),
      r.conta_id, r.id, NULL, r.valor);
  END LOOP;
  tot := tot || jsonb_build_object('ACIMA_DA_MEDIA', k);

  -- R6 FIM DE SEMANA (valor >= 1.000)
  k := 0;
  FOR r IN SELECT * FROM fin_extrato WHERE valor <= -1000 AND extract(isodow FROM data) IN (6,7) LOOP
    k := k + fin_novo_alerta('FDS:'||r.id, 'FIM_DE_SEMANA', 'baixo',
      'Saída de valor alto no fim de semana', jsonb_build_object('explicacao','Pagamento relevante em sábado/domingo.'),
      r.conta_id, r.id, NULL, r.valor);
  END LOOP;
  tot := tot || jsonb_build_object('FIM_DE_SEMANA', k);

  -- R7 IDA E VOLTA: entra e sai o mesmo valor em até 2 dias para contrapartes diferentes
  k := 0;
  FOR r IN
    SELECT s.*, en.id AS id_ent, en.contraparte AS de_quem FROM fin_extrato s
    JOIN fin_extrato en ON en.conta_id = s.conta_id AND en.valor = -s.valor AND en.valor >= 500
      AND s.data BETWEEN en.data AND en.data + 2
      AND coalesce(en.contraparte_norm,'') <> coalesce(s.contraparte_norm,'')
    WHERE s.valor < 0
  LOOP
    k := k + fin_novo_alerta('IDAVOLTA:'||r.id_ent||':'||r.id, 'IDA_E_VOLTA', 'baixo',
      'Entrou e saiu o mesmo valor em até 2 dias',
      jsonb_build_object('entrada_id', r.id_ent, 'entrada_de', r.de_quem,
        'explicacao','Dinheiro que entra e sai igual, pra outra pessoa. Confirme o motivo.'),
      r.conta_id, r.id, NULL, r.valor);
  END LOOP;
  tot := tot || jsonb_build_object('IDA_E_VOLTA', k);

  -- R8 LACUNA DE SALDO: saldo do banco não fecha com o extrato anterior + linhas do período
  k := 0;
  FOR r IN
    WITH imp AS (
      SELECT i.*, lag(i.saldo_final) OVER w AS saldo_ant, lag(i.saldo_data) OVER w AS data_ant, lag(i.id) OVER w AS id_ant
      FROM fin_importacoes i
      WHERE i.tipo = 'extrato' AND i.saldo_final IS NOT NULL AND i.saldo_data IS NOT NULL
      WINDOW w AS (PARTITION BY i.conta_id ORDER BY i.saldo_data, i.importado_em)
    )
    SELECT imp.*, (SELECT coalesce(sum(e.valor),0) FROM fin_extrato e
                   WHERE e.conta_id = imp.conta_id AND e.data > imp.data_ant AND e.data <= imp.saldo_data) AS mov
    FROM imp WHERE imp.saldo_ant IS NOT NULL AND imp.saldo_data > imp.data_ant
  LOOP
    IF abs(r.saldo_ant + r.mov - r.saldo_final) > 0.01 THEN
      k := k + fin_novo_alerta('SALDO:'||r.id, 'LACUNA_SALDO', 'critico',
        'Saldo não fecha: faltam ou sobram R$ '||to_char(abs(r.saldo_ant + r.mov - r.saldo_final),'FM999G999G990D00'),
        jsonb_build_object('saldo_anterior', r.saldo_ant, 'data_anterior', r.data_ant, 'movimento', r.mov,
          'saldo_esperado', r.saldo_ant + r.mov, 'saldo_banco', r.saldo_final, 'data', r.saldo_data,
          'diferenca', r.saldo_final - (r.saldo_ant + r.mov), 'importacao_anterior', r.id_ant,
          'explicacao', 'Saldo anterior + movimentações não bate com o saldo que o banco informou. '
                     || 'Pode ter linha faltando (removida do arquivo) ou um período sem extrato. '
                     || 'Exporte sempre dias completos.'),
        r.conta_id, NULL, NULL, r.saldo_final - (r.saldo_ant + r.mov));
    END IF;
  END LOOP;
  tot := tot || jsonb_build_object('LACUNA_SALDO', k);

  -- R9 CONTA PARADA: conta ativa sem extrato novo (esconder extrato é tática clássica)
  k := 0;
  FOR r IN
    SELECT c.id, c.nome, max(i.importado_em) AS ult FROM fin_contas c
    LEFT JOIN fin_importacoes i ON i.conta_id = c.id AND i.tipo = 'extrato'
    WHERE c.ativo GROUP BY c.id, c.nome
    HAVING max(i.importado_em) IS NOT NULL AND max(i.importado_em) < now() - make_interval(days => v_semimp::int)
  LOOP
    k := k + fin_novo_alerta('PARADA:'||r.id||':'||to_char(current_date,'IYYY-IW'), 'CONTA_SEM_EXTRATO', 'medio',
      'Conta '||r.nome||' sem extrato novo há '||(current_date - r.ult::date)||' dias',
      jsonb_build_object('ultimo_import', r.ult, 'explicacao','Importe o extrato desta conta.'),
      r.id, NULL, NULL, NULL);
  END LOOP;
  tot := tot || jsonb_build_object('CONTA_SEM_EXTRATO', k);

  -- R10 SAÍDA SEM CONFERÊNCIA depois de X dias
  k := 0;
  FOR r IN
    SELECT e.* FROM fin_extrato e
    WHERE e.valor < 0 AND e.data < current_date - v_dias::int
      AND NOT EXISTS (SELECT 1 FROM fin_conferencias c WHERE c.extrato_id = e.id)
  LOOP
    k := k + fin_novo_alerta('SEMCONF:'||r.id, 'SEM_CONFERENCIA', 'medio',
      'Saída sem conferência há mais de '||v_dias||' dias',
      jsonb_build_object('explicacao','Ninguém conferiu essa saída ainda.'), r.conta_id, r.id, NULL, r.valor);
  END LOOP;
  -- auto-fecha os que já foram conferidos
  UPDATE fin_alertas a SET status = 'resolvido', resolvido_por = 'sistema',
         justificativa = 'Resolvido automaticamente: a linha foi conferida.'
  WHERE a.regra = 'SEM_CONFERENCIA' AND a.status = 'aberto'
    AND EXISTS (SELECT 1 FROM fin_conferencias c WHERE c.extrato_id = a.extrato_id);
  tot := tot || jsonb_build_object('SEM_CONFERENCIA', k);

  -- R11/R12 LASTRO (só quando os lançamentos do Kamino estiverem entrando)
  IF fin_cfg_bool('exigir_lastro') THEN
    PERFORM fin_conciliar_auto(p_ator);
    k := 0;
    FOR r IN
      SELECT e.* FROM fin_extrato e
      WHERE e.valor <= -50 AND e.data < current_date - 3
        AND NOT EXISTS (SELECT 1 FROM fin_conciliacoes c WHERE c.extrato_id = e.id AND c.ativo)
    LOOP
      k := k + fin_novo_alerta('LASTRO:'||r.id, 'SAIDA_SEM_LANCAMENTO', 'alto',
        'Saída sem lançamento correspondente no Kamino',
        jsonb_build_object('explicacao','Dinheiro saiu do banco e não existe conta a pagar com esse valor/data.'),
        r.conta_id, r.id, NULL, r.valor);
    END LOOP;
    tot := tot || jsonb_build_object('SAIDA_SEM_LANCAMENTO', k);

    k := 0;
    FOR r IN
      SELECT l.* FROM fin_lancamentos l
      WHERE l.tipo = 'pagar' AND l.data_pagamento IS NOT NULL AND l.data_pagamento < current_date - 3
        AND NOT EXISTS (SELECT 1 FROM fin_conciliacoes c WHERE c.lancamento_id = l.id AND c.ativo)
    LOOP
      k := k + fin_novo_alerta('PAGOSEMSAIDA:'||r.id, 'PAGO_SEM_SAIDA', 'medio',
        'Lançamento marcado como pago sem saída no extrato: '||coalesce(r.pessoa,'?'),
        jsonb_build_object('explicacao','O Kamino diz que pagou, mas o extrato importado não mostra essa saída.'),
        NULL, NULL, r.id, -r.valor);
    END LOOP;
    tot := tot || jsonb_build_object('PAGO_SEM_SAIDA', k);
  END IF;

  RETURN tot;
END $$;

-- Conciliação automática: só casa quando existe UM ÚNICO candidato (nada de chute)
CREATE OR REPLACE FUNCTION fin_conciliar_auto(p_ator text) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE r record; n int := 0;
BEGIN
  PERFORM fin_set_ator(p_ator);
  FOR r IN
    SELECT e.id AS eid, (array_agg(l.id))[1] AS lid, count(*) AS qtd
    FROM fin_extrato e
    JOIN fin_lancamentos l ON l.valor = abs(e.valor)
      AND l.tipo = CASE WHEN e.valor < 0 THEN 'pagar' ELSE 'receber' END
      AND coalesce(l.data_pagamento, l.vencimento) BETWEEN e.data - 3 AND e.data + 3
      AND NOT EXISTS (SELECT 1 FROM fin_conciliacoes c WHERE c.lancamento_id = l.id AND c.ativo)
    WHERE NOT EXISTS (SELECT 1 FROM fin_conciliacoes c WHERE c.extrato_id = e.id AND c.ativo)
    GROUP BY e.id
    HAVING count(*) = 1
  LOOP
    BEGIN
      INSERT INTO fin_conciliacoes (extrato_id, lancamento_id, metodo, criado_por) VALUES (r.eid, r.lid, 'auto', p_ator);
      n := n + 1;
    EXCEPTION WHEN unique_violation THEN NULL;  -- outro extrato já pegou esse lançamento nesta rodada
    END;
  END LOOP;
  RETURN n;
END $$;

-- ------------------------------------------------------------
-- 6) RPCs DE ESCRITA (chamadas só pela função Netlify com a service key)
-- ------------------------------------------------------------

-- Importa extrato. p_linhas = [{data,valor,descricao,documento,contraparte,contraparte_doc,fitid,tipo_banco,hash}]
CREATE OR REPLACE FUNCTION fin_importar_extrato(p_ator text, p_conta uuid, p_meta jsonb, p_linhas jsonb)
RETURNS jsonb LANGUAGE plpgsql SET statement_timeout = '120s' AS $$
DECLARE
  v_conta fin_contas; v_imp uuid; v_novas int; v_total int; v_dup int; v_regras jsonb;
  v_cred numeric; v_deb numeric;
BEGIN
  PERFORM fin_set_ator(p_ator);
  PERFORM pg_advisory_xact_lock(hashtext('fin_import:'||p_conta::text));

  SELECT * INTO v_conta FROM fin_contas WHERE id = p_conta;
  IF NOT FOUND OR NOT v_conta.ativo THEN RAISE EXCEPTION 'Conta inválida ou inativa'; END IF;
  IF v_conta.formato IS NOT NULL AND v_conta.formato <> (p_meta->>'formato') AND coalesce((p_meta->>'forcar_formato')::boolean,false) = false THEN
    RAISE EXCEPTION 'Esta conta sempre foi importada em %, use o mesmo formato (trocar de formato pode duplicar linhas)', upper(v_conta.formato);
  END IF;
  IF EXISTS (SELECT 1 FROM fin_importacoes WHERE conta_id = p_conta AND tipo = 'extrato' AND arquivo_sha256 = p_meta->>'sha256') THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Este arquivo já foi importado nesta conta.');
  END IF;

  SELECT count(*), count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM fin_extrato e WHERE e.conta_id = p_conta AND e.hash = l->>'hash')),
         coalesce(sum((l->>'valor')::numeric) FILTER (WHERE (l->>'valor')::numeric > 0), 0),
         coalesce(sum((l->>'valor')::numeric) FILTER (WHERE (l->>'valor')::numeric < 0), 0)
    INTO v_total, v_novas, v_cred, v_deb
  FROM jsonb_array_elements(p_linhas) l;
  v_dup := v_total - v_novas;

  INSERT INTO fin_importacoes (conta_id, tipo, formato, arquivo_nome, arquivo_sha256, arquivo_bytes, conteudo,
     periodo_ini, periodo_fim, saldo_final, saldo_data, qtd_linhas, qtd_novas, qtd_duplicadas, soma_creditos, soma_debitos, importado_por)
  VALUES (p_conta, 'extrato', p_meta->>'formato', p_meta->>'arquivo_nome', p_meta->>'sha256', (p_meta->>'bytes')::int, p_meta->>'conteudo',
     (p_meta->>'periodo_ini')::date, (p_meta->>'periodo_fim')::date, (p_meta->>'saldo_final')::numeric, (p_meta->>'saldo_data')::date,
     v_total, v_novas, v_dup, v_cred, v_deb, p_ator)
  RETURNING id INTO v_imp;

  INSERT INTO fin_extrato (conta_id, data, valor, descricao, documento, contraparte, contraparte_doc, contraparte_norm, fitid, tipo_banco, hash, importacao_id)
  SELECT p_conta, (l->>'data')::date, (l->>'valor')::numeric, l->>'descricao', nullif(l->>'documento',''),
         nullif(l->>'contraparte',''), nullif(l->>'contraparte_doc',''), fin_norm(l->>'contraparte'),
         nullif(l->>'fitid',''), nullif(l->>'tipo_banco',''), l->>'hash', v_imp
  FROM jsonb_array_elements(p_linhas) l
  ON CONFLICT (conta_id, hash) DO NOTHING;

  IF v_conta.formato IS NULL THEN
    UPDATE fin_contas SET formato = p_meta->>'formato', atualizado_por = p_ator, atualizado_em = now() WHERE id = p_conta;
  END IF;

  v_regras := fin_rodar_regras(p_ator);
  RETURN jsonb_build_object('ok', true, 'importacao_id', v_imp, 'linhas', v_total, 'novas', v_novas, 'duplicadas', v_dup, 'alertas_novos', v_regras);
END $$;

-- Importa lançamentos (Kamino CSV/API). Upsert por (origem, chave); mudanças ficam auditadas.
CREATE OR REPLACE FUNCTION fin_importar_lancamentos(p_ator text, p_meta jsonb, p_linhas jsonb)
RETURNS jsonb LANGUAGE plpgsql SET statement_timeout = '120s' AS $$
DECLARE v_imp uuid; v_total int; v_novas int; v_origem text := coalesce(p_meta->>'origem','kamino_csv');
BEGIN
  PERFORM fin_set_ator(p_ator);
  PERFORM pg_advisory_xact_lock(hashtext('fin_import_lanc'));
  IF EXISTS (SELECT 1 FROM fin_importacoes WHERE conta_id IS NULL AND tipo = 'lancamentos' AND arquivo_sha256 = p_meta->>'sha256') THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Este arquivo de lançamentos já foi importado.');
  END IF;
  SELECT count(*), count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM fin_lancamentos x WHERE x.origem = v_origem AND x.chave = l->>'chave'))
    INTO v_total, v_novas FROM jsonb_array_elements(p_linhas) l;

  INSERT INTO fin_importacoes (conta_id, tipo, formato, arquivo_nome, arquivo_sha256, arquivo_bytes, conteudo,
     periodo_ini, periodo_fim, qtd_linhas, qtd_novas, qtd_duplicadas, importado_por)
  VALUES (NULL, 'lancamentos', p_meta->>'formato', p_meta->>'arquivo_nome', p_meta->>'sha256', (p_meta->>'bytes')::int, p_meta->>'conteudo',
     (p_meta->>'periodo_ini')::date, (p_meta->>'periodo_fim')::date, v_total, v_novas, v_total - v_novas, p_ator)
  RETURNING id INTO v_imp;

  INSERT INTO fin_lancamentos (origem, chave, tipo, pessoa, pessoa_doc, pessoa_norm, descricao, categoria, unidade, conta_nome,
                               valor, vencimento, data_pagamento, situacao, importacao_id, raw)
  SELECT v_origem, l->>'chave', l->>'tipo', nullif(l->>'pessoa',''), nullif(l->>'pessoa_doc',''), fin_norm(l->>'pessoa'),
         nullif(l->>'descricao',''), nullif(l->>'categoria',''), nullif(l->>'unidade',''), nullif(l->>'conta_nome',''),
         (l->>'valor')::numeric, nullif(l->>'vencimento','')::date, nullif(l->>'data_pagamento','')::date,
         nullif(l->>'situacao',''), v_imp, l->'raw'
  FROM jsonb_array_elements(p_linhas) l
  ON CONFLICT (origem, chave) DO UPDATE SET
    pessoa = EXCLUDED.pessoa, pessoa_doc = EXCLUDED.pessoa_doc, pessoa_norm = EXCLUDED.pessoa_norm,
    descricao = EXCLUDED.descricao, categoria = EXCLUDED.categoria, unidade = EXCLUDED.unidade, conta_nome = EXCLUDED.conta_nome,
    valor = EXCLUDED.valor, vencimento = EXCLUDED.vencimento, data_pagamento = EXCLUDED.data_pagamento,
    situacao = EXCLUDED.situacao, importacao_id = EXCLUDED.importacao_id, raw = EXCLUDED.raw
  WHERE (fin_lancamentos.valor, fin_lancamentos.vencimento, fin_lancamentos.data_pagamento, fin_lancamentos.situacao, fin_lancamentos.pessoa)
        IS DISTINCT FROM (EXCLUDED.valor, EXCLUDED.vencimento, EXCLUDED.data_pagamento, EXCLUDED.situacao, EXCLUDED.pessoa);

  RETURN jsonb_build_object('ok', true, 'importacao_id', v_imp, 'linhas', v_total, 'novas', v_novas,
                            'conciliadas', fin_conciliar_auto(p_ator), 'alertas_novos', fin_rodar_regras(p_ator));
END $$;

CREATE OR REPLACE FUNCTION fin_conferir(p_ator text, p_extrato bigint, p_status text, p_categoria text,
                                        p_obs text, p_ref text, p_idem text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_id bigint; e fin_extrato;
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF p_idem IS NOT NULL AND EXISTS (SELECT 1 FROM fin_conferencias WHERE idem_key = p_idem) THEN
    RETURN jsonb_build_object('ok', true, 'repetido', true);  -- clique duplo / reenvio: não grava 2x
  END IF;
  SELECT * INTO e FROM fin_extrato WHERE id = p_extrato;
  IF NOT FOUND THEN RAISE EXCEPTION 'Linha do extrato não encontrada'; END IF;

  INSERT INTO fin_conferencias (extrato_id, status, categoria, observacao, referencia, conferido_por, idem_key)
  VALUES (p_extrato, p_status, nullif(btrim(p_categoria),''), nullif(btrim(p_obs),''), nullif(btrim(p_ref),''), p_ator, p_idem)
  RETURNING id INTO v_id;

  IF p_status IN ('suspeito','divergente') THEN
    PERFORM fin_novo_alerta('CONF:'||v_id, CASE WHEN p_status='suspeito' THEN 'CONF_SUSPEITO' ELSE 'CONF_DIVERGENTE' END,
      CASE WHEN p_status='suspeito' THEN 'alto' ELSE 'medio' END,
      CASE WHEN p_status='suspeito' THEN 'Conferente marcou como SUSPEITO' ELSE 'Conferente marcou como DIVERGENTE' END,
      jsonb_build_object('observacao', p_obs, 'conferido_por', p_ator), e.conta_id, e.id, NULL, e.valor);
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

CREATE OR REPLACE FUNCTION fin_resolver_alerta(p_ator text, p_id bigint, p_status text, p_just text, p_eh_super boolean)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a fin_alertas;
BEGIN
  PERFORM fin_set_ator(p_ator);
  SELECT * INTO a FROM fin_alertas WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Alerta não encontrado'; END IF;
  IF a.status <> 'aberto' THEN RAISE EXCEPTION 'Alerta já foi resolvido'; END IF;
  IF a.severidade = 'critico' AND NOT p_eh_super THEN RAISE EXCEPTION 'Alerta CRÍTICO só o super admin resolve'; END IF;
  IF a.regra IN ('CONF_SUSPEITO','CONF_DIVERGENTE') AND a.detalhe->>'conferido_por' = p_ator AND NOT p_eh_super THEN
    RAISE EXCEPTION 'Quem marcou a linha não pode resolver o próprio alerta (segregação de funções)';
  END IF;
  UPDATE fin_alertas SET status = p_status, resolvido_por = p_ator, justificativa = p_just WHERE id = p_id;
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION fin_salvar_conta(p_ator text, p_id uuid, p_dados jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF p_id IS NULL THEN
    INSERT INTO fin_contas (nome, banco, agencia, numero, cidade_slug, unidade, criado_por)
    VALUES (p_dados->>'nome', p_dados->>'banco', p_dados->>'agencia', p_dados->>'numero',
            nullif(p_dados->>'cidade_slug',''), nullif(p_dados->>'unidade',''), p_ator)
    RETURNING id INTO v_id;
  ELSE
    UPDATE fin_contas SET nome = p_dados->>'nome', banco = p_dados->>'banco', agencia = p_dados->>'agencia',
           numero = p_dados->>'numero', cidade_slug = nullif(p_dados->>'cidade_slug',''), unidade = nullif(p_dados->>'unidade',''),
           ativo = coalesce((p_dados->>'ativo')::boolean, ativo), atualizado_por = p_ator, atualizado_em = now()
    WHERE id = p_id RETURNING id INTO v_id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

CREATE OR REPLACE FUNCTION fin_salvar_acesso(p_ator text, p_pessoa text, p_papel text, p_ativo boolean)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fin_set_ator(p_ator);
  INSERT INTO fin_acesso (pessoa_id, papel, ativo, criado_por) VALUES (p_pessoa, p_papel, p_ativo, p_ator)
  ON CONFLICT (pessoa_id) DO UPDATE SET papel = EXCLUDED.papel, ativo = EXCLUDED.ativo, atualizado_por = p_ator, atualizado_em = now();
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION fin_salvar_config(p_ator text, p_chave text, p_valor jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fin_set_ator(p_ator);
  UPDATE fin_config SET valor = p_valor, atualizado_por = p_ator, atualizado_em = now() WHERE chave = p_chave;
  IF NOT FOUND THEN RAISE EXCEPTION 'Configuração desconhecida'; END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION fin_benef_confiar(p_ator text, p_nome text, p_motivo text)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF fin_norm(p_nome) IS NULL THEN RAISE EXCEPTION 'Nome inválido'; END IF;
  INSERT INTO fin_benef_confiaveis (contraparte_norm, nome_exibicao, motivo, aprovado_por)
  VALUES (fin_norm(p_nome), p_nome, p_motivo, p_ator);
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('ok', false, 'erro', 'Esse favorecido já está na lista de confiáveis');
END $$;

CREATE OR REPLACE FUNCTION fin_benef_revogar(p_ator text, p_id bigint)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fin_set_ator(p_ator);
  UPDATE fin_benef_confiaveis SET ativo = false, desativado_por = p_ator WHERE id = p_id AND ativo;
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION fin_conciliar_manual(p_ator text, p_extrato bigint, p_lanc bigint)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fin_set_ator(p_ator);
  INSERT INTO fin_conciliacoes (extrato_id, lancamento_id, metodo, criado_por) VALUES (p_extrato, p_lanc, 'manual', p_ator);
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('ok', false, 'erro', 'Essa linha ou esse lançamento já está conciliado. Desfaça antes.');
END $$;

CREATE OR REPLACE FUNCTION fin_desfazer_conciliacao(p_ator text, p_extrato bigint, p_motivo text)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fin_set_ator(p_ator);
  UPDATE fin_conciliacoes SET ativo = false, desfeito_por = p_ator, motivo_desfazer = p_motivo WHERE extrato_id = p_extrato AND ativo;
  RETURN jsonb_build_object('ok', true);
END $$;

-- ------------------------------------------------------------
-- 7) LEITURA AGREGADA E INTEGRIDADE
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_resumo(p_ini date, p_fim date) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'contas', coalesce((SELECT jsonb_agg(x ORDER BY x->>'nome') FROM (
       SELECT jsonb_build_object('id', c.id, 'nome', c.nome, 'banco', c.banco, 'cidade_slug', c.cidade_slug, 'ativo', c.ativo,
         'formato', c.formato,
         'saldo_banco', (SELECT i.saldo_final FROM fin_importacoes i WHERE i.conta_id = c.id AND i.tipo='extrato' AND i.saldo_final IS NOT NULL ORDER BY i.saldo_data DESC, i.importado_em DESC LIMIT 1),
         'saldo_data',  (SELECT i.saldo_data  FROM fin_importacoes i WHERE i.conta_id = c.id AND i.tipo='extrato' AND i.saldo_final IS NOT NULL ORDER BY i.saldo_data DESC, i.importado_em DESC LIMIT 1),
         'ultimo_import', (SELECT max(i.importado_em) FROM fin_importacoes i WHERE i.conta_id = c.id AND i.tipo='extrato'),
         'ultima_linha', (SELECT max(e.data) FROM fin_extrato e WHERE e.conta_id = c.id),
         'entradas', (SELECT coalesce(sum(e.valor),0) FROM fin_extrato e WHERE e.conta_id = c.id AND e.valor > 0 AND e.data BETWEEN p_ini AND p_fim),
         'saidas',   (SELECT coalesce(sum(e.valor),0) FROM fin_extrato e WHERE e.conta_id = c.id AND e.valor < 0 AND e.data BETWEEN p_ini AND p_fim)
       ) AS x FROM fin_contas c) s), '[]'::jsonb),
    'status', coalesce((SELECT jsonb_object_agg(status, jsonb_build_object('qtd', qtd, 'valor', valor)) FROM (
       SELECT status, count(*) AS qtd, sum(abs(valor)) AS valor FROM fin_v_extrato WHERE data BETWEEN p_ini AND p_fim GROUP BY status) s), '{}'::jsonb),
    'alertas', coalesce((SELECT jsonb_object_agg(severidade, qtd) FROM (
       SELECT severidade, count(*) AS qtd FROM fin_alertas WHERE status = 'aberto' GROUP BY severidade) s), '{}'::jsonb),
    'categorias', coalesce((SELECT jsonb_agg(jsonb_build_object('categoria', categoria, 'entradas', ent, 'saidas', sai) ORDER BY sai) FROM (
       SELECT coalesce(categoria,'(sem categoria)') AS categoria, sum(valor) FILTER (WHERE valor > 0) AS ent, sum(valor) FILTER (WHERE valor < 0) AS sai
       FROM fin_v_extrato WHERE data BETWEEN p_ini AND p_fim GROUP BY 1) s), '[]'::jsonb),
    'por_dia', coalesce((SELECT jsonb_agg(jsonb_build_object('dia', data, 'entradas', ent, 'saidas', sai) ORDER BY data) FROM (
       SELECT data, sum(valor) FILTER (WHERE valor > 0) AS ent, sum(valor) FILTER (WHERE valor < 0) AS sai
       FROM fin_extrato WHERE data BETWEEN p_ini AND p_fim GROUP BY data) s), '[]'::jsonb),
    'auditoria_total', (SELECT count(*) FROM fin_auditoria)
  )
$$;

-- Recalcula a cadeia inteira. Se alguém mexeu no banco por fora, aponta onde quebrou.
CREATE OR REPLACE FUNCTION fin_verificar_cadeia() RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = public, extensions SET statement_timeout = '120s' AS $$
DECLARE r record; v_prev text := 'GENESIS'; v_calc text; v_n bigint := 0; v_esperado bigint := 0;
BEGIN
  FOR r IN SELECT * FROM fin_auditoria ORDER BY seq LOOP
    v_n := v_n + 1; v_esperado := v_esperado + 1;
    IF r.seq <> v_esperado THEN
      RETURN jsonb_build_object('ok', false, 'total', v_n, 'quebra_seq', r.seq, 'motivo', 'Registro faltando antes deste (sequência pulou)');
    END IF;
    IF r.hash_anterior <> v_prev THEN
      RETURN jsonb_build_object('ok', false, 'total', v_n, 'quebra_seq', r.seq, 'motivo', 'Elo com o registro anterior não confere');
    END IF;
    v_calc := encode(extensions.digest(
      r.hash_anterior || '|' || r.seq || '|' || extract(epoch FROM r.ts)::text || '|' || r.ator || '|' ||
      r.acao || '|' || r.tabela || '|' || coalesce(r.registro_id,'') || '|' ||
      coalesce(r.antes::text,'') || '|' || coalesce(r.depois::text,''), 'sha256'), 'hex');
    IF v_calc <> r.hash THEN
      RETURN jsonb_build_object('ok', false, 'total', v_n, 'quebra_seq', r.seq, 'motivo', 'Conteúdo do registro foi alterado');
    END IF;
    v_prev := r.hash;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'total', v_n, 'ultimo_hash', v_prev);
END $$;

-- ------------------------------------------------------------
-- 8) TRAVA DAS FUNÇÕES: ninguém além da service key executa
-- ------------------------------------------------------------
DO $do$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname LIKE 'fin\_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $do$;

-- ------------------------------------------------------------
-- 9) BACKUP: bucket PRIVADO pros snapshots diários (função financeiro-backup)
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public) VALUES ('fin-backups', 'fin-backups', false)
ON CONFLICT (id) DO UPDATE SET public = false;
-- sem policy nenhuma em storage.objects pra esse bucket = só service key lê/grava

-- ------------------------------------------------------------
-- 10) ROTINA DIÁRIA: roda as regras de tempo (sem conferência, conta parada) às 09:00 UTC
-- ------------------------------------------------------------
DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'fin_regras_diarias';
  PERFORM cron.schedule('fin_regras_diarias', '0 9 * * *', $c$SELECT fin_rodar_regras('sistema:cron')$c$);
EXCEPTION WHEN undefined_table OR invalid_schema_name THEN
  RAISE NOTICE 'pg_cron indisponível: as regras rodam a cada importação';
END $do$;

-- ------------------------------------------------------------
-- TESTE RÁPIDO (rodar depois; deve dar ERRO nas duas primeiras = blindagem ok)
--   DELETE FROM fin_auditoria;                       -> ERRO "exclusão proibida"
--   UPDATE fin_extrato SET valor = 1;                -> ERRO "imutável"
--   SELECT fin_verificar_cadeia();                   -> {"ok": true, ...}
-- ------------------------------------------------------------
