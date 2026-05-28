// netlify/functions/machine-test.js
// TESTE v3 — autenticacao CORRETA: api-key (header) + Basic Auth (login/senha master)
// Baseado na documentacao oficial da Machine.
//
// USO:
//   /.netlify/functions/machine-test?cidade=maceio
//   /.netlify/functions/machine-test?cidade=maceio&endpoint=condutor
//
// Variaveis necessarias no Netlify:
//   MACHINE_API_KEY_<CIDADE>  (uma por cidade)
//   MACHINE_USER              (login master, Basic Auth)
//   MACHINE_PASS              (senha master, Basic Auth)
// ============================================================

const BASE_URL = 'https://api.taximachine.com.br/api/integracao';

// Endpoints REAIS da documentacao Machine (GET, leitura)
const ENDPOINTS = [
  '/condutor',
  '/solicitacao',
  '/posicaoCondutor',
  '/recibo',
  '/consultarProgramada',
  '/saldoCreditosEmpresa',
  '/saldoCreditosCondutor'
];

function getCidadeKey(cidade){
  if(!cidade) return null;
  var n = String(cidade).toLowerCase().trim()
    .replace(/\u00e3/g,'a').replace(/\u00e1/g,'a').replace(/\u00e2/g,'a')
    .replace(/\u00e9/g,'e').replace(/\u00ea/g,'e').replace(/\u00ed/g,'i')
    .replace(/\u00f3/g,'o').replace(/\u00f4/g,'o').replace(/\u00fa/g,'u')
    .replace(/\u00e7/g,'c').replace(/\s+/g,'_').replace(/-/g,'_').toUpperCase();
  return 'MACHINE_API_KEY_' + n;
}

async function chamar(url, apiKey, user, pass, metodo){
  var headers = { 'Content-Type':'application/json', 'Accept':'application/json' };
  if(user && pass){
    headers['Authorization'] = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
  }
  if(metodo === 'chave-api'){ headers['chave-api'] = apiKey; }
  else if(metodo === 'x-api-key'){ headers['x-api-key'] = apiKey; }
  else { headers['api-key'] = apiKey; }

  try{
    var r = await fetch(url, { method:'GET', headers });
    var text = await r.text();
    var body; try{ body = JSON.parse(text); }catch(e){ body = text; }
    return {
      status: r.status,
      ok: r.ok,
      body_preview: typeof body==='string' ? body.slice(0,300) : JSON.stringify(body).slice(0,600)
    };
  }catch(err){
    return { erro: err.message };
  }
}

exports.handler = async function(event){
  var cors = { 'Access-Control-Allow-Origin':'*', 'Content-Type':'application/json' };
  var p = event.queryStringParameters || {};
  var cidade = p.cidade || 'maceio';
  var endpoint = p.endpoint || null;
  var metodo = p.metodo || 'api-key';

  var apiKey = process.env[getCidadeKey(cidade)];
  var user = process.env.MACHINE_USER;
  var pass = process.env.MACHINE_PASS;

  var faltando = [];
  if(!apiKey) faltando.push(getCidadeKey(cidade));
  if(!user) faltando.push('MACHINE_USER');
  if(!pass) faltando.push('MACHINE_PASS');
  if(faltando.length){
    return { statusCode:400, headers:cors, body: JSON.stringify({
      erro: 'Variaveis faltando no Netlify',
      faltando: faltando,
      dica: 'Configure em Site settings > Environment variables'
    }, null, 2) };
  }

  if(endpoint){
    var url1 = BASE_URL + (endpoint.charAt(0)==='/' ? endpoint : '/'+endpoint);
    var res = await chamar(url1, apiKey, user, pass, metodo);
    return { statusCode:200, headers:cors, body: JSON.stringify({
      cidade: cidade, url: url1, metodo: metodo,
      api_key: apiKey.slice(0,12)+'...', basic_auth: user.slice(0,3)+'***',
      resultado: res
    }, null, 2) };
  }

  var resultados = [];
  for(var i=0;i<ENDPOINTS.length;i++){
    var url = BASE_URL + ENDPOINTS[i];
    var r = await chamar(url, apiKey, user, pass, metodo);
    resultados.push({ endpoint: ENDPOINTS[i], status: r.status, ok: r.ok, preview: r.body_preview ? String(r.body_preview).slice(0,160) : r.erro });
  }

  return { statusCode:200, headers:cors, body: JSON.stringify({
    cidade: cidade, metodo: metodo + ' (header) + Basic Auth',
    api_key: apiKey.slice(0,12)+'...', basic_auth_user: user.slice(0,3)+'***',
    endpoints_que_funcionam: resultados.filter(function(x){return x.ok;}).map(function(x){return x.endpoint;}),
    detalhes: resultados
  }, null, 2) };
};
