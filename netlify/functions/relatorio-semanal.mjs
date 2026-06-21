// netlify/functions/relatorio-semanal.mjs
// -----------------------------------------------------------------------------
// CRON do relatório semanal — dispara o worker em background toda SEGUNDA.
//
// INSTALAR: salve junto com relatorio-semanal-background.mjs em
//   netlify/functions/  e faça commit/deploy.
//
// ⚠️ Cron do Netlify é UTC. Ji-Paraná/RO é UTC-4.
//   "30 10 * * 1" = 10:30 UTC = ~6:30 da manhã (segunda) em RO.
//   O worker leva alguns minutos (gera 1 rede + 11 cidades via IA), então as
//   notificações das 7h chegam logo em seguida. Ajuste o horário se quiser.
//
//   Campos cron:  minuto hora dia-do-mês mês dia-da-semana   (1 = segunda)
// -----------------------------------------------------------------------------

export const config = {
  schedule: "30 10 * * 1"
};

export default async (req) => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
  if (!base) return new Response("URL do site não encontrada", { status: 500 });
  try {
    // dispara o background (responde na hora; o trabalho roda async, até 15 min)
    await fetch(base + "/.netlify/functions/relatorio-semanal-background", { method: "GET" });
    console.log("[relatorio-semanal] disparado", new Date().toISOString());
    return new Response("relatorio-semanal-background disparado", { status: 200 });
  } catch (e) {
    console.error("[relatorio-semanal] falhou:", e && e.message);
    return new Response("erro: " + (e && e.message), { status: 500 });
  }
};
