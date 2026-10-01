-- Mural interativo (v32.13) — colunas novas na tabela recados:
-- reacoes (reações compartilhadas), imagem (foto em data URL) e gif (URL do GIF).
-- Rodar no Supabase (SQL Editor). Seguro: IF NOT EXISTS, não mexe nos dados.
ALTER TABLE recados ADD COLUMN IF NOT EXISTS reacoes jsonb;
ALTER TABLE recados ADD COLUMN IF NOT EXISTS imagem  text;
ALTER TABLE recados ADD COLUMN IF NOT EXISTS gif     text;

-- v32.17: respostas (comentários) nos recados
ALTER TABLE recados ADD COLUMN IF NOT EXISTS respostas jsonb;
