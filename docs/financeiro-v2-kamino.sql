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
      classificacao_id = coalesce(EXCLUDED.classificacao_id, fin_lancamentos.classificacao_id),
      unidade_id = coalesce(EXCLUDED.unidade_id, fin_lancamentos.unidade_id), conta_id = coalesce(EXCLUDED.conta_id, fin_lancamentos.conta_id),
      valor = EXCLUDED.valor, vencimento = EXCLUDED.vencimento, competencia = EXCLUDED.competencia, data_pagamento = EXCLUDED.data_pagamento,
      situacao = EXCLUDED.situacao, status = EXCLUDED.status, cancelado_por = EXCLUDED.cancelado_por, cancelado_em = EXCLUDED.cancelado_em,
      motivo_cancelamento = EXCLUDED.motivo_cancelamento, importacao_id = EXCLUDED.importacao_id, raw = EXCLUDED.raw
    WHERE (fin_lancamentos.valor, fin_lancamentos.vencimento, fin_lancamentos.data_pagamento, fin_lancamentos.situacao, fin_lancamentos.pessoa, fin_lancamentos.categoria)
          IS DISTINCT FROM (EXCLUDED.valor, EXCLUDED.vencimento, EXCLUDED.data_pagamento, EXCLUDED.situacao, EXCLUDED.pessoa, EXCLUDED.categoria)
      -- NUNCA sobrescreve o que já foi tratado aqui dentro: baixa ativa, conciliação ativa, edição manual ou cancelamento feito no sistema
      AND NOT EXISTS (SELECT 1 FROM fin_baixas b WHERE b.lancamento_id = fin_lancamentos.id AND NOT b.estornada)
      AND NOT EXISTS (SELECT 1 FROM fin_conciliacoes c WHERE c.lancamento_id = fin_lancamentos.id AND c.ativo)
      AND fin_lancamentos.atualizado_por IS NULL
      AND (fin_lancamentos.status <> 'cancelado' OR fin_lancamentos.cancelado_por = 'kamino');
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
