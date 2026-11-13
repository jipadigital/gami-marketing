// netlify/lib/valores.js
// Quem pode VER VALORES em R$ (decisão do dono, 13/11/2026):
//   super admin, diretoria, gerência, gestor e financeiro.
// Os demais níveis (vendedor, prospecção, suporte, colaborador, auditoria) NÃO veem.
//
// O painel já esconde os valores na TELA pra esses níveis (ocultar_valores na matriz de
// permissões). Faltava o servidor: qualquer logado conseguia ler valor_corrida pelo
// console e reconstruir faturamento/LTV. Este módulo fecha isso do lado do servidor.
//
// REGRA DE NÍVEL: é o ESPELHO do detectarNivelPermissao() do index.html, na mesma ordem.
// Se mudar lá, mude aqui. O servidor nunca pode restringir MAIS do que a tela (senão
// alguém que vê valor na tela passaria a receber zero).

const crypto = require('crypto');
const { SUPA_URL, chaveServico } = require('./sessao');

const SUPER_ADMIN_EMAIL = 'jipadigital@gmail.com';
const AUDITORES = ['auditor@seg.gami'];
// Convidados externos tratados como diretoria (hash sha256 do e-mail, igual ao painel).
const CONVIDADOS_H = [
  'eb8eeec3d83c65666a44e748500d3b103af5b4ab9cbf8d69faae20e7e6cd81ac',
  'c925893e1184b8b332d1fbb4bce946ab868b88e3dc2a925a275b8ec4a0fa4e8e',
];
// Prospecção restrita (hash do e-mail): sem valores, mesmo que o cadastro diga outra coisa.
const PROSPECCAO_H = [
  '22f392c3b68237971e08b83a6541a2500f4a81540ac8772b5369c08e37feda88',
  '92c287d6c3914f5784beb08073aab432b05fadff0633563b4e11ab1c7451d521',
  '69d163a7485bdc449976fca2cb54cb411cb92796366cad576164d9fdf8906d45',
];
const NIVEIS_VALIDOS = ['super_admin', 'diretoria', 'gerencia', 'gestor', 'vendedor', 'financeiro', 'prospeccao', 'suporte', 'auditor', 'colaborador', 'visitante'];
const NIVEIS_COM_VALOR = ['super_admin', 'diretoria', 'gerencia', 'gestor', 'financeiro'];

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

// Mesmo algoritmo (e mesma ORDEM) do detectarNivelPermissao do painel.
// usuario = { email, nivel_permissao, cargo, categoria }
function nivelDe(usuario) {
  if (!usuario) return 'visitante';
  const email = String(usuario.email || '').toLowerCase().trim();
  if (email === SUPER_ADMIN_EMAIL) return 'super_admin';
  if (email && AUDITORES.indexOf(email) !== -1) return 'auditor';
  const eh = email ? sha256(email) : '';
  if (eh && CONVIDADOS_H.indexOf(eh) !== -1) return 'diretoria';
  if (eh && PROSPECCAO_H.indexOf(eh) !== -1) return 'prospeccao';

  const cargo = String(usuario.cargo || '').toLowerCase();
  const np = String(usuario.nivel_permissao || '').toLowerCase().trim();
  if ((cargo.indexOf('suporte') >= 0 || cargo.indexOf('atendimento') >= 0 || cargo.indexOf('sucesso') >= 0) && (!np || np === 'colaborador')) {
    return 'suporte';
  }
  if (np && NIVEIS_VALIDOS.indexOf(np) !== -1) return np;

  const categoria = String(usuario.categoria || '').toLowerCase();
  if (cargo.includes('diretoria') || cargo.includes('diretor') || categoria === 'diretoria') return 'diretoria';
  if (cargo.includes('gerente') || categoria === 'gerência' || categoria === 'gerencia') return 'gerencia';
  if (cargo.includes('gestor')) return 'gestor';
  if (cargo.includes('vendedor') || cargo.includes('vendas')) return 'vendedor';
  if (cargo.includes('financ') || categoria === 'financeiro') return 'financeiro';
  if (cargo.includes('marketing')) return 'super_admin';
  if (cargo.includes('sucesso') || cargo.includes('prospec') || cargo.includes('suporte home')) return 'prospeccao';
  return 'colaborador';
}

// Cache curto por container (o nível de alguém muda raramente).
const _cache = new Map();
const CACHE_MS = 3 * 60 * 1000;

// true = vê valores | false = não vê | null = não deu pra conferir agora (erro de rede/banco).
// Quem chama decide o que fazer com null (o proxy de leitura responde 503: nem vaza, nem
// entrega zero falso pra quem tem direito).
async function podeVerValores(pessoaId) {
  const id = String(pessoaId || '').trim();
  if (!id) return false;
  const c = _cache.get(id);
  if (c && c.ate > Date.now()) return c.v;
  const k = chaveServico();
  if (!k) return null;
  const h = { apikey: k, Authorization: 'Bearer ' + k };
  try {
    const [rL, rP] = await Promise.all([
      fetch(SUPA_URL + '/rest/v1/usuarios_login?pessoa_id=eq.' + encodeURIComponent(id) + '&select=email&limit=1', { headers: h }),
      fetch(SUPA_URL + '/rest/v1/pessoas?id=eq.' + encodeURIComponent(id) + '&select=*&limit=1', { headers: h }),
    ]);
    if (!rL.ok || !rP.ok) return null;
    const aL = await rL.json();
    const aP = await rP.json();
    const login = Array.isArray(aL) ? aL[0] : null;
    const pessoa = Array.isArray(aP) ? aP[0] : null;
    // O painel monta o usuário com o e-mail do LOGIN; o cadastro entra com nível e cargo.
    const usuario = {
      email: (login && login.email) || (pessoa && pessoa.email) || '',
      nivel_permissao: pessoa ? pessoa.nivel_permissao : '',
      cargo: pessoa ? pessoa.cargo : '',
      categoria: pessoa ? pessoa.categoria : '',
    };
    const nivel = (login || pessoa) ? nivelDe(usuario) : 'visitante';
    const v = NIVEIS_COM_VALOR.indexOf(nivel) !== -1;
    if (_cache.size > 500) _cache.clear();
    _cache.set(id, { ate: Date.now() + CACHE_MS, v });
    return v;
  } catch (e) {
    return null;
  }
}

// ---- Tirar os valores de uma resposta -------------------------------------------------
// Nome de campo que carrega dinheiro nos dados da Machine / comercial.
const RE_DINHEIRO = /(valor|fatur|receita|ticket|tarifa|gmv|comiss|ltv|margem|desconto|taxas?_cancel|saldo|credito)/i;

// Zera (número) ou anula (resto) todo campo de dinheiro, em profundidade (inclui `raw`).
// Zero em vez de remover: conta feita na tela (soma, toFixed) continua funcionando sem erro;
// a tela desses níveis já não mostra o número.
function ocultarValores(dado, nivel) {
  const n = nivel || 0;
  if (n > 8 || dado == null) return dado;
  if (Array.isArray(dado)) { for (let i = 0; i < dado.length; i++) dado[i] = ocultarValores(dado[i], n + 1); return dado; }
  if (typeof dado !== 'object') return dado;
  for (const k of Object.keys(dado)) {
    const v = dado[k];
    if (RE_DINHEIRO.test(k)) {
      if (v !== null && typeof v === 'object') dado[k] = Array.isArray(v) ? [] : null;
      else dado[k] = (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v.replace(',', '.'))))) ? 0 : null;
    } else if (v !== null && typeof v === 'object') {
      dado[k] = ocultarValores(v, n + 1);
    }
  }
  return dado;
}

// Agregação no select do PostgREST (ex.: "valor_corrida.sum()" ou "total:valor_corrida.sum()")
// devolve a soma numa chave que NÃO tem "valor" no nome ("sum" ou o apelido). Aqui descobrimos
// essas chaves pra zerar também.
function chavesAgregadasDeDinheiro(query) {
  const m = /(?:^|&)select=([^&]*)/i.exec(String(query || ''));
  if (!m) return [];
  let sel = m[1];
  try { sel = decodeURIComponent(sel); } catch (e) { /* usa cru */ }
  const itens = [];
  let atual = '', prof = 0;
  for (const ch of sel) {
    if (ch === '(') prof++;
    if (ch === ')') prof = Math.max(0, prof - 1);
    if (ch === ',' && prof === 0) { itens.push(atual); atual = ''; } else atual += ch;
  }
  if (atual) itens.push(atual);
  const chaves = [];
  for (let it of itens) {
    it = it.trim();
    const ag = /\.(sum|avg|min|max)\(\)\s*$/i.exec(it);
    if (!ag) continue;
    let alias = '';
    const dois = it.indexOf(':');
    // "apelido:coluna.sum()" (cuidado com o cast "coluna::numeric.sum()")
    if (dois > 0 && it.charAt(dois + 1) !== ':' && it.charAt(dois - 1) !== ':') { alias = it.slice(0, dois).trim(); it = it.slice(dois + 1); }
    if (!RE_DINHEIRO.test(it)) continue;
    chaves.push(alias || ag[1].toLowerCase());
  }
  return chaves;
}
function zerarChaves(linhas, chaves) {
  if (!chaves.length || !Array.isArray(linhas)) return linhas;
  for (const l of linhas) { if (l && typeof l === 'object') for (const c of chaves) if (c in l) l[c] = 0; }
  return linhas;
}

module.exports = { nivelDe, podeVerValores, ocultarValores, chavesAgregadasDeDinheiro, zerarChaves, NIVEIS_COM_VALOR, RE_DINHEIRO };
