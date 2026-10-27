-- ============================================================
-- SEGURANÇA: travar escrita da tabela `pessoas`
-- RODAR SÓ DEPOIS da v33.30 no ar E de você TESTAR editar/salvar
-- uma pessoa (as escritas já passam pelo servidor agora).
--
-- Remove TODAS as políticas (inclusive as antigas "Permitir todos
-- escreverem"), liga RLS e deixa só LEITURA. Escrita segue pelo
-- servidor (service key, ignora RLS). Bloqueia a chave pública.
-- REVERSÍVEL: ALTER TABLE pessoas DISABLE ROW LEVEL SECURITY;
-- 27/10/2026
-- ============================================================

DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='pessoas' LOOP
    EXECUTE format('DROP POLICY %I ON public.pessoas', p.policyname);
  END LOOP;
  ALTER TABLE public.pessoas ENABLE ROW LEVEL SECURITY;
  CREATE POLICY pessoas_sel ON public.pessoas FOR SELECT TO anon, authenticated USING (true);
END $$;

-- Teste depois: INSERT pela chave pública deve dar 401 (bloqueado);
-- o app (logado) deve continuar editando/salvando normal.
