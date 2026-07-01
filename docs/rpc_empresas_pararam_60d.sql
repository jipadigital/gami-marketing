-- ============================================================
-- RPC: empresas_pararam_60d  (churn de médio prazo — 60 dias)
-- Espelha empresas_pararam_30d / empresas_pararam_90d para a janela de 60d.
-- Empresas (nome_passageiro em machine_corridas) que tinham
--   >= p_min_pedidos_antes pedidos na janela "antes" (60 a p_dias_lookback_total dias)
--   e <= p_max_recente pedidos nos últimos 60 dias  → churn confirmado.
-- "pedido" = 1 corrida (COUNT(*)), todos os status — igual à RPC de 30d.
-- Rodar no SQL Editor do Supabase.
-- ============================================================
create or replace function public.empresas_pararam_60d(
  p_cidade_slug         text,
  p_min_pedidos_antes   integer default 3,
  p_max_recente         integer default 0,
  p_dias_lookback_total integer default 120
)
returns table(
  nome            text,
  bairro          text,
  telefone        text,
  ultimo_pedido   timestamptz,
  dias_sem_pedir  integer,
  qtd_antes_60d   bigint,
  qtd_ultimos_60d bigint
)
language sql
stable
as $$
  with base as (
    select
      c.nome_passageiro       as nome,
      c.data_hora_solicitacao as dt
    from public.machine_corridas c
    where c.cidade_slug = p_cidade_slug
      and c.nome_passageiro is not null
      and btrim(c.nome_passageiro) <> ''
      and c.data_hora_solicitacao >= now() - (p_dias_lookback_total * interval '1 day')
  ),
  agg as (
    select
      nome,
      count(*) filter (where dt <  now() - interval '60 days') as qtd_antes,
      count(*) filter (where dt >= now() - interval '60 days') as qtd_recente,
      max(dt) as ultimo
    from base
    group by nome
  )
  select
    a.nome,
    coalesce(e.bairro, '—')  as bairro,
    coalesce(e.telefone, '') as telefone,
    a.ultimo                 as ultimo_pedido,
    (current_date - a.ultimo::date)::int as dias_sem_pedir,
    a.qtd_antes   as qtd_antes_60d,
    a.qtd_recente as qtd_ultimos_60d
  from agg a
  left join lateral (
    select me.bairro, me.telefone
    from public.machine_empresas me
    where me.cidade_slug = p_cidade_slug
      and lower(btrim(me.nome)) = lower(btrim(a.nome))
    limit 1
  ) e on true
  where a.qtd_antes   >= p_min_pedidos_antes
    and a.qtd_recente <= p_max_recente
  order by a.ultimo desc nulls last;
$$;

grant execute on function public.empresas_pararam_60d(text,integer,integer,integer) to anon, authenticated;
