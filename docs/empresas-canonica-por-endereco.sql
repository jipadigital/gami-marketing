-- ============================================================
-- VÍNCULO POR ENDEREÇO (canônico) — corrige o FALSO "parou de pedir"
-- nos RELATÓRIOS (raio-X + listas de churn), 21/10/2026
-- ------------------------------------------------------------
-- PROBLEMA: todos os relatórios agrupam os pedidos por nome_passageiro
-- (texto livre). A MESMA loja digitada de 2 jeitos (abreviação, nº da
-- unidade, acento, erro, nome cortado) vira "2 empresas", e a do nome
-- antigo parece ter PARADO. Ex (Campo Grande, real):
--   "Delicati"                         último 11/09  (parece parado)
--   "Casa de bolo Delicati Rua Bah"    último 20/10  (a mesma loja, viva)
-- Auditoria: ~74 lojas / ~18 mil pedidos mal atribuídos nas 9 cidades.
--
-- SOLUÇÃO: uma MV central (mv_empresa_canonica) que, POR COORDENADA DE
-- COLETA (o endereço real), aponta cada nome pro nome CANÔNICO da loja
-- (o de mais pedidos no ponto). Regra conservadora e SEGURA:
--   só absorve um nome se ele for SUBSTRING do canônico (ou vice-versa),
--   com >= 5 caracteres. Assim "Delicati" entra em "Casa de bolo
--   Delicati Rua Bah", mas um SHOPPING (lojas diferentes na mesma coord)
--   NÃO funde (nenhum nome é substring do outro). Testado nos dados reais:
--   Delicati e Massa Pura voltam a ATIVA; Melissa/Arezzo/Kopenhagen não fundem.
--
-- Os consumidores (raio-X + 3 RPCs de churn) passam a agrupar por
-- COALESCE(canonica.nome_canonico, nome_passageiro). Com o COALESCE,
-- se a MV ainda não populou, o comportamento é IGUAL ao de hoje (nada quebra).
--
-- COMO RODAR: cole TUDO no SQL Editor do Supabase e execute. Volta rápido
-- ("Success"); as MVs repopulam em ~minutos pelo pg_cron. Depois Ctrl+Shift+R.
-- ROLLBACK: rode de novo os arquivos originais (rpc_empresas_raiox_cidade.sql,
-- rpc_empresas_churn_inteligente.sql, rpc_empresas_pararam_intervalo.sql,
-- rpc_empresas_pararam_60d.sql) pra voltar ao agrupamento por nome.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS unaccent;

-- ------------------------------------------------------------
-- 1) PEÇA CENTRAL: mapa nome -> nome_canonico (por cidade), via coordenada
-- ------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS mv_empresa_canonica CASCADE;
CREATE MATERIALIZED VIEW mv_empresa_canonica AS
WITH base AS (
  SELECT
    c.cidade_slug,
    btrim(c.nome_passageiro)                         AS nome,
    NULLIF(c.raw->'coleta'->>'lat','')::numeric       AS lat,
    NULLIF(c.raw->'coleta'->>'lng','')::numeric       AS lng,
    c.data_hora_solicitacao                           AS dt
  FROM machine_corridas c
  WHERE c.data_hora_solicitacao >= now() - interval '180 days'
    AND btrim(COALESCE(c.nome_passageiro,'')) <> ''
),
agg AS (  -- qtd de pedidos por (cidade, nome)
  SELECT cidade_slug, nome, count(*) AS qtd
  FROM base GROUP BY cidade_slug, nome
),
coord AS (  -- coordenada mais recente VÁLIDA por (cidade, nome)
  SELECT DISTINCT ON (cidade_slug, nome) cidade_slug, nome, lat, lng
  FROM base
  WHERE lat IS NOT NULL AND lng IS NOT NULL AND abs(lat) > 0.01 AND abs(lng) > 0.01
  ORDER BY cidade_slug, nome, dt DESC
),
nom AS (  -- nome + qtd + chave de coordenada (~1m) + nome "achatado" (sem acento/pontuação)
  SELECT
    a.cidade_slug, a.nome, a.qtd, c.lat, c.lng,
    CASE WHEN c.lat IS NOT NULL
         THEN round(c.lat,5)::text || ',' || round(c.lng,5)::text END          AS ckey,
    lower(regexp_replace(unaccent(a.nome), '[^a-zA-Z0-9]', '', 'g'))           AS flat
  FROM agg a
  LEFT JOIN coord c ON c.cidade_slug = a.cidade_slug AND c.nome = a.nome
),
top AS (  -- nome com MAIS pedidos por (cidade, coordenada) = o canônico do ponto
  SELECT DISTINCT ON (cidade_slug, ckey) cidade_slug, ckey, nome AS top_nome, flat AS top_flat
  FROM nom
  WHERE ckey IS NOT NULL
  ORDER BY cidade_slug, ckey, qtd DESC, nome
)
SELECT
  n.cidade_slug,
  n.nome,
  n.lat, n.lng,
  CASE
    WHEN n.ckey IS NOT NULL AND t.top_nome IS NOT NULL
         AND length(n.flat) >= 5 AND length(t.top_flat) >= 5
         AND (n.flat LIKE '%' || t.top_flat || '%' OR t.top_flat LIKE '%' || n.flat || '%')
      THEN t.top_nome          -- mesma loja (substring) → usa o nome canônico do ponto
    ELSE n.nome                -- sem coord, ou nome não casa (loja diferente no mesmo endereço) → fica ele mesmo
  END AS nome_canonico
FROM nom n
LEFT JOIN top t ON t.cidade_slug = n.cidade_slug AND t.ckey = n.ckey
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_emp_canon_uk  ON mv_empresa_canonica (cidade_slug, nome);
CREATE INDEX        IF NOT EXISTS idx_mv_emp_canon_can ON mv_empresa_canonica (cidade_slug, nome_canonico);
GRANT SELECT ON mv_empresa_canonica TO anon, authenticated;

CREATE OR REPLACE FUNCTION refresh_empresa_canonica()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET statement_timeout TO '600s'
AS $ref$ BEGIN REFRESH MATERIALIZED VIEW mv_empresa_canonica; END; $ref$;

-- agenda: diário 06:30 UTC (ANTES do raio-X/mapa) + bootstrap a cada 3min que se auto-desliga
DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job
  WHERE jobname IN ('empresa_canonica_daily','empresa_canonica_bootstrap');
EXCEPTION WHEN OTHERS THEN NULL;
END $do$;
SELECT cron.schedule('empresa_canonica_daily', '30 6 * * *', $cron$ SELECT refresh_empresa_canonica(); $cron$);
SELECT cron.schedule('empresa_canonica_bootstrap', '*/3 * * * *', $cron$
  DO $b$
  BEGIN
    PERFORM refresh_empresa_canonica();
    IF EXISTS (SELECT 1 FROM mv_empresa_canonica LIMIT 1) THEN
      PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'empresa_canonica_bootstrap';
    END IF;
  END $b$;
$cron$);

-- ------------------------------------------------------------
-- 2) RAIO-X: reescreve a MV agrupando por nome CANÔNICO
--    (mesmas colunas e mesma RPC empresas_raiox_cidade — só muda o agrupamento)
-- ------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS mv_empresas_raiox CASCADE;
CREATE MATERIALIZED VIEW mv_empresas_raiox AS
  WITH base AS (   -- varredura 1: já com o nome canônico (vínculo por endereço)
    SELECT
      c.cidade_slug,
      COALESCE(k.nome_canonico, btrim(c.nome_passageiro))            AS nome,
      c.data_hora_solicitacao                                        AS dt,
      c.status_solicitacao                                           AS st,
      COALESCE(c.valor_corrida,0)::numeric                           AS val,
      to_char(date_trunc('month', c.data_hora_solicitacao),'YYYY-MM') AS ym,
      (extract(hour FROM c.data_hora_solicitacao AT TIME ZONE 'America/Campo_Grande'))::int AS hora,
      (extract(dow  FROM c.data_hora_solicitacao AT TIME ZONE 'America/Campo_Grande'))::int AS dow,
      NULLIF(btrim(c.raw->'coleta'->>'bairro'),'')                   AS bcol
    FROM machine_corridas c
    LEFT JOIN mv_empresa_canonica k
      ON k.cidade_slug = c.cidade_slug AND k.nome = btrim(c.nome_passageiro)
    WHERE c.data_hora_solicitacao >= date_trunc('month', now()) - interval '5 months'
      AND btrim(COALESCE(c.nome_passageiro,'')) <> ''
  ),
  agg AS (
    SELECT cidade_slug, nome,
      count(*) qtd, count(*) FILTER (WHERE st='F') fin, count(*) FILTER (WHERE st='C') canc,
      sum(val) FILTER (WHERE st='F') fat, min(dt) primeiro, max(dt) ultimo,
      mode() WITHIN GROUP (ORDER BY hora) hora_pico,
      mode() WITHIN GROUP (ORDER BY dow)  dia_pico,
      mode() WITHIN GROUP (ORDER BY bcol) bairro_op
    FROM base GROUP BY 1,2
  ),
  serie AS (
    SELECT cidade_slug, nome, jsonb_agg(jsonb_build_object('ym',ym,'n',n) ORDER BY ym) meses
    FROM ( SELECT cidade_slug, nome, ym, count(*) n FROM base GROUP BY 1,2,3 ) q
    GROUP BY 1,2
  ),
  entrega AS (   -- varredura 2: top 3 bairros de entrega (paradas), também por nome canônico
    SELECT cidade_slug, nome,
      string_agg(bairro || ' (' || n || ')', ', ' ORDER BY n DESC) bairros_entrega
    FROM (
      SELECT c.cidade_slug,
        COALESCE(k.nome_canonico, btrim(c.nome_passageiro)) AS nome,
        NULLIF(btrim(p->>'bairro'),'') AS bairro, count(*) n,
        row_number() OVER (PARTITION BY c.cidade_slug, COALESCE(k.nome_canonico, btrim(c.nome_passageiro))
                           ORDER BY count(*) DESC) rn
      FROM machine_corridas c
        LEFT JOIN mv_empresa_canonica k
          ON k.cidade_slug = c.cidade_slug AND k.nome = btrim(c.nome_passageiro)
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.raw->'paradas','[]'::jsonb)) p
      WHERE c.data_hora_solicitacao >= date_trunc('month', now()) - interval '5 months'
        AND btrim(COALESCE(c.nome_passageiro,'')) <> ''
        AND NULLIF(btrim(p->>'bairro'),'') IS NOT NULL
      GROUP BY c.cidade_slug, COALESCE(k.nome_canonico, btrim(c.nome_passageiro)), NULLIF(btrim(p->>'bairro'),'')
    ) q
    WHERE rn <= 3
    GROUP BY cidade_slug, nome
  )
  SELECT
    a.cidade_slug, a.nome,
    a.qtd::bigint  AS qtd_total,
    a.fin::bigint  AS qtd_finalizadas,
    a.canc::bigint AS qtd_canceladas,
    round(COALESCE(a.fat,0),2) AS faturamento,
    round(CASE WHEN a.fin>0 THEN a.fat/a.fin ELSE 0 END, 2) AS ticket,
    a.primeiro, a.ultimo, s.meses,
    a.hora_pico, a.dia_pico,
    COALESCE(a.bairro_op,'')       AS bairro_op,
    COALESCE(e.bairros_entrega,'') AS bairros_entrega
  FROM agg a
  LEFT JOIN serie   s ON s.cidade_slug = a.cidade_slug AND s.nome = a.nome
  LEFT JOIN entrega e ON e.cidade_slug = a.cidade_slug AND e.nome = a.nome
  WITH NO DATA;

CREATE INDEX IF NOT EXISTS idx_mv_raiox_cidade ON mv_empresas_raiox (cidade_slug, qtd_total DESC);

CREATE OR REPLACE FUNCTION refresh_raiox()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET statement_timeout TO '600s'
AS $ref$ BEGIN REFRESH MATERIALIZED VIEW mv_empresas_raiox; END; $ref$;

-- RPC do raio-X: IGUAL à original (só recriada porque o CASCADE a derrubou junto com a MV)
DROP FUNCTION IF EXISTS empresas_raiox_cidade(text, integer, integer);
CREATE OR REPLACE FUNCTION empresas_raiox_cidade(
  p_cidade_slug text, p_meses int DEFAULT 6, p_min_pedidos int DEFAULT 1
)
RETURNS TABLE(
  nome text, bairro text, telefone text,
  qtd_total bigint, qtd_finalizadas bigint, qtd_canceladas bigint,
  faturamento numeric, ticket numeric,
  primeiro timestamptz, ultimo timestamptz, meses jsonb,
  hora_pico int, dia_pico int, bairros_entrega text
)
LANGUAGE sql STABLE
AS $fn$
  WITH emp AS (
    SELECT DISTINCT ON (lower(btrim(nome))) lower(btrim(nome)) AS nk, telefone, bairro
    FROM machine_empresas WHERE cidade_slug = p_cidade_slug
    ORDER BY lower(btrim(nome)), (telefone IS NULL OR btrim(telefone) = ''), nome
  )
  SELECT
    m.nome,
    COALESCE(NULLIF(m.bairro_op,''), NULLIF(btrim(e.bairro),''), '') AS bairro,
    COALESCE(e.telefone,'') AS telefone,
    m.qtd_total, m.qtd_finalizadas, m.qtd_canceladas,
    m.faturamento, m.ticket, m.primeiro, m.ultimo, m.meses,
    m.hora_pico, m.dia_pico, m.bairros_entrega
  FROM mv_empresas_raiox m
  LEFT JOIN emp e ON e.nk = lower(btrim(m.nome))
  WHERE m.cidade_slug = p_cidade_slug AND m.qtd_total >= p_min_pedidos
  ORDER BY m.qtd_total DESC;
$fn$;

-- bootstrap: a MV foi recriada VAZIA pelo DROP; popula em ~minutos, mas só DEPOIS
-- que a canônica estiver pronta (pra já nascer com os nomes vinculados). Auto-desliga.
DO $do$ BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'raiox_bootstrap';
EXCEPTION WHEN OTHERS THEN NULL; END $do$;
SELECT cron.schedule('raiox_bootstrap', '*/3 * * * *', $cron$
  DO $b$
  BEGIN
    IF EXISTS (SELECT 1 FROM mv_empresa_canonica LIMIT 1) THEN
      PERFORM refresh_raiox();
      IF EXISTS (SELECT 1 FROM mv_empresas_raiox LIMIT 1) THEN
        PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'raiox_bootstrap';
      END IF;
    END IF;
  END $b$;
$cron$);

-- ------------------------------------------------------------
-- 3) CHURN INTELIGENTE: agrupa por nome canônico
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION empresas_churn_inteligente(
  p_cidade_slug   text,
  p_min_pedidos   int     DEFAULT 5,
  p_fator         numeric DEFAULT 2.0,
  p_lookback_dias int     DEFAULT 90,
  p_gap_min_dias  int     DEFAULT 3
)
RETURNS TABLE(
  nome text, telefone text, bairro text, ultimo_pedido timestamptz,
  dias_sem_pedir numeric, gap_normal_dias numeric, qtd_pedidos bigint, razao numeric
)
LANGUAGE sql STABLE
AS $fn$
  WITH base AS (
    SELECT COALESCE(k.nome_canonico, btrim(c.nome_passageiro)) AS nome,
           c.data_hora_solicitacao AS dt,
           date_trunc('day', c.data_hora_solicitacao) AS dia
    FROM machine_corridas c
    LEFT JOIN mv_empresa_canonica k
      ON k.cidade_slug = c.cidade_slug AND k.nome = btrim(c.nome_passageiro)
    WHERE c.cidade_slug = p_cidade_slug
      AND c.data_hora_solicitacao >= now() - (p_lookback_dias || ' days')::interval
      AND c.nome_passageiro IS NOT NULL
      AND btrim(c.nome_passageiro) <> ''
  ),
  dias AS ( SELECT DISTINCT nome, dia FROM base ),
  gaps AS (
    SELECT nome, dia,
      EXTRACT(EPOCH FROM (dia - lag(dia) OVER (PARTITION BY nome ORDER BY dia))) / 86400.0 AS gap_dias
    FROM dias
  ),
  cad AS (
    SELECT nome, count(*) AS dias_ativos,
      percentile_cont(0.8) WITHIN GROUP (ORDER BY gap_dias) FILTER (WHERE gap_dias IS NOT NULL) AS gap_normal
    FROM gaps GROUP BY nome
  ),
  tot AS ( SELECT nome, count(*) AS qtd, max(dt) AS ultimo_ts FROM base GROUP BY nome ),
  calc AS (
    SELECT c.nome, c.dias_ativos, c.gap_normal, t.qtd, t.ultimo_ts,
      EXTRACT(EPOCH FROM (now() - t.ultimo_ts)) / 86400.0 AS gap_atual
    FROM cad c JOIN tot t ON t.nome = c.nome
  )
  SELECT
    calc.nome,
    COALESCE(e.telefone, '')  AS telefone,
    COALESCE(NULLIF(btrim(e.bairro), ''), '—') AS bairro,
    calc.ultimo_ts AS ultimo_pedido,
    round(calc.gap_atual::numeric, 1)  AS dias_sem_pedir,
    round(calc.gap_normal::numeric, 1) AS gap_normal_dias,
    calc.qtd AS qtd_pedidos,
    round((calc.gap_atual / NULLIF(calc.gap_normal, 0))::numeric, 1) AS razao
  FROM calc
  LEFT JOIN machine_empresas e
    ON e.cidade_slug = p_cidade_slug
   AND lower(btrim(e.nome)) = lower(btrim(calc.nome))
  WHERE calc.qtd >= p_min_pedidos
    AND calc.dias_ativos >= 3
    AND calc.gap_normal IS NOT NULL
    AND calc.gap_normal > 0
    AND calc.gap_atual >= p_gap_min_dias
    AND calc.gap_atual > calc.gap_normal * p_fator
  ORDER BY (calc.gap_atual / NULLIF(calc.gap_normal, 0)) DESC, calc.gap_atual DESC;
$fn$;

-- ------------------------------------------------------------
-- 4) PARARAM (intervalo): agrupa por nome canônico
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.empresas_pararam_intervalo(
  p_cidade_slug text, p_dias_min integer DEFAULT 5,
  p_dias_max integer DEFAULT 90, p_min_pedidos integer DEFAULT 2
)
RETURNS TABLE(
  nome text, bairro text, telefone text,
  ultimo_pedido timestamptz, dias_sem_pedir integer, qtd_pedidos bigint
)
LANGUAGE sql STABLE
AS $$
  WITH agg AS (
    SELECT
      COALESCE(k.nome_canonico, btrim(c.nome_passageiro)) AS nome,
      count(*) AS qtd,
      max(c.data_hora_solicitacao) AS ultimo
    FROM public.machine_corridas c
    LEFT JOIN mv_empresa_canonica k
      ON k.cidade_slug = c.cidade_slug AND k.nome = btrim(c.nome_passageiro)
    WHERE c.cidade_slug = p_cidade_slug
      AND c.nome_passageiro IS NOT NULL
      AND btrim(c.nome_passageiro) <> ''
    GROUP BY 1
  )
  SELECT
    a.nome,
    COALESCE(NULLIF(btrim(e.bairro), ''), '—') AS bairro,
    COALESCE(e.telefone, '') AS telefone,
    a.ultimo AS ultimo_pedido,
    (current_date - a.ultimo::date)::int AS dias_sem_pedir,
    a.qtd AS qtd_pedidos
  FROM agg a
  LEFT JOIN LATERAL (
    SELECT me.bairro, me.telefone
    FROM public.machine_empresas me
    WHERE me.cidade_slug = p_cidade_slug
      AND lower(btrim(me.nome)) = lower(btrim(a.nome))
    LIMIT 1
  ) e ON true
  WHERE a.qtd >= p_min_pedidos
    AND (current_date - a.ultimo::date) >= p_dias_min
    AND (current_date - a.ultimo::date) <= p_dias_max
  ORDER BY (current_date - a.ultimo::date) ASC;
$$;
GRANT EXECUTE ON FUNCTION public.empresas_pararam_intervalo(text, integer, integer, integer) TO anon, authenticated;

-- ------------------------------------------------------------
-- 5) PARARAM 60d: agrupa por nome canônico
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.empresas_pararam_60d(
  p_cidade_slug text, p_min_pedidos_antes integer DEFAULT 3,
  p_max_recente integer DEFAULT 0, p_dias_lookback_total integer DEFAULT 120
)
RETURNS TABLE(
  nome text, bairro text, telefone text, ultimo_pedido timestamptz,
  dias_sem_pedir integer, qtd_antes_60d bigint, qtd_ultimos_60d bigint
)
LANGUAGE sql STABLE
AS $$
  WITH base AS (
    SELECT
      COALESCE(k.nome_canonico, btrim(c.nome_passageiro)) AS nome,
      c.data_hora_solicitacao AS dt
    FROM public.machine_corridas c
    LEFT JOIN mv_empresa_canonica k
      ON k.cidade_slug = c.cidade_slug AND k.nome = btrim(c.nome_passageiro)
    WHERE c.cidade_slug = p_cidade_slug
      AND c.nome_passageiro IS NOT NULL
      AND btrim(c.nome_passageiro) <> ''
      AND c.data_hora_solicitacao >= now() - (p_dias_lookback_total * interval '1 day')
  ),
  agg AS (
    SELECT nome,
      count(*) FILTER (WHERE dt <  now() - interval '60 days') AS qtd_antes,
      count(*) FILTER (WHERE dt >= now() - interval '60 days') AS qtd_recente,
      max(dt) AS ultimo
    FROM base GROUP BY nome
  )
  SELECT
    a.nome,
    COALESCE(e.bairro, '—')  AS bairro,
    COALESCE(e.telefone, '') AS telefone,
    a.ultimo AS ultimo_pedido,
    (current_date - a.ultimo::date)::int AS dias_sem_pedir,
    a.qtd_antes   AS qtd_antes_60d,
    a.qtd_recente AS qtd_ultimos_60d
  FROM agg a
  LEFT JOIN LATERAL (
    SELECT me.bairro, me.telefone
    FROM public.machine_empresas me
    WHERE me.cidade_slug = p_cidade_slug
      AND lower(btrim(me.nome)) = lower(btrim(a.nome))
    LIMIT 1
  ) e ON true
  WHERE a.qtd_antes   >= p_min_pedidos_antes
    AND a.qtd_recente <= p_max_recente
  ORDER BY a.ultimo DESC NULLS LAST;
$$;
GRANT EXECUTE ON FUNCTION public.empresas_pararam_60d(text,integer,integer,integer) TO anon, authenticated;

-- ------------------------------------------------------------
-- 6) VERIFICAÇÃO (rode DEPOIS que o cron popular a MV, ~minutos)
-- ------------------------------------------------------------
-- a) a MV central populou?
--    SELECT count(*) FROM mv_empresa_canonica;
-- b) Delicati virou 1 linha só e ATIVA no raio-X (último recente)?
--    SELECT nome, qtd_total, ultimo FROM mv_empresas_raiox
--     WHERE cidade_slug='campo-grande' AND nome ILIKE '%delicati%';
--    (esperado: "Delicati" e "Casa de Bolos Delicati Av Mato" com último de outubro)
-- c) Delicati e Massa Pura NÃO aparecem mais no churn?
--    SELECT * FROM empresas_pararam_intervalo('campo-grande',5,90,2)
--     WHERE nome ILIKE '%delicati%' OR nome ILIKE '%massa pura%';   -- esperado: vazio
-- d) o mapeamento do Delicati:
--    SELECT nome, nome_canonico FROM mv_empresa_canonica
--     WHERE cidade_slug='campo-grande' AND nome ILIKE '%delicati%';
