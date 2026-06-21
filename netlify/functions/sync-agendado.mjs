// netlify/functions/sync-agendado.mjs
// -----------------------------------------------------------------------------
// LEVA 2 — Sync automático da rede (Gâmi Marketing Dashboard)
//
// O QUE FAZ: dispara a função de sync que VOCÊ JÁ TEM (sync-diario-background)
// num horário fixo, sem ninguém precisar apertar "Sincronizar". Assim a Central
// de Comando e o Relatório diário ficam sempre com dados frescos.
//
// COMO INSTALAR:
//   1. Salve este arquivo em:  netlify/functions/sync-agendado.mjs
//   2. Faça commit + deploy (do seu jeito normal pelo GitHub Desktop).
//   3. No painel do Netlify, em "Functions", o "sync-agendado" vai aparecer
//      como Scheduled. Não precisa configurar mais nada.
//
// AJUSTAR HORÁRIO: troque o cron em `config.schedule` abaixo.
//   ⚠️ O cron do Netlify é em UTC. Rondônia é UTC-4.
//   Exemplo atual: a cada 2h das 9h às 23h UTC = ~5h às 19h em Ji-Paraná.
//   - de hora em hora:        "0 * * * *"
//   - a cada 30 min:          "*/30 * * * *"
//   - 1x por dia às 6h local: "0 10 * * *"   (10 UTC = 6h em RO)
//
// Referência cron: minuto hora dia-do-mês mês dia-da-semana
// -----------------------------------------------------------------------------

export const config = {
  schedule: "0 9-23/2 * * *"
};

export default async (req) => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
  if (!base) {
    return new Response("URL do site não encontrada no ambiente", { status: 500 });
  }

  const alvo = base + "/.netlify/functions/sync-diario-background";

  try {
    // dispara a função de background existente (ela roda async, 5-15 min)
    await fetch(alvo, { method: "GET" });
    console.log("[sync-agendado] disparado:", alvo, new Date().toISOString());
    return new Response("sync-diario-background disparado com sucesso", { status: 200 });
  } catch (e) {
    console.error("[sync-agendado] falhou:", e && e.message ? e.message : e);
    return new Response("erro ao disparar sync: " + (e && e.message ? e.message : e), { status: 500 });
  }
};
