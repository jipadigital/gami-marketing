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

-- ====== VERIFICAÇÃO ======
-- Depois de rodar, confirma que está OK:
-- select count(*) from public.configuracoes where chave like 'gami_%';
