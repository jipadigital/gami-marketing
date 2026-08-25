-- ============================================================
-- Modulo Verificacao de Motoristas — ANEXAR DOCUMENTOS
-- Bucket PRIVADO no Supabase Storage + tabela de metadados.
-- ADITIVO: nao altera nada existente. Rodar 1x no SQL Editor.
--
-- Seguranca: bucket PRIVADO (public=false) => sem URL publica. Upload e
-- visualizacao acontecem via URLs ASSINADAS de curta duracao, geradas pela
-- Netlify Function verificar-motorista (service key + sessao Gami + super_admin).
-- A tabela de metadados tambem fica com RLS ligado e sem policies pro anon.
-- ============================================================

-- 1) Bucket privado pros documentos dos motoristas
insert into storage.buckets (id, name, public)
values ('motorista-docs', 'motorista-docs', false)
on conflict (id) do nothing;

-- 2) Metadados dos documentos anexados (o arquivo mora no Storage)
create table if not exists public.motorista_documentos (
  id                uuid primary key default gen_random_uuid(),
  cpf               text not null,
  consulta_id       uuid,                 -- opcional: liga a uma consulta especifica
  tipo              text not null,        -- 'cnh' | 'rg' | 'comprovante' | 'outro'
  nome_arquivo      text,
  storage_path      text not null,        -- caminho dentro do bucket motorista-docs
  mime              text,
  tamanho           bigint,
  enviado_por       text,                 -- pessoa_id do Gami
  enviado_por_nome  text,
  enviado_em        timestamptz not null default now()
);
create index if not exists idx_mdoc_cpf on public.motorista_documentos(cpf);

alter table public.motorista_documentos enable row level security;
-- (sem policies pro anon: acesso so via service key na function)
