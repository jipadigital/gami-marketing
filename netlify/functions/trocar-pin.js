// netlify/functions/trocar-pin.js
// Troca de PIN SERVER-SIDE: valida o PIN atual e grava o novo com a SERVICE KEY.
// Elimina a necessidade de o navegador ler pin_hash — permite trancar usuarios_login.
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
function hashPin(pin){ return crypto.createHash('sha256').update(String(pin)).digest('hex'); }
function svcHeaders(extra){ return Object.assign({ 'apikey': SUPA_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPA_SERVICE_KEY }, extra || {}); }

// Mesma regra do _pinFraco do cliente
function pinFraco(pin){
  pin = String(pin || '');
  if(/^(.)\1+$/.test(pin)) return true;
  var comuns = ['1234','12345','123456','4321','54321','0123','2580','1212','6969','1230','2468','1357','7890'];
  if(comuns.indexOf(pin) !== -1) return true;
  if(/^\d+$/.test(pin) && pin.length >= 4){
    var asc = true, desc = true;
    for(var i=1;i<pin.length;i++){
      if(+pin[i] !== +pin[i-1]+1) asc = false;
      if(+pin[i] !== +pin[i-1]-1) desc = false;
    }
    if(asc || desc) return true;
  }
  return false;
}

exports.handler = async function(event){
  const origin = event.headers.origin || event.headers.Origin || '';
  const cors = corsHeaders(origin);

  if(event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if(event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ sucesso:false, erro:'Use POST' }) };
  if(!SUPA_SERVICE_KEY) return { statusCode: 500, headers: cors, body: JSON.stringify({ sucesso:false, erro:'Servidor sem chave configurada' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e){ return { statusCode: 400, headers: cors, body: JSON.stringify({ sucesso:false, erro:'Body inválido' }) }; }

  const pessoaId = String(body.pessoa_id || '').trim();
  const pinAtual = String(body.pin_atual || '');
  const pinNovo  = String(body.pin_novo || '');

  // Validações do PIN novo (iguais ao cliente)
  if(!pessoaId) return { statusCode: 200, headers: cors, body: JSON.stringify({ sucesso:false, erro:'Sessão inválida' }) };
  if(!pinNovo || pinNovo.length < 4 || pinNovo.length > 32) return { statusCode: 200, headers: cors, body: JSON.stringify({ sucesso:false, erro:'A senha deve ter 4 a 32 caracteres' }) };
  if(pinNovo === 'gami2026') return { statusCode: 200, headers: cors, body: JSON.stringify({ sucesso:false, erro:'Escolha um PIN diferente do padrão' }) };
  if(pinFraco(pinNovo)) return { statusCode: 200, headers: cors, body: JSON.stringify({ sucesso:false, erro:'PIN muito fácil de adivinhar. Evite sequências (1234) ou dígitos repetidos (0000).' }) };

  try {
    // Lê o usuário (service key)
    const r = await fetch(SUPA_URL + '/rest/v1/usuarios_login?pessoa_id=eq.' + encodeURIComponent(pessoaId) + '&select=pin_hash,ativo&limit=1', { headers: svcHeaders() });
    if(!r.ok) return { statusCode: 200, headers: cors, body: JSON.stringify({ sucesso:false, erro:'Erro de conexão. Tente novamente.' }) };
    const lista = await r.json();
    if(!Array.isArray(lista) || !lista.length) return { statusCode: 200, headers: cors, body: JSON.stringify({ sucesso:false, erro:'Usuário não encontrado' }) };
    const u = lista[0];
    if(u.ativo === false) return { statusCode: 200, headers: cors, body: JSON.stringify({ sucesso:false, erro:'Usuário desativado' }) };

    // Valida PIN atual (mesma regra: default = gami2026)
    let atualValido = false;
    if(!u.pin_hash || u.pin_hash === 'gami2026_init'){
      atualValido = (pinAtual === 'gami2026');
    } else {
      atualValido = (hashPin(pinAtual) === u.pin_hash);
    }
    if(!atualValido) return { statusCode: 200, headers: cors, body: JSON.stringify({ sucesso:false, erro:'PIN atual incorreto' }) };

    // Grava o novo PIN
    const upd = await fetch(SUPA_URL + '/rest/v1/usuarios_login?pessoa_id=eq.' + encodeURIComponent(pessoaId), {
      method: 'PATCH',
      headers: svcHeaders({ 'Content-Type':'application/json', 'Prefer':'return=minimal' }),
      body: JSON.stringify({ pin_hash: hashPin(pinNovo), pin_trocado: true, updated_at: new Date().toISOString() })
    });
    if(!upd.ok){
      const t = await upd.text();
      return { statusCode: 200, headers: cors, body: JSON.stringify({ sucesso:false, erro:'Falha ao salvar: ' + t.substring(0,160) }) };
    }
    return { statusCode: 200, headers: cors, body: JSON.stringify({ sucesso:true }) };

  } catch(err){
    console.error('[trocar-pin]', err);
    return { statusCode: 200, headers: cors, body: JSON.stringify({ sucesso:false, erro:'Erro: ' + (err.message || 'desconhecido') }) };
  }
};
