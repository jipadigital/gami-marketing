// netlify/lib/sessao.js
// Validação ÚNICA de sessão do dashboard para as Netlify Functions (auditoria 13/11/2026).
//
// Antes cada função validava de um jeito (ou não validava). Aqui fica uma regra só:
//   - Sessão do usuário: headers X-Gami-User + X-Gami-Token, conferidos em usuarios_login
//     com a SERVICE KEY (token_atual OU a lista sessoes_ativas, igual ao supabase-write).
//   - Chamada interna (uma function chamando outra, ex.: agendador -> publicador): header
//     X-Gami-Interno com um valor derivado da service key. Não precisa de variável nova no
//     Netlify: as duas pontas enxergam a mesma chave e ninguém de fora consegue calcular.
//
// Uso típico no começo do handler:
//   const { exigirSessao } = require('../lib/sessao');
//   const acesso = await exigirSessao(event);            // sessão OU chamada interna
//   if (!acesso.ok) return acesso.resposta(HEADERS);
//
// Falha FECHADA: sem chave no servidor ou com erro no banco, nega (401/503).

const crypto = require('crypto');

const SUPA_URL = process.env.SUPABASE_URL || 'https://tdbyzsouhrhmhpctttps.supabase.co';
function chaveServico() {
  return process.env.SUPA_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
}

// ---- chamada interna (function -> function) --------------------------------
function tokenInterno() {
  const k = chaveServico();
  if (!k) return '';
  return crypto.createHash('sha256').update('gami-interno-v1:' + k).digest('hex');
}
function headersInternos(extra) {
  return Object.assign({ 'X-Gami-Interno': tokenInterno() }, extra || {});
}
// Lê um header tanto do formato antigo (event.headers = objeto) quanto do novo
// (Request com headers.get, usado pelas functions .mjs).
function lerHeader(event, nome) {
  const h = (event && event.headers) || {};
  if (typeof h.get === 'function') return String(h.get(nome) || '');
  const baixo = nome.toLowerCase();
  if (h[baixo] != null) return String(h[baixo]);
  for (const k of Object.keys(h)) { if (k.toLowerCase() === baixo) return String(h[k] || ''); }
  return '';
}
function ehChamadaInterna(event) {
  const esperado = tokenInterno();
  if (!esperado) return false;
  const recebido = lerHeader(event, 'X-Gami-Interno');
  if (recebido.length !== esperado.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(recebido), Buffer.from(esperado)); }
  catch (e) { return false; }
}

// ---- sessão do usuário ------------------------------------------------------
function tokenAtivo(u, token) {
  const agora = new Date();
  if (u.token_atual && u.token_atual === token && (!u.token_expira_em || new Date(u.token_expira_em) >= agora)) return true;
  if (Array.isArray(u.sessoes_ativas)) {
    for (let i = 0; i < u.sessoes_ativas.length; i++) {
      const s = u.sessoes_ativas[i];
      if (s && s.t === token && (!s.e || new Date(s.e) >= agora)) return true;
    }
  }
  return false;
}

// Cache curto em memória (por container) pra não bater no banco a cada chamada.
// Só guarda sessão VÁLIDA, por 60s. Sessão inválida nunca é cacheada.
const _cache = new Map();
const CACHE_MS = 60 * 1000;

function lerCredenciais(event) {
  return {
    userId: lerHeader(event, 'X-Gami-User').trim(),
    token: lerHeader(event, 'X-Gami-Token').trim(),
  };
}

// Devolve { ok:true, usuario:{ pessoa_id, nome, email } } ou { ok:false, status, erro }.
async function validarSessao(event) {
  const { userId, token } = lerCredenciais(event);
  if (!userId || !token) return { ok: false, status: 401, erro: 'Sessão não informada. Recarregue a página e entre de novo.' };
  if (userId.length > 80 || token.length > 300 || !/^[A-Za-z0-9_.@-]+$/.test(userId)) {
    return { ok: false, status: 401, erro: 'Sessão inválida.' };
  }
  const k = chaveServico();
  if (!k) return { ok: false, status: 503, erro: 'Servidor sem chave configurada.' };

  const ck = userId + '|' + token;
  const emCache = _cache.get(ck);
  if (emCache && emCache.ate > Date.now()) return { ok: true, usuario: emCache.usuario };

  let u;
  try {
    // select=* de propósito: não quebra se a coluna sessoes_ativas não existir.
    const r = await fetch(SUPA_URL + '/rest/v1/usuarios_login?pessoa_id=eq.' + encodeURIComponent(userId) + '&select=*&limit=1', {
      headers: { apikey: k, Authorization: 'Bearer ' + k },
    });
    if (!r.ok) return { ok: false, status: 503, erro: 'Não consegui validar a sessão agora. Tente de novo.' };
    const arr = await r.json();
    u = Array.isArray(arr) ? arr[0] : null;
  } catch (e) {
    return { ok: false, status: 503, erro: 'Não consegui validar a sessão agora. Tente de novo.' };
  }
  if (!u) return { ok: false, status: 401, erro: 'Sessão inválida. Entre de novo.' };
  if (u.ativo === false) return { ok: false, status: 401, erro: 'Usuário desativado.' };
  if (!tokenAtivo(u, token)) return { ok: false, status: 401, erro: 'Sessão expirada. Entre de novo.' };

  const usuario = { pessoa_id: u.pessoa_id, nome: u.nome || '', email: String(u.email || '').toLowerCase() };
  if (_cache.size > 500) _cache.clear();
  _cache.set(ck, { ate: Date.now() + CACHE_MS, usuario });
  return { ok: true, usuario };
}

function _negado(status, erro) {
  return {
    ok: false,
    status,
    erro,
    resposta(headers) {
      return {
        statusCode: status,
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        // "error" e "erro": o front antigo lê um ou outro conforme a tela.
        body: JSON.stringify({ error: erro, erro, sucesso: false, success: false, sessao_invalida: status === 401 }),
      };
    },
  };
}

// Sessão de usuário OU chamada interna. É o guarda padrão das funções chamadas pelo painel.
async function exigirSessao(event) {
  if (ehChamadaInterna(event)) return { ok: true, interno: true, usuario: null };
  const v = await validarSessao(event);
  if (v.ok) return { ok: true, interno: false, usuario: v.usuario };
  return _negado(v.status, v.erro);
}

// Só chamada interna (funções que nenhuma tela chama, ex.: o publicador de stories).
function exigirInterno(event) {
  if (ehChamadaInterna(event)) return { ok: true, interno: true, usuario: null };
  return _negado(401, 'Acesso negado.');
}

module.exports = {
  SUPA_URL,
  chaveServico,
  tokenInterno,
  headersInternos,
  ehChamadaInterna,
  tokenAtivo,
  validarSessao,
  exigirSessao,
  exigirInterno,
};
