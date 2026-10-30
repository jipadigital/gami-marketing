-- ============================================================
-- SESSÕES MULTI-DISPOSITIVO (fim do logout ao trocar de aparelho)
-- ------------------------------------------------------------
-- Antes: usuarios_login.token_atual guardava UM único token por usuário.
-- Logar no celular sobrescrevia o token do notebook (e vice-versa), então
-- a cada troca de aparelho o outro caía em "sessão expirou" / re-login.
--
-- Agora o login ACUMULA as sessões ativas nesta coluna (lista das últimas
-- 10, sem as expiradas) e a validação (supabase-read / supabase-write)
-- aceita QUALQUER token dessa lista. Notebook + celular ficam logados juntos.
-- token_atual continua existindo (compatibilidade), só deixou de ser o único.
--
-- Rodar 1x. Seguro: só ADD COLUMN com default []. Cada aparelho pode precisar
-- logar UMA última vez depois do deploy (pra entrar na lista); daí para.
-- ============================================================

ALTER TABLE public.usuarios_login
  ADD COLUMN IF NOT EXISTS sessoes_ativas jsonb NOT NULL DEFAULT '[]'::jsonb;
