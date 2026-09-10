-- Push Notifications (avisos de compromisso mesmo com o app FECHADO) — 10/09/2026
-- Rode no Supabase (SQL Editor). RLS aberto (mesmo modelo do resto do app: o cliente
-- escreve com a anon key; dado pouco sensível — inscrição do próprio aparelho e horários).

-- 1) Inscrições de push (1 por aparelho/navegador)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pessoa_id   text NOT NULL,
  endpoint    text NOT NULL UNIQUE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  user_agent  text,
  criado_em   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_subs_pessoa ON push_subscriptions(pessoa_id);

-- 2) Avisos agendados (o cliente, com o app aberto, grava os horários de hoje;
--    a função push-enviar dispara na hora, mesmo depois de fechar o app)
CREATE TABLE IF NOT EXISTS push_agendados (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pessoa_id   text NOT NULL,
  titulo      text NOT NULL,
  quando      timestamptz NOT NULL,   -- instante (UTC) do disparo
  tipo        text NOT NULL,          -- 'pre' (10min antes) ou 'now' (na hora)
  enviado     boolean NOT NULL DEFAULT false,
  criado_em   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pessoa_id, titulo, quando, tipo)
);
CREATE INDEX IF NOT EXISTS idx_push_ag_due ON push_agendados(enviado, quando);

-- RLS aberto (anon lê/escreve). Se preferir travar depois, roteie via função service-key.
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_agendados     ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_push_subs_all ON push_subscriptions;
DROP POLICY IF EXISTS p_push_ag_all   ON push_agendados;
CREATE POLICY p_push_subs_all ON push_subscriptions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY p_push_ag_all   ON push_agendados     FOR ALL USING (true) WITH CHECK (true);
