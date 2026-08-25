-- ============================================================
-- Modulo: Verificacao de Motoristas (Driver Status)
-- Tabela de cache + auditoria das consultas de motorista.
-- ADITIVO: nao altera nenhuma tabela/funcao existente.
--
-- OBS de arquitetura (importante): o Gami NAO usa Supabase Auth (auth.users /
-- auth.uid()). O login e proprio (usuarios_login + PIN + token de sessao) e o
-- client usa a anon/publishable key. Por isso:
--   - consultado_por e TEXT (o pessoa_id do Gami), sem FK pra auth.users.
--   - a tabela fica com RLS LIGADO e SEM policies pra anon => 100% fechada pro
--     navegador. TODO acesso (consulta e historico) passa pela Netlify Function
--     'verificar-motorista', que usa a SERVICE KEY (bypassa RLS) e valida a
--     sessao Gami + super_admin. Assim ficha criminal NUNCA e legivel com a
--     chave publica do navegador (mais seguro que policy 'authenticated').
-- Rodar 1x no SQL Editor do Supabase.
-- ============================================================

create extension if not exists "pgcrypto";  -- p/ gen_random_uuid()

create table if not exists public.motorista_consultas (
  id                  uuid primary key default gen_random_uuid(),
  cpf                 text not null,
  nome_informado      text,
  nome_retornado      text,
  driver_status       text not null check (driver_status in ('APTO','ANALISE','REPROVADO')),
  score               int,
  antecedentes        jsonb,     -- retorno normalizado (nada consta / positivo + detalhe)
  processos           jsonb,     -- lista normalizada de processos
  cnh                 jsonb,     -- situacao/validade/categoria
  homonimo_risco      boolean default false,
  consentimento       boolean not null default false,
  consultado_por      text,      -- pessoa_id do Gami (sem auth.users)
  consultado_por_nome text,
  consultado_por_email text,
  fonte               text default 'mock',  -- 'mock' | nome do agregador real
  consultado_em       timestamptz not null default now(),
  raw                 jsonb      -- payload completo do agregador (auditoria)
);

create index if not exists idx_mc_cpf  on public.motorista_consultas(cpf);
create index if not exists idx_mc_data on public.motorista_consultas(consultado_em desc);

-- RLS LIGADO e SEM policies => anon (publishable key do navegador) nao le nem
-- escreve. A service key usada pela Netlify Function bypassa o RLS.
alter table public.motorista_consultas enable row level security;

-- (Sem create policy de proposito. Se um dia o modulo precisar de leitura direta
--  por um papel autenticado do Supabase, cria-se policy especifica aqui.)
