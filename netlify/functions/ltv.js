// netlify/functions/ltv.js
// Estudo LTV por cidade/parceiro (dados SENSÍVEIS). Entrega só se a sessão for de
// um AUTORIZADO: Matheus + diretoria (sem o Carlos) OU super_admin. Validação 100%
// no servidor; nem a chave pública lê as MVs. Lê com a service key (bypassa RLS).
// Espelha o padrão do faturamento.js, mas aceita sessão multi-dispositivo.
// ============================================================

const SUPA_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
const SUPER_ADMIN_EMAIL = 'jipadigital@gmail.com';

// Quem vê o LTV (pessoa_id). Matheus + diretoria. Carlos NÃO entra (pedido do dono).
const ALLOWLIST = [
  'pe001',             // Rafhael Nóbrega (Diretor)
  'pe002',             // Tainara Nóbrega (Diretor)
  'pe003',             // João Duarte (Diretor)
  'pematheusfedrizzi'  // Matheus Fedrizzi Marques (Gerente de Operações, dono do estudo)
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

// aceita o token no token_atual OU na lista sessoes_ativas (multi-dispositivo)
function tokenAtivo(u, token){
  var agora = new Date();
  if(u.token_atual && u.token_atual === token && (!u.token_expira_em || new Date(u.token_expira_em) >= agora)) return true;
  if(Array.isArray(u.sessoes_ativas)){
    for(var i=0;i<u.sessoes_ativas.length;i++){ var s=u.sessoes_ativas[i];
      if(s && s.t === token && (!s.e || new Date(s.e) >= agora)) return true; }
  }
  return false;
}

async function lerTudo(tabela, select, order){
  var out = [];
  for(var off=0; off<60000; off+=1000){
    var r = await fetch(SUPA_URL + '/rest/v1/' + tabela + '?select=' + select + (order?('&order='+order):''), {
      headers: svc({ 'Range-Unit':'items', 'Range': off + '-' + (off+999) })
    });
    if(!r.ok){ if(off===0){ var t=await r.text().catch(function(){return '';}); throw new Error('Falha ao ler '+tabela+' (rodou o ltv-mv.sql?): '+t.slice(0,160)); } break; }
    var pg = await r.json();
    if(!Array.isArray(pg) || !pg.length) break;
    out = out.concat(pg);
    if(pg.length < 1000) break;
  }
  return out;
}

exports.handler = async function(event){
  const origin = event.headers.origin || event.headers.Origin || '';
  const cors = corsHeaders(origin);
  if(event.httpMethod === 'OPTIONS') return { statusCode:204, headers:cors, body:'' };
  if(event.httpMethod !== 'POST') return { statusCode:405, headers:cors, body:JSON.stringify({ ok:false, erro:'Use POST' }) };
  if(!SUPA_SERVICE_KEY) return { statusCode:500, headers:cors, body:JSON.stringify({ ok:false, erro:'Servidor sem SUPA_SERVICE_KEY' }) };

  const callerId = event.headers['x-gami-user'] || event.headers['X-Gami-User'] || '';
  const callerToken = event.headers['x-gami-token'] || event.headers['X-Gami-Token'] || '';
  if(!callerId) return { statusCode:401, headers:cors, body:JSON.stringify({ ok:false, erro:'Sessão não informada' }) };

  try {
    const rC = await fetch(SUPA_URL + '/rest/v1/usuarios_login?pessoa_id=eq.' + encodeURIComponent(callerId) + '&select=*&limit=1', { headers: svc() });
    if(!rC.ok) return { statusCode:500, headers:cors, body:JSON.stringify({ ok:false, erro:'Falha ao validar sessão' }) };
    const arrC = await rC.json();
    if(!Array.isArray(arrC) || !arrC.length) return { statusCode:401, headers:cors, body:JSON.stringify({ ok:false, erro:'Sessão não encontrada' }) };
    const caller = arrC[0];
    if(caller.ativo === false) return { statusCode:403, headers:cors, body:JSON.stringify({ ok:false, erro:'Usuário desativado' }) };
    if(!tokenAtivo(caller, callerToken)) return { statusCode:401, headers:cors, body:JSON.stringify({ ok:false, erro:'Sessão expirada (faça login de novo)' }) };

    const ehSuper = String(caller.email || '').toLowerCase() === SUPER_ADMIN_EMAIL;
    const autorizado = ehSuper || ALLOWLIST.indexOf(callerId) >= 0;
    if(!autorizado) return { statusCode:403, headers:cors, body:JSON.stringify({ ok:false, erro:'Sem permissão para ver o LTV' }) };

    const [cidades, meses, empresas] = await Promise.all([
      lerTudo('v_ltv_cidade', 'cidade_slug,parceiros,parceiros_ativos,gmv_total,margem_total,ticket_medio,pedidos,ltv_medio_parceiro,desde,ate', 'gmv_total.desc'),
      lerTudo('mv_ltv_mes', 'cidade_slug,mes,parceiros_ativos,pedidos,gmv,margem_14', 'mes.asc'),
      lerTudo('mv_ltv_empresa', 'cidade_slug,parceiro,pedidos,gmv,primeiro_pedido,ultimo_pedido,meses_ativos,ticket_medio,ltv_atual,ativo', 'ltv_atual.desc')
    ]);
    return { statusCode:200, headers:cors, body:JSON.stringify({ ok:true, cidades, meses, empresas }) };

  } catch(err){
    return { statusCode:500, headers:cors, body:JSON.stringify({ ok:false, erro: err.message }) };
  }
};
