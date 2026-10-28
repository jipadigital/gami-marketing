-- ============================================================
-- Desligamento: Ana Flávia Gomes (Sucesso do Cliente / Maceió) — 28/10/2026
-- id: 6f28bf4d-116b-4598-a462-98cfb79d5942
-- Some de Pessoas pelo PESSOAS_DESLIGADAS (syncPessoas apaga), mas apagamos
-- aqui tambem pra ser imediato. Historico de prospeccao/CRM dela (visitas,
-- leads) NAO e apagado de proposito (e dado da empresa).
-- ============================================================

-- confere quem e (rode antes se quiser)
SELECT id, nome, cargo, cidade FROM pessoas WHERE id = '6f28bf4d-116b-4598-a462-98cfb79d5942';

-- login
DELETE FROM usuarios_login WHERE pessoa_id = '6f28bf4d-116b-4598-a462-98cfb79d5942';

-- pontos / gamificação
DELETE FROM pontos_log            WHERE pessoa_id = '6f28bf4d-116b-4598-a462-98cfb79d5942';
DELETE FROM badges_desbloqueadas  WHERE pessoa_id = '6f28bf4d-116b-4598-a462-98cfb79d5942';

-- tarefas dela e as que ela delegou
DELETE FROM tarefas WHERE pessoa_id = '6f28bf4d-116b-4598-a462-98cfb79d5942'
                       OR delegada_por = '6f28bf4d-116b-4598-a462-98cfb79d5942';

-- registros de acesso
DELETE FROM acessos_log WHERE pessoa_id = '6f28bf4d-116b-4598-a462-98cfb79d5942';

-- cadastro
DELETE FROM pessoas WHERE id = '6f28bf4d-116b-4598-a462-98cfb79d5942';
