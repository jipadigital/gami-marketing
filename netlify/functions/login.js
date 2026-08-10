// netlify/functions/login.js
// Login SERVER-SIDE: valida email/username + PIN com a SERVICE KEY, sem expor pin_hash
// ao navegador. Permite trancar a tabela usuarios_login pro anon (RLS).
// Replica exatamente a lógica do tentarLogin() antigo do index.html.
// ============================================================

const crypto = require('crypto');
const SUPA_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;

const ORIGENS_PERMITIDAS = [
  'https://gami-marketing.netlify.app',
  'http://localhost:8888',
  'http://localhost:3000'
];

function corsHeaders(origin){
  var permitido = ORIGENS_PERMITIDAS.indexOf(origin) >= 0 ? origin : ORIGENS_PERMITIDAS[0];
  return {
    'Access-Control-Allow-Origin': permitido,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
}

function hashPin(pin){
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}
function svcHeaders(extra){
  return Object.assign({ 'apikey': SUPA_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPA_SERVICE_KEY }, extra || {});
}

exports.handler = async function(event){
  const origin = event.headers.origin || event.headers.Origin || '';
  const cors = corsHeaders(origin);

  if(event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if(event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ sucesso:false, erro:'Use POST' }) };

  if(!SUPA_SERVICE_KEY){
    return { statusCode: 500, headers: cors, body: JSON.stringify({ sucesso:false, erro:'Servidor sem chave configurada' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e){ return { statusCode: 400, headers: cors, body: JSON.stringify({ sucesso:false, erro:'Body inválido' }) }; }

  const identificador = String(body.identificador || '').toLowerCase().trim();
  const pin = String(body.pin || '');
  const userAgent = body.user_agent || null;

  if(!identificador || !pin){
    return { statusCode: 200, headers: cors, body: JSON.stringify({ sucesso:false, erro:'Preencha usuário e PIN' }) };
  }

  try {
    // 1) Busca por email OU username (case-insensitive)
    const idEnc = encodeURIComponent(identificador);
    const query = SUPA_URL + '/rest/v1/usuarios_login?or=(email.ilike.' + idEnc + ',username.ilike.' + idEnc + ')&select=*&limit=1';
    const r = await fetch(query, { headers: svcHeaders() });
    if(!r.ok){
      return { statusCode: 200, headers: cors, body: JSON.stringify({ sucesso:false, erro:'Erro de conexão (HTTP ' + r.status + '). Tente novamente.' }) };
    }
    const lista = await r.json();
    if(!Array.isArray(lista) || !lista.length){
      return { statusCode: 200, headers: cors, body: JSON.stringify({ sucesso:false, erro:'Email ou username não encontrado' }) };
    }
    const usuario = lista[0];

    if(!usuario.ativo){
      return { statusCode: 200, headers: cors, body: JSON.stringify({ sucesso:false, erro:'Usuário desativado' }) };
    }
    if(usuario.bloqueado_ate && new Date(usuario.bloqueado_ate) > new Date()){
      return { statusCode: 200, headers: cors, body: JSON.stringify({ sucesso:false, erro:'Conta bloqueada temporariamente. Tente em alguns minutos.' }) };
    }

    // 2) Valida PIN (mesma regra do cliente)
    let pinValido = false;
    if(!usuario.pin_hash || usuario.pin_hash === 'gami2026_init'){
      pinValido = (pin === 'gami2026');
    } else {
      pinValido = (hashPin(pin) === usuario.pin_hash);
    }

    if(!pinValido){
      const tentativas = (usuario.tentativas_falhas || 0) + 1;
      const bloquearAte = tentativas >= 5 ? new Date(Date.now() + 15*60*1000).toISOString() : null;
      try {
        await fetch(SUPA_URL + '/rest/v1/usuarios_login?pessoa_id=eq.' + encodeURIComponent(usuario.pessoa_id), {
          method: 'PATCH',
          headers: svcHeaders({ 'Content-Type':'application/json', 'Prefer':'return=minimal' }),
          body: JSON.stringify({ tentativas_falhas: tentativas, bloqueado_ate: bloquearAte })
        });
      } catch(e){}
      if(tentativas >= 5){
        return { statusCode: 200, headers: cors, body: JSON.stringify({ sucesso:false, erro:'Muitas tentativas. Conta bloqueada por 15 minutos.' }) };
      }
      return { statusCode: 200, headers: cors, body: JSON.stringify({ sucesso:false, erro:'PIN incorreto (' + (5-tentativas) + ' tentativas restantes)' }) };
    }

    // 3) Sucesso — gera token de sessão e atualiza login
    const sessaoToken = crypto.randomUUID();
    // v31.40: token de sessao de 7 dias (era 24h). Evita que o servidor recuse a
    // escrita do ponto quando o cliente ainda se considera logado, e reduz re-logins.
    const sessaoExpira = new Date(Date.now() + 7*24*60*60*1000).toISOString();
    try {
      await fetch(SUPA_URL + '/rest/v1/usuarios_login?pessoa_id=eq.' + encodeURIComponent(usuario.pessoa_id), {
        method: 'PATCH',
        headers: svcHeaders({ 'Content-Type':'application/json', 'Prefer':'return=minimal' }),
        body: JSON.stringify({
          ultimo_login: new Date().toISOString(),
          tentativas_falhas: 0,
          bloqueado_ate: null,
          token_atual: sessaoToken,
          token_expira_em: sessaoExpira,
          ultimo_user_agent: userAgent
        })
      });
    } catch(e){}

    // 4) Busca dados completos da pessoa
    let pessoa = null;
    try {
      const rP = await fetch(SUPA_URL + '/rest/v1/pessoas?id=eq.' + encodeURIComponent(usuario.pessoa_id) + '&select=*&limit=1', { headers: svcHeaders() });
      if(rP.ok){ const lp = await rP.json(); if(Array.isArray(lp) && lp.length) pessoa = lp[0]; }
    } catch(e){}

    const usuarioFinal = {
      id: usuario.pessoa_id,
      nome: usuario.nome,
      email: usuario.email,
      username: usuario.username,
      foto_url: pessoa ? (pessoa.foto_url || pessoa.foto) : null,
      cargo: pessoa ? pessoa.cargo : null,
      cidade: pessoa ? pessoa.cidade : null,
      categoria: pessoa ? pessoa.categoria : null,
      nivel: pessoa ? pessoa.nivel : null,
      nivel_permissao: pessoa ? pessoa.nivel_permissao : null,
      tipo: pessoa ? pessoa.tipo : null,
      data_admissao: pessoa ? (pessoa.entrada || pessoa.data_admissao || pessoa.admissao) : null,
      aniversario: pessoa ? (pessoa.nascimento || pessoa.aniversario || pessoa.aniversario_dia) : null,
      telefone: pessoa ? (pessoa.tel || pessoa.telefone) : null,
      pin_trocado: usuario.pin_trocado,
      username_escolhido: usuario.username_escolhido
    };

    // NUNCA retorna pin_hash / tokens de recuperação ao cliente
    return { statusCode: 200, headers: cors, body: JSON.stringify({ sucesso:true, usuario: usuarioFinal, sessao_token: sessaoToken }) };

  } catch(err){
    console.error('[login]', err);
    return { statusCode: 200, headers: cors, body: JSON.stringify({ sucesso:false, erro:'Erro: ' + (err.message || 'desconhecido') }) };
  }
};
