-- ============================================================
-- PROSPECÇÃO x MACHINE — cruzamento TOLERANTE A NOME (v2)
-- ------------------------------------------------------------
-- PROBLEMA (falsa perda / falso "nunca ativou"):
--   A loja está em prospeccao_lojas como "Pizzaria do Zé LTDA" e paga na
--   Machine como "Pizzaria do Ze" (sem acento / sufixo). O match EXATO da
--   v1 (lower+btrim) não casa, então a loja fica CINZA/PERDIDA no mapa
--   sendo que está ATIVA de verdade na Machine.
--
-- SOLUÇÃO: normalizar o nome dos DOIS lados antes de casar —
--   tira acento, pontuação, espaços repetidos e sufixos de razão social
--   (LTDA, ME, EPP, EIRELI, MEI, S/A, CIA, MATRIZ, FILIAL, UNIDADE) e
--   "- 02 / nº 3" no fim. Match normalizado, com fallback no exato.
--   Agrega por loja (SUM/MIN/MAX) pra uma loja casar com 1+ registros.
--
-- Mesma assinatura da v1: o app NÃO muda. A lógica conservadora de churn
-- (só mexe em quem BATEU, churn 21d) continua no cliente — isso aqui só
-- AMPLIA quem bate, reduzindo a falsa perda. Só LÊ, não altera nada.
-- Só Campo Grande tem o espelho/MV; outras cidades voltam vazio (ok).
-- ============================================================

-- 1) Normalizador de nome (sem depender da extensão unaccent):
--    translate() resolve os acentos do português; regexp tira o resto.
CREATE OR REPLACE FUNCTION public._gami_norm_nome(t text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT btrim(
    regexp_replace(                                   -- colapsa espaços
      regexp_replace(                                 -- tira sufixos de razão social / nº de unidade
        regexp_replace(                               -- troca tudo que não é letra/dígito por espaço
          lower(translate(coalesce(t,''),
            'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
            'aaaaaeeeeiiiiooooouuuucaaaaaeeeeiiiiooooouuuuc')),
          '[^a-z0-9]+', ' ', 'g'),
        '\m(ltda|epp|eireli|mei|me|sa|cia|matriz|filial|unidade|un|no|num|numero)\M', ' ', 'g'),
      '\s+', ' ', 'g')
  );
$$;

-- 2) Cruzamento tolerante — mesma saída da v1 (loja_id, loja_nome, qtd, primeiro, ultimo)
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
  SELECT l.id,
         l.nome,
         SUM(m.qtd_total)::bigint AS qtd,
         MIN(m.primeiro)          AS primeiro,
         MAX(m.ultimo)            AS ultimo
  FROM prospeccao_lojas l
  JOIN mv_empresas_raiox m
    ON  m.cidade_slug = l.cidade_slug
    AND (
          lower(btrim(m.nome)) = lower(btrim(l.nome))                 -- exato (v1)
          OR public._gami_norm_nome(m.nome) = public._gami_norm_nome(l.nome)  -- tolerante (v2)
        )
   AND public._gami_norm_nome(l.nome) <> ''                          -- evita casar "lixo" vazio
  WHERE l.ativo = true
    AND (p_cidade_slug IS NULL OR l.cidade_slug = p_cidade_slug)
  GROUP BY l.id, l.nome;
$$;

GRANT EXECUTE ON FUNCTION public._gami_norm_nome(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prospeccao_sinal_machine(text) TO anon, authenticated;

-- ------------------------------------------------------------
-- CONFERIR quantas lojas passam a bater (antes de aplicar no mapa):
--   SELECT count(*) FROM public.prospeccao_sinal_machine('campo-grande');
-- Ver os casos que SÓ o normalizado pegou (nome diverge):
--   SELECT l.nome AS prospect, m.nome AS machine
--   FROM prospeccao_lojas l
--   JOIN mv_empresas_raiox m ON m.cidade_slug=l.cidade_slug
--    AND public._gami_norm_nome(m.nome)=public._gami_norm_nome(l.nome)
--    AND lower(btrim(m.nome))<>lower(btrim(l.nome))
--   WHERE l.cidade_slug='campo-grande' AND l.ativo LIMIT 50;
-- ============================================================
