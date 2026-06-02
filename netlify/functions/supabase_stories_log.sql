-- ============================================================
-- 📸 STORIES LOG — Garante estrutura da tabela pra rotação
-- Cole no SQL Editor e RUN
-- ============================================================

-- 1) Cria a tabela se não existir
CREATE TABLE IF NOT EXISTS stories_log (
  id BIGSERIAL PRIMARY KEY,
  cidade TEXT,
  username TEXT,
  categoria TEXT,
  imagem_url TEXT,
  imagem_nome TEXT,
  ig_media_id TEXT,
  ig_publish_id TEXT,
  status TEXT DEFAULT 'postado',
  erro_msg TEXT,
  postado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 2) Garante todas as colunas (caso já exista parcial)
ALTER TABLE stories_log ADD COLUMN IF NOT EXISTS cidade TEXT;
ALTER TABLE stories_log ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE stories_log ADD COLUMN IF NOT EXISTS categoria TEXT;
ALTER TABLE stories_log ADD COLUMN IF NOT EXISTS imagem_url TEXT;
ALTER TABLE stories_log ADD COLUMN IF NOT EXISTS imagem_nome TEXT;
ALTER TABLE stories_log ADD COLUMN IF NOT EXISTS ig_media_id TEXT;
ALTER TABLE stories_log ADD COLUMN IF NOT EXISTS ig_publish_id TEXT;
ALTER TABLE stories_log ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'postado';
ALTER TABLE stories_log ADD COLUMN IF NOT EXISTS erro_msg TEXT;
ALTER TABLE stories_log ADD COLUMN IF NOT EXISTS postado_em TIMESTAMPTZ DEFAULT NOW();

-- 3) Índices pra performance (busca por categoria + data + status)
CREATE INDEX IF NOT EXISTS idx_stories_categoria_data 
  ON stories_log(categoria, postado_em DESC);
CREATE INDEX IF NOT EXISTS idx_stories_imagem_nome 
  ON stories_log(imagem_nome, postado_em DESC);
CREATE INDEX IF NOT EXISTS idx_stories_status 
  ON stories_log(status);

-- 4) RLS — leitura aberta (escrita só via função Netlify)
ALTER TABLE stories_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "leitura stories_log" ON stories_log;
CREATE POLICY "leitura stories_log" ON stories_log FOR SELECT USING (true);

-- 5) Função de diagnóstico: mostra uso de imagens nos últimos 30 dias
CREATE OR REPLACE FUNCTION stories_diagnostico(p_categoria TEXT DEFAULT NULL)
RETURNS TABLE (
  categoria TEXT,
  imagem_nome TEXT,
  total_usos BIGINT,
  primeiro_uso TIMESTAMPTZ,
  ultimo_uso TIMESTAMPTZ,
  dias_desde_ultimo INTEGER
) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY 
  SELECT 
    sl.categoria,
    sl.imagem_nome,
    count(*)::BIGINT as total_usos,
    MIN(sl.postado_em) as primeiro_uso,
    MAX(sl.postado_em) as ultimo_uso,
    EXTRACT(DAY FROM NOW() - MAX(sl.postado_em))::INTEGER as dias_desde_ultimo
  FROM stories_log sl
  WHERE sl.status = 'postado' 
    AND sl.imagem_nome IS NOT NULL
    AND sl.postado_em > NOW() - INTERVAL '30 days'
    AND (p_categoria IS NULL OR sl.categoria = p_categoria)
  GROUP BY sl.categoria, sl.imagem_nome
  ORDER BY sl.categoria, count(*) DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION stories_diagnostico(TEXT) TO anon, authenticated;
GRANT SELECT ON stories_log TO anon, authenticated;

-- =====================================================
-- TESTE: vê uso atual por imagem nos últimos 30 dias
-- =====================================================

-- Por categoria específica:
-- SELECT * FROM stories_diagnostico('bom-dia');

-- Todas as categorias:
SELECT * FROM stories_diagnostico() ORDER BY categoria, total_usos DESC;
