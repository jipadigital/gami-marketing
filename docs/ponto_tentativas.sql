-- ============================================================
-- ponto_tentativas — registra as TENTATIVAS de bater ponto que FALHARAM
-- (GPS negado / IP fora da rede / fora do raio). As batidas que dao CERTO
-- ja ficam em ponto_registros; esta tabela guarda as que NAO passaram, com
-- hora + motivo + IP, pra ter PROVA de quem tentou e nao conseguiu (e por que).
-- Assim "eu bati e nao registrou" deixa de ser palavra contra palavra.
-- Rodar 1x no SQL Editor do Supabase.
-- ============================================================

create table if not exists public.ponto_tentativas (
  id          bigint generated always as identity primary key,
  pessoa_id   text,
  nome        text,
  resultado   text not null,   -- 'falha_gps_ip' | 'fora_raio' | 'erro'
  tipo_batida text,            -- entrada1/saida1/entrada2/saida2 (proxima esperada)
  ip          text,
  detalhe     text,
  user_agent  text,
  criado_em   timestamptz not null default now()
);
create index if not exists idx_ponto_tentativas_dia    on public.ponto_tentativas (criado_em);
create index if not exists idx_ponto_tentativas_pessoa on public.ponto_tentativas (pessoa_id);

-- RLS ligado e SEM policies pra anon: ninguem le nem escreve direto.
-- Todo acesso passa pelas RPCs SECURITY DEFINER abaixo (mesmo padrao do ponto_bater).
alter table public.ponto_tentativas enable row level security;

-- ---- GRAVAR uma tentativa falha (o app chama isso) --------------------
create or replace function public.ponto_log_tentativa(
  p_pessoa_id  text,
  p_nome       text,
  p_resultado  text,
  p_tipo       text,
  p_ip         text,
  p_detalhe    text,
  p_user_agent text
) returns bigint
language sql
security definer
set search_path = public
as $$
  insert into public.ponto_tentativas
    (pessoa_id, nome, resultado, tipo_batida, ip, detalhe, user_agent)
  values
    (p_pessoa_id, p_nome, p_resultado, p_tipo, p_ip, left(p_detalhe,300), left(p_user_agent,200))
  returning id;
$$;
grant execute on function public.ponto_log_tentativa(text,text,text,text,text,text,text) to anon, authenticated;

-- ---- LER as tentativas de um dia (gestores, no editor de ponto) --------
-- Agrupa pelo dia no fuso de Rondonia (America/Porto_Velho), igual o resto do ponto.
create or replace function public.ponto_tentativas_dia(p_data date)
returns setof public.ponto_tentativas
language sql
security definer
set search_path = public
as $$
  select *
  from public.ponto_tentativas
  where (criado_em at time zone 'America/Porto_Velho')::date = p_data
  order by criado_em desc;
$$;
grant execute on function public.ponto_tentativas_dia(date) to anon, authenticated;
