-- ============================================================
-- FINANCEIRO v9 (16/11/2026): ESPELHO AUTOMÁTICO DO KAMINO + CONFERÊNCIA + ANTIFRAUDE
--
-- Decisão do dono: o Kamino continua sendo onde se paga e cobra; a Cora NÃO será integrada e
-- ninguém sobe extrato. O servidor (netlify/functions/kamino-sync.js) puxa do Kamino sozinho,
-- a cada 10 min, e grava aqui. As meninas do financeiro, a Leomara e a diretoria conferem.
--
-- Garantias (no BANCO, valem até pra service key):
--  * fin_kmn_versoes / fin_kmn_conf / fin_kmn_pessoas_versoes: só INSERT (sem UPDATE/DELETE).
--    Toda mudança que alguém fizer no Kamino fica guardada com o antes e o depois, pra sempre.
--  * fin_kmn_lanc / fin_kmn_pessoas: sem DELETE; UPDATE só pela função de sincronização.
--  * Conferência é por VERSÃO: se o lançamento mudar no Kamino depois de conferido, a
--    conferência deixa de valer ("mudou depois de conferido") e, se mudou valor/favorecido/
--    destino, abre alerta.
--  * Chave Pix e conta de destino NÃO são guardadas por extenso: só a impressão digital
--    (sha256) e o final mascarado. Dá pra comparar sem expor.
--  * RLS + REVOKE: nada disso existe pra chave pública.
--
-- Rode INTEIRO no SQL Editor do projeto do financeiro (vyjjdirlgvysbalrmmih). Idempotente.
-- ============================================================

-- data 'AAAA-MM-DD' -> date, sem depender de configuração (pode ir em coluna gerada)
CREATE OR REPLACE FUNCTION fin__kd(t text) RETURNS date
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN t ~ '^\d{4}-\d{2}-\d{2}' THEN make_date(substr(t,1,4)::int, substr(t,6,2)::int, substr(t,9,2)::int) END
$$;
CREATE OR REPLACE FUNCTION fin__kn(t text) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN t ~ '^-?\d+(\.\d+)?$' THEN round(t::numeric, 2) END
$$;

-- ---------------- Lançamentos espelhados (estado atual) ----------------
CREATE TABLE IF NOT EXISTS fin_kmn_lanc (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo           text NOT NULL CHECK (tipo IN ('pagar','receber')),
  kamino_id      bigint NOT NULL,
  dados          jsonb NOT NULL,
  hash           text NOT NULL,          -- impressão digital de tudo (muda = nova versão)
  hash_conf      text NOT NULL,          -- impressão digital do que a conferência atesta
  versao         int NOT NULL DEFAULT 1,
  primeiro_visto timestamptz NOT NULL DEFAULT now(),
  ultimo_visto   timestamptz NOT NULL DEFAULT now(),
  alterado_em    timestamptz NOT NULL DEFAULT now(),
  sumiu_em       timestamptz,            -- não aparece mais no Kamino (provável exclusão)
  -- colunas de consulta, calculadas a partir de "dados"
  pessoa         text    GENERATED ALWAYS AS (dados->>'pessoa') STORED,
  pessoa_kmn_id  bigint  GENERATED ALWAYS AS (CASE WHEN (dados->>'pessoa_kmn_id') ~ '^\d+$' THEN (dados->>'pessoa_kmn_id')::bigint END) STORED,
  valor          numeric GENERATED ALWAYS AS (fin__kn(dados->>'valor')) STORED,
  valor_pago     numeric GENERATED ALWAYS AS (fin__kn(dados->>'valor_pago')) STORED,
  vencimento     date    GENERATED ALWAYS AS (fin__kd(dados->>'vencimento')) STORED,
  data_pagamento date    GENERATED ALWAYS AS (fin__kd(dados->>'data_pagamento')) STORED,
  situacao       text    GENERATED ALWAYS AS (dados->>'situacao') STORED,
  unidade        text    GENERATED ALWAYS AS (dados->>'unidade') STORED,
  classificacao  text    GENERATED ALWAYS AS (dados->>'classificacao') STORED,
  destino_hash   text    GENERATED ALWAYS AS (dados->>'destino_hash') STORED,
  UNIQUE (tipo, kamino_id)
);
CREATE INDEX IF NOT EXISTS fin_kmn_lanc_pag  ON fin_kmn_lanc (tipo, data_pagamento);
CREATE INDEX IF NOT EXISTS fin_kmn_lanc_venc ON fin_kmn_lanc (tipo, vencimento);
CREATE INDEX IF NOT EXISTS fin_kmn_lanc_pes  ON fin_kmn_lanc (tipo, pessoa_kmn_id);
CREATE INDEX IF NOT EXISTS fin_kmn_lanc_dest ON fin_kmn_lanc (destino_hash) WHERE destino_hash IS NOT NULL;

-- ---------------- Histórico (cada versão vista no Kamino) ----------------
CREATE TABLE IF NOT EXISTS fin_kmn_versoes (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lanc_id   bigint NOT NULL REFERENCES fin_kmn_lanc(id),
  versao    int NOT NULL,
  hash      text NOT NULL,
  dados     jsonb NOT NULL,
  mudou     text[],                      -- campos que mudaram em relação à versão anterior
  visto_em  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lanc_id, versao)
);

-- ---------------- Conferências (append-only, por versão) ----------------
CREATE TABLE IF NOT EXISTS fin_kmn_conf (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lanc_id    bigint NOT NULL REFERENCES fin_kmn_lanc(id),
  versao     int NOT NULL,
  hash_conf  text NOT NULL,
  resultado  text NOT NULL CHECK (resultado IN ('ok','divergente','suspeito')),
  observacao text,
  por        text NOT NULL,
  em         timestamptz NOT NULL DEFAULT now(),
  CHECK (resultado = 'ok' OR length(btrim(coalesce(observacao,''))) >= 10)
);
CREATE INDEX IF NOT EXISTS fin_kmn_conf_lanc ON fin_kmn_conf (lanc_id, em DESC);

-- ---------------- Pessoas do Kamino (só o que serve pro antifraude) ----------------
CREATE TABLE IF NOT EXISTS fin_kmn_pessoas (
  kamino_id      bigint PRIMARY KEY,
  nome           text,
  doc            text,
  pix_tipo       text,
  pix_hash       text,
  pix_final      text,
  ativo          boolean,
  hash           text NOT NULL,
  versao         int NOT NULL DEFAULT 1,
  primeiro_visto timestamptz NOT NULL DEFAULT now(),
  ultimo_visto   timestamptz NOT NULL DEFAULT now(),
  alterado_em    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fin_kmn_pessoas_versoes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kamino_id  bigint NOT NULL,
  versao     int NOT NULL,
  nome       text,
  doc        text,
  pix_tipo   text,
  pix_hash   text,
  pix_final  text,
  ativo      boolean,
  visto_em   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kamino_id, versao)
);

-- ---------------- Estado da sincronização ----------------
CREATE TABLE IF NOT EXISTS fin_kmn_sync (
  chave          text PRIMARY KEY,
  estado         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ultimo_ok      timestamptz,
  ultimo_erro    text,
  ultimo_erro_em timestamptz,
  atualizado_em  timestamptz NOT NULL DEFAULT now()
);

-- alertas apontam pro lançamento espelhado
ALTER TABLE fin_alertas ADD COLUMN IF NOT EXISTS kmn_lanc_id bigint REFERENCES fin_kmn_lanc(id);
CREATE INDEX IF NOT EXISTS fin_alertas_kmn ON fin_alertas (kmn_lanc_id) WHERE kmn_lanc_id IS NOT NULL;

INSERT INTO fin_config (chave, valor, descricao) VALUES
  ('kmn_limite_sem_anexo', '1000', 'Pagamento do Kamino a partir deste valor (R$) sem anexo (nota/boleto) vira alerta'),
  ('kmn_dias_conciliar',   '5',    'Pagamento pago há mais de X dias sem conciliação bancária no Kamino vira alerta')
ON CONFLICT (chave) DO NOTHING;

-- ---------------- Blindagem ----------------
-- fin_kmn_lanc / fin_kmn_pessoas: UPDATE só dentro das funções de sincronização (fin.kmn = '1')
CREATE OR REPLACE FUNCTION fin_trg_kmn_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('fin.kmn', true), '') <> '1' THEN
    RAISE EXCEPTION 'FINANCEIRO: % só é alterada pela sincronização com o Kamino', TG_TABLE_NAME;
  END IF;
  IF TG_TABLE_NAME = 'fin_kmn_lanc' THEN
    IF to_jsonb(NEW)->>'tipo' <> to_jsonb(OLD)->>'tipo' OR NEW.kamino_id <> OLD.kamino_id OR NEW.primeiro_visto <> OLD.primeiro_visto THEN
      RAISE EXCEPTION 'FINANCEIRO: identidade do lançamento espelhado não muda';
    END IF;
  ELSIF NEW.kamino_id <> OLD.kamino_id OR NEW.primeiro_visto <> OLD.primeiro_visto THEN
    RAISE EXCEPTION 'FINANCEIRO: identidade da pessoa espelhada não muda';
  END IF;
  RETURN NEW;
END $$;

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fin_kmn_lanc','fin_kmn_versoes','fin_kmn_conf','fin_kmn_pessoas','fin_kmn_pessoas_versoes','fin_kmn_sync'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %s TO service_role', t);
  END LOOP;
  -- nada se apaga (o estado da sincronização pode ser zerado só reescrevendo, nunca apagando)
  FOREACH t IN ARRAY ARRAY['fin_kmn_lanc','fin_kmn_versoes','fin_kmn_conf','fin_kmn_pessoas','fin_kmn_pessoas_versoes','fin_kmn_sync'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_nodel ON %1$s', t);
    EXECUTE format('CREATE TRIGGER %1$s_nodel BEFORE DELETE ON %1$s FOR EACH ROW EXECUTE FUNCTION fin_trg_bloqueia_delete()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_notrunc ON %1$s', t);
    EXECUTE format('CREATE TRIGGER %1$s_notrunc BEFORE TRUNCATE ON %1$s FOR EACH STATEMENT EXECUTE FUNCTION fin_trg_bloqueia_delete()', t);
  END LOOP;
  -- histórico e conferências: imutáveis
  FOREACH t IN ARRAY ARRAY['fin_kmn_versoes','fin_kmn_conf','fin_kmn_pessoas_versoes'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_noupd ON %1$s', t);
    EXECUTE format('CREATE TRIGGER %1$s_noupd BEFORE UPDATE ON %1$s FOR EACH ROW EXECUTE FUNCTION fin_trg_bloqueia_update()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['fin_kmn_lanc','fin_kmn_pessoas'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_guard ON %1$s', t);
    EXECUTE format('CREATE TRIGGER %1$s_guard BEFORE UPDATE ON %1$s FOR EACH ROW EXECUTE FUNCTION fin_trg_kmn_guard()', t);
  END LOOP;
  -- conferência é ato de gente: entra na cadeia de auditoria (o espelho não, senão a cadeia vira o Kamino inteiro)
  DROP TRIGGER IF EXISTS fin_kmn_conf_audit ON fin_kmn_conf;
  CREATE TRIGGER fin_kmn_conf_audit AFTER INSERT ON fin_kmn_conf FOR EACH ROW EXECUTE FUNCTION fin_trg_audit();
END $do$;

-- ---------------- Utilitários ----------------
CREATE OR REPLACE FUNCTION fin__kmn_alerta(p_chave text, p_regra text, p_sev text, p_titulo text, p_detalhe jsonb, p_lanc bigint, p_valor numeric)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO fin_alertas (chave, regra, severidade, titulo, detalhe, kmn_lanc_id, valor)
  VALUES (p_chave, p_regra, p_sev, left(p_titulo, 300), p_detalhe, p_lanc, p_valor)
  ON CONFLICT (chave) DO NOTHING
$$;

-- mesma pessoa? (Kamino guarda "Leomara", o dashboard "Leomara Souza"): 1º nome igual e,
-- se os dois tiverem sobrenome, o 2º nome também
CREATE OR REPLACE FUNCTION fin__kmn_mesma_pessoa(a text, b text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN fin_norm(a) IS NULL OR fin_norm(b) IS NULL THEN false
    ELSE split_part(fin_norm(a),' ',1) = split_part(fin_norm(b),' ',1)
     AND (split_part(fin_norm(a),' ',2) = '' OR split_part(fin_norm(b),' ',2) = ''
          OR split_part(fin_norm(a),' ',2) = split_part(fin_norm(b),' ',2)) END
$$;

-- classificação que é pagamento normal pra gente da equipe (salário/benefício)
CREATE OR REPLACE FUNCTION fin__kmn_eh_folha(c text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(fin_norm(c), '') ~ '(SALARI|BENEFICI|PLANO DE SAUDE|FGTS|INSS|IRRF|FERIAS|RESCIS|PRO ?LABORE|DECIMO TERCEIRO|VALE (ALIMENTA|REFEI|TRANSP)|\mVA\M|\mVR\M|\mVT\M)'
$$;

-- ---------------- Regras (rodam a cada lançamento novo ou mudado) ----------------
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
END $$;

-- ---------------- Aplicar o que veio do Kamino ----------------
-- p_itens: [{kamino_id, hash, hash_conf, dados:{...}}]. p_silencioso: carga inicial (não gera alerta).
CREATE OR REPLACE FUNCTION fin_kmn_aplicar(p_tipo text, p_itens jsonb, p_silencioso boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public, extensions AS $$
DECLARE
  it jsonb; r fin_kmn_lanc%ROWTYPE; v_id bigint; v_d jsonb; v_mudou text[];
  n_novos int := 0; n_mud int := 0; n_iguais int := 0;
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
      -- igual: só marca que ainda existe (sem reescrever a linha toda vez)
      IF r.sumiu_em IS NOT NULL OR r.ultimo_visto < now() - interval '6 hours' THEN
        UPDATE fin_kmn_lanc SET ultimo_visto = now(), sumiu_em = NULL WHERE id = r.id;
      END IF;
      n_iguais := n_iguais + 1;
    ELSE
      SELECT array_agg(k ORDER BY k) INTO v_mudou FROM (
        SELECT key AS k FROM jsonb_each(v_d) UNION SELECT key FROM jsonb_each(r.dados)) z
       WHERE (v_d->z.k) IS DISTINCT FROM (r.dados->z.k);
      UPDATE fin_kmn_lanc SET dados = v_d, hash = it->>'hash', hash_conf = it->>'hash_conf', versao = r.versao + 1,
             alterado_em = now(), ultimo_visto = now(), sumiu_em = NULL
       WHERE id = r.id;
      INSERT INTO fin_kmn_versoes (lanc_id, versao, hash, dados, mudou) VALUES (r.id, r.versao + 1, it->>'hash', v_d, v_mudou);
      n_mud := n_mud + 1;
      IF NOT p_silencioso THEN PERFORM fin__kmn_regras(r.id, r.dados, v_mudou, r.hash_conf); END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('novos', n_novos, 'mudaram', n_mud, 'iguais', n_iguais);
END $$;

-- Lançamentos que SUMIRAM do Kamino (o servidor já confirmou buscando pelo ID)
CREATE OR REPLACE FUNCTION fin_kmn_sumiram(p_tipo text, p_ids bigint[], p_silencioso boolean DEFAULT false)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE l fin_kmn_lanc%ROWTYPE; n int := 0;
BEGIN
  PERFORM set_config('fin.ator', 'sistema:kamino', true);
  PERFORM set_config('fin.kmn', '1', true);
  FOR l IN SELECT * FROM fin_kmn_lanc WHERE tipo = p_tipo AND kamino_id = ANY(p_ids) AND sumiu_em IS NULL FOR UPDATE LOOP
    UPDATE fin_kmn_lanc SET sumiu_em = now() WHERE id = l.id;
    n := n + 1;
    IF NOT p_silencioso THEN
      PERFORM fin__kmn_alerta('kmn_sumiu:' || l.id || ':' || l.versao, 'KMN_EXCLUIDO_NO_KAMINO',
        CASE WHEN l.data_pagamento IS NOT NULL THEN 'critico' ELSE 'alto' END,
        (CASE l.tipo WHEN 'pagar' THEN 'Pagamento' ELSE 'Recebimento' END) || ' Kamino #' || l.kamino_id || ' · ' || coalesce(l.pessoa, '?') || ': sumiu do Kamino (excluído)',
        jsonb_build_object('ultima_versao', l.dados), l.id, l.valor);
    END IF;
  END LOOP;
  RETURN n;
END $$;

-- Pessoas: troca de chave Pix / documento
CREATE OR REPLACE FUNCTION fin_kmn_pessoas_aplicar(p_itens jsonb, p_silencioso boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE it jsonb; r fin_kmn_pessoas%ROWTYPE; n_novos int := 0; n_mud int := 0; v_pag int; v_ult date;
BEGIN
  IF jsonb_typeof(p_itens) <> 'array' THEN RAISE EXCEPTION 'FINANCEIRO: itens inválidos'; END IF;
  PERFORM set_config('fin.ator', 'sistema:kamino', true);
  PERFORM set_config('fin.kmn', '1', true);
  FOR it IN SELECT value FROM jsonb_array_elements(p_itens) LOOP
    IF NOT ((it->>'kamino_id') ~ '^\d+$') OR coalesce(it->>'hash','') = '' THEN RAISE EXCEPTION 'FINANCEIRO: pessoa do Kamino incompleta'; END IF;
    SELECT * INTO r FROM fin_kmn_pessoas WHERE kamino_id = (it->>'kamino_id')::bigint FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO fin_kmn_pessoas (kamino_id, nome, doc, pix_tipo, pix_hash, pix_final, ativo, hash)
      VALUES ((it->>'kamino_id')::bigint, it->>'nome', it->>'doc', it->>'pix_tipo', nullif(it->>'pix_hash',''), it->>'pix_final', (it->>'ativo')::boolean, it->>'hash');
      INSERT INTO fin_kmn_pessoas_versoes (kamino_id, versao, nome, doc, pix_tipo, pix_hash, pix_final, ativo)
      VALUES ((it->>'kamino_id')::bigint, 1, it->>'nome', it->>'doc', it->>'pix_tipo', nullif(it->>'pix_hash',''), it->>'pix_final', (it->>'ativo')::boolean);
      n_novos := n_novos + 1;
    ELSIF r.hash <> it->>'hash' THEN
      UPDATE fin_kmn_pessoas SET nome = it->>'nome', doc = it->>'doc', pix_tipo = it->>'pix_tipo', pix_hash = nullif(it->>'pix_hash',''),
             pix_final = it->>'pix_final', ativo = (it->>'ativo')::boolean, hash = it->>'hash', versao = r.versao + 1,
             alterado_em = now(), ultimo_visto = now()
       WHERE kamino_id = r.kamino_id;
      INSERT INTO fin_kmn_pessoas_versoes (kamino_id, versao, nome, doc, pix_tipo, pix_hash, pix_final, ativo)
      VALUES (r.kamino_id, r.versao + 1, it->>'nome', it->>'doc', it->>'pix_tipo', nullif(it->>'pix_hash',''), it->>'pix_final', (it->>'ativo')::boolean);
      n_mud := n_mud + 1;
      IF NOT p_silencioso THEN
        SELECT count(*), max(data_pagamento) INTO v_pag, v_ult FROM fin_kmn_lanc
         WHERE tipo = 'pagar' AND pessoa_kmn_id = r.kamino_id AND data_pagamento >= current_date - 180;
        IF r.pix_hash IS NOT NULL AND r.pix_hash IS DISTINCT FROM nullif(it->>'pix_hash','') THEN
          PERFORM fin__kmn_alerta('kmn_pix:' || r.kamino_id || ':' || (r.versao + 1), 'KMN_PIX_ALTERADO',
            CASE WHEN v_pag > 0 THEN 'critico' ELSE 'medio' END,
            'Chave Pix trocada no Kamino: ' || coalesce(it->>'nome', r.nome, '?'),
            jsonb_build_object('pix_antes', coalesce(r.pix_tipo,'') || ' ' || coalesce(r.pix_final,''),
                               'pix_depois', coalesce(it->>'pix_tipo','') || ' ' || coalesce(it->>'pix_final',''),
                               'pagamentos_180d', v_pag, 'ultimo_pagamento', v_ult), NULL, NULL);
        END IF;
        IF r.doc IS NOT NULL AND r.doc IS DISTINCT FROM it->>'doc' THEN
          PERFORM fin__kmn_alerta('kmn_doc:' || r.kamino_id || ':' || (r.versao + 1), 'KMN_DOCUMENTO_ALTERADO', 'alto',
            'CPF/CNPJ trocado no cadastro do Kamino: ' || coalesce(it->>'nome', r.nome, '?'),
            jsonb_build_object('pagamentos_180d', v_pag), NULL, NULL);
        END IF;
      END IF;
    ELSIF r.ultimo_visto < now() - interval '6 hours' THEN
      UPDATE fin_kmn_pessoas SET ultimo_visto = now() WHERE kamino_id = r.kamino_id;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('novos', n_novos, 'mudaram', n_mud);
END $$;

-- ---------------- Conferência ----------------
CREATE OR REPLACE VIEW fin_kmn_v AS
SELECT l.id, l.tipo, l.kamino_id, l.dados, l.versao, l.primeiro_visto, l.ultimo_visto, l.alterado_em, l.sumiu_em,
       l.pessoa, l.pessoa_kmn_id, l.valor, l.valor_pago, l.vencimento, l.data_pagamento, l.situacao, l.unidade, l.classificacao,
       c.oks, c.ult_res, c.ult_por, c.ult_em, coalesce(c.antes, false) AS conferido_antes,
       CASE WHEN c.ult_res IN ('suspeito','divergente') THEN c.ult_res
            WHEN coalesce(c.oks,0) >= (CASE WHEN coalesce(l.valor_pago, l.valor, 0) >= lim.v THEN 2 ELSE 1 END) THEN 'ok'
            WHEN coalesce(c.oks,0) >= 1 THEN 'aguardando_2a'
            WHEN c.antes THEN 'mudou'
            ELSE 'pendente' END AS conf_status
  FROM fin_kmn_lanc l
  CROSS JOIN (SELECT coalesce((SELECT (valor #>> '{}')::numeric FROM fin_config WHERE chave = 'limite_dupla_conferencia'), 5000) AS v) lim
  LEFT JOIN LATERAL (
    SELECT count(DISTINCT x.por) FILTER (WHERE x.resultado = 'ok' AND x.hash_conf = l.hash_conf) AS oks,
           (array_agg(x.resultado ORDER BY x.em DESC) FILTER (WHERE x.hash_conf = l.hash_conf))[1] AS ult_res,
           (array_agg(x.por ORDER BY x.em DESC) FILTER (WHERE x.hash_conf = l.hash_conf))[1] AS ult_por,
           max(x.em) FILTER (WHERE x.hash_conf = l.hash_conf) AS ult_em,
           bool_or(x.hash_conf <> l.hash_conf) AS antes
      FROM fin_kmn_conf x WHERE x.lanc_id = l.id) c ON true;
REVOKE ALL ON fin_kmn_v FROM PUBLIC, anon, authenticated;
GRANT SELECT ON fin_kmn_v TO service_role;

-- Conferir. Regras: observação obrigatória fora do "ok"; quem lançou no Kamino não confere o
-- próprio lançamento; a mesma pessoa não conta 2x na dupla conferência.
CREATE OR REPLACE FUNCTION fin_kmn_conferir(p_ator text, p_ids bigint[], p_resultado text, p_obs text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE l fin_kmn_lanc%ROWTYPE; v_nome text; n int := 0; pul int := 0; motivos text[] := '{}'; v_conf bigint;
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF p_resultado NOT IN ('ok','divergente','suspeito') THEN RAISE EXCEPTION 'FINANCEIRO: resultado inválido'; END IF;
  IF p_resultado <> 'ok' AND length(btrim(coalesce(p_obs,''))) < 10 THEN RAISE EXCEPTION 'FINANCEIRO: escreva o que está errado (mín. 10 letras)'; END IF;
  IF coalesce(array_length(p_ids,1),0) = 0 OR array_length(p_ids,1) > 500 THEN RAISE EXCEPTION 'FINANCEIRO: selecione de 1 a 500 lançamentos'; END IF;
  SELECT nome INTO v_nome FROM fin_equipe WHERE pessoa_id = p_ator;
  FOR l IN SELECT * FROM fin_kmn_lanc WHERE id = ANY(p_ids) ORDER BY id LOOP
    IF l.tipo = 'pagar' AND v_nome IS NOT NULL AND fin__kmn_mesma_pessoa(v_nome, l.dados->>'incluido_por') THEN
      pul := pul + 1; motivos := motivos || ('#' || l.kamino_id || ' foi lançado por você no Kamino'); CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM fin_kmn_conf c WHERE c.lanc_id = l.id AND c.hash_conf = l.hash_conf AND c.por = p_ator AND c.resultado = p_resultado) THEN
      pul := pul + 1; CONTINUE;
    END IF;
    INSERT INTO fin_kmn_conf (lanc_id, versao, hash_conf, resultado, observacao, por)
    VALUES (l.id, l.versao, l.hash_conf, p_resultado, nullif(btrim(coalesce(p_obs,'')),''), p_ator) RETURNING id INTO v_conf;
    n := n + 1;
    IF p_resultado <> 'ok' THEN
      PERFORM fin__kmn_alerta('kmn_conf:' || v_conf, CASE p_resultado WHEN 'suspeito' THEN 'KMN_MARCADO_SUSPEITO' ELSE 'KMN_MARCADO_DIVERGENTE' END,
        CASE p_resultado WHEN 'suspeito' THEN 'alto' ELSE 'medio' END,
        (CASE l.tipo WHEN 'pagar' THEN 'Pagamento' ELSE 'Recebimento' END) || ' Kamino #' || l.kamino_id || ' · ' || coalesce(l.pessoa,'?') ||
          ': marcado ' || p_resultado || ' na conferência',
        jsonb_build_object('observacao', p_obs, 'por', p_ator), l.id, coalesce(l.valor_pago, l.valor));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('conferidos', n, 'pulados', pul, 'motivos', to_jsonb(motivos[1:5]));
END $$;

-- O que mudou no Kamino (cada versão com a anterior ao lado)
CREATE OR REPLACE VIEW fin_kmn_v_mudancas AS
SELECT v.id, v.lanc_id, v.versao, v.visto_em, v.mudou, v.dados AS depois,
       lag(v.dados) OVER (PARTITION BY v.lanc_id ORDER BY v.versao) AS antes,
       l.tipo, l.kamino_id, l.pessoa, l.unidade, l.sumiu_em
  FROM fin_kmn_versoes v JOIN fin_kmn_lanc l ON l.id = v.lanc_id;
REVOKE ALL ON fin_kmn_v_mudancas FROM PUBLIC, anon, authenticated;
GRANT SELECT ON fin_kmn_v_mudancas TO service_role;

-- Resumo da tela de conferência (período por data de pagamento ou de vencimento)
CREATE OR REPLACE FUNCTION fin_kmn_resumo(p_tipo text, p_campo text, p_ini date, p_fim date)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH b AS (
    SELECT * FROM fin_kmn_v
     WHERE tipo = p_tipo AND sumiu_em IS NULL
       AND CASE WHEN p_campo = 'vencimento' THEN vencimento ELSE data_pagamento END BETWEEN p_ini AND p_fim)
  SELECT jsonb_build_object(
    'qtd', (SELECT count(*) FROM b),
    'valor', (SELECT coalesce(sum(coalesce(valor_pago, valor)),0) FROM b),
    'por_status', coalesce((SELECT jsonb_object_agg(conf_status, jsonb_build_object('qtd', q, 'valor', v))
                              FROM (SELECT conf_status, count(*) q, sum(coalesce(valor_pago, valor)) v FROM b GROUP BY 1) x), '{}'::jsonb),
    'alterados', (SELECT count(*) FROM b WHERE versao > 1),
    'unidades', coalesce((SELECT jsonb_agg(u ORDER BY u) FROM (SELECT DISTINCT unidade u FROM fin_kmn_lanc WHERE tipo = p_tipo AND unidade IS NOT NULL) z), '[]'::jsonb),
    'sumidos', (SELECT count(*) FROM fin_kmn_lanc WHERE tipo = p_tipo AND sumiu_em IS NOT NULL),
    'total_espelho', (SELECT count(*) FROM fin_kmn_lanc WHERE tipo = p_tipo))
$$;

-- ---------------- Regras diárias (pg_cron) ----------------
CREATE OR REPLACE FUNCTION fin_kmn_regras_diarias() RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_lim numeric; v_dias int; l record; n int := 0;
BEGIN
  PERFORM set_config('fin.ator', 'sistema:cron', true);
  v_lim := coalesce((SELECT (valor #>> '{}')::numeric FROM fin_config WHERE chave = 'kmn_limite_sem_anexo'), 1000);
  v_dias := coalesce((SELECT (valor #>> '{}')::int FROM fin_config WHERE chave = 'kmn_dias_conciliar'), 5);
  -- pago (saiu do banco segundo o Kamino) há X dias e o Kamino NÃO achou a saída no extrato da Cora
  FOR l IN SELECT * FROM fin_kmn_lanc WHERE tipo = 'pagar' AND sumiu_em IS NULL AND data_pagamento IS NOT NULL
             AND data_pagamento BETWEEN current_date - 60 AND current_date - v_dias
             AND coalesce((dados->>'conciliado')::boolean, false) = false LOOP
    PERFORM fin__kmn_alerta('kmn_sem_conc:' || l.id, 'KMN_PAGO_SEM_CONCILIACAO', 'medio',
      'Pagamento Kamino #' || l.kamino_id || ' · ' || coalesce(l.pessoa,'?') || ': marcado pago há mais de ' || v_dias || ' dias e não conciliado com o banco',
      jsonb_build_object('data_pagamento', l.data_pagamento, 'conta', l.dados->>'conta'), l.id, coalesce(l.valor_pago, l.valor));
    n := n + 1;
  END LOOP;
  -- pago acima do limite sem nota/boleto anexado
  FOR l IN SELECT * FROM fin_kmn_lanc WHERE tipo = 'pagar' AND sumiu_em IS NULL AND data_pagamento >= current_date - 60
             AND coalesce(valor_pago, valor, 0) >= v_lim AND coalesce((dados->>'anexos')::boolean, false) = false
             AND NOT fin__kmn_eh_folha(classificacao) LOOP
    PERFORM fin__kmn_alerta('kmn_sem_anexo:' || l.id, 'KMN_PAGO_SEM_ANEXO', 'baixo',
      'Pagamento Kamino #' || l.kamino_id || ' · ' || coalesce(l.pessoa,'?') || ': pago sem nota/boleto anexado',
      jsonb_build_object('classificacao', l.classificacao), l.id, coalesce(l.valor_pago, l.valor));
    n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('verificados', n);
END $$;

DO $$ BEGIN
  PERFORM cron.unschedule('fin_kmn_diarias');
EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN
  PERFORM cron.schedule('fin_kmn_diarias', '30 9 * * *', $c$SELECT fin_kmn_regras_diarias()$c$);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pg_cron indisponível: rode fin_kmn_regras_diarias() pelo servidor'; END $$;

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

-- Conferência rápida depois de rodar (deve mostrar as 6 tabelas com RLS ligada):
-- SELECT relname, relrowsecurity FROM pg_class WHERE relname LIKE 'fin_kmn%' AND relkind = 'r';
