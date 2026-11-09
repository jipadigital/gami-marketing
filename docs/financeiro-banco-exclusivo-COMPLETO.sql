-- ============================================================
-- BANCO EXCLUSIVO DO FINANCEIRO GÂMI: SETUP COMPLETO (v1 + v2 + v3 FLYP) num projeto Supabase NOVO.
-- Gerado de docs/financeiro-schema.sql + docs/financeiro-v2-kamino.sql + docs/financeiro-v3-flyp.sql. Rode INTEIRO no SQL Editor.
-- Pode rodar de novo sem risco (idempotente).
-- ============================================================

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
-- pg_cron (rotina diária das regras). Num projeto Supabase novo, cria aqui; se não der, ative em Database > Extensions.
DO $$ BEGIN CREATE EXTENSION IF NOT EXISTS pg_cron; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pg_cron: ative em Database > Extensions'; END $$;

-- Nomes da equipe (só o nome, nada mais) pra regra "pagamento pra alguém da equipe".
-- Quem preenche é a função financeiro.js, copiando da tabela pessoas do dashboard.
CREATE TABLE IF NOT EXISTS fin_equipe (
  pessoa_id     text PRIMARY KEY,
  nome          text NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE fin_equipe ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON fin_equipe FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON fin_equipe TO service_role;

CREATE OR REPLACE FUNCTION fin_sincronizar_equipe(p_lista jsonb) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  IF jsonb_typeof(p_lista) <> 'array' OR jsonb_array_length(p_lista) = 0 THEN RETURN 0; END IF;  -- lista vazia nunca apaga a equipe
  INSERT INTO fin_equipe (pessoa_id, nome)
  SELECT x->>'id', x->>'nome' FROM jsonb_array_elements(p_lista) x WHERE coalesce(x->>'id','') <> '' AND coalesce(x->>'nome','') <> ''
  ON CONFLICT (pessoa_id) DO UPDATE SET nome = EXCLUDED.nome, atualizado_em = now() WHERE fin_equipe.nome IS DISTINCT FROM EXCLUDED.nome;
  DELETE FROM fin_equipe WHERE pessoa_id NOT IN (SELECT x->>'id' FROM jsonb_array_elements(p_lista) x);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

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

-- Auditoria: grava antes/depois de TODA escrita, com o ator da transação.
-- (mesma função do financeiro-v3-flyp.sql: das tabelas da FLYP guarda só a impressão digital,
--  sem nomes nem valores; rodar este arquivo de novo NÃO pode desfazer essa blindagem)
CREATE OR REPLACE FUNCTION fin_trg_audit() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, extensions AS $$
DECLARE v_antes jsonb; v_depois jsonb; v_id text;
BEGIN
  IF TG_OP = 'UPDATE' THEN v_antes := to_jsonb(OLD); END IF;
  v_depois := to_jsonb(NEW);
  IF TG_TABLE_NAME IN ('fin_importacoes','fin_flyp_importacoes') THEN
    v_depois := v_depois - 'conteudo';
    IF v_antes IS NOT NULL THEN v_antes := v_antes - 'conteudo'; END IF;
  END IF;
  IF TG_TABLE_NAME IN ('fin_flyp_transacoes','fin_flyp_leituras') THEN
    v_depois := jsonb_build_object('id', v_depois->'id', 'status', v_depois->'status',
                  'impressao', encode(extensions.digest(to_jsonb(NEW)::text, 'sha256'), 'hex'));
    IF v_antes IS NOT NULL THEN
      v_antes := jsonb_build_object('id', v_antes->'id', 'status', v_antes->'status',
                  'impressao', encode(extensions.digest(to_jsonb(OLD)::text, 'sha256'), 'hex'));
    END IF;
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

  -- R4 FAVORECIDO É DA EQUIPE: pagamento pra nome igual ao de alguém da equipe
  -- (fin_equipe = cópia só dos NOMES da tabela pessoas do dashboard, sincronizada pela função
  --  financeiro.js; assim funciona igual com o financeiro num banco separado)
  k := 0;
  FOR r IN
    SELECT DISTINCT ON (e.id) e.*, p.nome AS pessoa_nome
    FROM fin_extrato e
    JOIN fin_equipe p ON fin_norm(p.nome) IS NOT NULL AND length(fin_norm(p.nome)) >= 8
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

-- ============================================================
-- MÓDULO FINANCEIRO GÂMI v2 — RÉPLICA DO KAMINO (09/11/2026)
-- Rodar DEPOIS de docs/financeiro-schema.sql. Idempotente (pode rodar de novo).
-- ------------------------------------------------------------
-- Acrescenta: Pessoas, Plano de contas, Unidades de negócio, Centros de custo,
-- Contas a pagar/receber completas (forma, competência, parcelamento, rateio,
-- composição de valores, fiscal), Baixas (com estorno), Transferências,
-- Regras de extrato, Caixa de entrada (documentos), Anexos e os relatórios
-- (Painel, DRE, Fluxo diário, Fluxo mensal, Resultado, Dashboard de cobranças).
-- Mesma blindagem da v1: sem DELETE, auditoria encadeada, RLS + REVOKE,
-- escrita só por RPC com o ator carimbado.
-- ============================================================

-- ------------------------------------------------------------
-- 1) CADASTROS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fin_unidades (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nome        text NOT NULL,
  cidade_slug text,
  cnpj        text,
  ativo       boolean NOT NULL DEFAULT true,
  criado_por  text NOT NULL DEFAULT 'sistema',
  criado_em   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_unidades_nome_uk ON fin_unidades (lower(nome));

CREATE TABLE IF NOT EXISTS fin_centros_custo (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nome       text NOT NULL,
  ativo      boolean NOT NULL DEFAULT true,
  criado_por text NOT NULL DEFAULT 'sistema',
  criado_em  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_cc_nome_uk ON fin_centros_custo (lower(nome));

-- Plano de contas (classificações). grupo = receita|despesa|aporte|retirada|transferencia
-- dre_linha decide onde cai no DRE gerencial.
CREATE TABLE IF NOT EXISTS fin_classificacoes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  grupo      text NOT NULL CHECK (grupo IN ('receita','despesa','aporte','retirada','transferencia')),
  subgrupo   text,
  nome       text NOT NULL,
  codigo     text,
  dre_linha  text NOT NULL CHECK (dre_linha IN ('receita_bruta','retencoes','impostos_venda','descontos','outras_receitas',
               'despesas_comerciais','despesas_operacionais','impostos_renda','aportes','retiradas','fora_dre')),
  ordem      int NOT NULL DEFAULT 100,
  ativo      boolean NOT NULL DEFAULT true,
  criado_por text NOT NULL DEFAULT 'sistema',
  criado_em  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_class_uk ON fin_classificacoes (grupo, lower(coalesce(subgrupo,'')), lower(nome));

CREATE TABLE IF NOT EXISTS fin_pessoas (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  documento     text,                      -- CPF/CNPJ só dígitos
  estrangeira   boolean NOT NULL DEFAULT false,
  nome          text NOT NULL,             -- nome amigável
  nome_norm     text,
  razao_social  text,
  fantasia      text,
  ie            text,
  im            text,
  cliente       boolean NOT NULL DEFAULT false,
  fornecedor    boolean NOT NULL DEFAULT false,
  cep text, logradouro text, numero text, complemento text, bairro text, cidade text, uf text,
  telefone      text,
  email         text,
  pix_tipo      text,
  pix_chave     text,
  banco         text,
  agencia       text,
  conta         text,
  observacoes   text,
  ativo         boolean NOT NULL DEFAULT true,
  criado_por    text NOT NULL,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_por text,
  atualizado_em timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_pessoas_doc_uk ON fin_pessoas (documento) WHERE documento IS NOT NULL AND documento <> '';
CREATE INDEX IF NOT EXISTS fin_pessoas_norm ON fin_pessoas (nome_norm);

ALTER TABLE fin_contas ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'corrente';
ALTER TABLE fin_contas ADD COLUMN IF NOT EXISTS saldo_inicial numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE fin_contas ADD COLUMN IF NOT EXISTS saldo_inicial_data date;
ALTER TABLE fin_contas ADD COLUMN IF NOT EXISTS unidade_id bigint REFERENCES fin_unidades(id);

-- ------------------------------------------------------------
-- 2) CONTAS A PAGAR / RECEBER (fin_lancamentos ganha tudo do Kamino)
-- ------------------------------------------------------------
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS pessoa_id bigint REFERENCES fin_pessoas(id);
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS classificacao_id bigint REFERENCES fin_classificacoes(id);
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS centro_custo_id bigint REFERENCES fin_centros_custo(id);
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS unidade_id bigint REFERENCES fin_unidades(id);
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS conta_id uuid REFERENCES fin_contas(id);
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS forma text;               -- boleto|ted|pix|outros|manual|pix_conta
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS competencia date;
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS juros numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS multa numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS desconto numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS retencao numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS retencao_tipo text;
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS nf_numero text;
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS codigo_barras text;
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS pix_copia_cola text;
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS observacao text;
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS grupo_parcela uuid;
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS parcela_num int;
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS parcela_total int;
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pendente';
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS rateio jsonb;              -- [{"unidade_id":1,"pct":31.5},...]
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS criado_por text;
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS atualizado_por text;
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS cancelado_por text;
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS cancelado_em timestamptz;
ALTER TABLE fin_lancamentos ADD COLUMN IF NOT EXISTS motivo_cancelamento text;
DO $$ BEGIN
  ALTER TABLE fin_lancamentos ADD CONSTRAINT fin_lanc_status_ck CHECK (status IN ('pendente','pago','cancelado'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS fin_lanc_venc ON fin_lancamentos (tipo, status, vencimento);
CREATE INDEX IF NOT EXISTS fin_lanc_pag ON fin_lancamentos (tipo, data_pagamento);
CREATE INDEX IF NOT EXISTS fin_lanc_pessoa ON fin_lancamentos (pessoa_id);

-- Baixas (pagamento/recebimento registrado). Só pode ser ESTORNADA, nunca apagada.
CREATE TABLE IF NOT EXISTS fin_baixas (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lancamento_id  bigint NOT NULL REFERENCES fin_lancamentos(id),
  data           date NOT NULL,
  conta_id       uuid NOT NULL REFERENCES fin_contas(id),
  valor          numeric(14,2) NOT NULL CHECK (valor > 0),
  juros          numeric(14,2) NOT NULL DEFAULT 0,
  multa          numeric(14,2) NOT NULL DEFAULT 0,
  desconto       numeric(14,2) NOT NULL DEFAULT 0,
  extrato_id     bigint REFERENCES fin_extrato(id),
  origem         text NOT NULL CHECK (origem IN ('manual','conciliacao')),
  observacao     text,
  por            text NOT NULL,
  em             timestamptz NOT NULL DEFAULT now(),
  estornada      boolean NOT NULL DEFAULT false,
  estornada_por  text,
  estornada_em   timestamptz,
  motivo_estorno text
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_baixa_ativa_uk ON fin_baixas (lancamento_id) WHERE NOT estornada;

CREATE TABLE IF NOT EXISTS fin_transferencias (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  data             date NOT NULL,
  conta_origem_id  uuid NOT NULL REFERENCES fin_contas(id),
  conta_destino_id uuid NOT NULL REFERENCES fin_contas(id),
  valor            numeric(14,2) NOT NULL CHECK (valor > 0),
  descricao        text,
  por              text NOT NULL,
  em               timestamptz NOT NULL DEFAULT now(),
  cancelada        boolean NOT NULL DEFAULT false,
  cancelada_por    text,
  cancelada_em     timestamptz,
  motivo_cancelamento text,
  CHECK (conta_origem_id <> conta_destino_id)
);

-- Conciliação passa a aceitar transferência no lugar de lançamento
ALTER TABLE fin_conciliacoes ALTER COLUMN lancamento_id DROP NOT NULL;
ALTER TABLE fin_conciliacoes ADD COLUMN IF NOT EXISTS transferencia_id bigint REFERENCES fin_transferencias(id);
DO $$ BEGIN
  ALTER TABLE fin_conciliacoes ADD CONSTRAINT fin_conc_alvo_ck CHECK (num_nonnulls(lancamento_id, transferencia_id) = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS fin_regras_extrato (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  descricao        text NOT NULL,
  texto_busca      text NOT NULL,
  conta_id         uuid REFERENCES fin_contas(id),
  pessoa_id        bigint REFERENCES fin_pessoas(id),
  classificacao_id bigint REFERENCES fin_classificacoes(id),
  centro_custo_id  bigint REFERENCES fin_centros_custo(id),
  unidade_id       bigint REFERENCES fin_unidades(id),
  transferencia_conta_id uuid REFERENCES fin_contas(id),
  ativo            boolean NOT NULL DEFAULT true,
  criado_por       text NOT NULL,
  criado_em        timestamptz NOT NULL DEFAULT now(),
  atualizado_por   text,
  atualizado_em    timestamptz
);

CREATE TABLE IF NOT EXISTS fin_anexos (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lancamento_id bigint REFERENCES fin_lancamentos(id),
  entrada_id    bigint,
  nome          text NOT NULL,
  caminho       text NOT NULL UNIQUE,      -- no bucket privado fin-anexos
  mime          text,
  bytes         int,
  sha256        text,
  por           text NOT NULL,
  em            timestamptz NOT NULL DEFAULT now()
);

-- Caixa de entrada: boleto/NF que chegou e ainda não virou conta a pagar
CREATE TABLE IF NOT EXISTS fin_entradas (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  beneficiario   text,
  documento      text,
  vencimento     date,
  valor          numeric(14,2),
  linha_digitavel text,
  observacao     text,
  status         text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','nao_identificado','lancado','arquivado')),
  lancamento_id  bigint REFERENCES fin_lancamentos(id),
  por            text NOT NULL,
  em             timestamptz NOT NULL DEFAULT now(),
  atualizado_por text,
  atualizado_em  timestamptz,
  motivo_arquivo text
);

-- ------------------------------------------------------------
-- 3) BLINDAGEM nas tabelas novas (mesmo padrão da v1)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_trg_baixa_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.estornada OR NOT NEW.estornada OR NEW.lancamento_id <> OLD.lancamento_id OR NEW.valor <> OLD.valor
     OR NEW.data <> OLD.data OR NEW.conta_id <> OLD.conta_id OR NEW.por <> OLD.por THEN
    RAISE EXCEPTION 'FINANCEIRO: baixa só pode ser estornada';
  END IF;
  IF NEW.estornada_por IS NULL OR length(btrim(coalesce(NEW.motivo_estorno,''))) < 10 THEN
    RAISE EXCEPTION 'FINANCEIRO: estorno exige quem e motivo (mín. 10 caracteres)';
  END IF;
  NEW.estornada_em := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION fin_trg_transf_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.cancelada OR NOT NEW.cancelada OR NEW.valor <> OLD.valor OR NEW.data <> OLD.data
     OR NEW.conta_origem_id <> OLD.conta_origem_id OR NEW.conta_destino_id <> OLD.conta_destino_id THEN
    RAISE EXCEPTION 'FINANCEIRO: transferência só pode ser cancelada';
  END IF;
  IF NEW.cancelada_por IS NULL OR length(btrim(coalesce(NEW.motivo_cancelamento,''))) < 10 THEN
    RAISE EXCEPTION 'FINANCEIRO: cancelamento exige motivo (mín. 10 caracteres)';
  END IF;
  NEW.cancelada_em := now();
  RETURN NEW;
END $$;

-- Lançamento: pago e cancelado ficam congelados. Pra mexer num pago, estorna a baixa antes.
CREATE OR REPLACE FUNCTION fin_trg_lanc_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.origem <> OLD.origem OR NEW.chave <> OLD.chave OR NEW.tipo <> OLD.tipo OR NEW.criado_em <> OLD.criado_em THEN
    RAISE EXCEPTION 'FINANCEIRO: identidade do lançamento não pode mudar';
  END IF;
  -- espelho do Kamino (kamino_csv/kamino_api): o Kamino é a fonte, então aceita a atualização (fica auditada)
  IF OLD.origem <> 'manual' THEN NEW.atualizado_em := now(); RETURN NEW; END IF;
  IF OLD.status = 'cancelado' THEN
    RAISE EXCEPTION 'FINANCEIRO: lançamento cancelado não pode ser alterado';
  END IF;
  IF OLD.status = 'pago' AND NEW.status = 'pago' AND (
       NEW.valor IS DISTINCT FROM OLD.valor OR NEW.pessoa_id IS DISTINCT FROM OLD.pessoa_id
       OR NEW.juros IS DISTINCT FROM OLD.juros OR NEW.multa IS DISTINCT FROM OLD.multa OR NEW.desconto IS DISTINCT FROM OLD.desconto
       OR NEW.data_pagamento IS DISTINCT FROM OLD.data_pagamento OR NEW.pix_copia_cola IS DISTINCT FROM OLD.pix_copia_cola
       OR NEW.codigo_barras IS DISTINCT FROM OLD.codigo_barras) THEN
    RAISE EXCEPTION 'FINANCEIRO: lançamento já pago, estorne a baixa antes de alterar valor, pessoa ou data';
  END IF;
  IF NEW.status = 'cancelado' AND (NEW.cancelado_por IS NULL OR length(btrim(coalesce(NEW.motivo_cancelamento,''))) < 10) THEN
    RAISE EXCEPTION 'FINANCEIRO: cancelamento exige motivo (mín. 10 caracteres)';
  END IF;
  NEW.atualizado_em := now();
  RETURN NEW;
END $$;

-- Pessoa: mudar dado bancário/pix vira alerta (golpe clássico: troca a chave do fornecedor)
CREATE OR REPLACE FUNCTION fin_trg_pessoa_banco() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.pix_chave, OLD.banco, OLD.agencia, OLD.conta) IS DISTINCT FROM (NEW.pix_chave, NEW.banco, NEW.agencia, NEW.conta)
     AND coalesce(OLD.pix_chave, OLD.conta, '') <> '' THEN
    PERFORM fin_novo_alerta('BANCO:'||NEW.id||':'||extract(epoch FROM clock_timestamp())::bigint, 'DADOS_BANCARIOS_ALTERADOS', 'alto',
      'Dados bancários/Pix alterados: '||NEW.nome,
      jsonb_build_object('antes', jsonb_build_object('pix', OLD.pix_chave, 'banco', OLD.banco, 'agencia', OLD.agencia, 'conta', OLD.conta),
                         'depois', jsonb_build_object('pix', NEW.pix_chave, 'banco', NEW.banco, 'agencia', NEW.agencia, 'conta', NEW.conta),
                         'alterado_por', current_setting('fin.ator', true),
                         'explicacao', 'Trocar a chave Pix/conta de um fornecedor é o golpe mais comum. Confirme por telefone com o fornecedor.'),
      NULL, NULL, NULL, NULL);
  END IF;
  NEW.nome_norm := fin_norm(NEW.nome);
  NEW.atualizado_em := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION fin_trg_pessoa_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.nome_norm := fin_norm(NEW.nome); RETURN NEW; END $$;

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fin_unidades','fin_centros_custo','fin_classificacoes','fin_pessoas','fin_baixas','fin_transferencias',
                           'fin_regras_extrato','fin_anexos','fin_entradas'] LOOP
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
END $do$;
REVOKE UPDATE ON fin_anexos FROM service_role;
DROP TRIGGER IF EXISTS fin_anexos_noupd ON fin_anexos;
CREATE TRIGGER fin_anexos_noupd BEFORE UPDATE ON fin_anexos FOR EACH ROW EXECUTE FUNCTION fin_trg_bloqueia_update();
DROP TRIGGER IF EXISTS fin_baixas_guard ON fin_baixas;
CREATE TRIGGER fin_baixas_guard BEFORE UPDATE ON fin_baixas FOR EACH ROW EXECUTE FUNCTION fin_trg_baixa_guard();
DROP TRIGGER IF EXISTS fin_transf_guard ON fin_transferencias;
CREATE TRIGGER fin_transf_guard BEFORE UPDATE ON fin_transferencias FOR EACH ROW EXECUTE FUNCTION fin_trg_transf_guard();
DROP TRIGGER IF EXISTS fin_pessoa_banco ON fin_pessoas;
CREATE TRIGGER fin_pessoa_banco BEFORE UPDATE ON fin_pessoas FOR EACH ROW EXECUTE FUNCTION fin_trg_pessoa_banco();
DROP TRIGGER IF EXISTS fin_pessoa_ins ON fin_pessoas;
CREATE TRIGGER fin_pessoa_ins BEFORE INSERT ON fin_pessoas FOR EACH ROW EXECUTE FUNCTION fin_trg_pessoa_ins();
-- o guard novo do lançamento substitui o da v1 (mesmo nome de trigger)
DROP TRIGGER IF EXISTS fin_lanc_guard ON fin_lancamentos;
CREATE TRIGGER fin_lanc_guard BEFORE UPDATE ON fin_lancamentos FOR EACH ROW EXECUTE FUNCTION fin_trg_lanc_guard();

-- ------------------------------------------------------------
-- 4) SEMENTE: o que existe hoje no Kamino da Gâmi
-- ------------------------------------------------------------
DO $seed$
BEGIN
  PERFORM set_config('fin.ator', 'sistema:seed-v2', true);

  INSERT INTO fin_unidades (nome, cidade_slug) VALUES
    ('Gami Delivery Aracaju','aracaju'), ('Gami Delivery Fortaleza','fortaleza'), ('Gami Delivery Joao Pessoa','joao-pessoa'),
    ('Gami Delivery Natal','natal'), ('Gami Delivery Recife','recife'), ('Gami Delivery São Luis','sao-luis'),
    ('Gami Gestão',NULL), ('Gami Maceió','maceio'), ('Gami Teresina','teresina'), ('Gamy Delivery Vitória','vitoria'),
    ('JUMA ENTREGAS',NULL)
  ON CONFLICT ((lower(nome))) DO NOTHING;

  INSERT INTO fin_centros_custo (nome) VALUES ('Geral') ON CONFLICT ((lower(nome))) DO NOTHING;

  INSERT INTO fin_contas (nome, banco, cidade_slug, criado_por) VALUES
    ('Caixa Local','Caixa',NULL,'sistema:seed-v2'), ('Cora - João Pessoa','Cora','joao-pessoa','sistema:seed-v2'),
    ('Cora Aracaju','Cora','aracaju','sistema:seed-v2'), ('Cora Campo Grande','Cora','campo-grande','sistema:seed-v2'),
    ('Cora Cuiabá','Cora','cuiaba','sistema:seed-v2'), ('Cora Fortaleza','Cora','fortaleza','sistema:seed-v2'),
    ('Cora Maceió','Cora','maceio','sistema:seed-v2'), ('Cora Natal','Cora','natal','sistema:seed-v2'),
    ('Cora Recife','Cora','recife','sistema:seed-v2'), ('Cora São Luis','Cora','sao-luis','sistema:seed-v2'),
    ('Cora Teresina','Cora','teresina','sistema:seed-v2'), ('Cora Vitória','Cora','vitoria','sistema:seed-v2'),
    ('Gami Delivery Gestão','Cora',NULL,'sistema:seed-v2'), ('Gami Teresina','Cora','teresina','sistema:seed-v2'),
    ('Kamino - Gami','Kamino',NULL,'sistema:seed-v2')
  ON CONFLICT ((lower(nome))) DO NOTHING;

  INSERT INTO fin_classificacoes (grupo, subgrupo, nome, dre_linha, ordem) VALUES
    ('receita',NULL,'Receitas com Serviços','receita_bruta',10),
    ('receita',NULL,'Receitas Financeiras','outras_receitas',20),
    ('despesa','Despesas Administrativas','Cartório','despesas_operacionais',100),
    ('despesa','Despesas Administrativas','Contabilidade','despesas_operacionais',101),
    ('despesa','Despesas Administrativas','Despesas Financeiras e Tarifas','despesas_operacionais',102),
    ('despesa','Despesas Administrativas','Despesas Jurídicas','despesas_operacionais',103),
    ('despesa','Despesas Administrativas','Estournos/Devoluções','despesas_operacionais',104),
    ('despesa','Despesas Administrativas','Motoboy e Correios','despesas_operacionais',105),
    ('despesa','Despesas Comerciais','Comissões','despesas_comerciais',200),
    ('despesa','Despesas Comerciais','Compra de Mailing','despesas_comerciais',201),
    ('despesa','Despesas Comerciais','MARKETING','despesas_comerciais',202),
    ('despesa','Despesas Comerciais','Facebook Ads','despesas_comerciais',203),
    ('despesa','Despesas Comerciais','Linkedin Ads','despesas_comerciais',204),
    ('despesa','Despesas Operacionais','ASSINATURA ZAPSIGN','despesas_operacionais',300),
    ('despesa','Despesas Operacionais','Consultoria Terceirizada','despesas_operacionais',301),
    ('despesa','Despesas Operacionais','Servidores (Cloud)','despesas_operacionais',302),
    ('despesa','Despesas Operacionais','IA de Prospecção','despesas_operacionais',303),
    ('despesa','Despesas Operacionais','Prospecção Novos Clientes','despesas_operacionais',304),
    ('despesa','Despesas com Infraestrutura','Aluguel','despesas_operacionais',400),
    ('despesa','Despesas com Infraestrutura','Compra de Equipamentos','despesas_operacionais',401),
    ('despesa','Despesas com Infraestrutura','Condomínio','despesas_operacionais',402),
    ('despesa','Despesas com Infraestrutura','Consórcio Moto','despesas_operacionais',403),
    ('despesa','Despesas com Infraestrutura','Insumos e Materiais Consumíveis','despesas_operacionais',404),
    ('despesa','Despesas com Infraestrutura','Iptu','despesas_operacionais',405),
    ('despesa','Despesas com Infraestrutura','Luz','despesas_operacionais',406),
    ('despesa','Despesas com Infraestrutura','Obras, Reformas e Manutenções','despesas_operacionais',407),
    ('despesa','Despesas com Infraestrutura','Telefone / Internet','despesas_operacionais',408),
    ('despesa','Despesas com Pessoas','Clubes de Benefícios','despesas_operacionais',500),
    ('despesa','Despesas com Pessoas','Plano de Saúde','despesas_operacionais',501),
    ('despesa','Despesas com Pessoas','Vale-Alimentação','despesas_operacionais',502),
    ('despesa','Despesas com Pessoas','Vale-Refeição','despesas_operacionais',503),
    ('despesa','Despesas com Pessoas','Vale-Transporte','despesas_operacionais',504),
    ('despesa','Despesas com Pessoas','Contribuição Sindical','despesas_operacionais',505),
    ('despesa','Despesas com Pessoas','Fgts','despesas_operacionais',506),
    ('despesa','Despesas com Pessoas','Inss 2100','despesas_operacionais',507),
    ('despesa','Despesas com Pessoas','Irrf 0561','despesas_operacionais',508),
    ('despesa','Despesas com Pessoas','Salário','despesas_operacionais',509),
    ('despesa','Impostos sobre a Venda','Cofins 2172','impostos_venda',600),
    ('despesa','Impostos sobre a Venda','Cssl 2372','impostos_venda',601),
    ('despesa','Impostos sobre a Venda','Irpj 2089','impostos_venda',602),
    ('despesa','Impostos sobre a Venda','Iss','impostos_venda',603),
    ('despesa','Impostos sobre a Venda','Pis 8109','impostos_venda',604),
    ('despesa','Impostos sobre a Venda','Simples','impostos_venda',605),
    ('aporte',NULL,'Investimento Recebido','aportes',700),
    ('retirada',NULL,'Distribuição de Lucro','retiradas',800),
    ('transferencia',NULL,'Transferência entre contas','fora_dre',900)
  ON CONFLICT (grupo, lower(coalesce(subgrupo,'')), lower(nome)) DO NOTHING;
END $seed$;

-- ------------------------------------------------------------
-- 5) VIEWS
-- ------------------------------------------------------------
DROP VIEW IF EXISTS fin_v_lanc CASCADE;
CREATE VIEW fin_v_lanc WITH (security_invoker = true) AS
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
  (SELECT count(*) FROM fin_anexos a WHERE a.lancamento_id = l.id) AS anexos
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

-- Uma linha por (lançamento × unidade) com o fator do rateio. Sem rateio = 100% na unidade do lançamento.
CREATE VIEW fin_v_alocado WITH (security_invoker = true) AS
SELECT v.*, r.unidade_alocada, r.fator
FROM fin_v_lanc v
CROSS JOIN LATERAL (
  SELECT (x->>'unidade_id')::bigint AS unidade_alocada, (x->>'pct')::numeric / 100 AS fator
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v.rateio) = 'array' AND jsonb_array_length(v.rateio) > 0 THEN v.rateio ELSE NULL END) x
  UNION ALL
  SELECT v.unidade_id, 1 WHERE v.rateio IS NULL OR jsonb_typeof(v.rateio) <> 'array' OR jsonb_array_length(v.rateio) = 0
) r
WHERE v.status <> 'cancelado';
REVOKE ALL ON fin_v_alocado FROM PUBLIC, anon, authenticated;
GRANT SELECT ON fin_v_alocado TO service_role;

-- ------------------------------------------------------------
-- 6) RPCs DE ESCRITA
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin__valida_rateio(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s numeric;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'array' OR jsonb_array_length(p) = 0 THEN RETURN NULL; END IF;
  SELECT sum((x->>'pct')::numeric) INTO s FROM jsonb_array_elements(p) x;
  IF abs(s - 100) > 0.01 THEN RAISE EXCEPTION 'Rateio precisa somar 100%% (está %)', s; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p) x WHERE (x->>'pct')::numeric <= 0
             OR NOT EXISTS (SELECT 1 FROM fin_unidades u WHERE u.id = (x->>'unidade_id')::bigint)) THEN
    RAISE EXCEPTION 'Rateio com unidade inválida ou percentual zerado';
  END IF;
  RETURN p;
END $$;

-- Cria 1 ou N lançamentos (parcelamento) numa transação. p_itens = array de lançamentos.
CREATE OR REPLACE FUNCTION fin_criar_lancamentos(p_ator text, p_itens jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE i jsonb; v_ids bigint[] := '{}'; v_id bigint; v_grupo uuid := CASE WHEN jsonb_array_length(p_itens) > 1 THEN gen_random_uuid() END; n int := 0;
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF jsonb_array_length(p_itens) = 0 OR jsonb_array_length(p_itens) > 120 THEN RAISE EXCEPTION 'Entre 1 e 120 lançamentos por vez'; END IF;
  FOR i IN SELECT * FROM jsonb_array_elements(p_itens) LOOP
    n := n + 1;
    IF (i->>'valor')::numeric IS NULL OR (i->>'valor')::numeric <= 0 THEN RAISE EXCEPTION 'Valor inválido na parcela %', n; END IF;
    IF (i->>'vencimento') IS NULL THEN RAISE EXCEPTION 'Vencimento obrigatório'; END IF;
    INSERT INTO fin_lancamentos (origem, chave, tipo, pessoa_id, pessoa, descricao, classificacao_id, centro_custo_id, unidade_id, conta_id,
      forma, valor, juros, multa, desconto, retencao, retencao_tipo, vencimento, competencia, nf_numero, codigo_barras, pix_copia_cola,
      observacao, grupo_parcela, parcela_num, parcela_total, rateio, status, criado_por)
    VALUES ('manual', 'M:'||gen_random_uuid(), i->>'tipo', nullif(i->>'pessoa_id','')::bigint,
      (SELECT nome FROM fin_pessoas WHERE id = nullif(i->>'pessoa_id','')::bigint),
      nullif(btrim(i->>'descricao'),''), nullif(i->>'classificacao_id','')::bigint, nullif(i->>'centro_custo_id','')::bigint,
      nullif(i->>'unidade_id','')::bigint, nullif(i->>'conta_id','')::uuid, nullif(i->>'forma',''),
      (i->>'valor')::numeric, coalesce((i->>'juros')::numeric,0), coalesce((i->>'multa')::numeric,0), coalesce((i->>'desconto')::numeric,0),
      coalesce((i->>'retencao')::numeric,0), nullif(i->>'retencao_tipo',''),
      (i->>'vencimento')::date, coalesce(nullif(i->>'competencia','')::date, (i->>'vencimento')::date),
      nullif(i->>'nf_numero',''), nullif(i->>'codigo_barras',''), nullif(i->>'pix_copia_cola',''), nullif(btrim(i->>'observacao'),''),
      v_grupo, CASE WHEN v_grupo IS NOT NULL THEN n END, CASE WHEN v_grupo IS NOT NULL THEN jsonb_array_length(p_itens) END,
      fin__valida_rateio(i->'rateio'), 'pendente', p_ator)
    RETURNING id INTO v_id;
    v_ids := v_ids || v_id;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'ids', to_jsonb(v_ids));
END $$;

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
    pessoa = coalesce((SELECT nome FROM fin_pessoas WHERE id = nullif(i->>'pessoa_id','')::bigint), pessoa),
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

CREATE OR REPLACE FUNCTION fin_cancelar_lancamento(p_ator text, p_id bigint, p_motivo text) RETURNS jsonb
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF EXISTS (SELECT 1 FROM fin_baixas WHERE lancamento_id = p_id AND NOT estornada) THEN
    RAISE EXCEPTION 'Lançamento pago: estorne a baixa antes de cancelar';
  END IF;
  UPDATE fin_lancamentos SET status = 'cancelado', cancelado_por = p_ator, cancelado_em = now(), motivo_cancelamento = p_motivo
  WHERE id = p_id AND status = 'pendente';
  IF NOT FOUND THEN RAISE EXCEPTION 'Lançamento não está pendente'; END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- Split: divide um pendente em dois (o original vira o 1º, nasce o 2º). Útil quando paga em partes.
CREATE OR REPLACE FUNCTION fin_split_lancamento(p_ator text, p_id bigint, p_valor2 numeric, p_venc2 date) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE l fin_lancamentos; v_novo bigint;
BEGIN
  PERFORM fin_set_ator(p_ator);
  SELECT * INTO l FROM fin_lancamentos WHERE id = p_id FOR UPDATE;
  IF l.status <> 'pendente' THEN RAISE EXCEPTION 'Só lançamento pendente pode ser dividido'; END IF;
  IF p_valor2 <= 0 OR p_valor2 >= l.valor THEN RAISE EXCEPTION 'Valor da 2ª parte deve ser maior que zero e menor que o total'; END IF;
  UPDATE fin_lancamentos SET valor = l.valor - p_valor2, atualizado_por = p_ator WHERE id = p_id;
  INSERT INTO fin_lancamentos (origem, chave, tipo, pessoa_id, pessoa, descricao, classificacao_id, centro_custo_id, unidade_id, conta_id,
    forma, valor, vencimento, competencia, nf_numero, observacao, rateio, status, criado_por)
  VALUES ('manual', 'M:'||gen_random_uuid(), l.tipo, l.pessoa_id, l.pessoa, coalesce(l.descricao,'')||' (split de #'||l.id||')',
    l.classificacao_id, l.centro_custo_id, l.unidade_id, l.conta_id, l.forma, p_valor2, coalesce(p_venc2, l.vencimento), l.competencia,
    l.nf_numero, l.observacao, l.rateio, 'pendente', p_ator)
  RETURNING id INTO v_novo;
  RETURN jsonb_build_object('ok', true, 'novo_id', v_novo);
END $$;

-- Baixa manual: registra que foi pago/recebido. NÃO move dinheiro: quem prova é o extrato.
CREATE OR REPLACE FUNCTION fin_baixar(p_ator text, p_id bigint, p_data date, p_conta uuid, p_juros numeric, p_multa numeric,
                                      p_desconto numeric, p_obs text, p_extrato bigint DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE l fin_lancamentos; v_total numeric;
BEGIN
  PERFORM fin_set_ator(p_ator);
  SELECT * INTO l FROM fin_lancamentos WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lançamento não encontrado'; END IF;
  IF l.status <> 'pendente' THEN RAISE EXCEPTION 'Lançamento já está %', l.status; END IF;
  IF p_conta IS NULL OR NOT EXISTS (SELECT 1 FROM fin_contas WHERE id = p_conta) THEN RAISE EXCEPTION 'Escolha a conta'; END IF;
  IF p_data IS NULL OR p_data > (now() AT TIME ZONE 'America/Sao_Paulo')::date + 1 THEN RAISE EXCEPTION 'Data de pagamento inválida (não pode ser futura)'; END IF;
  INSERT INTO fin_baixas (lancamento_id, data, conta_id, valor, juros, multa, desconto, extrato_id, origem, observacao, por)
  VALUES (p_id, p_data, p_conta, l.valor - l.retencao, coalesce(p_juros, l.juros), coalesce(p_multa, l.multa), coalesce(p_desconto, l.desconto),
          p_extrato, CASE WHEN p_extrato IS NULL THEN 'manual' ELSE 'conciliacao' END, nullif(btrim(p_obs),''), p_ator);
  UPDATE fin_lancamentos SET status = 'pago', data_pagamento = p_data, juros = coalesce(p_juros, juros), multa = coalesce(p_multa, multa),
         desconto = coalesce(p_desconto, desconto), situacao = 'Pago', atualizado_por = p_ator
  WHERE id = p_id;
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION fin_estornar_baixa(p_ator text, p_id bigint, p_motivo text) RETURNS jsonb
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fin_set_ator(p_ator);
  UPDATE fin_baixas SET estornada = true, estornada_por = p_ator, motivo_estorno = p_motivo WHERE lancamento_id = p_id AND NOT estornada;
  IF NOT FOUND THEN RAISE EXCEPTION 'Este lançamento não tem baixa ativa'; END IF;
  UPDATE fin_conciliacoes SET ativo = false, desfeito_por = p_ator, motivo_desfazer = 'Estorno da baixa: '||p_motivo WHERE lancamento_id = p_id AND ativo;
  UPDATE fin_lancamentos SET status = 'pendente', data_pagamento = NULL, situacao = 'Pendente', atualizado_por = p_ator WHERE id = p_id;
  RETURN jsonb_build_object('ok', true);
END $$;

-- Conciliar linha do extrato com lançamento: liga e já dá baixa (se pendente) na data e conta do banco
CREATE OR REPLACE FUNCTION fin_conciliar_manual(p_ator text, p_extrato bigint, p_lanc bigint) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE e fin_extrato; l fin_lancamentos;
BEGIN
  PERFORM fin_set_ator(p_ator);
  SELECT * INTO e FROM fin_extrato WHERE id = p_extrato;
  SELECT * INTO l FROM fin_lancamentos WHERE id = p_lanc FOR UPDATE;
  IF e.id IS NULL OR l.id IS NULL THEN RAISE EXCEPTION 'Linha ou lançamento não encontrado'; END IF;
  IF l.status = 'cancelado' THEN RAISE EXCEPTION 'Lançamento cancelado'; END IF;
  IF (e.valor < 0) <> (l.tipo = 'pagar') THEN RAISE EXCEPTION 'Saída do banco só casa com conta a pagar, entrada só com conta a receber'; END IF;
  INSERT INTO fin_conciliacoes (extrato_id, lancamento_id, metodo, criado_por) VALUES (p_extrato, p_lanc, 'manual', p_ator);
  IF l.status = 'pendente' THEN
    PERFORM fin_baixar(p_ator, p_lanc, e.data, e.conta_id, NULL, NULL, NULL, 'Baixa pela conciliação com o extrato', p_extrato);
  END IF;
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('ok', false, 'erro', 'Essa linha ou esse lançamento já está conciliado. Desfaça antes.');
END $$;

-- Cria o lançamento a partir da linha do extrato (botão "+") já pago e conciliado
CREATE OR REPLACE FUNCTION fin_lancar_da_linha(p_ator text, p_extrato bigint, i jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE e fin_extrato; r jsonb; v_id bigint;
BEGIN
  PERFORM fin_set_ator(p_ator);
  SELECT * INTO e FROM fin_extrato WHERE id = p_extrato;
  IF NOT FOUND THEN RAISE EXCEPTION 'Linha não encontrada'; END IF;
  IF EXISTS (SELECT 1 FROM fin_conciliacoes WHERE extrato_id = p_extrato AND ativo) THEN RAISE EXCEPTION 'Linha já conciliada'; END IF;
  r := fin_criar_lancamentos(p_ator, jsonb_build_array(i || jsonb_build_object(
         'tipo', CASE WHEN e.valor < 0 THEN 'pagar' ELSE 'receber' END, 'valor', abs(e.valor),
         'vencimento', e.data, 'conta_id', e.conta_id, 'descricao', coalesce(nullif(i->>'descricao',''), e.descricao))));
  v_id := (r->'ids'->>0)::bigint;
  RETURN fin_conciliar_manual(p_ator, p_extrato, v_id) || jsonb_build_object('lancamento_id', v_id);
END $$;

CREATE OR REPLACE FUNCTION fin_criar_transferencia(p_ator text, p_data date, p_origem uuid, p_destino uuid, p_valor numeric, p_desc text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  PERFORM fin_set_ator(p_ator);
  INSERT INTO fin_transferencias (data, conta_origem_id, conta_destino_id, valor, descricao, por)
  VALUES (p_data, p_origem, p_destino, p_valor, nullif(btrim(p_desc),''), p_ator) RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

CREATE OR REPLACE FUNCTION fin_cancelar_transferencia(p_ator text, p_id bigint, p_motivo text) RETURNS jsonb
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fin_set_ator(p_ator);
  UPDATE fin_conciliacoes SET ativo = false, desfeito_por = p_ator, motivo_desfazer = 'Transferência cancelada: '||p_motivo
  WHERE transferencia_id = p_id AND ativo;
  UPDATE fin_transferencias SET cancelada = true, cancelada_por = p_ator, motivo_cancelamento = p_motivo WHERE id = p_id AND NOT cancelada;
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION fin_conciliar_transferencia(p_ator text, p_extrato bigint, p_transf bigint) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE e fin_extrato; t fin_transferencias;
BEGIN
  PERFORM fin_set_ator(p_ator);
  SELECT * INTO e FROM fin_extrato WHERE id = p_extrato;
  SELECT * INTO t FROM fin_transferencias WHERE id = p_transf;
  IF t.cancelada THEN RAISE EXCEPTION 'Transferência cancelada'; END IF;
  IF abs(e.valor) <> t.valor THEN RAISE EXCEPTION 'Valor da linha diferente do valor da transferência'; END IF;
  IF NOT ((e.valor < 0 AND e.conta_id = t.conta_origem_id) OR (e.valor > 0 AND e.conta_id = t.conta_destino_id)) THEN
    RAISE EXCEPTION 'A linha não é da conta de origem (saída) nem da de destino (entrada) desta transferência';
  END IF;
  INSERT INTO fin_conciliacoes (extrato_id, transferencia_id, metodo, criado_por) VALUES (p_extrato, p_transf, 'manual', p_ator);
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('ok', false, 'erro', 'Linha já conciliada');
END $$;

-- Desfazer conciliação: se a baixa veio da conciliação, estorna junto
CREATE OR REPLACE FUNCTION fin_desfazer_conciliacao(p_ator text, p_extrato bigint, p_motivo text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE c fin_conciliacoes;
BEGIN
  PERFORM fin_set_ator(p_ator);
  SELECT * INTO c FROM fin_conciliacoes WHERE extrato_id = p_extrato AND ativo;
  IF NOT FOUND THEN RAISE EXCEPTION 'Linha não está conciliada'; END IF;
  UPDATE fin_conciliacoes SET ativo = false, desfeito_por = p_ator, motivo_desfazer = p_motivo WHERE id = c.id;
  IF c.lancamento_id IS NOT NULL AND EXISTS (SELECT 1 FROM fin_baixas WHERE lancamento_id = c.lancamento_id AND NOT estornada AND extrato_id = p_extrato) THEN
    UPDATE fin_baixas SET estornada = true, estornada_por = p_ator, motivo_estorno = 'Conciliação desfeita: '||p_motivo
    WHERE lancamento_id = c.lancamento_id AND NOT estornada;
    UPDATE fin_lancamentos SET status = 'pendente', data_pagamento = NULL, situacao = 'Pendente', atualizado_por = p_ator WHERE id = c.lancamento_id;
  END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- Conciliação automática v2: só com candidato ÚNICO; dá baixa junto
CREATE OR REPLACE FUNCTION fin_conciliar_auto(p_ator text) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE r record; n int := 0;
BEGIN
  PERFORM fin_set_ator(p_ator);
  FOR r IN
    SELECT e.id AS eid, (array_agg(l.id))[1] AS lid
    FROM fin_extrato e
    JOIN fin_lancamentos l ON l.status <> 'cancelado'
      AND (l.valor + l.juros + l.multa - l.desconto - l.retencao) = abs(e.valor)
      AND l.tipo = CASE WHEN e.valor < 0 THEN 'pagar' ELSE 'receber' END
      AND coalesce(l.data_pagamento, l.vencimento) BETWEEN e.data - 3 AND e.data + 3
      AND NOT EXISTS (SELECT 1 FROM fin_conciliacoes c WHERE c.lancamento_id = l.id AND c.ativo)
    WHERE NOT EXISTS (SELECT 1 FROM fin_conciliacoes c WHERE c.extrato_id = e.id AND c.ativo)
    GROUP BY e.id HAVING count(*) = 1
  LOOP
    BEGIN
      IF (fin_conciliar_auto_um(p_ator, r.eid, r.lid)) THEN n := n + 1; END IF;
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
  END LOOP;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION fin_conciliar_auto_um(p_ator text, p_extrato bigint, p_lanc bigint) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE e fin_extrato; l fin_lancamentos;
BEGIN
  SELECT * INTO e FROM fin_extrato WHERE id = p_extrato;
  SELECT * INTO l FROM fin_lancamentos WHERE id = p_lanc FOR UPDATE;
  INSERT INTO fin_conciliacoes (extrato_id, lancamento_id, metodo, criado_por) VALUES (p_extrato, p_lanc, 'auto', p_ator);
  IF l.status = 'pendente' THEN
    PERFORM fin_baixar(p_ator, p_lanc, e.data, e.conta_id, NULL, NULL, NULL, 'Baixa automática pela conciliação', p_extrato);
  END IF;
  RETURN true;
END $$;

-- Pessoa (cria/edita). Mudança de dado bancário dispara alerta pelo trigger.
CREATE OR REPLACE FUNCTION fin_salvar_pessoa(p_ator text, p_id bigint, d jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_id bigint; v_doc text := nullif(regexp_replace(coalesce(d->>'documento',''), '\D', '', 'g'), '');
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF length(btrim(coalesce(d->>'nome',''))) < 2 THEN RAISE EXCEPTION 'Nome obrigatório'; END IF;
  IF v_doc IS NOT NULL AND length(v_doc) NOT IN (11, 14) AND NOT coalesce((d->>'estrangeira')::boolean, false) THEN
    RAISE EXCEPTION 'CPF/CNPJ inválido (11 ou 14 dígitos)';
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO fin_pessoas (documento, estrangeira, nome, razao_social, fantasia, ie, im, cliente, fornecedor, cep, logradouro, numero,
      complemento, bairro, cidade, uf, telefone, email, pix_tipo, pix_chave, banco, agencia, conta, observacoes, ativo, criado_por)
    VALUES (v_doc, coalesce((d->>'estrangeira')::boolean,false), btrim(d->>'nome'), d->>'razao_social', d->>'fantasia', d->>'ie', d->>'im',
      coalesce((d->>'cliente')::boolean,false), coalesce((d->>'fornecedor')::boolean,false), d->>'cep', d->>'logradouro', d->>'numero',
      d->>'complemento', d->>'bairro', d->>'cidade', d->>'uf', d->>'telefone', d->>'email', d->>'pix_tipo', nullif(btrim(d->>'pix_chave'),''),
      d->>'banco', d->>'agencia', d->>'conta', d->>'observacoes', coalesce((d->>'ativo')::boolean,true), p_ator)
    RETURNING id INTO v_id;
  ELSE
    UPDATE fin_pessoas SET documento = v_doc, estrangeira = coalesce((d->>'estrangeira')::boolean,false), nome = btrim(d->>'nome'),
      razao_social = d->>'razao_social', fantasia = d->>'fantasia', ie = d->>'ie', im = d->>'im',
      cliente = coalesce((d->>'cliente')::boolean,false), fornecedor = coalesce((d->>'fornecedor')::boolean,false),
      cep = d->>'cep', logradouro = d->>'logradouro', numero = d->>'numero', complemento = d->>'complemento', bairro = d->>'bairro',
      cidade = d->>'cidade', uf = d->>'uf', telefone = d->>'telefone', email = d->>'email', pix_tipo = d->>'pix_tipo',
      pix_chave = nullif(btrim(d->>'pix_chave'),''), banco = d->>'banco', agencia = d->>'agencia', conta = d->>'conta',
      observacoes = d->>'observacoes', ativo = coalesce((d->>'ativo')::boolean,true), atualizado_por = p_ator
    WHERE id = p_id RETURNING id INTO v_id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('ok', false, 'erro', 'Já existe uma pessoa com esse CPF/CNPJ');
END $$;

-- Cadastros simples (unidade, centro, classificação, regra)
CREATE OR REPLACE FUNCTION fin_salvar_cadastro(p_ator text, p_tabela text, p_id bigint, d jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF p_tabela = 'unidade' THEN
    IF p_id IS NULL THEN INSERT INTO fin_unidades (nome, cidade_slug, cnpj, criado_por) VALUES (btrim(d->>'nome'), nullif(d->>'cidade_slug',''), nullif(d->>'cnpj',''), p_ator) RETURNING id INTO v_id;
    ELSE UPDATE fin_unidades SET nome = btrim(d->>'nome'), cidade_slug = nullif(d->>'cidade_slug',''), cnpj = nullif(d->>'cnpj',''), ativo = coalesce((d->>'ativo')::boolean, true) WHERE id = p_id RETURNING id INTO v_id; END IF;
  ELSIF p_tabela = 'centro' THEN
    IF p_id IS NULL THEN INSERT INTO fin_centros_custo (nome, criado_por) VALUES (btrim(d->>'nome'), p_ator) RETURNING id INTO v_id;
    ELSE UPDATE fin_centros_custo SET nome = btrim(d->>'nome'), ativo = coalesce((d->>'ativo')::boolean, true) WHERE id = p_id RETURNING id INTO v_id; END IF;
  ELSIF p_tabela = 'classificacao' THEN
    IF p_id IS NULL THEN INSERT INTO fin_classificacoes (grupo, subgrupo, nome, codigo, dre_linha, criado_por)
      VALUES (d->>'grupo', nullif(btrim(d->>'subgrupo'),''), btrim(d->>'nome'), nullif(d->>'codigo',''), d->>'dre_linha', p_ator) RETURNING id INTO v_id;
    ELSE UPDATE fin_classificacoes SET subgrupo = nullif(btrim(d->>'subgrupo'),''), nome = btrim(d->>'nome'), codigo = nullif(d->>'codigo',''),
      dre_linha = d->>'dre_linha', ativo = coalesce((d->>'ativo')::boolean, true) WHERE id = p_id RETURNING id INTO v_id; END IF;
  ELSIF p_tabela = 'regra' THEN
    IF length(btrim(coalesce(d->>'texto_busca',''))) < 3 THEN RAISE EXCEPTION 'Texto de busca muito curto'; END IF;
    IF p_id IS NULL THEN INSERT INTO fin_regras_extrato (descricao, texto_busca, conta_id, pessoa_id, classificacao_id, centro_custo_id, unidade_id, transferencia_conta_id, criado_por)
      VALUES (btrim(d->>'descricao'), btrim(d->>'texto_busca'), nullif(d->>'conta_id','')::uuid, nullif(d->>'pessoa_id','')::bigint, nullif(d->>'classificacao_id','')::bigint,
              nullif(d->>'centro_custo_id','')::bigint, nullif(d->>'unidade_id','')::bigint, nullif(d->>'transferencia_conta_id','')::uuid, p_ator) RETURNING id INTO v_id;
    ELSE UPDATE fin_regras_extrato SET descricao = btrim(d->>'descricao'), texto_busca = btrim(d->>'texto_busca'), conta_id = nullif(d->>'conta_id','')::uuid,
      pessoa_id = nullif(d->>'pessoa_id','')::bigint, classificacao_id = nullif(d->>'classificacao_id','')::bigint, centro_custo_id = nullif(d->>'centro_custo_id','')::bigint,
      unidade_id = nullif(d->>'unidade_id','')::bigint, transferencia_conta_id = nullif(d->>'transferencia_conta_id','')::uuid,
      ativo = coalesce((d->>'ativo')::boolean, true), atualizado_por = p_ator, atualizado_em = now() WHERE id = p_id RETURNING id INTO v_id; END IF;
  ELSE RAISE EXCEPTION 'Cadastro desconhecido';
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('ok', false, 'erro', 'Já existe um cadastro com esse nome');
END $$;

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
    UPDATE fin_entradas SET beneficiario = nullif(d->>'beneficiario',''), documento = nullif(d->>'documento',''),
      vencimento = nullif(d->>'vencimento','')::date, valor = nullif(d->>'valor','')::numeric, linha_digitavel = nullif(d->>'linha_digitavel',''),
      observacao = nullif(d->>'observacao',''), status = coalesce(nullif(d->>'status',''), status),
      lancamento_id = coalesce(nullif(d->>'lancamento_id','')::bigint, lancamento_id), motivo_arquivo = coalesce(nullif(d->>'motivo_arquivo',''), motivo_arquivo),
      atualizado_por = p_ator, atualizado_em = now()
    WHERE id = p_id RETURNING id INTO v_id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

CREATE OR REPLACE FUNCTION fin_registrar_anexo(p_ator text, d jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  PERFORM fin_set_ator(p_ator);
  INSERT INTO fin_anexos (lancamento_id, entrada_id, nome, caminho, mime, bytes, sha256, por)
  VALUES (nullif(d->>'lancamento_id','')::bigint, nullif(d->>'entrada_id','')::bigint, d->>'nome', d->>'caminho', d->>'mime',
          (d->>'bytes')::int, d->>'sha256', p_ator) RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

CREATE OR REPLACE FUNCTION fin_salvar_conta(p_ator text, p_id uuid, p_dados jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF p_id IS NULL THEN
    INSERT INTO fin_contas (nome, banco, agencia, numero, cidade_slug, unidade, tipo, saldo_inicial, saldo_inicial_data, unidade_id, criado_por)
    VALUES (p_dados->>'nome', p_dados->>'banco', p_dados->>'agencia', p_dados->>'numero', nullif(p_dados->>'cidade_slug',''), nullif(p_dados->>'unidade',''),
            coalesce(nullif(p_dados->>'tipo',''),'corrente'), coalesce((p_dados->>'saldo_inicial')::numeric,0), nullif(p_dados->>'saldo_inicial_data','')::date,
            nullif(p_dados->>'unidade_id','')::bigint, p_ator)
    RETURNING id INTO v_id;
  ELSE
    UPDATE fin_contas SET nome = p_dados->>'nome', banco = p_dados->>'banco', agencia = p_dados->>'agencia', numero = p_dados->>'numero',
      cidade_slug = nullif(p_dados->>'cidade_slug',''), unidade = nullif(p_dados->>'unidade',''), tipo = coalesce(nullif(p_dados->>'tipo',''), tipo),
      saldo_inicial = coalesce((p_dados->>'saldo_inicial')::numeric, saldo_inicial), saldo_inicial_data = coalesce(nullif(p_dados->>'saldo_inicial_data','')::date, saldo_inicial_data),
      unidade_id = nullif(p_dados->>'unidade_id','')::bigint,
      ativo = coalesce((p_dados->>'ativo')::boolean, ativo), atualizado_por = p_ator, atualizado_em = now()
    WHERE id = p_id RETURNING id INTO v_id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

-- Aplica as regras de extrato numa linha: devolve a sugestão (não grava nada)
CREATE OR REPLACE FUNCTION fin_sugestao_regra(p_extrato bigint) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT to_jsonb(r) FROM fin_regras_extrato r, fin_extrato e
  WHERE e.id = p_extrato AND r.ativo AND (r.conta_id IS NULL OR r.conta_id = e.conta_id)
    AND fin_norm(e.descricao) LIKE '%' || fin_norm(r.texto_busca) || '%'
  ORDER BY length(r.texto_busca) DESC LIMIT 1
$$;

-- Importação do Kamino v2: liga pessoa/classificação/unidade/conta pelo NOME (cria a pessoa se não existir)
-- e define o status (pago/cancelado/pendente) pela situação e data de pagamento.
CREATE OR REPLACE FUNCTION fin_importar_lancamentos(p_ator text, p_meta jsonb, p_linhas jsonb)
RETURNS jsonb LANGUAGE plpgsql SET statement_timeout = '180s' AS $$
DECLARE v_imp uuid; v_total int; v_novas int; v_origem text := coalesce(p_meta->>'origem','kamino_csv'); l jsonb;
        v_pessoa bigint; v_doc text; v_status text; v_pessoas_novas int := 0;
BEGIN
  PERFORM fin_set_ator(p_ator);
  PERFORM pg_advisory_xact_lock(hashtext('fin_import_lanc'));
  IF EXISTS (SELECT 1 FROM fin_importacoes WHERE conta_id IS NULL AND tipo = 'lancamentos' AND arquivo_sha256 = p_meta->>'sha256') THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Este arquivo de lançamentos já foi importado.');
  END IF;
  SELECT count(*), count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM fin_lancamentos x WHERE x.origem = v_origem AND x.chave = l2->>'chave'))
    INTO v_total, v_novas FROM jsonb_array_elements(p_linhas) l2;

  INSERT INTO fin_importacoes (conta_id, tipo, formato, arquivo_nome, arquivo_sha256, arquivo_bytes, conteudo,
     periodo_ini, periodo_fim, qtd_linhas, qtd_novas, qtd_duplicadas, importado_por)
  VALUES (NULL, 'lancamentos', p_meta->>'formato', p_meta->>'arquivo_nome', p_meta->>'sha256', (p_meta->>'bytes')::int, p_meta->>'conteudo',
     (p_meta->>'periodo_ini')::date, (p_meta->>'periodo_fim')::date, v_total, v_novas, v_total - v_novas, p_ator)
  RETURNING id INTO v_imp;

  FOR l IN SELECT * FROM jsonb_array_elements(p_linhas) LOOP
    -- pessoa: pelo CPF/CNPJ, senão pelo nome; cria se não existir
    v_pessoa := NULL;
    v_doc := nullif(regexp_replace(coalesce(l->>'pessoa_doc',''), '\D', '', 'g'), '');
    IF v_doc IS NOT NULL AND length(v_doc) NOT IN (11,14) THEN v_doc := NULL; END IF;
    IF v_doc IS NOT NULL THEN SELECT id INTO v_pessoa FROM fin_pessoas WHERE documento = v_doc; END IF;
    IF v_pessoa IS NULL AND fin_norm(l->>'pessoa') IS NOT NULL THEN
      SELECT id INTO v_pessoa FROM fin_pessoas WHERE nome_norm = fin_norm(l->>'pessoa') ORDER BY id LIMIT 1;
    END IF;
    IF v_pessoa IS NULL AND fin_norm(l->>'pessoa') IS NOT NULL THEN
      INSERT INTO fin_pessoas (documento, nome, cliente, fornecedor, criado_por)
      VALUES (v_doc, btrim(l->>'pessoa'), l->>'tipo' = 'receber', l->>'tipo' = 'pagar', p_ator) RETURNING id INTO v_pessoa;
      v_pessoas_novas := v_pessoas_novas + 1;
    END IF;
    v_status := CASE WHEN lower(coalesce(l->>'situacao','')) LIKE 'cancel%' THEN 'cancelado'
                     WHEN nullif(l->>'data_pagamento','') IS NOT NULL OR lower(coalesce(l->>'situacao','')) ~ '^(pag|receb|quitad|liquidad)' THEN 'pago'
                     ELSE 'pendente' END;
    INSERT INTO fin_lancamentos (origem, chave, tipo, pessoa, pessoa_doc, pessoa_norm, pessoa_id, descricao, categoria, unidade, conta_nome,
                                 classificacao_id, unidade_id, conta_id, centro_custo_id,
                                 valor, vencimento, competencia, data_pagamento, situacao, status, cancelado_por, cancelado_em, motivo_cancelamento,
                                 importacao_id, raw, criado_por)
    VALUES (v_origem, l->>'chave', l->>'tipo', nullif(l->>'pessoa',''), nullif(l->>'pessoa_doc',''), fin_norm(l->>'pessoa'), v_pessoa,
      nullif(l->>'descricao',''), nullif(l->>'categoria',''), nullif(l->>'unidade',''), nullif(l->>'conta_nome',''),
      (SELECT id FROM fin_classificacoes c WHERE fin_norm(c.nome) = fin_norm(l->>'categoria') OR fin_norm(coalesce(c.codigo,'')||' '||c.nome) = fin_norm(l->>'categoria') ORDER BY c.id LIMIT 1),
      (SELECT id FROM fin_unidades u WHERE fin_norm(u.nome) = fin_norm(l->>'unidade') LIMIT 1),
      (SELECT id FROM fin_contas c WHERE fin_norm(c.nome) = fin_norm(l->>'conta_nome') LIMIT 1),
      (SELECT id FROM fin_centros_custo c WHERE fin_norm(c.nome) = fin_norm(coalesce(nullif(l->>'centro_custo',''),'Geral')) LIMIT 1),
      (l->>'valor')::numeric, nullif(l->>'vencimento','')::date, coalesce(nullif(l->>'competencia','')::date, nullif(l->>'vencimento','')::date),
      CASE WHEN v_status = 'pago' THEN coalesce(nullif(l->>'data_pagamento','')::date, nullif(l->>'vencimento','')::date) END,
      nullif(l->>'situacao',''), v_status,
      CASE WHEN v_status = 'cancelado' THEN 'kamino' END, CASE WHEN v_status = 'cancelado' THEN now() END,
      CASE WHEN v_status = 'cancelado' THEN 'Cancelado no Kamino' END, v_imp, l->'raw', p_ator)
    ON CONFLICT (origem, chave) DO UPDATE SET
      pessoa = EXCLUDED.pessoa, pessoa_doc = EXCLUDED.pessoa_doc, pessoa_norm = EXCLUDED.pessoa_norm, pessoa_id = EXCLUDED.pessoa_id,
      descricao = EXCLUDED.descricao, categoria = EXCLUDED.categoria, unidade = EXCLUDED.unidade, conta_nome = EXCLUDED.conta_nome,
      classificacao_id = EXCLUDED.classificacao_id, unidade_id = EXCLUDED.unidade_id, conta_id = EXCLUDED.conta_id,
      valor = EXCLUDED.valor, vencimento = EXCLUDED.vencimento, competencia = EXCLUDED.competencia, data_pagamento = EXCLUDED.data_pagamento,
      situacao = EXCLUDED.situacao, status = EXCLUDED.status, cancelado_por = EXCLUDED.cancelado_por, cancelado_em = EXCLUDED.cancelado_em,
      motivo_cancelamento = EXCLUDED.motivo_cancelamento, importacao_id = EXCLUDED.importacao_id, raw = EXCLUDED.raw
    WHERE (fin_lancamentos.valor, fin_lancamentos.vencimento, fin_lancamentos.data_pagamento, fin_lancamentos.situacao, fin_lancamentos.pessoa, fin_lancamentos.categoria)
          IS DISTINCT FROM (EXCLUDED.valor, EXCLUDED.vencimento, EXCLUDED.data_pagamento, EXCLUDED.situacao, EXCLUDED.pessoa, EXCLUDED.categoria);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'importacao_id', v_imp, 'linhas', v_total, 'novas', v_novas, 'pessoas_novas', v_pessoas_novas,
                            'sem_classificacao', (SELECT count(*) FROM fin_lancamentos WHERE importacao_id = v_imp AND classificacao_id IS NULL),
                            'conciliadas', fin_conciliar_auto(p_ator), 'alertas_novos', fin_rodar_regras(p_ator));
END $$;

-- ------------------------------------------------------------
-- 7) RELATÓRIOS
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_hoje() RETURNS date LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date $$;

-- Saldo de cada conta = saldo informado no último extrato; sem extrato, saldo inicial + baixas
CREATE OR REPLACE FUNCTION fin_saldos_contas() RETURNS TABLE (conta_id uuid, nome text, banco text, tipo text, ativo boolean, saldo numeric, saldo_data date, origem text)
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.nome, c.banco, c.tipo, c.ativo,
    coalesce(i.saldo_final,
      c.saldo_inicial
      + coalesce((SELECT sum(CASE WHEN l.tipo = 'receber' THEN 1 ELSE -1 END * (b.valor + b.juros + b.multa - b.desconto))
                  FROM fin_baixas b JOIN fin_lancamentos l ON l.id = b.lancamento_id
                  WHERE b.conta_id = c.id AND NOT b.estornada AND b.data >= coalesce(c.saldo_inicial_data, '1900-01-01')), 0)
      + coalesce((SELECT sum(CASE WHEN t.conta_destino_id = c.id THEN t.valor ELSE -t.valor END) FROM fin_transferencias t
                  WHERE NOT t.cancelada AND (t.conta_origem_id = c.id OR t.conta_destino_id = c.id) AND t.data >= coalesce(c.saldo_inicial_data, '1900-01-01')), 0)),
    coalesce(i.saldo_data, fin_hoje()),
    CASE WHEN i.saldo_final IS NOT NULL THEN 'extrato' ELSE 'sistema' END
  FROM fin_contas c
  LEFT JOIN LATERAL (SELECT saldo_final, saldo_data FROM fin_importacoes x WHERE x.conta_id = c.id AND x.tipo = 'extrato' AND x.saldo_final IS NOT NULL
                     ORDER BY saldo_data DESC, importado_em DESC LIMIT 1) i ON true
$$;

CREATE OR REPLACE FUNCTION fin_painel() RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH h AS (SELECT fin_hoje() AS d),
  ab AS (SELECT * FROM fin_v_lanc WHERE status = 'pendente')
  SELECT jsonb_build_object(
    'saldos', (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.nome), '[]') FROM fin_saldos_contas() s WHERE s.ativo),
    'pagar', (SELECT jsonb_build_object(
        'atrasado', coalesce(sum(valor_final) FILTER (WHERE vencimento < h.d), 0), 'qtd_atrasado', count(*) FILTER (WHERE vencimento < h.d),
        'hoje', coalesce(sum(valor_final) FILTER (WHERE vencimento = h.d), 0), 'qtd_hoje', count(*) FILTER (WHERE vencimento = h.d),
        'semana', coalesce(sum(valor_final) FILTER (WHERE vencimento BETWEEN h.d AND h.d + 7), 0), 'qtd_semana', count(*) FILTER (WHERE vencimento BETWEEN h.d AND h.d + 7))
        FROM ab, h WHERE tipo = 'pagar'),
    'receber', (SELECT jsonb_build_object(
        'atrasado', coalesce(sum(valor_final) FILTER (WHERE vencimento < h.d), 0), 'qtd_atrasado', count(*) FILTER (WHERE vencimento < h.d),
        'hoje', coalesce(sum(valor_final) FILTER (WHERE vencimento = h.d), 0), 'qtd_hoje', count(*) FILTER (WHERE vencimento = h.d),
        'semana', coalesce(sum(valor_final) FILTER (WHERE vencimento BETWEEN h.d AND h.d + 7), 0), 'qtd_semana', count(*) FILTER (WHERE vencimento BETWEEN h.d AND h.d + 7))
        FROM ab, h WHERE tipo = 'receber'),
    'top_classificacoes', (SELECT coalesce(jsonb_agg(x ORDER BY x.atual DESC), '[]') FROM (
        SELECT classificacao_nome AS nome,
          sum(valor_final) FILTER (WHERE date_trunc('month', competencia) = date_trunc('month', h.d)) AS atual,
          sum(valor_final) FILTER (WHERE date_trunc('month', competencia) = date_trunc('month', h.d) - interval '1 month') AS anterior
        FROM fin_v_lanc, h WHERE tipo = 'pagar' AND status <> 'cancelado' AND competencia >= date_trunc('month', h.d) - interval '1 month'
        GROUP BY 1 ORDER BY 2 DESC NULLS LAST LIMIT 6) x),
    'evolucao', (SELECT coalesce(jsonb_agg(x ORDER BY x.mes), '[]') FROM (
        SELECT to_char(date_trunc('month', competencia), 'YYYY-MM') AS mes,
          sum(valor_final) FILTER (WHERE status = 'pago') AS realizado,
          sum(valor_final) FILTER (WHERE status = 'pendente') AS previsto
        FROM fin_v_lanc, h WHERE tipo = 'pagar' AND status <> 'cancelado'
          AND competencia >= date_trunc('month', h.d) - interval '5 months' AND competencia < date_trunc('month', h.d) + interval '2 months'
        GROUP BY 1) x),
    'entradas_pendentes', (SELECT count(*) FROM fin_entradas WHERE status IN ('pendente','nao_identificado'))
  )
$$;

-- DRE: valores por mês × linha × classificação, com rateio por unidade aplicado
CREATE OR REPLACE FUNCTION fin_rel_dre(p_ano int, p_regime text, p_unidade bigint, p_centro bigint)
RETURNS TABLE (mes int, dre_linha text, subgrupo text, classificacao text, valor numeric)
LANGUAGE sql STABLE AS $$
  SELECT extract(month FROM d)::int, coalesce(a.dre_linha, CASE WHEN a.tipo = 'receber' THEN 'outras_receitas' ELSE 'despesas_operacionais' END),
         coalesce(a.classificacao_subgrupo, ''), coalesce(a.classificacao_nome, '(Sem classificação)'),
         round(sum(CASE WHEN a.tipo = 'receber' THEN 1 ELSE -1 END * a.valor_final * a.fator), 2)
  FROM fin_v_alocado a
  CROSS JOIN LATERAL (SELECT CASE WHEN p_regime = 'caixa' THEN a.data_pagamento ELSE coalesce(a.competencia, a.vencimento) END AS d) x
  WHERE x.d IS NOT NULL AND extract(year FROM x.d) = p_ano
    AND (p_regime <> 'caixa' OR a.status = 'pago')
    AND coalesce(a.dre_linha, '') <> 'fora_dre'
    AND (p_unidade IS NULL OR a.unidade_alocada = p_unidade)
    AND (p_centro IS NULL OR a.centro_custo_id = p_centro)
  GROUP BY 1, 2, 3, 4
$$;

-- Fluxo mensal (regime de caixa; projeção opcional = pendentes pelo vencimento)
CREATE OR REPLACE FUNCTION fin_rel_fluxo_mensal(p_ano int, p_unidade bigint, p_centro bigint, p_projecao boolean)
RETURNS TABLE (mes int, grupo text, classificacao text, valor numeric, projetado boolean)
LANGUAGE sql STABLE AS $$
  SELECT extract(month FROM coalesce(a.data_pagamento, a.vencimento))::int,
         coalesce(a.classificacao_grupo, 'sem'), coalesce(a.classificacao_nome, '(Sem classificação)'),
         round(sum(CASE WHEN a.tipo = 'receber' THEN 1 ELSE -1 END * a.valor_final * a.fator), 2),
         a.status = 'pendente'
  FROM fin_v_alocado a
  WHERE (a.status = 'pago' OR (p_projecao AND a.status = 'pendente'))
    AND extract(year FROM coalesce(a.data_pagamento, a.vencimento)) = p_ano
    AND coalesce(a.classificacao_grupo, '') <> 'transferencia'
    AND (p_unidade IS NULL OR a.unidade_alocada = p_unidade)
    AND (p_centro IS NULL OR a.centro_custo_id = p_centro)
  GROUP BY 1, 2, 3, 5
$$;

-- Fluxo diário: realizado (baixas) ou projetado (pendentes pelo vencimento, atrasados caem hoje)
CREATE OR REPLACE FUNCTION fin_rel_fluxo_diario(p_ini date, p_fim date, p_modo text, p_unidade bigint)
RETURNS TABLE (dia date, receitas numeric, despesas numeric)
LANGUAGE sql STABLE AS $$
  SELECT d, round(coalesce(sum(a.valor_final * a.fator) FILTER (WHERE a.tipo = 'receber'), 0), 2),
            round(coalesce(sum(a.valor_final * a.fator) FILTER (WHERE a.tipo = 'pagar'), 0), 2)
  FROM fin_v_alocado a
  CROSS JOIN LATERAL (SELECT CASE WHEN p_modo = 'realizado' THEN a.data_pagamento ELSE greatest(a.vencimento, fin_hoje()) END AS d) x
  WHERE ((p_modo = 'realizado' AND a.status = 'pago') OR (p_modo <> 'realizado' AND a.status = 'pendente'))
    AND x.d BETWEEN p_ini AND p_fim
    AND coalesce(a.classificacao_grupo, '') <> 'transferencia'
    AND (p_unidade IS NULL OR a.unidade_alocada = p_unidade)
  GROUP BY d ORDER BY d
$$;

CREATE OR REPLACE FUNCTION fin_rel_resultado(p_ini date, p_fim date, p_unidade bigint, p_centro bigint) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  WITH a AS (
    SELECT * FROM fin_v_alocado
    WHERE status <> 'cancelado' AND coalesce(competencia, vencimento) BETWEEN p_ini AND p_fim
      AND coalesce(classificacao_grupo, '') NOT IN ('transferencia','aporte','retirada')
      AND (p_unidade IS NULL OR unidade_alocada = p_unidade) AND (p_centro IS NULL OR centro_custo_id = p_centro))
  SELECT jsonb_build_object(
    'receita', (SELECT coalesce(round(sum(valor_final * fator), 2), 0) FROM a WHERE tipo = 'receber'),
    'despesa', (SELECT coalesce(round(sum(valor_final * fator), 2), 0) FROM a WHERE tipo = 'pagar'),
    'comp_receitas', (SELECT coalesce(jsonb_agg(x ORDER BY x.valor DESC), '[]') FROM (
        SELECT coalesce(classificacao_nome, '(Sem classificação)') AS nome, round(sum(valor_final * fator), 2) AS valor FROM a WHERE tipo = 'receber' GROUP BY 1) x),
    'comp_despesas', (SELECT coalesce(jsonb_agg(x ORDER BY x.valor DESC), '[]') FROM (
        SELECT coalesce(classificacao_subgrupo, classificacao_nome, '(Sem classificação)') AS nome, round(sum(valor_final * fator), 2) AS valor FROM a WHERE tipo = 'pagar' GROUP BY 1) x),
    'fontes_receita', (SELECT coalesce(jsonb_agg(x ORDER BY x.valor DESC), '[]') FROM (
        SELECT coalesce(pessoa_nome, '(sem pessoa)') AS nome, round(sum(valor_final * fator), 2) AS valor FROM a WHERE tipo = 'receber' GROUP BY 1 ORDER BY 2 DESC LIMIT 15) x),
    'maiores_despesas', (SELECT coalesce(jsonb_agg(x ORDER BY x.valor DESC), '[]') FROM (
        SELECT coalesce(classificacao_nome, '(Sem classificação)') AS nome, round(sum(valor_final * fator), 2) AS valor FROM a WHERE tipo = 'pagar' GROUP BY 1 ORDER BY 2 DESC LIMIT 15) x)
  )
$$;

-- Dashboard de cobranças (Receber)
CREATE OR REPLACE FUNCTION fin_receber_dash(p_unidade bigint) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  WITH h AS (SELECT fin_hoje() AS d),
  r AS (SELECT * FROM fin_v_lanc WHERE tipo = 'receber' AND status <> 'cancelado' AND (p_unidade IS NULL OR unidade_id = p_unidade))
  SELECT jsonb_build_object(
    'venc_mes', (SELECT coalesce(sum(valor_final), 0) FROM r, h WHERE date_trunc('month', vencimento) = date_trunc('month', h.d)),
    'venc_mes_ant', (SELECT coalesce(sum(valor_final), 0) FROM r, h WHERE date_trunc('month', vencimento) = date_trunc('month', h.d) - interval '1 month'),
    'inadimplencia', (SELECT coalesce(sum(valor_final), 0) FROM r, h WHERE status = 'pendente' AND vencimento < h.d),
    'qtd_inadimplentes', (SELECT count(DISTINCT coalesce(pessoa_id::text, pessoa_nome)) FROM r, h WHERE status = 'pendente' AND vencimento < h.d),
    'ultimos_recebidos', (SELECT coalesce(jsonb_agg(x), '[]') FROM (SELECT id, pessoa_nome, classificacao_nome, valor_final, vencimento, data_pagamento FROM r WHERE status = 'pago' ORDER BY data_pagamento DESC, id DESC LIMIT 8) x),
    'ultimos_atrasados', (SELECT coalesce(jsonb_agg(x), '[]') FROM (SELECT id, pessoa_nome, classificacao_nome, valor_final, vencimento FROM r, h WHERE status = 'pendente' AND vencimento < h.d ORDER BY vencimento DESC, id DESC LIMIT 8) x),
    'meses', (SELECT coalesce(jsonb_agg(x ORDER BY x.mes), '[]') FROM (
        SELECT to_char(date_trunc('month', vencimento), 'YYYY-MM') AS mes, sum(valor_final) AS emitido, sum(valor_final) FILTER (WHERE status = 'pago') AS recebido
        FROM r, h WHERE vencimento >= date_trunc('month', h.d) - interval '5 months' AND vencimento < date_trunc('month', h.d) + interval '1 month' GROUP BY 1) x),
    'aging', (SELECT coalesce(jsonb_agg(x ORDER BY x.total DESC), '[]') FROM (
        SELECT coalesce(pessoa_nome, '(sem pessoa)') AS pessoa,
          sum(valor_final) FILTER (WHERE h.d - vencimento BETWEEN 1 AND 30) AS d30,
          sum(valor_final) FILTER (WHERE h.d - vencimento BETWEEN 31 AND 60) AS d60,
          sum(valor_final) FILTER (WHERE h.d - vencimento BETWEEN 61 AND 90) AS d90,
          sum(valor_final) FILTER (WHERE h.d - vencimento > 90) AS d90mais,
          sum(valor_final) AS total
        FROM r, h WHERE status = 'pendente' AND vencimento < h.d GROUP BY 1 ORDER BY total DESC LIMIT 50) x)
  )
$$;

-- ------------------------------------------------------------
-- 8) ANTIFRAUDE extra: baixa manual sem extrato
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_regras_v2(p_ator text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE r record; k int := 0;
BEGIN
  PERFORM fin_set_ator(p_ator);
  -- Baixa manual de pagamento sem a saída correspondente no extrato da conta (só se a conta tem extrato importado)
  FOR r IN
    SELECT b.*, l.pessoa, l.valor AS lvalor FROM fin_baixas b JOIN fin_lancamentos l ON l.id = b.lancamento_id
    WHERE NOT b.estornada AND b.origem = 'manual' AND l.tipo = 'pagar' AND b.data < fin_hoje() - 3
      AND EXISTS (SELECT 1 FROM fin_importacoes i WHERE i.conta_id = b.conta_id AND i.tipo = 'extrato' AND i.periodo_fim >= b.data)
      AND NOT EXISTS (SELECT 1 FROM fin_conciliacoes c WHERE c.lancamento_id = b.lancamento_id AND c.ativo)
  LOOP
    k := k + fin_novo_alerta('BAIXASEMEXT:'||r.id, 'BAIXA_SEM_EXTRATO', 'alto',
      'Baixa manual sem saída no extrato: '||coalesce(r.pessoa,'?'),
      jsonb_build_object('baixa_por', r.por, 'data', r.data,
        'explicacao', 'Alguém marcou como pago, mas o extrato da conta escolhida não mostra essa saída. Confira o comprovante.'),
      r.conta_id, NULL, r.lancamento_id, -(r.valor + r.juros + r.multa - r.desconto));
  END LOOP;
  RETURN jsonb_build_object('BAIXA_SEM_EXTRATO', k);
END $$;

-- encaixa a regra nova no fin_rodar_regras sem reescrever a v1
CREATE OR REPLACE FUNCTION fin_rodar_regras_todas(p_ator text DEFAULT 'sistema:regras') RETURNS jsonb
LANGUAGE plpgsql AS $$
BEGIN
  RETURN fin_rodar_regras(p_ator) || fin_regras_v2(p_ator);
END $$;

DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'fin_regras_diarias';
  PERFORM cron.schedule('fin_regras_diarias', '0 9 * * *', $c$SELECT fin_rodar_regras_todas('sistema:cron')$c$);
EXCEPTION WHEN undefined_table OR invalid_schema_name THEN NULL;
END $do$;

-- Bucket privado dos anexos
INSERT INTO storage.buckets (id, name, public) VALUES ('fin-anexos', 'fin-anexos', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- ------------------------------------------------------------
-- 9) TRAVA DE TODAS as funções fin_* (inclusive as novas)
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

-- ============================================================
-- FINANCEIRO GÂMI v3: DADOS DA FLYP (ZL Hub, franquia Machine) (09/11/2026)
-- ------------------------------------------------------------
-- Traz para o financeiro as "Transações Financeiras" do ZL Hub (app.flyp.com.br):
-- saques Pix dos condutores, recargas Pix das empresas e boletos/a receber.
-- Entrada: o CSV que o próprio ZL Hub exporta (botão CSV da tela Transações Financeiras).
-- A API da ZL só tem entregas, por isso o caminho é o arquivo.
--
-- Mesma blindagem do resto do financeiro:
--  * nada se apaga (DELETE/TRUNCATE bloqueados); importação e arquivo original imutáveis
--  * a transação só pode mudar de STATUS (ex.: "Em análise" -> "Concluído"), e cada mudança fica auditada
--  * reimportar o mesmo período não duplica (hash da linha + nº da ocorrência)
--  * RLS ligada sem policy + REVOKE: só a função do servidor (service key) enxerga
-- Rodar DEPOIS do financeiro-banco-exclusivo-COMPLETO.sql. Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS fin_flyp_importacoes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unidade        text NOT NULL,                  -- ex.: '6104' (Gami Delivery São Luís)
  arquivo_nome   text,
  arquivo_sha256 text NOT NULL,
  arquivo_bytes  integer,
  conteudo       text,                           -- arquivo original guardado como PROVA
  periodo_ini    date,
  periodo_fim    date,
  qtd_linhas     integer NOT NULL DEFAULT 0,
  qtd_novas      integer NOT NULL DEFAULT 0,
  qtd_status_mudou integer NOT NULL DEFAULT 0,
  importado_por  text NOT NULL,
  importado_em   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_flyp_imp_uk ON fin_flyp_importacoes (unidade, arquivo_sha256);

CREATE TABLE IF NOT EXISTS fin_flyp_transacoes (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unidade          text NOT NULL,
  hash             text NOT NULL,
  data             date NOT NULL,
  hora             time,                         -- boleto não tem hora
  direcao          text NOT NULL CHECK (direcao IN ('entrada','saida')),
  tipo             text NOT NULL,                -- pix | boleto | a_receber | cartao | outros
  categoria        text NOT NULL CHECK (categoria IN ('saque','recarga','boleto','a_receber','outro')),
  contraparte      text NOT NULL,
  contraparte_norm text NOT NULL,
  valor            numeric(14,2) NOT NULL,
  valor_liquido    numeric(14,2) NOT NULL,
  taxa             numeric(14,2) NOT NULL,       -- valor - líquido (o que a Gâmi fica)
  status           text NOT NULL,                -- concluido | efetivado | aberto | em_analise | expirado | rejeitado | vencido | quitado | aguardando_aprovacao | outro
  status_original  text NOT NULL,
  tem_nota         boolean NOT NULL DEFAULT false,
  importacao_id    uuid NOT NULL REFERENCES fin_flyp_importacoes(id),
  status_atualizado_em timestamptz,
  ultima_importacao_id uuid REFERENCES fin_flyp_importacoes(id),
  criado_em        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_flyp_tx_uk ON fin_flyp_transacoes (unidade, hash);
CREATE INDEX IF NOT EXISTS fin_flyp_tx_data ON fin_flyp_transacoes (unidade, data);
CREATE INDEX IF NOT EXISTS fin_flyp_tx_cp ON fin_flyp_transacoes (contraparte_norm);

-- Quem pode ver os dados da FLYP (além do super). Separado do papel do financeiro:
-- ter acesso ao financeiro NÃO dá acesso à FLYP.
CREATE TABLE IF NOT EXISTS fin_flyp_acesso (
  pessoa_id     text PRIMARY KEY,
  ativo         boolean NOT NULL DEFAULT true,
  liberado_por  text NOT NULL,
  liberado_em   timestamptz NOT NULL DEFAULT now(),
  atualizado_por text,
  atualizado_em timestamptz
);

-- Registro de TODA consulta aos dados da FLYP (quem viu o quê e quando). Imutável.
CREATE TABLE IF NOT EXISTS fin_flyp_leituras (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ator    text NOT NULL,
  acao    text NOT NULL,
  filtro  jsonb,
  qtd     integer,
  em      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_flyp_leituras_em ON fin_flyp_leituras (em DESC);

-- Transação: só status (e o carimbo de quando mudou) pode mudar
CREATE OR REPLACE FUNCTION fin_trg_flyp_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','status_original','status_atualizado_em','ultima_importacao_id','tem_nota'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','status_original','status_atualizado_em','ultima_importacao_id','tem_nota']) THEN
    RAISE EXCEPTION 'FINANCEIRO: transação da FLYP só pode mudar de status';
  END IF;
  RETURN NEW;
END $$;

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fin_flyp_importacoes','fin_flyp_transacoes','fin_flyp_acesso','fin_flyp_leituras'] LOOP
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
  DROP TRIGGER IF EXISTS fin_flyp_importacoes_noupd ON fin_flyp_importacoes;
  CREATE TRIGGER fin_flyp_importacoes_noupd BEFORE UPDATE ON fin_flyp_importacoes FOR EACH ROW EXECUTE FUNCTION fin_trg_bloqueia_update();
  DROP TRIGGER IF EXISTS fin_flyp_leituras_noupd ON fin_flyp_leituras;
  CREATE TRIGGER fin_flyp_leituras_noupd BEFORE UPDATE ON fin_flyp_leituras FOR EACH ROW EXECUTE FUNCTION fin_trg_bloqueia_update();
  DROP TRIGGER IF EXISTS fin_flyp_transacoes_guard ON fin_flyp_transacoes;
  CREATE TRIGGER fin_flyp_transacoes_guard BEFORE UPDATE ON fin_flyp_transacoes FOR EACH ROW EXECUTE FUNCTION fin_trg_flyp_guard();
END $do$;

-- Auditoria: não carrega o arquivo inteiro, e das transações/leituras da FLYP guarda só a
-- "impressão digital" (sha256 da linha) + status. Nomes de condutores e valores NUNCA vão pra
-- auditoria geral (que outras pessoas do financeiro podem ver); a cadeia de hash continua provando
-- que nada foi mexido.
CREATE OR REPLACE FUNCTION fin_trg_audit() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, extensions AS $$
DECLARE v_antes jsonb; v_depois jsonb; v_id text;
BEGIN
  IF TG_OP = 'UPDATE' THEN v_antes := to_jsonb(OLD); END IF;
  v_depois := to_jsonb(NEW);
  IF TG_TABLE_NAME IN ('fin_importacoes','fin_flyp_importacoes') THEN
    v_depois := v_depois - 'conteudo';
    IF v_antes IS NOT NULL THEN v_antes := v_antes - 'conteudo'; END IF;
  END IF;
  IF TG_TABLE_NAME IN ('fin_flyp_transacoes','fin_flyp_leituras') THEN
    v_depois := jsonb_build_object('id', v_depois->'id', 'status', v_depois->'status',
                  'impressao', encode(extensions.digest(to_jsonb(NEW)::text, 'sha256'), 'hex'));
    IF v_antes IS NOT NULL THEN
      v_antes := jsonb_build_object('id', v_antes->'id', 'status', v_antes->'status',
                  'impressao', encode(extensions.digest(to_jsonb(OLD)::text, 'sha256'), 'hex'));
    END IF;
  END IF;
  v_id := coalesce(v_depois->>'id', v_depois->>'chave', v_depois->>'pessoa_id');
  INSERT INTO fin_auditoria (seq, ator, acao, tabela, registro_id, antes, depois, hash_anterior, hash)
  VALUES (0, coalesce(nullif(current_setting('fin.ator', true),''), 'sistema:' || current_user),
          TG_OP, TG_TABLE_NAME, v_id, v_antes, v_depois, '', '');
  RETURN NEW;
END $$;

-- ------------------------------------------------------------
-- Importação (transação única). Linhas já vêm validadas e com hash do servidor.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_flyp_importar(p_ator text, p_meta jsonb, p_linhas jsonb)
RETURNS jsonb LANGUAGE plpgsql SET statement_timeout = '180s' AS $$
DECLARE v_un text := p_meta->>'unidade'; v_imp uuid; v_total int; v_novas int; v_mud int;
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF v_un IS NULL OR v_un !~ '^[0-9A-Za-z_-]{1,20}$' THEN RAISE EXCEPTION 'Unidade inválida'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('fin_flyp_import:'||v_un));
  IF EXISTS (SELECT 1 FROM fin_flyp_importacoes WHERE unidade = v_un AND arquivo_sha256 = p_meta->>'sha256') THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Este arquivo já foi importado.');
  END IF;

  CREATE TEMP TABLE _fl ON COMMIT DROP AS
  SELECT l->>'hash' AS hash, (l->>'data')::date AS data, nullif(l->>'hora','')::time AS hora, l->>'direcao' AS direcao,
         l->>'tipo' AS tipo, l->>'categoria' AS categoria, l->>'contraparte' AS contraparte, fin_norm(l->>'contraparte') AS cpn,
         (l->>'valor')::numeric AS valor, (l->>'valor_liquido')::numeric AS liq, (l->>'taxa')::numeric AS taxa,
         l->>'status' AS status, l->>'status_original' AS status_original, coalesce((l->>'tem_nota')::boolean, false) AS tem_nota
  FROM jsonb_array_elements(p_linhas) l;

  SELECT count(*), count(*) FILTER (WHERE t.id IS NULL), count(*) FILTER (WHERE t.id IS NOT NULL AND t.status IS DISTINCT FROM f.status)
    INTO v_total, v_novas, v_mud
  FROM _fl f LEFT JOIN fin_flyp_transacoes t ON t.unidade = v_un AND t.hash = f.hash;

  INSERT INTO fin_flyp_importacoes (unidade, arquivo_nome, arquivo_sha256, arquivo_bytes, conteudo, periodo_ini, periodo_fim,
                                    qtd_linhas, qtd_novas, qtd_status_mudou, importado_por)
  VALUES (v_un, p_meta->>'arquivo_nome', p_meta->>'sha256', (p_meta->>'bytes')::int, p_meta->>'conteudo',
          (SELECT min(data) FROM _fl), (SELECT max(data) FROM _fl), v_total, v_novas, v_mud, p_ator)
  RETURNING id INTO v_imp;

  INSERT INTO fin_flyp_transacoes (unidade, hash, data, hora, direcao, tipo, categoria, contraparte, contraparte_norm,
                                   valor, valor_liquido, taxa, status, status_original, tem_nota, importacao_id, ultima_importacao_id)
  SELECT v_un, hash, data, hora, direcao, tipo, categoria, contraparte, cpn, valor, liq, taxa, status, status_original, tem_nota, v_imp, v_imp
  FROM _fl
  ON CONFLICT (unidade, hash) DO NOTHING;

  UPDATE fin_flyp_transacoes t SET status = f.status, status_original = f.status_original, tem_nota = t.tem_nota OR f.tem_nota,
         status_atualizado_em = now(), ultima_importacao_id = v_imp
  FROM _fl f WHERE t.unidade = v_un AND t.hash = f.hash AND t.status IS DISTINCT FROM f.status;

  RETURN jsonb_build_object('ok', true, 'importacao_id', v_imp, 'linhas', v_total, 'novas', v_novas,
                            'status_mudou', v_mud, 'repetidas', v_total - v_novas - v_mud);
END $$;

-- ------------------------------------------------------------
-- Resumo diário: quantos saques por dia, quanto saiu, quanto a Gâmi ganhou de taxa,
-- recargas das empresas e boletos. "Efetivo" = saque concluído / recarga efetivada / boleto quitado.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_flyp_resumo_calc(p_unidade text, p_ini date, p_fim date)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH t AS (
    SELECT * FROM fin_flyp_transacoes
    WHERE (p_unidade IS NULL OR unidade = p_unidade) AND data BETWEEN p_ini AND p_fim
  ), dias AS (
    SELECT data,
      count(*) FILTER (WHERE categoria = 'saque' AND status = 'concluido')                     AS saques,
      coalesce(sum(valor) FILTER (WHERE categoria = 'saque' AND status = 'concluido'), 0)        AS saques_valor,
      coalesce(sum(valor_liquido) FILTER (WHERE categoria = 'saque' AND status = 'concluido'), 0) AS saques_liquido,
      coalesce(sum(taxa) FILTER (WHERE categoria = 'saque' AND status = 'concluido'), 0)         AS saques_taxa,
      count(DISTINCT contraparte_norm) FILTER (WHERE categoria = 'saque' AND status = 'concluido') AS condutores,
      count(*) FILTER (WHERE categoria = 'saque' AND status = 'rejeitado')                      AS saques_rejeitados,
      count(*) FILTER (WHERE categoria = 'saque' AND status = 'expirado')                       AS saques_expirados,
      count(*) FILTER (WHERE categoria = 'saque' AND status IN ('em_analise','aguardando_aprovacao','aberto')) AS saques_pendentes,
      count(*) FILTER (WHERE categoria = 'recarga' AND status = 'efetivado')                    AS recargas,
      coalesce(sum(valor) FILTER (WHERE categoria = 'recarga' AND status = 'efetivado'), 0)      AS recargas_valor,
      coalesce(sum(taxa) FILTER (WHERE categoria = 'recarga' AND status = 'efetivado'), 0)       AS recargas_taxa,
      count(*) FILTER (WHERE categoria IN ('boleto','a_receber'))                               AS boletos,
      coalesce(sum(valor) FILTER (WHERE categoria IN ('boleto','a_receber')), 0)                 AS boletos_valor,
      coalesce(sum(valor) FILTER (WHERE categoria IN ('boleto','a_receber') AND status IN ('aberto','vencido')), 0) AS boletos_em_aberto
    FROM t GROUP BY data
  )
  SELECT jsonb_build_object(
    'periodo', jsonb_build_object('ini', p_ini, 'fim', p_fim),
    'totais', (SELECT jsonb_build_object(
        'saques', coalesce(sum(saques),0), 'saques_valor', coalesce(sum(saques_valor),0), 'saques_liquido', coalesce(sum(saques_liquido),0),
        'saques_taxa', coalesce(sum(saques_taxa),0), 'saques_rejeitados', coalesce(sum(saques_rejeitados),0),
        'saques_expirados', coalesce(sum(saques_expirados),0), 'saques_pendentes', coalesce(sum(saques_pendentes),0),
        'recargas', coalesce(sum(recargas),0), 'recargas_valor', coalesce(sum(recargas_valor),0), 'recargas_taxa', coalesce(sum(recargas_taxa),0),
        'boletos', coalesce(sum(boletos),0), 'boletos_valor', coalesce(sum(boletos_valor),0), 'boletos_em_aberto', coalesce(sum(boletos_em_aberto),0),
        'dias_com_saque', count(*) FILTER (WHERE saques > 0),
        'media_saques_dia', round(coalesce(avg(saques) FILTER (WHERE saques > 0), 0), 1),
        'condutores', (SELECT count(DISTINCT contraparte_norm) FROM t WHERE categoria = 'saque' AND status = 'concluido'))
      FROM dias),
    'dias', coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.data DESC) FROM dias d), '[]'::jsonb),
    'top_condutores', coalesce((SELECT jsonb_agg(x ORDER BY x.valor DESC) FROM (
        SELECT min(contraparte) AS nome, count(*) AS saques, sum(valor) AS valor, sum(taxa) AS taxa
        FROM t WHERE categoria = 'saque' AND status = 'concluido'
        GROUP BY contraparte_norm ORDER BY sum(valor) DESC LIMIT 15) x), '[]'::jsonb),
    'ultima_importacao', (SELECT jsonb_build_object('em', importado_em, 'por', importado_por, 'periodo_ini', periodo_ini, 'periodo_fim', periodo_fim,
                                                    'novas', qtd_novas, 'linhas', qtd_linhas)
                          FROM fin_flyp_importacoes WHERE (p_unidade IS NULL OR unidade = p_unidade) ORDER BY importado_em DESC LIMIT 1),
    'cobertura', (SELECT jsonb_build_object('ini', min(data), 'fim', max(data), 'total', count(*)) FROM fin_flyp_transacoes
                  WHERE (p_unidade IS NULL OR unidade = p_unidade))
  )
$$;

-- ------------------------------------------------------------
-- Portas de LEITURA: toda consulta passa por aqui e fica registrada em fin_flyp_leituras
-- (o servidor já checou a permissão; o banco registra quem viu, mesmo que alguém chame direto).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_flyp_pode_ver(p_pessoa text) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM fin_flyp_acesso WHERE pessoa_id = p_pessoa AND ativo) $$;

CREATE OR REPLACE FUNCTION fin_flyp_resumo(p_ator text, p_unidade text, p_ini date, p_fim date)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF p_ini IS NULL OR p_fim IS NULL OR p_fim < p_ini OR p_fim - p_ini > 400 THEN RAISE EXCEPTION 'Período inválido (máx. 400 dias)'; END IF;
  r := fin_flyp_resumo_calc(p_unidade, p_ini, p_fim);
  INSERT INTO fin_flyp_leituras (ator, acao, filtro, qtd)
  VALUES (p_ator, 'resumo', jsonb_build_object('unidade', p_unidade, 'ini', p_ini, 'fim', p_fim), jsonb_array_length(r->'dias'));
  RETURN r;
END $$;

-- Lista de transações: sempre com filtro e no máximo 200 por página (nada de "baixar tudo")
CREATE OR REPLACE FUNCTION fin_flyp_listar(p_ator text, p_unidade text, p_ini date, p_fim date, p_categoria text,
                                           p_status text, p_busca text, p_pagina int)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; v_total int; v_pag int := greatest(coalesce(p_pagina, 0), 0);
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF p_ini IS NULL OR p_fim IS NULL OR p_fim < p_ini OR p_fim - p_ini > 62 THEN RAISE EXCEPTION 'Período inválido (máx. 62 dias na lista)'; END IF;
  WITH f AS (
    SELECT id, data, hora, direcao, tipo, categoria, contraparte, valor, valor_liquido, taxa, status, status_original, tem_nota
    FROM fin_flyp_transacoes
    WHERE (p_unidade IS NULL OR unidade = p_unidade) AND data BETWEEN p_ini AND p_fim
      AND (p_categoria IS NULL OR categoria = p_categoria)
      AND (p_status IS NULL OR status = p_status)
      AND (p_busca IS NULL OR contraparte_norm LIKE '%' || fin_norm(p_busca) || '%')
  )
  SELECT (SELECT count(*) FROM f),
         coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.data DESC, x.hora DESC NULLS LAST, x.id DESC)
                   FROM (SELECT * FROM f ORDER BY data DESC, hora DESC NULLS LAST, id DESC OFFSET v_pag * 200 LIMIT 200) x), '[]'::jsonb)
    INTO v_total, r;
  INSERT INTO fin_flyp_leituras (ator, acao, filtro, qtd)
  VALUES (p_ator, 'listar', jsonb_build_object('unidade', p_unidade, 'ini', p_ini, 'fim', p_fim, 'categoria', p_categoria,
                                               'status', p_status, 'busca', left(p_busca, 60), 'pagina', v_pag), jsonb_array_length(r));
  RETURN jsonb_build_object('total', v_total, 'pagina', v_pag, 'transacoes', r);
END $$;

-- Liberar/revogar quem vê a FLYP (o servidor só deixa o super chamar)
CREATE OR REPLACE FUNCTION fin_flyp_liberar(p_ator text, p_pessoa text, p_ativo boolean)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF p_pessoa IS NULL OR p_pessoa !~ '^[A-Za-z0-9_-]{2,80}$' THEN RAISE EXCEPTION 'Pessoa inválida'; END IF;
  INSERT INTO fin_flyp_acesso (pessoa_id, ativo, liberado_por) VALUES (p_pessoa, p_ativo, p_ator)
  ON CONFLICT (pessoa_id) DO UPDATE SET ativo = EXCLUDED.ativo, atualizado_por = p_ator, atualizado_em = now();
  RETURN jsonb_build_object('ok', true);
END $$;

DROP FUNCTION IF EXISTS fin_flyp_resumo(text, date, date);

-- Trava das funções novas (mesma regra do resto: só service_role executa)
DO $do$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname LIKE 'fin\_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $do$;
