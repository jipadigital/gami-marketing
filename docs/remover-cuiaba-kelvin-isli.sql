-- Encerramento CUIABÁ + desligamentos Kelvin e Isli — 28/09/2026
-- Kelvin Felipe Araújo de Souza (pe011, kelvina602@gmail.com) — gestor de Cuiabá (encerrada)
-- Isli Stephanie (pe028) — Suporte Home, já saiu
-- Cidade slug: cuiaba
--
-- Backup feito antes (2 pessoas + 5 pontos + 62 empresas + 1669 corridas). Os badges de
-- Cuiabá/Vitória já foram removidos das outras pessoas via app. ranking_mensal é VIEW (não deletar).
-- Rodar no Supabase (SQL Editor).

BEGIN;

-- Dados da Machine de Cuiabá
DELETE FROM machine_corridas     WHERE cidade_slug = 'cuiaba';          -- ~1669
DELETE FROM machine_empresas     WHERE cidade_slug = 'cuiaba';          -- ~62

-- Pontos / conquistas / tarefas dos dois
DELETE FROM pontos_log           WHERE pessoa_id IN ('pe011','pe028');  -- ~5
DELETE FROM badges_desbloqueadas WHERE pessoa_id IN ('pe011','pe028');
DELETE FROM tarefas              WHERE pessoa_id IN ('pe011','pe028')
                                    OR delegada_por IN ('pe011','pe028');

-- Acesso e cadastro
DELETE FROM usuarios_login       WHERE pessoa_id IN ('pe011','pe028');
DELETE FROM pessoas              WHERE id IN ('pe011','pe028');

COMMIT;
