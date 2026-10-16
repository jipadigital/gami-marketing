-- ============================================================
-- PROSPECÇÃO EM CAMPO (v32.23, Parte 2b) — cruzamento com a Machine
-- ------------------------------------------------------------
-- Casa as lojas prospectadas (prospeccao_lojas) com o sinal real de
-- pedidos da Machine, LENDO A MATERIALIZED VIEW mv_empresas_raiox
-- (já agregada por empresa; não reprocessa as ~590k corridas).
-- Match por NOME (lower+btrim) dentro da MESMA cidade_slug.
-- Só Campo Grande está no espelho/MV, então pras outras cidades
-- isso volta vazio (status não muda) — é o esperado.
-- Seguro: só LÊ, não altera nada. O app decide e aplica as mudanças.
-- ============================================================

CREATE OR REPLACE FUNCTION public.prospeccao_sinal_machine(p_cidade_slug text DEFAULT NULL)
RETURNS TABLE(
  loja_id   text,
  loja_nome text,
  qtd       bigint,
  primeiro  timestamptz,
  ultimo    timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT l.id, l.nome, m.qtd_total::bigint, m.primeiro, m.ultimo
  FROM prospeccao_lojas l
  JOIN mv_empresas_raiox m
    ON  m.cidade_slug = l.cidade_slug
    AND lower(btrim(m.nome)) = lower(btrim(l.nome))
  WHERE l.ativo = true
    AND (p_cidade_slug IS NULL OR l.cidade_slug = p_cidade_slug);
$$;

GRANT EXECUTE ON FUNCTION public.prospeccao_sinal_machine(text) TO anon, authenticated;
