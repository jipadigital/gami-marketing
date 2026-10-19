-- ============================================================
-- Desligamento: Cláudio Martins (pe010) — ex-gestor de São Luís
-- São Luís CONTINUA ativa; só troca o gestor. 19/10/2026
-- Remove o login e os dados dele no servidor. O cadastro em pessoas
-- some pelo PESSOAS_DESLIGADAS (syncPessoas apaga), mas apagamos aqui
-- também pra ser imediato.
-- ============================================================

-- login
DELETE FROM usuarios_login WHERE pessoa_id = 'pe010';

-- pontos / gamificação (se houver)
DELETE FROM pontos_log            WHERE pessoa_id = 'pe010';
DELETE FROM badges_desbloqueadas  WHERE pessoa_id = 'pe010';

-- tarefas dele e as que ele delegou
DELETE FROM tarefas WHERE pessoa_id = 'pe010' OR delegada_por = 'pe010';

-- cadastro
DELETE FROM pessoas WHERE id = 'pe010';
