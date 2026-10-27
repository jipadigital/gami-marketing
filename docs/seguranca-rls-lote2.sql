-- ============================================================
-- SEGURANÇA (lote 2): travar ESCRITA das tabelas que o cliente
-- NÃO escreve direto (só servidor/RPC/background usam service key).
-- Travar aqui NÃO quebra nada.
--
-- Pra cada tabela: remove TODAS as políticas, liga RLS e cria só a de
-- LEITURA (anon/authenticated). Assim a chave pública só LÊ; escrita
-- continua pelo service key (que ignora RLS).
-- REVERSÍVEL: ALTER TABLE x DISABLE ROW LEVEL SECURITY;
-- 27/10/2026
-- ============================================================

DO $$
DECLARE t text; p record;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'badges_desbloqueadas','calendario_pessoal','stories_log',
    'pontos_log','reconhecimentos_pares','vencedores_mensais'
  ] LOOP
    -- remove todas as políticas atuais da tabela
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t);
    END LOOP;
    -- liga RLS e deixa só leitura
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO anon, authenticated USING (true)', t||'_sel', t);
  END LOOP;
END $$;

-- Confere (deve sobrar só *_sel em cada):
-- SELECT tablename, policyname, cmd FROM pg_policies
--  WHERE tablename IN ('badges_desbloqueadas','calendario_pessoal','stories_log','pontos_log','reconhecimentos_pares','vencedores_mensais')
--  ORDER BY 1,3;
