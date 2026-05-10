-- Schema necessário pra o "Cloud Mirror" do dashboard funcionar.
-- Roda esse script no SQL Editor do Supabase:
--   https://supabase.com/dashboard/project/tdbyzsouhrhmhpctttps/sql/new

-- 1) Tabela configuracoes (já deve existir, mas garante o schema)
create table if not exists public.configuracoes (
  chave text primary key,
  valor text,
  updated_at timestamptz default now()
);

-- 2) Garante que a coluna valor é text (não jsonb) — pra preservar JSON do
--    localStorage exatamente como está, sem reformatação automática.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='configuracoes' and column_name='valor' and data_type='jsonb'
  ) then
    alter table public.configuracoes alter column valor type text using valor::text;
  end if;
end $$;

-- 3) Index pra busca por prefixo (chave LIKE 'gami_%')
create index if not exists configuracoes_chave_prefix_idx
  on public.configuracoes (chave text_pattern_ops);

-- 4) RLS: habilitar e permitir leitura/escrita pra qualquer usuário
--    (modo "sem login" enquanto não temos autenticação)
alter table public.configuracoes enable row level security;

drop policy if exists "Permitir todos lerem configuracoes" on public.configuracoes;
create policy "Permitir todos lerem configuracoes"
  on public.configuracoes for select
  using (true);

drop policy if exists "Permitir todos escreverem configuracoes" on public.configuracoes;
create policy "Permitir todos escreverem configuracoes"
  on public.configuracoes for insert
  with check (true);

drop policy if exists "Permitir todos atualizarem configuracoes" on public.configuracoes;
create policy "Permitir todos atualizarem configuracoes"
  on public.configuracoes for update
  using (true) with check (true);

-- ⚠️ Quando implementar login multi-usuário, substituir as 3 policies acima
--    por policies baseadas em auth.uid() / role do usuário.

-- 5) Trigger pra atualizar updated_at automaticamente
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists configuracoes_updated_at on public.configuracoes;
create trigger configuracoes_updated_at
  before update on public.configuracoes
  for each row execute function public.set_updated_at();

-- 6) Coluna `niveis` na tabela pessoas (multi-níveis: Diretor + Gestor)
--    Armazenada como text contendo JSON array (ex: '["Diretor","Gestor"]').
alter table public.pessoas
  add column if not exists niveis text;

-- 7) Tabela posts_agendados — sistema de agendamento Instagram
create table if not exists public.posts_agendados (
  id text primary key,
  cidade_id text,                  -- c1..c11
  cidade_nome text,                -- redundante pra facilitar listar
  ig_id text not null,             -- Instagram Business Account ID (de list_accounts)
  ig_username text,                -- pra exibir
  tipo text not null,              -- 'feed' | 'story' | 'reel' | 'carousel'
  midia_urls text not null,        -- JSON array de URLs públicas
  legenda text default '',
  agendado_para timestamptz not null,
  status text not null default 'pendente', -- pendente|publicando|publicado|falho|cancelado
  ig_creation_id text,             -- ID temporário do container Meta
  ig_post_id text,                 -- ID do post final
  ig_permalink text,               -- link público do post
  erro text,                       -- mensagem em caso de falha
  tentativas int default 0,
  criado_por text,                 -- nome ou email do criador
  criado_em timestamptz default now(),
  publicado_em timestamptz
);

create index if not exists posts_agendados_status_idx on public.posts_agendados (status);
create index if not exists posts_agendados_agendado_idx on public.posts_agendados (agendado_para);
create index if not exists posts_agendados_cidade_idx on public.posts_agendados (cidade_id);

-- RLS
alter table public.posts_agendados enable row level security;
drop policy if exists "Permitir todos lerem posts_agendados" on public.posts_agendados;
create policy "Permitir todos lerem posts_agendados" on public.posts_agendados
  for select using (true);
drop policy if exists "Permitir todos escreverem posts_agendados" on public.posts_agendados;
create policy "Permitir todos escreverem posts_agendados" on public.posts_agendados
  for insert with check (true);
drop policy if exists "Permitir todos atualizarem posts_agendados" on public.posts_agendados;
create policy "Permitir todos atualizarem posts_agendados" on public.posts_agendados
  for update using (true) with check (true);
drop policy if exists "Permitir todos apagarem posts_agendados" on public.posts_agendados;
create policy "Permitir todos apagarem posts_agendados" on public.posts_agendados
  for delete using (true);

-- 8) Storage bucket "posts-instagram" — mídias dos posts agendados
-- ⚠️ Storage buckets devem ser criados pela UI do Supabase OU via JS API,
--    não direto via SQL. Crie manualmente:
--    Supabase Dashboard → Storage → New bucket → name: posts-instagram → public: ✓
--    File size limit: 50MB (pra reels/vídeos)
--    Allowed MIME types: image/jpeg, image/png, image/webp, video/mp4, video/quicktime

-- ====== VERIFICAÇÃO ======
-- Depois de rodar, confirma que está OK:
-- select count(*) from public.configuracoes where chave like 'gami_%';
-- select id, nome, nivel, niveis from public.pessoas where niveis is not null;
