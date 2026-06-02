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

// Origens permitidas (somente nosso domínio + localhost pra dev)
const ORIGENS_PERMITIDAS = [
  'https://gami-marketing.netlify.app',
  'http://localhost:8888',
  'http://localhost:3000'
];

function corsPermitido(origem){
  if(!origem) return ORIGENS_PERMITIDAS[0]; // requests sem origin (curl, server-to-server)
  return ORIGENS_PERMITIDAS.indexOf(origem) >= 0 ? origem : null;
}

// Recursos liberados pra leitura via GET (whitelist por seguranca)
const RECURSOS_GET = {
  condutor: '/condutor',
  solicitacao: '/solicitacao',
  programada: '/consultarProgramada',
  empresa: '/empresa'
};

// Cache em memoria (por instancia) — respeita limite de 50 req/min
var _cache = {};
var CACHE_MS = 30 * 1000; // 30 segundos (fase de testes; subir pra 3min em producao)

function getCidadeKey(cidade){
  if(!cidade) return null;
  var n = String(cidade).toLowerCase().trim()
    .replace(/\u00e3/g,'a').replace(/\u00e1/g,'a').replace(/\u00e2/g,'a')
    .replace(/\u00e9/g,'e').replace(/\u00ea/g,'e').replace(/\u00ed/g,'i')
    .replace(/\u00f3/g,'o').replace(/\u00f4/g,'o').replace(/\u00fa/g,'u')
    .replace(/\u00e7/g,'c').replace(/\s+/g,'_').replace(/-/g,'_').toUpperCase();
  return 'MACHINE_API_KEY_' + n;
}

// Normaliza nome da cidade pra sufixo de env var
function getCidadeSufixo(cidade){
  if(!cidade) return null;
  return String(cidade).toLowerCase().trim()
    .replace(/\u00e3/g,'a').replace(/\u00e1/g,'a').replace(/\u00e2/g,'a')
    .replace(/\u00e9/g,'e').replace(/\u00ea/g,'e').replace(/\u00ed/g,'i')
    .replace(/\u00f3/g,'o').replace(/\u00f4/g,'o').replace(/\u00fa/g,'u')
    .replace(/\u00e7/g,'c').replace(/\s+/g,'_').replace(/-/g,'_').toUpperCase();
}

exports.handler = async function(event){
  var origem = event.headers.origin || event.headers.Origin || '';
  var origemPermitida = corsPermitido(origem);
  
  // Se origem não permitida, bloqueia (exceto chamada server-to-server sem origem)
  if(origem && !origemPermitida){
    return { 
      statusCode: 403, 
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({success:false, error:'Origem não autorizada'})
    };
  }
  
  var cors = {
    'Access-Control-Allow-Origin': origemPermitida || ORIGENS_PERMITIDAS[0],
    'Access-Control-Allow-Methods':'GET, OPTIONS',
    'Content-Type':'application/json'
  };
  if(event.httpMethod === 'OPTIONS') return { statusCode:200, headers:cors, body:'' };
  
  // Rate limit por IP (60 chamadas/minuto)
  var ip = event.headers['x-forwarded-for'] || event.headers['x-nf-client-connection-ip'] || 'desconhecido';
  ip = ip.split(',')[0].trim();
  try {
    var SUPA_URL_RL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
    var SUPA_KEY_RL = process.env.SUPA_SERVICE_KEY || process.env.SUPA_PUBLIC_KEY || 'sb_publishable_0y-oz0aght1rNQNQrsh2tA_EfHajL61';
    var rRL = await fetch(SUPA_URL_RL+'/rest/v1/rpc/verificar_rate_limit', {
      method:'POST',
      headers:{'apikey':SUPA_KEY_RL,'Authorization':'Bearer '+SUPA_KEY_RL,'Content-Type':'application/json'},
      body: JSON.stringify({ p_chave: 'machine_ip:'+ip, p_limite: 60 })
    });
    if(rRL.ok){
      var dataRL = await rRL.json();
      if(Array.isArray(dataRL) && dataRL[0] && !dataRL[0].ok){
        return { 
          statusCode: 429, 
          headers: cors, 
          body: JSON.stringify({success:false, error:'Muitas chamadas. Aguarde 1 minuto.', contagem: dataRL[0].contagem}) 
        };
      }
    }
  } catch(e){ /* fail-open: se rate limit falhar, deixa passar */ }

  var p = event.queryStringParameters || {};
  var cidade = (p.cidade||'').toLowerCase();
  var recurso = (p.recurso||'condutor').toLowerCase();
  // Filtros opcionais de data (repassados a Machine se informados).
  // Nomes provaveis ajustaveis conforme a doc: data_inicio / data_fim.
  var dataInicio = p.data_inicio || p.inicio || null;
  var dataFim = p.data_fim || p.fim || null;

  // Valida recurso (whitelist)
  var path = RECURSOS_GET[recurso];
  if(!path){
    return { statusCode:400, headers:cors, body: JSON.stringify({
      success:false, error:'Recurso invalido', recursos_validos: Object.keys(RECURSOS_GET)
    }) };
  }

  // Credenciais — primeiro tenta específica da cidade, depois global (fallback)
  var sufixo = getCidadeSufixo(cidade);
  var apiKey = process.env['MACHINE_API_KEY_' + sufixo];
  var user = process.env['MACHINE_USER_' + sufixo] || process.env.MACHINE_USER;
  var pass = process.env['MACHINE_PASS_' + sufixo] || process.env.MACHINE_PASS;
  
  // Pra debug: indica quais credenciais foram usadas
  var credenciaisOrigem = {
    apikey: process.env['MACHINE_API_KEY_' + sufixo] ? ('MACHINE_API_KEY_' + sufixo) : null,
    user: process.env['MACHINE_USER_' + sufixo] ? ('MACHINE_USER_' + sufixo) : (process.env.MACHINE_USER ? 'MACHINE_USER (global)' : null),
    pass: process.env['MACHINE_PASS_' + sufixo] ? ('MACHINE_PASS_' + sufixo) : (process.env.MACHINE_PASS ? 'MACHINE_PASS (global)' : null)
  };
  
  if(!apiKey || !user || !pass){
    return { statusCode:400, headers:cors, body: JSON.stringify({
      success:false, 
      error:'Credenciais nao configuradas pra esta cidade', 
      cidade: cidade,
      sufixo: sufixo,
      faltando: {
        apikey: !apiKey ? ('MACHINE_API_KEY_' + sufixo) : null,
        user: !user ? ('MACHINE_USER_' + sufixo + ' ou MACHINE_USER') : null,
        pass: !pass ? ('MACHINE_PASS_' + sufixo + ' ou MACHINE_PASS') : null
      }
    }) };
  }

  // Cache (pode ser furado com &nocache=1)
  var cacheKey = cidade + ':' + recurso + ':' + (dataInicio||'') + ':' + (dataFim||'');
  var agora = Date.now();
  var pularCache = (p.nocache === '1' || p.nocache === 'true');
  if(!pularCache && _cache[cacheKey] && (agora - _cache[cacheKey].ts) < CACHE_MS){
    return { statusCode:200, headers:cors, body: JSON.stringify({
      success:true, cidade:cidade, recurso:recurso, cache:true,
      atualizado_em: new Date(_cache[cacheKey].ts).toISOString(),
      response: _cache[cacheKey].data
    }) };
  }

  // Chama a Machine (com paginacao automatica + protecoes anti-502)
  try{
    var headers = {
      'Content-Type':'application/json',
      'Accept':'application/json',
      'api-key': apiKey,
      'Authorization': 'Basic ' + Buffer.from(user + ':' + pass).toString('base64')
    };

    var todos = [];
    var pagina = 1;
    var LIMITE = 100;
    // solicitacao: 200 paginas x 100 = ate 20.000 corridas por chamada (cidades grandes)
    // condutor: 100 (sem limite real, sao poucos)
    var MAX_PAGINAS = (recurso === 'condutor') ? 100 : 200;
    var INICIO = Date.now();
    // Netlify Pro permite ate 26s; deixa 4s de margem
    // Empresa e solicitacao precisam mais tempo (cidades grandes tem ate 5000 empresas / 20k corridas)
    var TEMPO_MAX = (recurso === 'solicitacao' || recurso === 'empresa') ? 22000 : 8500;
    var truncado = false;

    // Helper: monta a URL pra uma pagina especifica
    var montarUrl = function(p){
      var sep = path.indexOf('?')>=0 ? '&' : '?';
      var u = BASE_URL + path + sep + 'pagina=' + p + '&limite=' + LIMITE;
      if(recurso === 'solicitacao' && dataInicio){
        var dIni = dataInicio.indexOf('T')>=0 ? dataInicio : (dataInicio + 'T00:00:00.000Z');
        u += '&data_hora_solicitacao_min=' + encodeURIComponent(dIni);
        if(dataFim){
          var dFim = dataFim.indexOf('T')>=0 ? dataFim : (dataFim + 'T23:59:59.999Z');
          u += '&data_hora_solicitacao_max=' + encodeURIComponent(dFim);
        }
      }
      return u;
    };

    // Helper: faz 1 fetch com timeout de 24s (próximo do limite Netlify 26s)
    var fetchPagina = async function(p){
      var ctrl = new AbortController();
      var t = setTimeout(function(){ ctrl.abort(); }, 24000);
      try{
        var r = await fetch(montarUrl(p), { method:'GET', headers, signal: ctrl.signal });
        clearTimeout(t);
        var data = await r.json();
        if(!r.ok || !data || data.success === false){
          return { erro: data || {status:r.status}, lote: [] };
        }
        return { lote: (data.response || []) };
      }catch(fe){
        clearTimeout(t);
        return { erro: {message:String(fe)}, lote: [] };
      }
    };

    // === CONDUTOR / EMPRESA: busca sequencial (testada e estavel) ===
    // Condutor: LIMITE=200 (com fallback 100), MAX=25 paginas (ate 5000 condutores)
    // Empresa:  LIMITE=100 (max da API segundo doc), MAX=50 paginas (ate 5000 empresas - cidades grandes)
    if(recurso === 'condutor' || recurso === 'empresa'){
      var ehEmpresa = (recurso === 'empresa');
      var LIMITE_COND = ehEmpresa ? 100 : 200;
      var MAX_COND = ehEmpresa ? 50 : 25;
      var nomeRec = ehEmpresa ? 'empresa' : 'condutor';
      while(pagina <= MAX_COND){
        if(Date.now() - INICIO > TEMPO_MAX){ truncado = true; break; }

        var sepC = path.indexOf('?')>=0 ? '&' : '?';
        var urlC = BASE_URL + path + sepC + 'pagina=' + pagina + '&limite=' + LIMITE_COND;

        var ctrlC = new AbortController();
        var tC = setTimeout(function(){ ctrlC.abort(); }, 8000);
        var rC, dataC;
        try{
          rC = await fetch(urlC, { method:'GET', headers, signal: ctrlC.signal });
          clearTimeout(tC);
          dataC = await rC.json();
        }catch(fc){
          clearTimeout(tC);
          if(pagina === 1){
            return { statusCode:504, headers:cors, body: JSON.stringify({
              success:false, error:'Timeout ao consultar a Machine ('+nomeRec+')', detalhe: String(fc)
            }) };
          }
          break;
        }

        if(!rC.ok || !dataC || dataC.success === false){
          if(pagina === 1){
            // Pode ser que a API nao aceite LIMITE maior; tenta 100
            if(LIMITE_COND > 100){
              LIMITE_COND = 100;
              continue;
            }
            return { statusCode: rC.status||502, headers:cors, body: JSON.stringify({
              success:false, error:'Machine retornou erro ('+nomeRec+')', detalhe: dataC, status_http: rC.status
            }) };
          }
          break;
        }

        var loteC = dataC.response || [];
        if(!Array.isArray(loteC) || loteC.length === 0) break;
        if(pagina > 1 && loteC.length && todos.some(function(x){ return x.id === loteC[0].id; })) break;
        todos = todos.concat(loteC);
        if(loteC.length < LIMITE_COND) break;
        pagina++;
      }
      if(pagina > MAX_COND) truncado = true;
    }
    // === SOLICITACAO: busca sequencial (mantida, com filtro de data) ===
    else {
      while(pagina <= MAX_PAGINAS){
        if(Date.now() - INICIO > TEMPO_MAX){ truncado = true; break; }
        var rs = await fetchPagina(pagina);
        if(rs.erro){
          if(pagina === 1){
            return { statusCode: 502, headers:cors, body: JSON.stringify({
              success:false, 
              error:'Machine retornou erro na primeira pagina',
              detalhe: rs.erro,
              cidade: cidade,
              recurso: recurso,
              periodo: dataInicio && dataFim ? (dataInicio + ' a ' + dataFim) : null,
              tempo_decorrido_ms: Date.now() - INICIO,
              dica: rs.erro.message && rs.erro.message.indexOf('aborted') >= 0 ? 'Timeout — Machine demorou >18s pra responder. Reduzir período pode ajudar.' : null
            }) };
          }
          break;
        }
        var loteS = rs.lote;
        if(!Array.isArray(loteS) || loteS.length === 0) break;
        if(pagina > 1 && loteS.length && todos.some(function(x){ return x.id === loteS[0].id; })) break;
        todos = todos.concat(loteS);
        // Otimizacao: se filtro de data e o lote ja passou do dia pedido, para
        if(dataFim && loteS.length){
          var ultima = loteS[loteS.length-1].data_hora_solicitacao || '';
          if(ultima && ultima.split(' ')[0] > dataFim) break;
        }
        if(loteS.length < LIMITE) break;
        pagina++;
      }
      if(pagina > MAX_PAGINAS) truncado = true;
    }

    // Detecta se o filtro de data foi REALMENTE aplicado pela Machine.
    // (Se pediu filtro mas as corridas voltaram fora do periodo, a API ignorou.)
    var filtroAplicado = null;
    if(recurso === 'solicitacao' && dataInicio && todos.length){
      var dentro = todos.filter(function(x){
        var d = (x.data_hora_solicitacao||'').split(' ')[0];
        return d >= dataInicio && (!dataFim || d <= dataFim);
      });
      filtroAplicado = (dentro.length / todos.length) > 0.5;
    }

    _cache[cacheKey] = { ts: agora, data: todos };

    return { statusCode:200, headers:cors, body: JSON.stringify({
      success:true, cidade:cidade, recurso:recurso, cache:false,
      total: todos.length,
      paginas_lidas: pagina,
      truncado: truncado,
      filtro_data: (dataInicio||dataFim) ? {inicio:dataInicio, fim:dataFim, aplicado:filtroAplicado} : null,
      atualizado_em: new Date(agora).toISOString(),
      response: todos
    }) };
  }catch(err){
    return { statusCode:502, headers:cors, body: JSON.stringify({
      success:false, error: err.message
    }) };
  }
};
