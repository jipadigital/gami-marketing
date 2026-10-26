-- ============================================================
-- CRM GÂMI — SCHEMA (Fase 0 / base da Fase 1) — 26/10/2026
-- ------------------------------------------------------------
-- PROPOSTA pra aprovação. NÃO roda nada de produção: só cria tabelas crm_* novas.
-- Dois funis (inside=BDR, field=vendedor/gestor), metas individuais, cadências,
-- histórico imutável, checklist de comissão. Carteira e "Ativado" são LIDOS da
-- Machine (mv_empresas_raiox / mv_prospeccao_mapa), o CRM não escreve na produção.
-- Escrita pelas tabelas crm_* via rota segura (service key), igual prospeccao_lojas.
-- ============================================================

-- 1) CONFIG (tudo que o Admin edita; nada fixo no código) ----------------------
CREATE TABLE IF NOT EXISTS crm_config (
  chave       text PRIMARY KEY,
  valor       jsonb NOT NULL,
  atualizado_por text,
  atualizado_em  timestamptz DEFAULT now()
);

-- 2) LEADS (o lead ativo; liga ao pool do mapa por loja_id/cnpj/nome+coord) -----
CREATE TABLE IF NOT EXISTS crm_leads (
  id            text PRIMARY KEY,                 -- ex: lead_<rand>
  loja_id       text,                             -- prospeccao_lojas.id (quando veio de prospect), nullable
  empresa_nome  text NOT NULL,
  cidade_slug   text NOT NULL,                    -- praça
  bairro        text,
  endereco      text,
  lat           numeric,
  lng           numeric,
  cnpj          text,                             -- dedup (quando existe)
  telefone      text,                             -- dedup + validado BR
  segmento      text,                             -- OBRIGATÓRIO p/ avançar (lista fixa em crm_config)
  segmento_desc text,                             -- quando segmento='Outro'
  tipo          text NOT NULL DEFAULT 'novo',     -- novo | cadastrado_nao_ativado | churn | em_queda
  pipeline      text NOT NULL,                    -- inside | field
  etapa         int  NOT NULL DEFAULT 1,          -- 1..4 (depende do pipeline, ver crm_config.etapas)
  status        text NOT NULL DEFAULT 'ativo',    -- ativo | perdido | retornar | aguardando_ativacao | ativado
  motivo_perda  text,                             -- obrigatório quando status='perdido'
  motivo_perda_txt text,
  retornar_em   date,                             -- status='retornar'
  decisor_nome  text,                             -- obrigatório p/ Oportunidade
  decisor_cargo text,
  dono_id       text,                             -- pessoa_id dono atual (posse)
  posse_desde   timestamptz,
  ultima_atividade_em timestamptz,                -- p/ devolver ao pool por inatividade
  aguardando_ativacao_desde timestamptz,
  ativado_em    timestamptz,                      -- preenchido pela leitura da Machine (1ª entrega)
  criado_por    text,
  criado_em     timestamptz DEFAULT now(),
  atualizado_em timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_leads_praca   ON crm_leads (cidade_slug, status, pipeline);
CREATE INDEX IF NOT EXISTS idx_crm_leads_dono    ON crm_leads (dono_id, status);
CREATE INDEX IF NOT EXISTS idx_crm_leads_cnpj    ON crm_leads (cnpj);
CREATE INDEX IF NOT EXISTS idx_crm_leads_loja    ON crm_leads (loja_id);

-- 3) ATIVIDADES (histórico IMUTÁVEL: toda ligação/wpp/visita/nota/mudança) ------
CREATE TABLE IF NOT EXISTS crm_atividades (
  id         bigserial PRIMARY KEY,
  lead_id    text NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  tipo       text NOT NULL,                       -- ligacao | whatsapp | visita | nota | etapa | perda | atribuicao | tarefa
  descricao  text,
  resultado  text,
  lat        numeric,                             -- check-in GPS (visita)
  lng        numeric,
  autor_id   text,
  autor_nome text,
  criado_em  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_ativ_lead ON crm_atividades (lead_id, criado_em DESC);

-- 4) TAREFAS (fila do dia; geradas pelas cadências ou manuais) ------------------
CREATE TABLE IF NOT EXISTS crm_tarefas (
  id        text PRIMARY KEY,
  lead_id   text NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  dono_id   text NOT NULL,
  tipo      text NOT NULL,                        -- ligacao | whatsapp | visita | followup | revisita
  titulo    text,
  script_id text,                                 -- crm_scripts.id (opcional)
  vence_em  timestamptz NOT NULL,
  feita     boolean DEFAULT false,
  feita_em  timestamptz,
  pulada    boolean DEFAULT false,
  origem    text DEFAULT 'cadencia',              -- cadencia | manual
  criado_em timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_tarefas_dono ON crm_tarefas (dono_id, feita, vence_em);
CREATE INDEX IF NOT EXISTS idx_crm_tarefas_lead ON crm_tarefas (lead_id);

-- 5) CHECKLIST (etapa Cadastramento do field; cada item data+autor p/ comissão) -
CREATE TABLE IF NOT EXISTS crm_checklist (
  id        bigserial PRIMARY KEY,
  lead_id   text NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  item      text NOT NULL,                        -- cadastro | ativacao | ifood | 99 | outra
  item_txt  text,                                 -- quando item='outra'
  feito     boolean DEFAULT false,
  feito_em  timestamptz,
  autor_id  text,                                 -- 'ativacao' é marcada pela Machine, não manual
  UNIQUE (lead_id, item)
);

-- 6) METAS individuais (e por praça/time) — Carlos/Admin define -----------------
CREATE TABLE IF NOT EXISTS crm_metas (
  id            bigserial PRIMARY KEY,
  pessoa_id     text,                             -- meta individual
  cidade_slug   text,                             -- meta de praça/time (opcional)
  periodo       text NOT NULL,                    -- 'YYYY-MM'
  meta_ativacoes int DEFAULT 0,
  meta_receita   numeric DEFAULT 0,
  definido_por  text,
  atualizado_em timestamptz DEFAULT now(),
  UNIQUE (pessoa_id, cidade_slug, periodo)
);

-- 7) SCRIPTS (modelos de mensagem com variáveis {nome_empresa} etc.) ------------
CREATE TABLE IF NOT EXISTS crm_scripts (
  id        text PRIMARY KEY,
  nome      text NOT NULL,
  tipo_lead text,                                 -- novo | cadastrado_nao_ativado | churn | null(=qualquer)
  etapa     int,
  canal     text,                                 -- whatsapp | ligacao
  texto     text NOT NULL,
  ativo     boolean DEFAULT true,
  criado_em timestamptz DEFAULT now()
);

-- Leitura pelo dashboard (anon), escrita pela rota segura (service key) ---------
GRANT SELECT ON crm_config, crm_leads, crm_atividades, crm_tarefas, crm_checklist, crm_metas, crm_scripts TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

-- ============================================================
-- SEED de configuração padrão (editável depois pelo Admin)
-- ============================================================
INSERT INTO crm_config (chave, valor) VALUES
('etapas', '{
  "inside":[{"n":1,"nome":"Prospectando"},{"n":2,"nome":"Contato realizado"},{"n":3,"nome":"Oportunidade"},{"n":4,"nome":"Fechamento"}],
  "field":[{"n":1,"nome":"Lead na rota"},{"n":2,"nome":"Visita realizada"},{"n":3,"nome":"Oportunidade"},{"n":4,"nome":"Cadastramento"}]
}'::jsonb),
('motivos_perda', '["Preço","Já usa concorrente","Frota própria","Não faz delivery","Fechou o negócio","Sem decisor","Outro"]'::jsonb),
('segmentos', '["Brasileira","Lanches","Hambúrguer","Pizza","Açaí","Doces & Bolos","Marmita","Salgados","Japonesa","Sorvetes","Pastel","Saudável","Italiana","Nordestina","Carnes","Cafeteria","Chinesa","Padaria","Mercado","Farmácia","Conveniência","Bebidas","Outro"]'::jsonb),
('limiares', '{"dias_devolve_lead":7,"dias_aguardando_ativacao":10,"carteira_queda_pct":30,"carteira_dias_sem_pedido":21}'::jsonb),
('cadencias', '{
  "inside_prospectando":[{"d":0,"canal":"ligacao+whatsapp","txt":"Apresentação"},{"d":1,"canal":"ligacao"},{"d":3,"canal":"whatsapp","txt":"Prova (caso da praça)"},{"d":5,"canal":"ligacao"},{"d":7,"canal":"whatsapp","txt":"Encerramento"}],
  "field_visita":[{"d":1,"canal":"whatsapp","txt":"Follow-up + proposta"},{"d":3,"canal":"revisita"}]
}'::jsonb)
ON CONFLICT (chave) DO NOTHING;
