-- ============================================================
-- MURAL: áudio (gravação de voz tipo WhatsApp) — v32.53
-- ------------------------------------------------------------
-- (1) coluna `audio` no recado (guarda a URL do áudio no Storage; se o
--     Storage falhar, o cliente cai pra data URL inline nesta mesma coluna).
-- (2) bucket público `mural-audios` + políticas pra anon enviar/ler o áudio
--     (mesmo esquema do bucket pessoas-fotos que já funciona).
-- Seguro rodar por cima (IF NOT EXISTS / on conflict).
-- ============================================================

ALTER TABLE recados ADD COLUMN IF NOT EXISTS audio text;

-- Bucket público pros áudios do mural
INSERT INTO storage.buckets (id, name, public)
VALUES ('mural-audios', 'mural-audios', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Qualquer um (anon) pode OUVIR os áudios do mural
DROP POLICY IF EXISTS "mural_audios_read" ON storage.objects;
CREATE POLICY "mural_audios_read" ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (bucket_id = 'mural-audios');

-- Qualquer um logado no painel (anon key) pode ENVIAR áudio no mural
DROP POLICY IF EXISTS "mural_audios_insert" ON storage.objects;
CREATE POLICY "mural_audios_insert" ON storage.objects
  FOR INSERT TO anon, authenticated
  WITH CHECK (bucket_id = 'mural-audios');
