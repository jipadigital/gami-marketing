-- ============================================================
-- FINANCEIRO v12 (16/11/2026): EXTRATO DA CORA x LANÇAMENTOS DO KAMINO
--
-- A Cora não é integrada: as meninas SOBEM o extrato (OFX/CSV) e conferem. Os lançamentos agora
-- vêm do Kamino (origem 'kamino_api') e são travados contra baixa manual. A conciliação do
-- extrato tentava dar baixa ao casar uma linha com um lançamento pendente, o que agora seria
-- recusado e derrubaria a importação do extrato.
--
-- Regra nova: lançamento do Kamino é só LIGADO à linha do banco (prova de que o dinheiro saiu/
-- entrou). Quem marca pago é o Kamino; a ligação fica registrada e auditada como sempre.
--
-- Rode INTEIRO no SQL Editor do projeto gami-financeiro (vyjjdirlgvysbalrmmih). Idempotente.
-- ============================================================

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
  -- v12: do Kamino só liga (a baixa é feita no Kamino)
  IF l.status = 'pendente' AND l.origem <> 'kamino_api' THEN
    PERFORM fin_baixar(p_ator, p_lanc, e.data, e.conta_id, NULL, NULL, NULL, 'Baixa pela conciliação com o extrato', p_extrato);
  END IF;
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('ok', false, 'erro', 'Essa linha ou esse lançamento já está conciliado. Desfaça antes.');
END $$;

CREATE OR REPLACE FUNCTION fin_conciliar_auto_um(p_ator text, p_extrato bigint, p_lanc bigint) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE e fin_extrato; l fin_lancamentos;
BEGIN
  SELECT * INTO e FROM fin_extrato WHERE id = p_extrato;
  SELECT * INTO l FROM fin_lancamentos WHERE id = p_lanc FOR UPDATE;
  INSERT INTO fin_conciliacoes (extrato_id, lancamento_id, metodo, criado_por) VALUES (p_extrato, p_lanc, 'auto', p_ator);
  IF l.status = 'pendente' AND l.origem <> 'kamino_api' THEN
    PERFORM fin_baixar(p_ator, p_lanc, e.data, e.conta_id, NULL, NULL, NULL, 'Baixa automática pela conciliação', p_extrato);
  END IF;
  RETURN true;
END $$;

-- a conciliação automática nunca derruba a importação do extrato por causa de UMA linha
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
    EXCEPTION WHEN OTHERS THEN NULL;  -- v12: qualquer problema numa linha só pula essa linha
    END;
  END LOOP;
  RETURN n;
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
