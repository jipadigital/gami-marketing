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

  // Credenciais
  var apiKey = process.env[getCidadeKey(cidade)];
  var user = process.env.MACHINE_USER;
  var pass = process.env.MACHINE_PASS;
  if(!apiKey || !user || !pass){
    return { statusCode:400, headers:cors, body: JSON.stringify({
      success:false, error:'Credenciais nao configuradas pra esta cidade', cidade: cidade
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
    // Limite de paginas POR RECURSO:
    // condutor = poucos (varre ate 20 pag). solicitacao = pode ser MILHARES,
    // entao limita a 3 paginas (300 corridas recentes) pra nao estourar 502.
    var MAX_PAGINAS = (recurso === 'condutor') ? 20 : 12;
    var INICIO = Date.now();
    var TEMPO_MAX = 8500; // 8.5s (limite Netlify e 10s, deixa folga)

    while(pagina <= MAX_PAGINAS){
      // Trava de tempo: se ja passou do limite, para e retorna o que tem
      if(Date.now() - INICIO > TEMPO_MAX) break;

      var sep = path.indexOf('?')>=0 ? '&' : '?';
      var url = BASE_URL + path + sep + 'pagina=' + pagina + '&limite=' + LIMITE;
      // Filtro de data (so pra solicitacao). Nomes oficiais Machine API:
      //   data_hora_solicitacao_min / data_hora_solicitacao_max
      // Formato: ISO 8601 com hora (2025-05-28T00:00:00.000Z)
      if(recurso === 'solicitacao' && dataInicio){
        // Aceita 'YYYY-MM-DD' (converte pra ISO com hora) ou ja ISO
        var dIni = dataInicio.indexOf('T')>=0 ? dataInicio : (dataInicio + 'T00:00:00.000Z');
        url += '&data_hora_solicitacao_min=' + encodeURIComponent(dIni);
        if(dataFim){
          var dFim = dataFim.indexOf('T')>=0 ? dataFim : (dataFim + 'T23:59:59.999Z');
          url += '&data_hora_solicitacao_max=' + encodeURIComponent(dFim);
        }
      }

      // Timeout por requisicao (5s cada)
      var ctrl = new AbortController();
      var t = setTimeout(function(){ ctrl.abort(); }, 5000);
      var r, data;
      try{
        r = await fetch(url, { method:'GET', headers, signal: ctrl.signal });
        clearTimeout(t);
        data = await r.json();
      }catch(fe){
        clearTimeout(t);
        // Timeout ou erro de rede: para e usa o que tiver
        if(pagina === 1){
          return { statusCode:504, headers:cors, body: JSON.stringify({
            success:false, error:'Timeout ao consultar a Machine', recurso:recurso,
            dica: 'O endpoint pode exigir filtro de data. Veja se ha muitos registros.'
          }) };
        }
        break;
      }

      if(!r.ok || !data || data.success === false){
        if(pagina === 1){
          return { statusCode: r.status||502, headers:cors, body: JSON.stringify({
            success:false, error:'Machine retornou erro', detalhe: data
          }) };
        }
        break;
      }

      var lote = data.response || [];
      if(!Array.isArray(lote) || lote.length === 0) break;

      if(pagina > 1 && lote.length && todos.some(function(x){ return x.id === lote[0].id; })){
        break;
      }

      todos = todos.concat(lote);

      // Otimizacao: se pediu filtro de data e o lote ja passou do dia pedido,
      // nao precisa continuar paginando.
      if(recurso === 'solicitacao' && dataFim && lote.length){
        var ultima = lote[lote.length-1].data_hora_solicitacao || '';
        if(ultima && ultima.split(' ')[0] > dataFim) break;
      }

      if(lote.length < LIMITE) break;
      pagina++;
    }

    // Detecta se o filtro de data foi REALMENTE aplicado pela Machine.
    // (Se pediu filtro mas as corridas voltaram fora do periodo, a API ignorou.)
    var filtroAplicado = null;
    if(recurso === 'solicitacao' && dataInicio && todos.length){
      var dentro = todos.filter(function(x){
        var d = (x.data_hora_solicitacao||'').split(' ')[0];
        return d >= dataInicio && (!dataFim || d <= dataFim);
      });
      filtroAplicado = (dentro.length / todos.length) > 0.5; // maioria dentro do periodo?
    }

    _cache[cacheKey] = { ts: agora, data: todos };

    return { statusCode:200, headers:cors, body: JSON.stringify({
      success:true, cidade:cidade, recurso:recurso, cache:false,
      total: todos.length,
      paginas_lidas: pagina,
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
