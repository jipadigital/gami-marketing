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
