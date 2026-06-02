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
  'machine_sync_log',
  'audit_log'  // pra registrar ações de auditoria
];

// Funções RPC permitidas (whitelist)
const RPCS_PERMITIDAS = [
  'refresh_machine_views',
  'limpar_sessoes_expiradas'
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
    'Access-Control-Allow-Headers': 'Content-Type, X-Gami-User, X-Gami-Token',
    'Content-Type': 'application/json'
  };
}

// Valida o usuário + token de sessão
async function validarSessao(userId, token){
  if(!userId) return { valido: false, erro: 'Usuário não informado' };
  
  try {
    // Busca o usuário em usuarios_login (que tem token + expiração)
    const r = await fetch(SUPA_URL+'/rest/v1/usuarios_login?pessoa_id=eq.'+encodeURIComponent(userId)+'&select=pessoa_id,nome,token_atual,token_expira_em,ativo&limit=1', {
      headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': 'Bearer '+SUPA_ANON_KEY }
    });
    if(!r.ok) return { valido: false, erro: 'Falha ao validar' };
    const arr = await r.json();
    if(!Array.isArray(arr) || arr.length === 0) return { valido: false, erro: 'Usuário não existe' };
    
    const u = arr[0];
    
    if(u.ativo === false) return { valido: false, erro: 'Usuário desativado' };
    
    // Se token foi enviado, valida (mais seguro)
    // Se token não foi enviado (sistema antigo), valida só user_id (compatibilidade)
    if(token){
      if(!u.token_atual) return { valido: false, erro: 'Sessão não encontrada (faça login de novo)' };
      if(u.token_atual !== token) return { valido: false, erro: 'Token inválido' };
      if(u.token_expira_em && new Date(u.token_expira_em) < new Date()){
        return { valido: false, erro: 'Sessão expirada (faça login de novo)' };
      }
    }
    
    // Busca o nivel na tabela pessoas
    const rP = await fetch(SUPA_URL+'/rest/v1/pessoas?id=eq.'+encodeURIComponent(userId)+'&select=id,nome,nivel,super_admin&limit=1', {
      headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': 'Bearer '+SUPA_ANON_KEY }
    });
    const arrP = await rP.json();
    const pessoa = (Array.isArray(arrP) && arrP[0]) ? arrP[0] : null;
    
    return { 
      valido: true, 
      usuario: { 
        id: userId, 
        nome: u.nome,
        nivel: pessoa ? pessoa.nivel : null,
        super_admin: pessoa ? (pessoa.super_admin === true || pessoa.nivel === 'super_admin') : false
      } 
    };
  } catch(e){
    console.error('validarSessao:', e);
    return { valido: false, erro: 'Erro ao validar sessão' };
  }
}

// Registra evento no audit_log (não bloqueia o fluxo se falhar)
async function auditar(usuario, acao, recurso, detalhes, ip, userAgent){
  try {
    await fetch(SUPA_URL+'/rest/v1/audit_log', {
      method: 'POST',
      headers: {
        'apikey': SUPA_SERVICE_KEY,
        'Authorization': 'Bearer '+SUPA_SERVICE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify([{
        pessoa_id: usuario.id,
        pessoa_nome: usuario.nome,
        acao: acao,
        recurso: recurso,
        detalhes: detalhes || null,
        ip: ip || null,
        user_agent: userAgent || null
      }])
    });
  } catch(e){ /* silencioso */ }
}

// Rate limit: usa função SQL atômica
const RATE_LIMIT_POR_MIN = 30; // 30 escritas/min por usuário
async function verificarRateLimit(chave){
  try {
    const r = await fetch(SUPA_URL+'/rest/v1/rpc/verificar_rate_limit', {
      method: 'POST',
      headers: {
        'apikey': SUPA_SERVICE_KEY,
        'Authorization': 'Bearer '+SUPA_SERVICE_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_chave: chave, p_limite: RATE_LIMIT_POR_MIN })
    });
    if(!r.ok) return { ok: true }; // se o check falha, deixa passar (fail-open)
    const data = await r.json();
    return Array.isArray(data) && data[0] ? data[0] : { ok: true };
  } catch(e){ return { ok: true }; }
}

// Registra alerta de segurança (não bloqueia)
async function alertar(tipo, severidade, mensagem, detalhes){
  try {
    await fetch(SUPA_URL+'/rest/v1/alertas_log', {
      method: 'POST',
      headers: {
        'apikey': SUPA_SERVICE_KEY,
        'Authorization': 'Bearer '+SUPA_SERVICE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify([{
        tipo: tipo,
        severidade: severidade,
        origem: 'supabase-write',
        mensagem: mensagem,
        detalhes: detalhes
      }])
    });
  } catch(e){}
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
  
  // Valida usuário + token de sessão
  const userId = event.headers['x-gami-user'] || event.headers['X-Gami-User'];
  const token = event.headers['x-gami-token'] || event.headers['X-Gami-Token'];
  const ip = event.headers['x-forwarded-for'] || event.headers['x-nf-client-connection-ip'] || '';
  const userAgent = event.headers['user-agent'] || '';
  
  if(!userId){
    return { statusCode: 401, headers: cors, body: JSON.stringify({error:'Usuário não informado (header X-Gami-User)'}) };
  }
  
  // RATE LIMIT: 30 escritas/min por usuário
  const rl = await verificarRateLimit('user:'+userId);
  if(!rl.ok){
    alertar('rate_limit_excedido', 'aviso', 'User excedeu rate limit', { userId, contagem: rl.contagem, ip });
    return { 
      statusCode: 429, 
      headers: cors, 
      body: JSON.stringify({error:'Muitas requisições. Aguarde 1 minuto.', contagem: rl.contagem, limite: rl.limite}) 
    };
  }
  
  const sessao = await validarSessao(userId, token);
  if(!sessao.valido){
    alertar('auth_falhou', 'aviso', sessao.erro, { userId, ip });
    return { statusCode: 401, headers: cors, body: JSON.stringify({error: sessao.erro}) };
  }
  
  const usuario = sessao.usuario;
  
  // Só super_admin pode escrever (por enquanto)
  if(!usuario.super_admin){
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
      // Pra chamar functions (refresh_machine_views etc)
      if(!body.funcao){
        return { statusCode: 400, headers: cors, body: JSON.stringify({error:'rpc precisa de funcao'}) };
      }
      if(RPCS_PERMITIDAS.indexOf(body.funcao) < 0){
        return { statusCode: 400, headers: cors, body: JSON.stringify({error:'RPC não permitida: '+body.funcao}) };
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
    
    // Audit log (não bloqueia se falhar)
    auditar(usuario, operacao, tabela || (body.funcao || ''), {
      qtd: Array.isArray(dados) ? dados.length : 0,
      filtro: filtro || null,
      funcao: body.funcao || null
    }, ip, userAgent);
    
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
