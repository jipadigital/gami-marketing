// netlify/functions/supabase-read.js
// LEITURA server-side com SUPA_SERVICE_KEY (ignora RLS), atrás de sessão válida.
// Etapa 3 da segurança: tirar a LEITURA das tabelas sensíveis da chave pública.
// Com isso dá pra DROPAR a policy *_sel dessas tabelas (anon não lê mais nada);
// o app lê por aqui, provando que é um usuário Gâmi logado (X-Gami-Token).
//
// USO (do frontend, via helper supaLer):
//   POST /.netlify/functions/supabase-read
//   Headers: Content-Type, X-Gami-User, X-Gami-Token
//   Body SELECT: { "tabela":"crm_leads", "query":"select=*&dono_id=eq.123&order=criado_em.desc" }
//   Body RPC:    { "rpc":"mapa_empresas_cidade", "args":{ "p_cidade":"campo-grande" } }
// ============================================================

const SUPA_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;

// Tabelas que o proxy aceita LER (lista branca). Só o sensível precisa estar aqui;
// o resto segue lendo direto com a chave pública (baixo risco).
const TABELAS_LEITURA = [
  // comercial
  'crm_leads','crm_atividades','crm_tarefas','crm_checklist','crm_metas','crm_scripts','crm_config',
  'prospeccao_lojas','prospeccao_visitas','prospeccao_rotas',
  'mv_prospeccao_mapa','mv_empresas_raiox',
  // machine (dados de cliente/corrida)
  'machine_corridas','machine_empresas','machine_condutores','machine_sync_log',
  // PII / pessoal
  'pessoas','ponto_registros','ponto_log_admin','ponto_config'
];

// RPCs sensíveis que o proxy aceita chamar (lista branca).
const RPCS_LEITURA = [
  'mapa_empresas_cidade','clientes_onboarding','ponto_dia_editor',
  'tarefas_minhas','crm_leads_visiveis','prospeccao_mapa_usuario'
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

// Valida a sessão (user + token) contra usuarios_login com a service key.
// Qualquer usuário logado e ativo pode LER o que está na lista branca
// (a ameaça aqui é o forasteiro com a chave pública, não o insider;
//  o escopo por linha/nível o app já trata na UI).
async function validarSessao(userId, token){
  if(!userId || !token) return { valido:false, erro:'Sessão não informada' };
  try {
    const r = await fetch(SUPA_URL+'/rest/v1/usuarios_login?pessoa_id=eq.'+encodeURIComponent(userId)+'&select=pessoa_id,token_atual,token_expira_em,ativo&limit=1', {
      headers: { 'apikey': SUPA_SERVICE_KEY, 'Authorization': 'Bearer '+SUPA_SERVICE_KEY }
    });
    if(!r.ok) return { valido:false, erro:'Falha ao validar' };
    const arr = await r.json();
    if(!Array.isArray(arr) || !arr.length) return { valido:false, erro:'Usuário não existe' };
    const u = arr[0];
    if(u.ativo === false) return { valido:false, erro:'Usuário desativado' };
    if(!u.token_atual) return { valido:false, erro:'Sessão não encontrada (faça login de novo)' };
    if(u.token_atual !== token) return { valido:false, erro:'Token inválido' };
    if(u.token_expira_em && new Date(u.token_expira_em) < new Date()) return { valido:false, erro:'Sessão expirada (faça login de novo)' };
    return { valido:true };
  } catch(e){
    console.error('[read] validarSessao', e);
    return { valido:false, erro:'Erro ao validar sessão' };
  }
}

// Bloqueia querystring que tente embutir OUTRA tabela (ex.: select=*,outra(*))
// ou que não seja a shape esperada. Mantém o proxy restrito à tabela pedida.
function querySegura(q){
  if(typeof q !== 'string') return false;
  if(q.length > 2000) return false;
  // parênteses no select = embed de recurso relacionado → recusa
  if(/select=[^&]*\(/i.test(q)) return false;
  return true;
}

exports.handler = async function(event){
  const origin = event.headers.origin || event.headers.Origin || '';
  const cors = corsHeaders(origin);

  if(event.httpMethod === 'OPTIONS') return { statusCode:204, headers:cors, body:'' };
  if(event.httpMethod !== 'POST') return { statusCode:405, headers:cors, body:JSON.stringify({error:'Use POST'}) };
  if(!SUPA_SERVICE_KEY) return { statusCode:500, headers:cors, body:JSON.stringify({error:'Servidor não configurado'}) };

  const userId = event.headers['x-gami-user'] || event.headers['X-Gami-User'];
  const token  = event.headers['x-gami-token'] || event.headers['X-Gami-Token'];

  const sessao = await validarSessao(userId, token);
  if(!sessao.valido) return { statusCode:401, headers:cors, body:JSON.stringify({error:sessao.erro}) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e){ return { statusCode:400, headers:cors, body:JSON.stringify({error:'Body inválido'}) }; }

  const svc = { 'apikey':SUPA_SERVICE_KEY, 'Authorization':'Bearer '+SUPA_SERVICE_KEY };

  try {
    let url;
    // ---- RPC ----
    if(body.rpc){
      if(RPCS_LEITURA.indexOf(body.rpc) < 0){
        return { statusCode:400, headers:cors, body:JSON.stringify({error:'RPC não permitida: '+body.rpc}) };
      }
      const r = await fetch(SUPA_URL+'/rest/v1/rpc/'+body.rpc, {
        method:'POST',
        headers: Object.assign({}, svc, { 'Content-Type':'application/json' }),
        body: JSON.stringify(body.args || {})
      });
      const txt = await r.text();
      if(!r.ok) return { statusCode:r.status, headers:cors, body:JSON.stringify({error:'Supabase HTTP '+r.status, detalhe:txt.slice(0,300)}) };
      return { statusCode:200, headers:cors, body:JSON.stringify({ ok:true, resultado: txt ? JSON.parse(txt) : [] }) };
    }

    // ---- SELECT ----
    const tabela = body.tabela;
    if(TABELAS_LEITURA.indexOf(tabela) < 0){
      return { statusCode:400, headers:cors, body:JSON.stringify({error:'Tabela não permitida: '+tabela}) };
    }
    const q = body.query || 'select=*';
    if(!querySegura(q)){
      return { statusCode:400, headers:cors, body:JSON.stringify({error:'Query inválida'}) };
    }
    url = SUPA_URL+'/rest/v1/'+tabela+'?'+q;
    const r = await fetch(url, { headers: svc });
    const txt = await r.text();
    if(!r.ok) return { statusCode:r.status, headers:cors, body:JSON.stringify({error:'Supabase HTTP '+r.status, detalhe:txt.slice(0,300)}) };
    return { statusCode:200, headers:cors, body:JSON.stringify({ ok:true, resultado: txt ? JSON.parse(txt) : [] }) };

  } catch(err){
    console.error('[supabase-read]', err);
    return { statusCode:500, headers:cors, body:JSON.stringify({error: err.message}) };
  }
};
