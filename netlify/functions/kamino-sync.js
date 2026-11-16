// netlify/functions/kamino-sync.js
// Agendada (netlify.toml, a cada 10 min): puxa do Kamino pro espelho do financeiro (fin_kmn_*).
// SÓ LEITURA no Kamino. Não responde a chamada comum por URL (só ao agendador do Netlify).
'use strict';
const { rodada } = require('../lib/kamino-sync-core');

exports.handler = async function (event) {
  let agendado = false;
  try { agendado = !!JSON.parse((event && event.body) || '{}').next_run; } catch (e) { agendado = false; }
  if (!agendado) return { statusCode: 403, body: 'Somente o agendador.' };
  try {
    const r = await rodada({});
    console.log('[kamino-sync]', JSON.stringify({ ok: r.ok, erro: r.erro, chamadas: r.chamadas, ms: r.ms, parado: r.parado, log: r.log, stats: r.stats }));
  } catch (e) {
    console.error('[kamino-sync] falhou:', e && e.message);
  }
  return { statusCode: 200, body: 'ok' };
};
