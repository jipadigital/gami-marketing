// netlify/lib/push.js
// Envio de push (Web Push / VAPID) num lugar só (13/11/2026).
//
// O QUE ESTAVA QUEBRADO:
//  1) send-push lia as inscrições no formato antigo da tabela (colunas `ativa` e
//     `subscription_json`, que não existem mais). A tabela hoje guarda endpoint + p256dh +
//     auth. Resultado: nunca achava inscrição nenhuma e nenhum push de tarefa saía.
//  2) send-push mandava o texto em {titulo, mensagem}; o service worker lê {title, body}.
//  3) O painel tem DOIS pares de chaves VAPID em uso (um do push antigo, outro do push de
//     compromissos), e cada function usava nomes de variável diferentes. A inscrição de cada
//     aparelho só aceita o par com que foi criada.
//
// COMO FICA: uma função só lê as inscrições no formato atual e tenta o envio com cada par de
// chaves configurado no servidor. Se o primeiro par for recusado por "chave não confere"
// (401/403), tenta o outro. Inscrição morta (404/410) é removida.

const webpush = require('web-push');
const { SUPA_URL, chaveServico } = require('./sessao');

const ASSUNTO = process.env.VAPID_SUBJECT || 'mailto:jipadigital@gmail.com';

// Pares de chaves disponíveis no servidor (aceita os dois jeitos de nomear a variável).
function paresVapid() {
  const pares = [];
  const add = (pub, priv) => { if (pub && priv && !pares.some((p) => p.publicKey === pub)) pares.push({ subject: ASSUNTO, publicKey: pub, privateKey: priv }); };
  add(process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  add(process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);
  return pares;
}

function cab() { const k = chaveServico(); return { apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' }; }

// Só id simples (evita injetar filtro na consulta).
function idsLimpos(ids) {
  return Array.from(new Set((ids || []).map((x) => String(x || '').trim()).filter((x) => /^[A-Za-z0-9_.@-]{1,80}$/.test(x)))).slice(0, 300);
}

async function inscricoesDe(pessoaIds) {
  const ids = idsLimpos(pessoaIds);
  if (!ids.length || !chaveServico()) return [];
  const lista = ids.map((id) => '"' + id + '"').join(',');
  const r = await fetch(SUPA_URL + '/rest/v1/push_subscriptions?pessoa_id=in.(' + encodeURIComponent(lista) + ')&select=id,pessoa_id,endpoint,p256dh,auth&limit=2000', { headers: cab() });
  if (!r.ok) throw new Error('push_subscriptions HTTP ' + r.status);
  const arr = await r.json();
  return (Array.isArray(arr) ? arr : []).filter((s) => s && s.endpoint && s.p256dh && s.auth);
}

async function removerInscricao(id) {
  if (id == null || !/^[A-Za-z0-9-]{1,60}$/.test(String(id))) return;
  try { await fetch(SUPA_URL + '/rest/v1/push_subscriptions?id=eq.' + encodeURIComponent(String(id)), { method: 'DELETE', headers: Object.assign(cab(), { Prefer: 'return=minimal' }) }); } catch (e) { /* melhor esforço */ }
}

// Manda UM push pra UMA inscrição, tentando cada par de chaves.
// Devolve 'ok' | 'morta' (aparelho desinscreveu) | 'falha'.
async function enviarUm(insc, payloadTexto, opcoes) {
  const pares = paresVapid();
  if (!pares.length) return 'falha';
  const sub = { endpoint: insc.endpoint, keys: { p256dh: insc.p256dh, auth: insc.auth } };
  for (const par of pares) {
    try {
      await webpush.sendNotification(sub, payloadTexto, Object.assign({ TTL: 60 * 60 * 24, vapidDetails: par }, opcoes || {}));
      return 'ok';
    } catch (err) {
      const st = err && err.statusCode;
      if (st === 404 || st === 410) return 'morta';
      if (st === 401 || st === 403) continue; // chave não confere com esta inscrição: tenta o outro par
      return 'falha';
    }
  }
  return 'falha';
}

// Link do clique: só caminho do próprio painel (nunca site de fora).
function urlSegura(u) {
  u = String(u || '/');
  return (u.charAt(0) === '/' && u.charAt(1) !== '/' && u.indexOf('\\') < 0 && u.length <= 300) ? u : '/';
}

// Monta o texto no formato que o service worker lê ({title, body, url, tag}).
function montarPayload({ titulo, mensagem, url, tag, tipo }) {
  return JSON.stringify({
    title: String(titulo || 'Notificação Gâmi').slice(0, 120),
    body: String(mensagem || '').slice(0, 300),
    url: urlSegura(url),
    tag: String(tag || ('gami-' + (tipo || 'geral'))).slice(0, 80),
    tipo: String(tipo || 'geral').slice(0, 40),
    ts: Date.now(),
  });
}

// Envia pra todas as inscrições das pessoas. Devolve contagens.
async function enviarParaPessoas(pessoaIds, dados) {
  if (!paresVapid().length) return { ok: false, erro: 'Chaves de push (VAPID) não configuradas no servidor', enviados: 0, falhas: 0, removidas: 0, inscricoes: 0 };
  const inscs = await inscricoesDe(pessoaIds);
  if (!inscs.length) return { ok: true, enviados: 0, falhas: 0, removidas: 0, inscricoes: 0, motivo: 'Nenhum aparelho inscrito pra essa(s) pessoa(s)' };
  const payload = montarPayload(dados || {});
  let enviados = 0, falhas = 0, removidas = 0;
  await Promise.all(inscs.map(async (s) => {
    const r = await enviarUm(s, payload);
    if (r === 'ok') enviados++;
    else if (r === 'morta') { removidas++; await removerInscricao(s.id); }
    else falhas++;
  }));
  return { ok: true, enviados, falhas, removidas, inscricoes: inscs.length };
}

module.exports = { paresVapid, inscricoesDe, enviarUm, enviarParaPessoas, montarPayload, removerInscricao, urlSegura };
