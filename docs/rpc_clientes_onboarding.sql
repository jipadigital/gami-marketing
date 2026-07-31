-- ============================================================
-- RPC: clientes_onboarding  (lista de onboarding do dia)
-- Clientes CADASTRADOS nos ultimos p_dias_max_cad dias que ainda
-- NAO fizeram NENHUM pedido (0 corridas em machine_corridas).
-- Serve pro time de suporte ativar/conversar com cada novo cliente.
-- Ordena do cadastro mais recente pro mais antigo.
-- Atualiza sozinho conforme o sync diario traz novos cadastros.
-- Rodar no SQL Editor do Supabase.
-- ============================================================
create or replace function public.clientes_onboarding(
  p_cidade_slug   text,
  p_dias_max_cad  integer default 30
)
returns table(
  nome            text,
  bairro          text,
  telefone        text,
  status_empresa  text,
  data_cadastro   timestamp,
  dias_cadastrado integer
)
language sql
stable
as $$
  select
    e.nome,
    coalesce(nullif(btrim(e.bairro), ''), '—')            as bairro,
    coalesce(e.telefone, '')                              as telefone,
    coalesce(e.status_empresa, '')                        as status_empresa,
    (e.raw->>'data_hora_cadastro')::timestamp             as data_cadastro,
    (current_date - ((e.raw->>'data_hora_cadastro')::timestamp)::date)::int as dias_cadastrado
  from public.machine_empresas e
  where e.cidade_slug = p_cidade_slug
    and e.raw->>'data_hora_cadastro' is not null
    and (e.raw->>'data_hora_cadastro')::timestamp >= now() - (p_dias_max_cad * interval '1 day')
    -- ainda NAO pediu: nenhuma corrida com esse nome de empresa na cidade
    and not exists (
      select 1
      from public.machine_corridas c
      where c.cidade_slug = p_cidade_slug
        and lower(btrim(c.nome_passageiro)) = lower(btrim(e.nome))
    )
  order by (e.raw->>'data_hora_cadastro')::timestamp desc;
$$;

grant execute on function public.clientes_onboarding(text, integer) to anon, authenticated;
