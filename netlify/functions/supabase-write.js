// netlify/functions/supabase-write.js
// Função pra escritas no Supabase com SUPA_SERVICE_KEY (bypassa RLS)
// Valida usuário antes de executar.
//
// USO (do frontend):
//   POST /.netlify/functions/supabase-write
//   Headers:
//     Content-Type: application/json
//     X-Gami-User: <user_id> (ex: pe016)
//   Body:
//     {
//       "tabela": "machine_corridas",
//       "operacao": "upsert" | "patch" | "delete",
//       "dados": [...],          // pra upsert
//       "filtro": "id=eq.123",   // pra patch/delete
//       "patch": { campo: val }  // pra patch
//     }
// ============================================================

const SUPA_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
const SUPA_ANON_KEY = process.env.SUPA_PUBLIC_KEY || 'sb_publishable_0y-oz0aght1rNQNQrsh2tA_EfHajL61';

// Tabelas permitidas (whitelist)
const TABELAS_PERMITIDAS = [
  'machine_corridas',
  'machine_condutores',
  'machine_empresas',
  'machine_sync_log'
];

// Origens permitidas (CORS)
const ORIGENS_PERMITIDAS = [
  'https://gami-marketing.netlify.app',
  'http://localhost:8888',     // dev local Netlify
  'http://localhost:3000'      // dev local genérico
];

function corsHeaders(origin){
  var permitido = ORIGENS_PERMITIDAS.indexOf(origin) >= 0 ? origin : ORIGENS_PERMITIDAS[0];
  return {
    'Access-Control-Allow-Origin': permitido,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Gami-User',
    'Content-Type': 'application/json'
  };
}

// Valida o usuário consultando a tabela pessoas
async function validarUsuario(userId){
  if(!userId) return null;
  try {
    const r = await fetch(SUPA_URL+'/rest/v1/pessoas?id=eq.'+encodeURIComponent(userId)+'&select=id,nome,nivel,super_admin', {
      headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': 'Bearer '+SUPA_ANON_KEY }
    });
    if(!r.ok) return null;
    const arr = await r.json();
    if(!Array.isArray(arr) || arr.length === 0) return null;
    return arr[0];
  } catch(e){ return null; }
}

exports.handler = async function(event){
  const origin = event.headers.origin || event.headers.Origin || '';
  const cors = corsHeaders(origin);
  
  // OPTIONS (preflight)
  if(event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, headers: cors, body: JSON.stringify({error:'Use POST'}) };
  }
  
  // Verifica service key configurada
  if(!SUPA_SERVICE_KEY){
    console.error('SUPA_SERVICE_KEY não configurada!');
    return { statusCode: 500, headers: cors, body: JSON.stringify({error:'Servidor não configurado (SUPA_SERVICE_KEY ausente)'}) };
  }
  
  // Valida usuário
  const userId = event.headers['x-gami-user'] || event.headers['X-Gami-User'];
  if(!userId){
    return { statusCode: 401, headers: cors, body: JSON.stringify({error:'Usuário não informado (header X-Gami-User)'}) };
  }
  
  const usuario = await validarUsuario(userId);
  if(!usuario){
    return { statusCode: 401, headers: cors, body: JSON.stringify({error:'Usuário inválido'}) };
  }
  
  // Só super_admin pode escrever (por enquanto)
  // (depois podemos permitir gestor/diretoria pra operações específicas)
  const ehSuperAdmin = usuario.super_admin === true || usuario.nivel === 'super_admin';
  if(!ehSuperAdmin){
    return { statusCode: 403, headers: cors, body: JSON.stringify({error:'Permissão negada (não é super_admin)'}) };
  }
  
  // Parse do body
  let body;
  try { body = JSON.parse(event.body); }
  catch(e){ return { statusCode: 400, headers: cors, body: JSON.stringify({error:'Body inválido'}) }; }
  
  const { tabela, operacao, dados, filtro, patch } = body;
  
  // Valida tabela
  if(TABELAS_PERMITIDAS.indexOf(tabela) < 0){
    return { statusCode: 400, headers: cors, body: JSON.stringify({error:'Tabela não permitida: '+tabela}) };
  }
  
  // Constrói chamada ao Supabase com SERVICE_KEY (bypassa RLS)
  const supaHeaders = {
    'apikey': SUPA_SERVICE_KEY,
    'Authorization': 'Bearer '+SUPA_SERVICE_KEY,
    'Content-Type': 'application/json'
  };
  
  try {
    let url = SUPA_URL+'/rest/v1/'+tabela;
    let method;
    let supaBody;
    
    if(operacao === 'upsert'){
      if(!Array.isArray(dados) || dados.length === 0){
        return { statusCode: 400, headers: cors, body: JSON.stringify({error:'dados deve ser array não-vazio pra upsert'}) };
      }
      method = 'POST';
      supaBody = JSON.stringify(dados);
      // Se cliente pediu retornar=true, devolve registros criados
      var prefer = body.retornar 
        ? 'resolution=merge-duplicates,return=representation'
        : 'resolution=merge-duplicates,return=minimal';
      supaHeaders['Prefer'] = prefer;
    }
    else if(operacao === 'patch'){
      if(!filtro || !patch){
        return { statusCode: 400, headers: cors, body: JSON.stringify({error:'patch precisa de filtro e patch'}) };
      }
      method = 'PATCH';
      url += '?'+filtro;
      supaBody = JSON.stringify(patch);
      supaHeaders['Prefer'] = 'return=minimal';
    }
    else if(operacao === 'rpc'){
      // Pra chamar functions/refresh_machine_views
      if(!body.funcao){
        return { statusCode: 400, headers: cors, body: JSON.stringify({error:'rpc precisa de funcao'}) };
      }
      url = SUPA_URL+'/rest/v1/rpc/'+body.funcao;
      method = 'POST';
      supaBody = JSON.stringify(body.argumentos || {});
    }
    else {
      return { statusCode: 400, headers: cors, body: JSON.stringify({error:'operacao inválida: '+operacao+' (use upsert/patch/rpc)'}) };
    }
    
    const r = await fetch(url, { method, headers: supaHeaders, body: supaBody });
    
    if(!r.ok){
      const txt = await r.text().catch(()=>'');
      return { statusCode: r.status, headers: cors, body: JSON.stringify({
        error:'Supabase HTTP '+r.status, detalhe: txt.substring(0,300)
      }) };
    }
    
    const respBody = await r.text();
    const resultado = respBody ? JSON.parse(respBody) : null;
    
    return { statusCode: 200, headers: cors, body: JSON.stringify({
      ok: true,
      operacao: operacao,
      tabela: tabela,
      afetados: Array.isArray(dados) ? dados.length : (resultado && Array.isArray(resultado) ? resultado.length : 0),
      resultado: resultado
    }) };
    
  } catch(err){
    console.error('[supabase-write]', err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({error: err.message}) };
  }
};
