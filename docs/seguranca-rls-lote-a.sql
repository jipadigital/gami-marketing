-- SEGURANÇA lote A: travar escrita de tarefas, recados, pulse_votos
-- RODAR SÓ DEPOIS da v33.31 no ar E de testar (postar recado, concluir tarefa, votar pulse).
-- Remove todas as políticas, liga RLS, deixa só leitura. Escrita segue pelo servidor. Reversível.
DO $$
DECLARE t text; p record;
BEGIN
  FOREACH t IN ARRAY ARRAY['tarefas','recados','pulse_votos'] LOOP
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t);
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO anon, authenticated USING (true)', t||'_sel', t);
  END LOOP;
END $$;
