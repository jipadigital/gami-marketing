-- ============================================================
-- SEGURANÇA (última da etapa 2): travar ESCRITA da tabela
-- `configuracoes`. RODAR SÓ DEPOIS da v33.33 no ar E de você TESTAR
-- que o espelho (Cloud Mirror) ainda salva e recarrega entre aparelhos.
--
-- ATENÇÃO: configuracoes é a tabela COMPARTILHADA mais usada do app.
-- Toda chave gami_* não-blacklistada do localStorage é espelhada aqui
-- pelo _gamiCloudFlush, que na v33.33 passou a escrever pelo SERVIDOR
-- (supabase-write, service key). syncConfig (reconhecimento, direção,
-- spotlight, foco, metas compartilhadas, etc.) também já vai pelo servidor.
-- Então travar a escrita da chave pública NÃO quebra o app.
--
-- Teste ANTES de rodar:
--   1) edite algo que espelha (ex.: reconhecimento da semana, direção Gâmi,
--      spotlight) num aparelho;
--   2) recarregue em OUTRO aparelho/login e confirme que veio;
--   3) só então rode este SQL.
--
-- Remove TODAS as políticas (inclusive legadas "Permitir todos..."),
-- liga RLS e deixa só LEITURA (anon/authenticated). Escrita segue pelo
-- service key (ignora RLS). SEM a política de SELECT a leitura volta
-- VAZIA e o app acha que "perdeu" tudo — por isso ela é obrigatória.
-- REVERSÍVEL: ALTER TABLE configuracoes DISABLE ROW LEVEL SECURITY;
-- 27/10/2026
-- ============================================================

DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='configuracoes' LOOP
    EXECUTE format('DROP POLICY %I ON public.configuracoes', p.policyname);
  END LOOP;
  ALTER TABLE public.configuracoes ENABLE ROW LEVEL SECURITY;
  CREATE POLICY configuracoes_sel ON public.configuracoes FOR SELECT TO anon, authenticated USING (true);
END $$;

-- CONFERE (deve sobrar só configuracoes_sel):
-- SELECT policyname, cmd FROM pg_policies WHERE tablename='configuracoes';

-- Teste depois: INSERT {} pela chave pública em configuracoes deve dar 401;
-- o app deve continuar espelhando (editar algo gami_* e ver recarregar).
