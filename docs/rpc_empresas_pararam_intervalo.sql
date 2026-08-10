-- ============================================================
-- RPC: empresas_pararam_intervalo  (lista de reativacao por janela)
-- Empresas (por cidade) cujo ULTIMO pedido foi entre p_dias_min e
-- p_dias_max dias atras — ex: parou de pedir ha 5 a 90 dias — e que
-- tinham pelo menos p_min_pedidos pedidos (cliente de verdade).
-- Ordena das que pararam MAIS RECENTE pras mais antigas (topo = mais
-- facil de reativar).
-- Rodar no SQL Editor do Supabase.
-- ============================================================
create or replace function public.empresas_pararam_intervalo(
  p_cidade_slug  text,
  p_dias_min     integer default 5,
  p_dias_max     integer default 90,
  p_min_pedidos  integer default 2
)
returns table(
  nome           text,
  bairro         text,
  telefone       text,
  ultimo_pedido  timestamptz,
  dias_sem_pedir integer,
  qtd_pedidos    bigint
)
language sql
stable
as $$
  with agg as (
    select
      c.nome_passageiro                as nome,
      count(*)                         as qtd,
      max(c.data_hora_solicitacao)     as ultimo
    from public.machine_corridas c
    where c.cidade_slug = p_cidade_slug
      and c.nome_passageiro is not null
      and btrim(c.nome_passageiro) <> ''
    group by c.nome_passageiro
  )
  select
    a.nome,
    coalesce(nullif(btrim(e.bairro), ''), '—') as bairro,
    coalesce(e.telefone, '')                   as telefone,
    a.ultimo                                   as ultimo_pedido,
    (current_date - a.ultimo::date)::int       as dias_sem_pedir,
    a.qtd                                      as qtd_pedidos
  from agg a
  left join lateral (
    select me.bairro, me.telefone
    from public.machine_empresas me
    where me.cidade_slug = p_cidade_slug
      and lower(btrim(me.nome)) = lower(btrim(a.nome))
    limit 1
  ) e on true
  where a.qtd >= p_min_pedidos
    and (current_date - a.ultimo::date) >= p_dias_min
    and (current_date - a.ultimo::date) <= p_dias_max
  order by (current_date - a.ultimo::date) asc;
$$;

grant execute on function public.empresas_pararam_intervalo(text, integer, integer, integer) to anon, authenticated;
