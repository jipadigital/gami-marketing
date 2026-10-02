-- v32.19: respostas e reações do mural PERSISTEM.
-- Causa do bug: a tabela recados não tem policy de UPDATE pro anon, então o PATCH
-- de respostas/reacoes voltava 204 sem gravar nada (e sumia no próximo load).
-- Em vez de abrir UPDATE geral na tabela, duas funções SECURITY DEFINER que só
-- mexem nessas colunas, de forma ATÔMICA (duas pessoas respondendo juntas não se apagam).
-- Rodar no Supabase (SQL Editor). Seguro: não altera dados existentes.

-- Acrescenta 1 resposta ao recado e devolve o array completo atualizado.
CREATE OR REPLACE FUNCTION public.recado_responder(p_id text, p_resposta jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_out jsonb;
BEGIN
  -- v32.20: aceita resposta com texto OU gif (dá pra responder só com GIF).
  IF p_resposta IS NULL OR jsonb_typeof(p_resposta) <> 'object'
     OR ( coalesce(length(p_resposta->>'texto'), 0) = 0
          AND coalesce(length(p_resposta->>'gif'), 0) = 0 )
     OR coalesce(length(p_resposta->>'texto'), 0) > 200 THEN
    RAISE EXCEPTION 'resposta invalida';
  END IF;
  UPDATE recados
     SET respostas = coalesce(respostas, '[]'::jsonb) || jsonb_build_array(p_resposta)
   WHERE id = p_id
  RETURNING respostas INTO v_out;
  RETURN v_out; -- NULL = recado não existe (apagado/expirado)
END;
$$;

-- Liga/desliga a reação de 1 pessoa num emoji e devolve o objeto reacoes atualizado.
CREATE OR REPLACE FUNCTION public.recado_reagir(p_id text, p_emoji text, p_quem text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_r   jsonb;
  v_arr jsonb;
BEGIN
  IF coalesce(p_emoji, '') = '' OR length(p_emoji) > 16 OR coalesce(p_quem, '') = '' THEN
    RAISE EXCEPTION 'reacao invalida';
  END IF;
  SELECT coalesce(reacoes, '{}'::jsonb) INTO v_r FROM recados WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_arr := coalesce(v_r -> p_emoji, '[]'::jsonb);
  IF v_arr ? p_quem THEN
    v_arr := v_arr - p_quem;
  ELSE
    v_arr := v_arr || to_jsonb(p_quem);
  END IF;
  IF jsonb_array_length(v_arr) = 0 THEN
    v_r := v_r - p_emoji;
  ELSE
    v_r := jsonb_set(v_r, ARRAY[p_emoji], v_arr, true);
  END IF;
  UPDATE recados SET reacoes = v_r WHERE id = p_id;
  RETURN v_r;
END;
$$;

GRANT EXECUTE ON FUNCTION public.recado_responder(text, jsonb)     TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recado_reagir(text, text, text)   TO anon, authenticated;
