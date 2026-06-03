// netlify/functions/resetar-pin.js
// Consome token de recuperação e define PIN novo
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

exports.handler = async function(event){
  const origin = event.headers.origin || event.headers.Origin || '';
  const cors = corsHeaders(origin);
  
  if(event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if(event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({error:'Use POST'}) };
  
  let body;
  try { body = JSON.parse(event.body); }
  catch(e){ return { statusCode: 400, headers: cors, body: JSON.stringify({error:'Body inválido'}) }; }
  
  const email = (body.email || '').toLowerCase().trim();
  const token = (body.token || '').trim();
  const pinNovo = String(body.pin_novo || '').trim();
  
  if(!email || !token || !pinNovo){
    return { statusCode: 400, headers: cors, body: JSON.stringify({error:'Email, token e PIN são obrigatórios'}) };
  }
  
  if(pinNovo.length < 4 || pinNovo.length > 6 || !/^\d+$/.test(pinNovo)){
    return { statusCode: 400, headers: cors, body: JSON.stringify({error:'PIN deve ter 4 a 6 dígitos'}) };
  }
  
  try {
    // Busca usuário pelo email
    const r = await fetch(SUPA_URL+'/rest/v1/usuarios_login?email=eq.'+encodeURIComponent(email)+'&select=pessoa_id,token_recuperacao,token_recuperacao_exp,ativo&limit=1', {
      headers: { 'apikey': SUPA_SERVICE_KEY, 'Authorization': 'Bearer '+SUPA_SERVICE_KEY }
    });
    const arr = await r.json();
    
    if(!Array.isArray(arr) || arr.length === 0){
      return { statusCode: 401, headers: cors, body: JSON.stringify({error:'Link inválido ou expirado'}) };
    }
    
    const u = arr[0];
    
    if(!u.ativo) return { statusCode: 401, headers: cors, body: JSON.stringify({error:'Usuário desativado'}) };
    if(!u.token_recuperacao || u.token_recuperacao !== token){
      return { statusCode: 401, headers: cors, body: JSON.stringify({error:'Link inválido ou já usado'}) };
    }
    if(u.token_recuperacao_exp && new Date(u.token_recuperacao_exp) < new Date()){
      return { statusCode: 401, headers: cors, body: JSON.stringify({error:'Link expirado (válido por 1 hora). Solicite um novo.'}) };
    }
    
    // Salva PIN novo + limpa token
    const pinHash = hashPin(pinNovo);
    const updateResp = await fetch(SUPA_URL+'/rest/v1/usuarios_login?pessoa_id=eq.'+encodeURIComponent(u.pessoa_id), {
      method: 'PATCH',
      headers: {
        'apikey': SUPA_SERVICE_KEY,
        'Authorization': 'Bearer '+SUPA_SERVICE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        pin_hash: pinHash,
        pin_trocado: true,
        token_recuperacao: null,
        token_recuperacao_exp: null,
        token_atual: null,  // força novo login com PIN novo
        updated_at: new Date().toISOString()
      })
    });
    
    if(!updateResp.ok){
      const txt = await updateResp.text();
      return { statusCode: 500, headers: cors, body: JSON.stringify({error:'Erro ao salvar: '+txt.substring(0,200)}) };
    }
    
    return { statusCode: 200, headers: cors, body: JSON.stringify({
      ok: true, 
      message: 'PIN atualizado com sucesso! Faça login com o novo PIN.'
    }) };
    
  } catch(err){
    console.error('[resetar-pin]', err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({error: err.message}) };
  }
};
