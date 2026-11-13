// netlify/functions/sync-agora-background.js
// -----------------------------------------------------------------------------
// Sincronização da Machine SOB DEMANDA (13/11/2026).
//
// POR QUE EXISTE: o botão "Sincronizar agora" e o agendador de 2 em 2 horas
// (sync-agendado) chamavam a URL de `sync-diario-background`. Só que ela é uma função
// AGENDADA, e o Netlify não deixa chamar função agendada por URL. Resultado: os dois
// nunca rodaram, e o espelho só atualizava 1x por dia, às 03h (por isso loja que fazia o
// 1º pedido de manhã só "ativava" no CRM no dia seguinte).
//
// Esta função NÃO é agendada, então pode ser chamada por URL. Ela só confere quem está
// chamando e reaproveita o mesmo código do sync diário (nenhuma lógica duplicada).
//
// QUEM PODE: sessão válida do painel (o botão já aparece só pra diretoria/super admin) ou
// chamada interna do agendador. Trava de frequência: se algum sync terminou há menos de
// 10 minutos, não roda de novo (evita martelar a API da Machine).
// -----------------------------------------------------------------------------

const { exigirSessao, chaveServico, SUPA_URL } = require('../lib/sessao');
const syncDiario = require('./sync-diario-background');

const INTERVALO_MIN_MS = 10 * 60 * 1000;

async function ultimoSyncMs() {
  try {
    const k = chaveServico();
    if (!k) return 0;
    const r = await fetch(SUPA_URL + '/rest/v1/machine_sync_log?select=iniciado_em&order=iniciado_em.desc&limit=1', {
      headers: { apikey: k, Authorization: 'Bearer ' + k },
    });
    if (!r.ok) return 0;
    const arr = await r.json();
    const t = Array.isArray(arr) && arr[0] && arr[0].iniciado_em ? new Date(arr[0].iniciado_em).getTime() : 0;
    return isNaN(t) ? 0 : t;
  } catch (e) { return 0; }
}

exports.handler = async function (event, context) {
  const acesso = await exigirSessao(event);
  if (!acesso.ok) {
    console.warn('[sync-agora] negado: sem sessão nem chamada interna');
    return acesso.resposta({});
  }

  const ult = await ultimoSyncMs();
  if (ult && Date.now() - ult < INTERVALO_MIN_MS) {
    console.log('[sync-agora] pulado: último sync começou há menos de 10 min');
    return { statusCode: 200, body: JSON.stringify({ ok: true, pulado: true, motivo: 'sync recente' }) };
  }

  // Só repassa parâmetros conferidos: cidade (slug simples) e dias (1 a 7).
  const q = (event && event.queryStringParameters) || {};
  const params = {};
  if (q.cidade && /^[a-z-]{3,30}$/.test(String(q.cidade).toLowerCase())) params.cidade = String(q.cidade).toLowerCase();
  const dias = parseInt(q.dias, 10);
  if (dias >= 1 && dias <= 7) params.dias = String(dias);

  console.log('[sync-agora] iniciando', JSON.stringify({ interno: !!acesso.interno, por: acesso.usuario ? acesso.usuario.pessoa_id : 'agendador', params }));
  return syncDiario.handler({ queryStringParameters: params }, context);
};
