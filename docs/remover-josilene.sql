-- Remover Josilene Ferreira Lopes (saiu da empresa) — 09/09/2026
-- pessoa_id: pemrar75bp | username: josilene | email: josylopes300@gmail.com
-- OBS: o registro em `pessoas` já foi removido via REST. Rode este SQL no
-- Supabase (SQL Editor) pra limpar as tabelas travadas por RLS.

-- 1) LOGIN (obrigatório: impede que ela acesse o sistema)
DELETE FROM usuarios_login WHERE pessoa_id = 'pemrar75bp';

-- 2) HISTÓRICO DE PONTOS / RANKING (opcional)
--    Ela NÃO está no ranking do mês atual (setembro), mas tem 111 registros de
--    meses anteriores. Rode a linha abaixo se quiser APAGAR o histórico dela
--    (some de hall da fama / ranking acumulado). Se preferir PRESERVAR o
--    histórico dela, NÃO rode esta linha.
DELETE FROM pontos_log WHERE pessoa_id = 'pemrar75bp';

-- 3) Tarefas órfãs dela (opcional, limpeza)
DELETE FROM tarefas WHERE pessoa_id = 'pemrar75bp';

-- (Se ela tiver sido vencedora de algum mês e você quiser tirar do hall:)
-- DELETE FROM vencedores_mensais WHERE pessoa_id = 'pemrar75bp';
