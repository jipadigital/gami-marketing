-- ============================================================
-- FINANCEIRO GÂMI v6: MOTOBOYS SEMANAL CALCULADO PELAS CORRIDAS DA MACHINE (10/11/2026)
-- ------------------------------------------------------------
-- A planilha MOTOBOYS = soma das corridas FINALIZADAS de cada motoboy na semana (validado em
-- 26/10 a 01/11 em João Pessoa: 192 motoboys, R$ 46.018,73, idêntico à planilha).
-- O servidor busca a Machine DIA A DIA e guarda só o necessário (id da corrida, motoboy, valor,
-- status): sem passageiro, sem endereço. Corrida não se repete (chave = cidade + id da corrida).
-- "Gerar a semana" só com a semana FECHADA e os 7 dias buscados; cria as linhas da planilha
-- Motoboys (origem 'machine') sem duplicar o que já foi lançado. Rodar depois do v5. Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS fin_ctl_machine_corridas (
  unidade_id    bigint NOT NULL REFERENCES fin_unidades(id),
  corrida_id    text NOT NULL CHECK (corrida_id ~ '^[0-9A-Za-z_-]{1,40}$'),
  dia           date NOT NULL,                  -- dia da busca (o mesmo recorte que gerou a planilha)
  data_hora     text,
  condutor_id   text NOT NULL,
  condutor_nome text,
  valor         numeric(14,2) NOT NULL,
  status        text NOT NULL,                  -- F = finalizada, C = cancelada...
  buscado_por   text NOT NULL,
  buscado_em    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (unidade_id, corrida_id)
);
CREATE INDEX IF NOT EXISTS fin_ctl_mq_dia ON fin_ctl_machine_corridas (unidade_id, dia);

CREATE TABLE IF NOT EXISTS fin_ctl_machine_dias (
  unidade_id   bigint NOT NULL REFERENCES fin_unidades(id),
  dia          date NOT NULL,
  corridas     integer NOT NULL,
  finalizadas  integer NOT NULL,
  valor        numeric(14,2) NOT NULL,
  completo     boolean NOT NULL,                -- false = a Machine cortou (truncado): não deixa gerar a semana
  buscado_por  text NOT NULL,
  buscado_em   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (unidade_id, dia)
);

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fin_ctl_machine_corridas','fin_ctl_machine_dias'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_nodel ON %1$s', t);
    EXECUTE format('CREATE TRIGGER %1$s_nodel BEFORE DELETE ON %1$s FOR EACH ROW EXECUTE FUNCTION fin_trg_bloqueia_delete()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_notrunc ON %1$s', t);
    EXECUTE format('CREATE TRIGGER %1$s_notrunc BEFORE TRUNCATE ON %1$s FOR EACH STATEMENT EXECUTE FUNCTION fin_trg_bloqueia_delete()', t);
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %s TO service_role', t);
  END LOOP;
  -- o resumo do dia é auditado (quem buscou, quanto deu); as corridas em si não (volume alto, dado bruto)
  DROP TRIGGER IF EXISTS fin_ctl_machine_dias_audit ON fin_ctl_machine_dias;
  CREATE TRIGGER fin_ctl_machine_dias_audit AFTER INSERT OR UPDATE ON fin_ctl_machine_dias FOR EACH ROW EXECUTE FUNCTION fin_trg_audit();
END $do$;

-- Guarda as corridas de UM dia (o servidor já validou e enxugou os campos)
CREATE OR REPLACE FUNCTION fin_ctl_machine_salvar_dia(p_ator text, p_unidade bigint, p_dia date, p_completo boolean, p_corridas jsonb)
RETURNS jsonb LANGUAGE plpgsql SET statement_timeout = '120s' AS $$
DECLARE v_total int; v_fin int; v_valor numeric;
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF NOT EXISTS (SELECT 1 FROM fin_unidades WHERE id = p_unidade) THEN RAISE EXCEPTION 'Cidade inválida'; END IF;
  IF p_dia IS NULL OR p_dia >= fin_hoje() THEN RAISE EXCEPTION 'Só dá pra buscar dias que já terminaram'; END IF;
  INSERT INTO fin_ctl_machine_corridas (unidade_id, corrida_id, dia, data_hora, condutor_id, condutor_nome, valor, status, buscado_por)
  SELECT p_unidade, c->>'id', p_dia, c->>'data_hora', c->>'condutor_id', left(c->>'condutor_nome', 200), (c->>'valor')::numeric, c->>'status', p_ator
  FROM jsonb_array_elements(p_corridas) c
  ON CONFLICT (unidade_id, corrida_id) DO UPDATE SET status = EXCLUDED.status, valor = EXCLUDED.valor, condutor_id = EXCLUDED.condutor_id,
    condutor_nome = EXCLUDED.condutor_nome, buscado_por = EXCLUDED.buscado_por, buscado_em = now()
  WHERE fin_ctl_machine_corridas.dia = EXCLUDED.dia;   -- corrida já contada em outro dia não muda de dia
  SELECT count(*), count(*) FILTER (WHERE status = 'F'), coalesce(sum(valor) FILTER (WHERE status = 'F'), 0)
    INTO v_total, v_fin, v_valor FROM fin_ctl_machine_corridas WHERE unidade_id = p_unidade AND dia = p_dia;
  INSERT INTO fin_ctl_machine_dias (unidade_id, dia, corridas, finalizadas, valor, completo, buscado_por)
  VALUES (p_unidade, p_dia, v_total, v_fin, v_valor, coalesce(p_completo, false), p_ator)
  ON CONFLICT (unidade_id, dia) DO UPDATE SET corridas = EXCLUDED.corridas, finalizadas = EXCLUDED.finalizadas, valor = EXCLUDED.valor,
    completo = EXCLUDED.completo, buscado_por = EXCLUDED.buscado_por, buscado_em = now();
  RETURN jsonb_build_object('ok', true, 'dia', p_dia, 'corridas', v_total, 'finalizadas', v_fin, 'valor', v_valor);
END $$;

-- Prévia da semana: dias buscados + total por motoboy + o que já existe na aba
CREATE OR REPLACE FUNCTION fin_ctl_moto_previa(p_unidade bigint, p_ini date, p_pct numeric)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH dias AS (SELECT * FROM fin_ctl_machine_dias WHERE unidade_id = p_unidade AND dia BETWEEN p_ini AND p_ini + 6),
  m AS (
    SELECT condutor_id, (array_agg(condutor_nome ORDER BY buscado_em DESC))[1] AS nome, count(*) AS corridas, sum(valor) AS valor
    FROM fin_ctl_machine_corridas WHERE unidade_id = p_unidade AND dia BETWEEN p_ini AND p_ini + 6 AND status = 'F'
    GROUP BY condutor_id
  ),
  ja AS (SELECT * FROM fin_ctl_registros WHERE tipo = 'motoboy_semanal' AND unidade_id = p_unidade AND semana_ini = p_ini AND status = 'ativo')
  SELECT jsonb_build_object(
    'semana_ini', p_ini, 'semana_fim', p_ini + 6, 'semana_fechada', p_ini + 6 < fin_hoje(),
    'dias', coalesce((SELECT jsonb_agg(jsonb_build_object('dia', dia, 'corridas', corridas, 'finalizadas', finalizadas, 'valor', valor, 'completo', completo,
                      'buscado_em', buscado_em, 'buscado_por', buscado_por) ORDER BY dia) FROM dias), '[]'::jsonb),
    'dias_ok', (SELECT count(*) FROM dias WHERE completo),
    'motoboys', (SELECT count(*) FROM m), 'faturamento', coalesce((SELECT sum(valor) FROM m), 0),
    'gami', coalesce((SELECT sum(round(valor * p_pct / 100, 2)) FROM m), 0),
    'ja_na_aba', (SELECT count(*) FROM ja), 'ja_na_aba_valor', coalesce((SELECT sum(valor) FROM ja), 0),
    'ja_da_machine', (SELECT count(*) FROM ja WHERE origem = 'machine'),
    'divergencias', coalesce((SELECT jsonb_agg(x) FROM (
        SELECT m.nome, m.valor AS machine, j.valor AS na_aba, j.origem FROM m JOIN ja j ON j.nome_norm = fin_norm(m.nome) AND j.origem <> 'machine'
        WHERE abs(j.valor - m.valor) > 0.009 ORDER BY abs(j.valor - m.valor) DESC LIMIT 30) x), '[]'::jsonb),
    'linhas', coalesce((SELECT jsonb_agg(jsonb_build_object('nome', nome, 'corridas', corridas, 'valor', valor) ORDER BY valor DESC) FROM m), '[]'::jsonb)
  )
$$;

-- Gera a semana na planilha Motoboys (só semana fechada + 7 dias completos). Não duplica.
CREATE OR REPLACE FUNCTION fin_ctl_moto_gerar(p_ator text, p_unidade bigint, p_ini date, p_pct numeric)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_novos int := 0; v_ja int := 0; v_manual int := 0; r record; v_gami numeric;
BEGIN
  PERFORM fin_set_ator(p_ator);
  IF extract(isodow FROM p_ini) <> 1 THEN RAISE EXCEPTION 'A semana começa na segunda-feira'; END IF;
  IF p_ini + 6 >= fin_hoje() THEN RAISE EXCEPTION 'A semana ainda não terminou'; END IF;
  IF p_pct IS NULL OR p_pct < 0 OR p_pct > 100 THEN RAISE EXCEPTION 'Percentual inválido'; END IF;
  IF (SELECT count(*) FROM fin_ctl_machine_dias WHERE unidade_id = p_unidade AND dia BETWEEN p_ini AND p_ini + 6 AND completo) < 7 THEN
    RAISE EXCEPTION 'Faltam dias da semana (busque os 7 dias da Machine antes de gerar)';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('fin_moto_gerar:' || p_unidade || ':' || p_ini));
  FOR r IN SELECT condutor_id, (array_agg(condutor_nome ORDER BY buscado_em DESC))[1] AS nome, count(*) AS corridas, sum(valor) AS valor
           FROM fin_ctl_machine_corridas WHERE unidade_id = p_unidade AND dia BETWEEN p_ini AND p_ini + 6 AND status = 'F'
           GROUP BY condutor_id HAVING sum(valor) > 0 LOOP
    IF EXISTS (SELECT 1 FROM fin_ctl_registros WHERE chave = 'MAQ|' || p_unidade || '|' || p_ini || '|' || r.condutor_id) THEN v_ja := v_ja + 1; CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM fin_ctl_registros WHERE tipo = 'motoboy_semanal' AND unidade_id = p_unidade AND semana_ini = p_ini AND status = 'ativo'
               AND origem <> 'machine' AND nome_norm = fin_norm(r.nome)) THEN v_manual := v_manual + 1; CONTINUE; END IF;
    v_gami := round(r.valor * p_pct / 100, 2);
    INSERT INTO fin_ctl_registros (tipo, unidade_id, data, semana_ini, semana_fim, nome, nome_norm, valor, percentual, valor_gami, valor_entregador,
      observacao, origem, chave, criado_por)
    VALUES ('motoboy_semanal', p_unidade, p_ini, p_ini, p_ini + 6, coalesce(nullif(btrim(r.nome), ''), 'Condutor ' || r.condutor_id), fin_norm(coalesce(nullif(btrim(r.nome), ''), 'Condutor ' || r.condutor_id)),
      round(r.valor, 2), p_pct, v_gami, round(r.valor - v_gami, 2), r.corridas || ' corridas (Machine, condutor ' || r.condutor_id || ')', 'machine',
      'MAQ|' || p_unidade || '|' || p_ini || '|' || r.condutor_id, p_ator);
    v_novos := v_novos + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'novos', v_novos, 'ja_gerados', v_ja, 'ja_lancados_a_mao', v_manual);
END $$;

DO $do$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname LIKE 'fin\_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $do$;
