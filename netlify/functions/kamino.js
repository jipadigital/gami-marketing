// netlify/functions/kamino.js
// -----------------------------------------------------------------------------
// Ponte de LEITURA com a API do Kamino (13/11/2026). Ambiente: o Kamino ANTIGO
// (gamidelivery.kamino.pro), que continua em uso porque o novo ainda não integra com o Cora.
//
// Credenciais: UMA variável de ambiente, KAMINO_API_JSON (escopo Functions), com
//   {"url":"https://...kamino.tech","app":"...","cn":"...","idusr":"...","usr":"...","hash":"..."}
// geradas no usuário dashboard@gamidelivery.com.br (só Visualizador). Elas NUNCA saem daqui:
// nenhuma resposta devolve nem parte delas.
//
// Autenticação do Kamino: 5 cabeçalhos fixos em toda chamada (App, CN, IDUsr, Usr, Hash).
// Limite deles: 20 requisições por minuto por empresa.
//
// Por enquanto só a ação 'teste' (lista as contas bancárias ativas, sem gravar nada) e só
// para o super admin. O sync pro módulo financeiro vem depois, em cima desta base.
// -----------------------------------------------------------------------------

const { exigirSessao } = require('../lib/sessao');

const SUPER_ADMIN_EMAIL = 'jipadigital@gmail.com';
const ORIGENS = ['https://gami-marketing.netlify.app', 'http://localhost:8888'];

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ORIGENS.indexOf(origin) >= 0 ? origin : ORIGENS[0],
    'Access-Control-Allow-Headers': 'Content-Type, X-Gami-User, X-Gami-Token',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
}

// Lê e confere as credenciais. Devolve { cred } ou { erro } (o erro nunca cita valores).
function credenciais() {
  const bruto = process.env.KAMINO_API_JSON || '';
  if (!bruto.trim()) return { erro: 'KAMINO_API_JSON não está configurada no Netlify (ou falta o redeploy).' };
  let j;
  try { j = JSON.parse(bruto); } catch (e) { return { erro: 'KAMINO_API_JSON não é um JSON válido (confira aspas e chaves).' }; }
  const faltam = ['url', 'app', 'cn', 'idusr', 'usr', 'hash'].filter((k) => !String((j && j[k]) || '').trim());
  if (faltam.length) return { erro: 'Faltam campos em KAMINO_API_JSON: ' + faltam.join(', ') };
  let host = '';
  try {
    const u = new URL(String(j.url).trim());
    if (u.protocol !== 'https:') return { erro: 'O "url" do Kamino precisa começar com https://' };
    host = u.host.toLowerCase();
  } catch (e) { return { erro: 'O "url" do Kamino não é um endereço válido.' }; }
  // Só manda as chaves pra servidor do próprio Kamino.
  if (!/(^|\.)kamino\.(tech|pro|com\.br)$/.test(host)) return { erro: 'O "url" não é um endereço do Kamino (esperado ...kamino.tech).' };
  return {
    cred: {
      base: String(j.url).trim().replace(/\/+$/, ''),
      headers: {
        Accept: 'application/json',
        App: String(j.app).trim(),
        CN: String(j.cn).trim(),
        IDUsr: String(j.idusr).trim(),
        Usr: String(j.usr).trim(),
        Hash: String(j.hash).trim(),
      },
    },
  };
}

async function kaminoGet(cred, caminho) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(cred.base + caminho, { headers: cred.headers, signal: ctrl.signal });
    let corpo = null;
    const txt = await r.text();
    try { corpo = JSON.parse(txt); } catch (e) { corpo = null; }
    return { status: r.status, corpo, trecho: corpo ? null : txt.slice(0, 160) };
  } finally {
    clearTimeout(t);
  }
}

exports.handler = async function (event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const H = cors(origin);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: H, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: H, body: JSON.stringify({ ok: false, erro: 'Use POST' }) };

  const acesso = await exigirSessao(event);
  if (!acesso.ok) return acesso.resposta(H);
  // Por enquanto só o dono (e-mail do LOGIN, que o usuário não consegue editar).
  if (!acesso.usuario || acesso.usuario.email !== SUPER_ADMIN_EMAIL) {
    return { statusCode: 403, headers: H, body: JSON.stringify({ ok: false, erro: 'Acesso restrito.' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { /* vazio */ }
  const acao = String(body.acao || 'teste');

  const c = credenciais();
  if (c.erro) return { statusCode: 200, headers: H, body: JSON.stringify({ ok: false, etapa: 'configuracao', erro: c.erro }) };

  if (acao === 'teste') {
    try {
      const r = await kaminoGet(c.cred, '/api/financeiro/contabanco/lista?ApenasAtivas=true');
      if (r.status === 401 || r.status === 403) {
        return { statusCode: 200, headers: H, body: JSON.stringify({ ok: false, etapa: 'autenticacao', status: r.status, erro: 'O Kamino recusou as chaves (confira se colou os 5 valores certos e o Link para API).' }) };
      }
      if (r.status === 429) return { statusCode: 200, headers: H, body: JSON.stringify({ ok: false, etapa: 'limite', status: 429, erro: 'Limite de 20 chamadas por minuto do Kamino. Tente em 1 minuto.' }) };
      if (r.status < 200 || r.status >= 300 || !r.corpo) {
        return { statusCode: 200, headers: H, body: JSON.stringify({ ok: false, etapa: 'resposta', status: r.status, erro: 'Resposta inesperada do Kamino.', trecho: r.trecho }) };
      }
      // A lista pode vir direto ou dentro de um campo; pegamos só nome/banco (sem saldo nem número da conta).
      const lista = Array.isArray(r.corpo) ? r.corpo : (Array.isArray(r.corpo.Dados) ? r.corpo.Dados : Array.isArray(r.corpo.dados) ? r.corpo.dados : Array.isArray(r.corpo.Lista) ? r.corpo.Lista : []);
      const contas = lista.slice(0, 30).map((x) => ({
        nome: String(x.Nome || x.Descricao || x.Apelido || x.nome || '').slice(0, 60),
        banco: String(x.Banco || x.NomeBanco || (x.Banco && x.Banco.Nome) || x.IDBanco || '').slice(0, 40),
        ativa: x.Ativa !== undefined ? !!x.Ativa : (x.Ativo !== undefined ? !!x.Ativo : null),
      }));
      return {
        statusCode: 200,
        headers: H,
        body: JSON.stringify({ ok: true, status: r.status, total: lista.length, contas, campos: lista[0] ? Object.keys(lista[0]).slice(0, 40) : (r.corpo && !Array.isArray(r.corpo) ? Object.keys(r.corpo).slice(0, 20) : []) }),
      };
    } catch (e) {
      return { statusCode: 200, headers: H, body: JSON.stringify({ ok: false, etapa: 'rede', erro: e && e.name === 'AbortError' ? 'O Kamino não respondeu em 9 segundos.' : 'Não consegui falar com o Kamino.' }) };
    }
  }

  return { statusCode: 400, headers: H, body: JSON.stringify({ ok: false, erro: 'Ação desconhecida.' }) };
};
