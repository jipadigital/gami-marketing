-- ============================================================
-- RPCs de atividade por INTERVALO DE DATAS (De/Até) para os relatorios.
-- Espelham empresas_atividade_real / motoboys_atividade_real, mas em vez de
-- "ultimos N dias" recebem p_data_inicio e p_data_fim (ambos inclusivos).
-- NAO substituem as RPCs atuais — sao funcoes NOVAS, entao nada quebra.
-- Bonus: somam paradas_count (a coluna correta) em vez de total_paradas.
-- Rodar no SQL Editor do Supabase.
-- ============================================================

-- ---- EMPRESAS (Top clientes) --------------------------------
create or replace function public.empresas_atividade_periodo(
  p_cidade_slug  text,
  p_data_inicio  date,
  p_data_fim     date
)
returns table(
  nome_passageiro     text,
  primeira_corrida    timestamptz,
  ultima_corrida      timestamptz,
  total_corridas      bigint,
  total_finalizadas   bigint,
  total_canceladas    bigint,
  total_paradas       bigint,
  paradas_finalizadas bigint,
  valor_total         numeric,
  ticket_medio_parada numeric,
  dias_distintos      bigint,
  dias_sem_pedir      integer
)
language sql
stable
as $$
  with base as (
    select
      btrim(c.nome_passageiro)         as nome,
      c.data_hora_solicitacao          as dt,
      c.status_solicitacao             as st,
      coalesce(c.paradas_count, 0)     as par,
      coalesce(c.valor_corrida, 0)     as val
    from public.machine_corridas c
    where c.cidade_slug = p_cidade_slug
      and c.nome_passageiro is not null
      and btrim(c.nome_passageiro) <> ''
      and c.data_hora_solicitacao >= p_data_inicio::timestamp
      and c.data_hora_solicitacao <  (p_data_fim + 1)::timestamp
  )
  select
    nome,
    min(dt),
    max(dt),
    count(*),
    count(*) filter (where st = 'F'),
    count(*) filter (where st = 'C'),
    sum(par),
    sum(par) filter (where st = 'F'),
    sum(val) filter (where st = 'F'),
    case when sum(par) filter (where st = 'F') > 0
         then round(sum(val) filter (where st = 'F') / sum(par) filter (where st = 'F'), 2)
         else 0 end,
    count(distinct dt::date),
    (current_date - max(dt)::date)::int
  from base
  group by nome;
$$;

grant execute on function public.empresas_atividade_periodo(text,date,date) to anon, authenticated;

-- ---- MOTOBOYS (Top motoboys) --------------------------------
create or replace function public.motoboys_atividade_periodo(
  p_cidade_slug  text,
  p_data_inicio  date,
  p_data_fim     date
)
returns table(
  condutor_id         text,
  nome_condutor       text,
  primeira_corrida    timestamptz,
  ultima_corrida      timestamptz,
  total_corridas      bigint,
  total_finalizadas   bigint,
  total_canceladas    bigint,
  total_paradas       bigint,
  paradas_finalizadas bigint,
  valor_total         numeric,
  ticket_medio_parada numeric,
  dias_distintos      bigint,
  dias_sem_rodar      integer
)
language sql
stable
as $$
  with base as (
    select
      c.condutor_id::text          as cid,
      c.nome_condutor              as nome_cond,
      c.data_hora_solicitacao      as dt,
      c.status_solicitacao         as st,
      coalesce(c.paradas_count, 0) as par,
      coalesce(c.valor_corrida, 0) as val
    from public.machine_corridas c
    where c.cidade_slug = p_cidade_slug
      and c.condutor_id is not null
      and c.data_hora_solicitacao >= p_data_inicio::timestamp
      and c.data_hora_solicitacao <  (p_data_fim + 1)::timestamp
  )
  select
    cid,
    max(nome_cond),
    min(dt),
    max(dt),
    count(*),
    count(*) filter (where st = 'F'),
    count(*) filter (where st = 'C'),
    sum(par),
    sum(par) filter (where st = 'F'),
    sum(val) filter (where st = 'F'),
    case when sum(par) filter (where st = 'F') > 0
         then round(sum(val) filter (where st = 'F') / sum(par) filter (where st = 'F'), 2)
         else 0 end,
    count(distinct dt::date),
    (current_date - max(dt)::date)::int
  from base
  group by cid;
$$;

grant execute on function public.motoboys_atividade_periodo(text,date,date) to anon, authenticated;
