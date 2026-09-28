-- Encerramento da operação VITÓRIA/ES — remove todos os dados do banco — 28/09/2026
-- Gestor: Jean Alves Guerra (id pejeanguerra, email jguerrabjj93@gmail.com)
-- Cidade slug: vitoria
--
-- Backup feito antes (135 empresas + 3278 corridas + pessoa/pontos/ranking/badges/tarefas do Jean).
-- Transação: ou apaga tudo, ou nada. Rodar no Supabase (SQL Editor).

BEGIN;

-- Dados da Machine da cidade
DELETE FROM machine_corridas     WHERE cidade_slug = 'vitoria';   -- ~3278
DELETE FROM machine_empresas     WHERE cidade_slug = 'vitoria';   -- ~135

-- Pontuação / ranking / conquistas do gestor
DELETE FROM pontos_log           WHERE pessoa_id = 'pejeanguerra'; -- ~32
DELETE FROM ranking_mensal       WHERE pessoa_id = 'pejeanguerra'; -- ~1
DELETE FROM badges_desbloqueadas WHERE pessoa_id = 'pejeanguerra'; -- ~2

-- Tarefas do gestor (as dele + as que ele delegou)
DELETE FROM tarefas              WHERE pessoa_id = 'pejeanguerra'
                                    OR delegada_por = 'pejeanguerra'; -- ~2

-- Acesso e cadastro do gestor
DELETE FROM usuarios_login       WHERE email = 'jguerrabjj93@gmail.com';
DELETE FROM pessoas              WHERE id = 'pejeanguerra';

COMMIT;
