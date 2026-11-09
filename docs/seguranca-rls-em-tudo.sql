-- ============================================================================
-- RLS EM TUDO , DEFESA EM PROFUNDIDADE (09/11/2026)
-- ----------------------------------------------------------------------------
-- Liga Row Level Security em TODAS as tabelas do schema public que ainda estão
-- SEM RLS. NÃO cria nem remove nenhuma policy: o que já funciona continua; tabela
-- sem policy = o anon lê 0 linhas (padrão seguro). Assim, se alguém criar uma
-- tabela nova e esquecer de proteger, ela já nasce fechada pro anônimo.
--
-- Views e materialized views NÃO entram (RLS é só de tabela; MV/view fecham por
-- REVOKE de grant). Só mexe em tabelas comuns (relkind='r').
-- NADA é destrutivo: só ALTER TABLE ... ENABLE ROW LEVEL SECURITY.
-- ============================================================================

-- PASSO 1 (revise antes): lista as tabelas que estão SEM RLS hoje.
-- Se alguma dessas for lida direto pela chave anônima no app (e tiver dado),
-- me avise ANTES de rodar o passo 2, pra não quebrar uma leitura.
SELECT c.relname AS tabela_sem_rls
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = false
ORDER BY c.relname;

-- PASSO 2: liga RLS em todas elas.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = false
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', r.relname);
    RAISE NOTICE 'RLS ligada: %', r.relname;
  END LOOP;
END $$;

-- PASSO 3 (conferência): deve voltar 0 linhas (nenhuma tabela sem RLS).
SELECT c.relname
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity=false
ORDER BY 1;
