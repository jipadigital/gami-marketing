// netlify/functions/machine.js
// Integracao DEFINITIVA com a Machine API (Gaudium).
// Credenciais ficam SO no servidor (env vars) — nunca expostas ao navegador.
//
// USO (do dashboard):
//   /.netlify/functions/machine?cidade=maceio&recurso=condutor
//   /.netlify/functions/machine?cidade=maceio&recurso=solicitacao
//
// Recursos suportados (GET): condutor, solicitacao, consultarProgramada
//
// Variaveis no Netlify:
//   MACHINE_API_KEY_<CIDADE>  (uma por cidade)
//   MACHINE_USER / MACHINE_PASS (login master Basic Auth)
// ============================================================

const BASE_URL = 'https://api.taximachine.com.br/api/integracao';

// Recursos liberados pra leitura via GET (whitelist por seguranca)
const RECURSOS_GET = {
  condutor: '/condutor',
  solicitacao: '/solicitacao',
  programada: '/consultarProgramada'
};

// Cache em memoria (por instancia) — respeita limite de 50 req/min
var _cache = {};
var CACHE_MS = 3 * 60 * 1000; // 3 minutos

function getCidadeKey(cidade){
  if(!cidade) return null;
  var n = String(cidade).toLowerCase().trim()
    .replace(/\u00e3/g,'a').replace(/\u00e1/g,'a').replace(/\u00e2/g,'a')
    .replace(/\u00e9/g,'e').replace(/\u00ea/g,'e').replace(/\u00ed/g,'i')
    .replace(/\u00f3/g,'o').replace(/\u00f4/g,'o').replace(/\u00fa/g,'u')
    .replace(/\u00e7/g,'c').replace(/\s+/g,'_').replace(/-/g,'_').toUpperCase();
  return 'MACHINE_API_KEY_' + n;
}

exports.handler = async function(event){
  var cors = {
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Methods':'GET, OPTIONS',
    'Content-Type':'application/json'
  };
  if(event.httpMethod === 'OPTIONS') return { statusCode:200, headers:cors, body:'' };

  var p = event.queryStringParameters || {};
  var cidade = (p.cidade||'').toLowerCase();
  var recurso = (p.recurso||'condutor').toLowerCase();

  // Valida recurso (whitelist)
  var path = RECURSOS_GET[recurso];
  if(!path){
    return { statusCode:400, headers:cors, body: JSON.stringify({
      success:false, error:'Recurso invalido', recursos_validos: Object.keys(RECURSOS_GET)
    }) };
  }

  // Credenciais
  var apiKey = process.env[getCidadeKey(cidade)];
  var user = process.env.MACHINE_USER;
  var pass = process.env.MACHINE_PASS;
  if(!apiKey || !user || !pass){
    return { statusCode:400, headers:cors, body: JSON.stringify({
      success:false, error:'Credenciais nao configuradas pra esta cidade', cidade: cidade
    }) };
  }

  // Cache
  var cacheKey = cidade + ':' + recurso;
  var agora = Date.now();
  if(_cache[cacheKey] && (agora - _cache[cacheKey].ts) < CACHE_MS){
    return { statusCode:200, headers:cors, body: JSON.stringify({
      success:true, cidade:cidade, recurso:recurso, cache:true,
      atualizado_em: new Date(_cache[cacheKey].ts).toISOString(),
      response: _cache[cacheKey].data
    }) };
  }

  // Chama a Machine
  try{
    var headers = {
      'Content-Type':'application/json',
      'Accept':'application/json',
      'api-key': apiKey,
      'Authorization': 'Basic ' + Buffer.from(user + ':' + pass).toString('base64')
    };
    var r = await fetch(BASE_URL + path, { method:'GET', headers });
    var data = await r.json();

    if(!r.ok || !data || data.success === false){
      return { statusCode: r.status||502, headers:cors, body: JSON.stringify({
        success:false, error:'Machine retornou erro', detalhe: data
      }) };
    }

    var lista = data.response || [];
    _cache[cacheKey] = { ts: agora, data: lista };

    return { statusCode:200, headers:cors, body: JSON.stringify({
      success:true, cidade:cidade, recurso:recurso, cache:false,
      total: Array.isArray(lista) ? lista.length : 0,
      atualizado_em: new Date(agora).toISOString(),
      response: lista
    }) };
  }catch(err){
    return { statusCode:502, headers:cors, body: JSON.stringify({
      success:false, error: err.message
    }) };
  }
};
