// netlify/functions/backup-semanal-background.js
// Roda aos domingos às 4h de Brasília (7h UTC).
//
// 13/11/2026: REESCRITA. A versão antiga chamava duas funções do banco que nunca existiram
// (gerar_backup_semanal e limpar_rate_limit_antigo), então não fazia nada desde sempre e
// ainda respondia "ok". O backup de verdade é o DIÁRIO (backup-diario-background), que roda
// todo dia às 5h e guarda o histórico.
//
// O que esta função faz agora, uma vez por semana:
//   1) CONFERE os backups diários dos últimos 7 dias: existe um por dia? veio com dados?
//      encolheu de repente? Se algo estiver errado grava um alerta CRÍTICO em alertas_log.
//      Se estiver tudo certo grava um alerta informativo (assim dá pra ver que conferiu).
//   2) Limpa sessões expiradas (função do banco que já existe).
// Sem chave de serviço não roda (não cai mais na chave pública).
// ============================================================

const { schedule } = require('@netlify/functions');

const SUPA_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
const CHAVE = process.env.SUPA_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY || '';

function cab(extra) {
  return Object.assign({ apikey: CHAVE, Authorization: 'Bearer ' + CHAVE, 'Content-Type': 'application/json' }, extra || {});
}
async function alerta(tipo, severidade, mensagem, detalhes) {
  try {
    await fetch(SUPA_URL + '/rest/v1/alertas_log', {
      method: 'POST',
      headers: cab({ Prefer: 'return=minimal' }),
      body: JSON.stringify([{ tipo, severidade, origem: 'backup-semanal-background', mensagem, detalhes }]),
    });
  } catch (e) { console.error('[backup-semanal] não consegui gravar o alerta:', e && e.message); }
}
function dia(d) { return d.toISOString().slice(0, 10); }

// Analisa a lista de backups (mais recentes primeiro ou em qualquer ordem) e devolve os problemas.
// Exportada pra teste.
function conferir(lista, hoje) {
  const porDia = {};
  (Array.isArray(lista) ? lista : []).forEach((b) => { if (b && b.data_backup) porDia[String(b.data_backup).slice(0, 10)] = b; });
  const problemas = [];
  const dias = [];
  for (let i = 0; i < 7; i++) dias.push(dia(new Date(hoje.getTime() - i * 86400000)));
  let anterior = null; // registro do dia seguinte (mais novo), pra comparar tamanho
  // percorre do mais antigo pro mais novo
  dias.slice().reverse().forEach((d, idx) => {
    const b = porDia[d];
    // o backup de hoje roda às 8h UTC; esta função roda às 7h UTC, então hoje pode faltar
    if (!b) { if (d !== dia(hoje)) problemas.push('Sem backup em ' + d); return; }
    const reg = Number(b.total_registros) || 0;
    if (reg <= 0) problemas.push('Backup de ' + d + ' veio vazio');
    if (anterior && anterior > 0 && reg < anterior * 0.7) problemas.push('Backup de ' + d + ' encolheu de ' + anterior + ' para ' + reg + ' registros');
    if (reg > 0) anterior = reg;
  });
  return { problemas, dias_conferidos: dias.length, backups_encontrados: dias.filter((d) => porDia[d]).length };
}

const handler = async function () {
  const inicio = Date.now();
  console.log('[backup-semanal] conferência iniciada', new Date().toISOString());
  if (!CHAVE) {
    console.error('[backup-semanal] SUPA_SERVICE_KEY ausente: não rodou');
    return { statusCode: 500, body: JSON.stringify({ ok: false, erro: 'chave de serviço ausente' }) };
  }
  const resultado = { ok: true, etapas: [] };

  // 1) Conferência dos backups diários
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/rpc/listar_backups_diarios', { method: 'POST', headers: cab(), body: '{}' });
    if (!r.ok) throw new Error('listar_backups_diarios HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const c = conferir(await r.json(), new Date());
    resultado.etapas.push(Object.assign({ etapa: 'conferir_backups_diarios' }, c));
    if (c.problemas.length) {
      resultado.ok = false;
      await alerta('backup_semana_com_falha', 'critico', 'Conferência semanal: há problema nos backups diários', c);
    } else {
      await alerta('backup_semana_ok', 'info', 'Conferência semanal: backups diários dos últimos 7 dias estão em ordem', c);
    }
  } catch (e) {
    resultado.ok = false;
    resultado.etapas.push({ etapa: 'conferir_backups_diarios', ok: false, erro: e.message });
    await alerta('backup_semana_com_falha', 'critico', 'Conferência semanal dos backups não conseguiu rodar', { erro: e.message });
  }

  // 2) Limpeza de sessões expiradas (melhor esforço)
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/rpc/limpar_sessoes_expiradas', { method: 'POST', headers: cab(), body: '{}' });
    resultado.etapas.push({ etapa: 'limpar_sessoes', ok: r.ok, removidas: r.ok ? await r.json().catch(() => null) : undefined });
  } catch (e) {
    resultado.etapas.push({ etapa: 'limpar_sessoes', ok: false, erro: e.message });
  }

  resultado.duracao_seg = Math.round((Date.now() - inicio) / 1000);
  console.log('[backup-semanal] fim', JSON.stringify(resultado));
  // Diz a verdade no status: falhou = 500 (antes respondia 200 mesmo sem fazer nada).
  return { statusCode: resultado.ok ? 200 : 500, body: JSON.stringify(resultado) };
};

// Roda aos domingos às 7h UTC = 4h Brasília
exports.handler = schedule('0 7 * * 0', handler);
exports._conferir = conferir;
