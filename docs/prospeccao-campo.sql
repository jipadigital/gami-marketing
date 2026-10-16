-- ============================================================
-- PROSPECÇÃO EM CAMPO (v32.21) — CRM de campo do Carlos + gestores
-- ------------------------------------------------------------
-- Duas tabelas: lojas prospectadas + log de visitas.
-- Escrita passa pela Netlify function supabase-write (service key,
-- sessao validada), entao o anon NAO precisa de policy de escrita.
-- Leitura e direta pelo anon (dashboard), entao liberamos so SELECT.
-- Seguro de rodar: cria do zero, nao mexe em nada existente.
-- ============================================================

-- 1) LOJAS prospectadas / atendidas ---------------------------
CREATE TABLE IF NOT EXISTS public.prospeccao_lojas (
  id            text PRIMARY KEY,
  nome          text NOT NULL,
  cidade        text,                 -- nome da cidade (ex: "Fortaleza")
  cidade_slug   text,                 -- slug (ex: "fortaleza")
  bairro        text,
  endereco      text,
  lat           double precision,     -- preenchido na Parte 2 (geocodificacao)
  lng           double precision,
  status        text DEFAULT 'prospect',  -- prospect(cinza) | ativada(amarelo, sem 1o pedido) | ativa(verde, pedindo) | perdida(vermelho)
  ativada_em    date,                     -- quando foi marcada como ativada (pra medir tempo ate o 1o pedido)
  primeiro_pedido_em date,                -- preenchido na Parte 2 quando a Machine confirma o 1o pedido
  cnpj          text,
  telefone      text,
  segmento      text,
  obs           text,
  origem        text DEFAULT 'manual',    -- manual | machine (importada do cadastro)
  ativo         boolean DEFAULT true,     -- soft-delete
  criado_por      text,
  criado_por_nome text,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prosp_lojas_cidade ON public.prospeccao_lojas (cidade_slug);
CREATE INDEX IF NOT EXISTS idx_prosp_lojas_status ON public.prospeccao_lojas (status);

-- 2) VISITAS (o que o Carlos/gestor fez no dia) ---------------
CREATE TABLE IF NOT EXISTS public.prospeccao_visitas (
  id            text PRIMARY KEY,
  loja_id       text REFERENCES public.prospeccao_lojas(id) ON DELETE CASCADE,
  loja_nome     text,                 -- denormalizado pra listar rapido
  cidade        text,
  cidade_slug   text,
  data          date NOT NULL DEFAULT current_date,
  resultado     text,                 -- visitei | ativei | sem_interesse | retornar
  relato        text,                 -- "como foi a visita"
  proxima_acao  text,
  por           text,                 -- pessoa_id de quem visitou
  por_nome      text,
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prosp_visitas_loja  ON public.prospeccao_visitas (loja_id);
CREATE INDEX IF NOT EXISTS idx_prosp_visitas_data  ON public.prospeccao_visitas (data DESC);
CREATE INDEX IF NOT EXISTS idx_prosp_visitas_cidade ON public.prospeccao_visitas (cidade_slug);

-- 3) RLS: leitura liberada pro anon, escrita so via service key ----
ALTER TABLE public.prospeccao_lojas   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospeccao_visitas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS prosp_lojas_sel   ON public.prospeccao_lojas;
DROP POLICY IF EXISTS prosp_visitas_sel ON public.prospeccao_visitas;

CREATE POLICY prosp_lojas_sel   ON public.prospeccao_lojas
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY prosp_visitas_sel ON public.prospeccao_visitas
  FOR SELECT TO anon, authenticated USING (true);

-- (service_role ignora RLS, entao a Netlify function grava normal)
GRANT SELECT ON public.prospeccao_lojas   TO anon, authenticated;
GRANT SELECT ON public.prospeccao_visitas TO anon, authenticated;
