-- ============================================================================
-- DIAGNÓSTICO DE SEGURANÇA (SÓ LEITURA , não muda nada). Rode cada bloco no SQL
-- Editor do Supabase e me cole o resultado. Isso me dá o catálogo que a API REST
-- não expõe: RLS por tabela, policies, grants do anon/authenticated e funções
-- SECURITY DEFINER. Nada aqui escreve nem apaga.
-- ============================================================================

-- 1) RLS LIGADO/DESLIGADO por tabela do schema public
SELECT c.relname AS tabela,
       c.relrowsecurity  AS rls_ligado,
       c.relforcerowsecurity AS rls_forcado
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relrowsecurity ASC, c.relname;   -- as SEM rls (false) aparecem primeiro

-- 2) TODAS as policies (tabela, comando, papéis, condição)
SELECT tablename AS tabela, policyname AS policy, cmd AS comando,
       roles AS papeis, qual AS condicao_using, with_check AS condicao_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, cmd;

-- 3) GRANTs dos papéis anon e authenticated no schema public (o que eles podem
--    fazer a nível de tabela, ANTES da RLS). Aqui queremos ver SELECT/INSERT/
--    UPDATE/DELETE sobrando pro anon.
SELECT table_name AS tabela, grantee AS papel, privilege_type AS privilegio
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee IN ('anon','authenticated')
ORDER BY table_name, grantee, privilege_type;

-- 4) Funções SECURITY DEFINER no schema public (furam a RLS , cada uma precisa
--    validar quem chama). Mostra quem pode EXECUTAR (acl).
SELECT p.proname AS funcao,
       pg_get_function_identity_arguments(p.oid) AS args,
       p.prosecdef AS security_definer,
       array_to_string(p.proacl, ' | ') AS quem_executa
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
ORDER BY p.prosecdef DESC, p.proname;

-- 5) VIEWS do schema public (views não têm RLS; fecham-se por REVOKE de grant).
--    Útil pra ver ranking_mensal e companhia.
SELECT table_name AS view, 'view' AS tipo
FROM information_schema.views
WHERE table_schema = 'public'
ORDER BY table_name;
