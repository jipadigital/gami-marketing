-- ============================================================
-- SEGURANÇA: ligar RLS (Row Level Security) nas tabelas comerciais
-- Motivo: hoje a chave PÚBLICA (anon, que está no código do site) consegue
--         LER, EDITAR e APAGAR direto essas tabelas. Qualquer um poderia
--         zerar os leads/prospects. Testado: PATCH e DELETE retornam 204.
--
-- O que este SQL faz:
--   1) Liga RLS em cada tabela.
--   2) Cria política que PERMITE SÓ LEITURA (SELECT) pela chave pública.
--      => o dashboard continua lendo normal (ele lê com a chave anon).
--      => INSERT/UPDATE/DELETE pela chave pública ficam BLOQUEADOS.
--      => as escritas do app passam pela Netlify function (service key),
--         que IGNORA o RLS, então continuam funcionando.
--
-- IMPORTANTE: sem a política de SELECT, a leitura voltaria VAZIA (já aconteceu).
-- Por isso cada tabela ganha a política de leitura junto.
-- 27/10/2026
-- ============================================================

-- (0) BONUS: coluna que faltava no crm_leads (o app manda 'origem' e dava erro,
--     por isso leads de "Iniciar o dia"/"Escolher"/rota não salvavam).
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS origem text;

-- (1) Diagnóstico — rode pra ver TODAS as tabelas com RLS desligado:
-- SELECT relname FROM pg_class
--   WHERE relkind='r' AND relnamespace='public'::regnamespace AND relrowsecurity=false
--   ORDER BY relname;

-- (2) Liga RLS + política de leitura nas tabelas comerciais.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'crm_leads','crm_atividades','crm_tarefas','crm_checklist','crm_metas','crm_scripts','crm_config',
    'prospeccao_lojas','prospeccao_visitas','prospeccao_rotas'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I;', t||'_anon_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO anon, authenticated USING (true);', t||'_anon_select', t);
  END LOOP;
END $$;

-- Pronto. Depois de rodar:
--   - O dashboard continua lendo tudo (política de SELECT).
--   - A chave pública NÃO consegue mais editar/apagar essas tabelas.
--   - As escritas do app (CRM, prospecção, rota) seguem pela Netlify function.
--
-- DESFAZER (se algo quebrar): troca ENABLE por DISABLE ROW LEVEL SECURITY em cada tabela.
--
-- FALTA AINDA (não incluído aqui, trato no código antes):
--   - notificacoes: o app marca "lida" direto com a chave pública; preciso
--     mandar isso pelo servidor antes de ligar RLS nela, senão quebra.
--   - machine_empresas / machine_corridas / mv_* e outras: mesmo padrão,
--     confirmar que nenhuma escrita direta existe e aplicar igual.
