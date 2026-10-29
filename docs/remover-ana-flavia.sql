-- ============================================================
-- Desligamento: Ana Flávia Gomes (Sucesso do Cliente / Maceió)
-- id REAL: pempy5sa34   (o UUID usado antes, 6f28bf4d-..., estava ERRADO,
--                        por isso ela nunca saiu. Corrigido 29/10/2026.)
-- Some de Pessoas pelo PESSOAS_DESLIGADAS, mas apagamos aqui tambem pra ser
-- imediato e limpar o login. Historico de prospeccao/CRM dela (visitas, leads)
-- NAO e apagado de proposito (e dado da empresa).
-- ============================================================

-- confere quem e (rode antes se quiser)
SELECT id, nome, cargo, cidade FROM pessoas WHERE id = 'pempy5sa34';

-- login
DELETE FROM usuarios_login WHERE pessoa_id = 'pempy5sa34';

-- pontos / gamificação
DELETE FROM pontos_log            WHERE pessoa_id = 'pempy5sa34';
DELETE FROM badges_desbloqueadas  WHERE pessoa_id = 'pempy5sa34';

-- tarefas dela e as que ela delegou
DELETE FROM tarefas WHERE pessoa_id = 'pempy5sa34'
                       OR delegada_por = 'pempy5sa34';

-- registros de acesso
DELETE FROM acessos_log WHERE pessoa_id = 'pempy5sa34';

-- cadastro
DELETE FROM pessoas WHERE id = 'pempy5sa34';

-- confere que sumiu (deve voltar vazio)
SELECT id, nome FROM pessoas WHERE id = 'pempy5sa34';
