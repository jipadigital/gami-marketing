-- ============================================================
-- ROTA DE VISITAS — Prospecção em Campo (v32.48)
-- ------------------------------------------------------------
-- Cada gestor monta a lista de empresas que vai visitar e o sistema
-- vira isso numa ROTA (ordem otimizada + ajustável) pra abrir no
-- Google Maps / Waze e ir marcando "visitei". Uma rota ATIVA por gestor.
--
-- paradas (jsonb): [{ key, nome, cidade, cidade_slug, bairro, endereco,
--   lat, lng, status, telefone, documento, loja_id, visitado, visitado_em, ordem }]
--
-- Segurança: mesmo padrão do prospeccao_lojas — SELECT liberado (leitura
-- direta via supaSelect, filtrada por gestor_id no cliente), ESCRITA só
-- pela rota segura supabase-write.js (service key + sessão validada).
-- ============================================================

CREATE TABLE IF NOT EXISTS prospeccao_rotas (
  id           text PRIMARY KEY,
  gestor_id    text NOT NULL,
  gestor_nome  text,
  nome         text,
  paradas      jsonb NOT NULL DEFAULT '[]'::jsonb,
  ativa        boolean NOT NULL DEFAULT true,
  criada_em    timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rotas_gestor ON prospeccao_rotas (gestor_id, ativa);

ALTER TABLE prospeccao_rotas ENABLE ROW LEVEL SECURITY;

-- SELECT liberado (igual prospeccao_lojas); o cliente filtra por gestor_id.
DROP POLICY IF EXISTS rotas_select ON prospeccao_rotas;
CREATE POLICY rotas_select ON prospeccao_rotas FOR SELECT TO anon, authenticated USING (true);

-- Escrita NÃO é liberada pro anon: só a service key (rota supabase-write.js) grava.
GRANT SELECT ON prospeccao_rotas TO anon, authenticated;
