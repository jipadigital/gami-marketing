// netlify/functions/faturamento.js
// Faturamento por cidade (dados SENSÍVEIS). Só entrega os números se a sessão
// for de um dos autorizados (lista fixa de pessoa_id) OU do super_admin.
// A validação é 100% no SERVIDOR: nem a chave pública (anon) lê a MV, nem dá
// pra burlar pela URL. Lê mv_faturamento_mensal com a service key (bypassa RLS).
// ============================================================

const SUPA_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
const SUPER_ADMIN_EMAIL = 'jipadigital@gmail.com';

// Quem pode ver o faturamento (pessoa_id). Super_admin sempre pode.
const ALLOWLIST = [
  'pe001',             // Rafhael Nóbrega
  'pe002',             // Tainara Nóbrega
  'pe003',             // João Duarte
  'pecarlosvinicius',  // Carlos Vinícius Alves
  'pematheusfedrizzi'  // Matheus Fedrizzi Marques
];

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
    'Access-Control-Allow-Headers': 'Content-Type, X-Gami-User, X-Gami-Token',
    'Content-Type': 'application/json'
  };
}
function svc(extra){ return Object.assign({ 'apikey': SUPA_SERVICE_KEY, 'Authorization': 'Bearer '+SUPA_SERVICE_KEY }, extra||{}); }

exports.handler = async function(event){
  const origin = event.headers.origin || event.headers.Origin || '';
  const cors = corsHeaders(origin);
  if(event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if(event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ ok:false, erro:'Use POST' }) };
  if(!SUPA_SERVICE_KEY) return { statusCode: 500, headers: cors, body: JSON.stringify({ ok:false, erro:'Servidor sem SUPA_SERVICE_KEY' }) };

  const callerId = event.headers['x-gami-user'] || event.headers['X-Gami-User'] || '';
  const callerToken = event.headers['x-gami-token'] || event.headers['X-Gami-Token'] || '';
  if(!callerId) return { statusCode: 401, headers: cors, body: JSON.stringify({ ok:false, erro:'Sessão não informada' }) };

  try {
    // 1) Valida a sessão (token ativo, não expirado) e pega o e-mail do chamador
    const rC = await fetch(SUPA_URL + '/rest/v1/usuarios_login?pessoa_id=eq.' + encodeURIComponent(callerId) + '&select=pessoa_id,email,token_atual,token_expira_em,ativo&limit=1', { headers: svc() });
    if(!rC.ok) return { statusCode: 500, headers: cors, body: JSON.stringify({ ok:false, erro:'Falha ao validar sessão' }) };
    const arrC = await rC.json();
    if(!Array.isArray(arrC) || !arrC.length) return { statusCode: 401, headers: cors, body: JSON.stringify({ ok:false, erro:'Sessão não encontrada' }) };
    const caller = arrC[0];
    if(caller.ativo === false) return { statusCode: 403, headers: cors, body: JSON.stringify({ ok:false, erro:'Usuário desativado' }) };
    if(!caller.token_atual || caller.token_atual !== callerToken) return { statusCode: 401, headers: cors, body: JSON.stringify({ ok:false, erro:'Token inválido (faça login de novo)' }) };
    if(caller.token_expira_em && new Date(caller.token_expira_em) < new Date()) return { statusCode: 401, headers: cors, body: JSON.stringify({ ok:false, erro:'Sessão expirada' }) };

    // 2) AUTORIZAÇÃO: super_admin OU pessoa_id na allowlist
    const ehSuper = String(caller.email || '').toLowerCase() === SUPER_ADMIN_EMAIL;
    const autorizado = ehSuper || ALLOWLIST.indexOf(callerId) >= 0;
    if(!autorizado) return { statusCode: 403, headers: cors, body: JSON.stringify({ ok:false, erro:'Sem permissão para ver o faturamento' }) };

    // 3) Entrega os dados (service key, bypassa RLS). MV pré-agregada por cidade/mês.
    const rD = await fetch(SUPA_URL + '/rest/v1/mv_faturamento_mensal?select=cidade_slug,ano_mes,faturamento,pedidos&order=ano_mes.asc', { headers: svc() });
    if(!rD.ok){
      const t = await rD.text().catch(function(){ return ''; });
      return { statusCode: 502, headers: cors, body: JSON.stringify({ ok:false, erro:'Falha ao ler faturamento. Rodou a MV? ' + t.slice(0,160) }) };
    }
    const dados = await rD.json();
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok:true, dados: Array.isArray(dados)?dados:[] }) };

  } catch(err){
    return { statusCode: 500, headers: cors, body: JSON.stringify({ ok:false, erro: err.message }) };
  }
};
