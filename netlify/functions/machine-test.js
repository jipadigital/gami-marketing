// netlify/functions/machine-test.js
// FUNÇÃO DE TESTE — descobre endpoints disponíveis da Machine API
// 
// COMO USAR:
//   GET https://gami-marketing.netlify.app/.netlify/functions/machine-test?cidade=recife
//   GET https://gami-marketing.netlify.app/.netlify/functions/machine-test?cidade=recife&endpoint=motoboys
//
// PARÂMETROS:
//   cidade   = nome da cidade (recife, fortaleza, maceio, etc)
//   endpoint = endpoint específico (opcional - testa só esse)
//   auth     = método de auth (bearer, x-api-key, query, plain) - opcional
// ============================================================

const BASE_URL = 'https://api.taximachine.com.br/api/integracao';

// Endpoints comuns a testar (descobrindo o que a API tem)
const ENDPOINTS_COMUNS = [
  '',                          // raiz
  '/',
  '/status',
  '/health',
  '/motoboys',
  '/motoboys/ativos',
  '/motoboys/online',
  '/motoboys/cadastrados',
  '/corridas',
  '/corridas/hoje',
  '/corridas/em-andamento',
  '/corridas/finalizadas',
  '/lojas',
  '/lojas/ativas',
  '/lojas/parceiros',
  '/restaurantes',
  '/pedidos',
  '/pedidos/hoje',
  '/relatorios',
  '/relatorios/diario',
  '/financeiro',
  '/financeiro/repasse',
  '/avaliacoes',
  '/usuarios',
  '/clientes',
  '/dashboard',
  '/dashboard/resumo',
  '/operacao',
  '/operacao/status'
];

// Mapeia cidade -> nome da variável no Netlify
function getCidadeKey(cidade) {
  if (!cidade) return null;
  const cidadeNorm = String(cidade).toLowerCase().trim()
    .replace(/ã/g, 'a').replace(/á/g, 'a').replace(/â/g, 'a')
    .replace(/é/g, 'e').replace(/ê/g, 'e')
    .replace(/í/g, 'i')
    .replace(/ó/g, 'o').replace(/ô/g, 'o')
    .replace(/ú/g, 'u')
    .replace(/ç/g, 'c')
    .replace(/\s+/g, '_').replace(/-/g, '_').toUpperCase();
  
  return `MACHINE_API_KEY_${cidadeNorm}`;
}

// Tenta diferentes formas de autenticação
async function tentarComAuth(url, chave, metodo) {
  let headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  let finalUrl = url;
  let method = 'GET';
  let body = null;
  
  switch (metodo) {
    case 'bearer':
      headers['Authorization'] = `Bearer ${chave}`;
      break;
    case 'x-api-key':
      headers['X-API-Key'] = chave;
      break;
    case 'api-key':
      headers['api-key'] = chave;
      break;
    case 'apikey-junto':
      headers['ApiKey'] = chave;
      break;
    case 'query-apikey':
      finalUrl = url + (url.includes('?') ? '&' : '?') + `apiKey=${chave}`;
      break;
    case 'query-api_key':
      finalUrl = url + (url.includes('?') ? '&' : '?') + `api_key=${chave}`;
      break;
    case 'query-token':
      finalUrl = url + (url.includes('?') ? '&' : '?') + `token=${chave}`;
      break;
    case 'query-key':
      finalUrl = url + (url.includes('?') ? '&' : '?') + `key=${chave}`;
      break;
    case 'token':
      headers['Token'] = chave;
      break;
    case 'access-token':
      headers['Access-Token'] = chave;
      break;
    case 'machine-token':
      headers['Machine-Token'] = chave;
      break;
    case 'mch-key':
      headers['mch-key'] = chave;
      break;
    case 'mch-api-key':
      headers['mch-api-key'] = chave;
      break;
    case 'authorization-plain':
      headers['Authorization'] = chave;
      break;
    case 'authorization-token':
      headers['Authorization'] = `Token ${chave}`;
      break;
    case 'authorization-apikey':
      headers['Authorization'] = `ApiKey ${chave}`;
      break;
    case 'authorization-key':
      headers['Authorization'] = `Key ${chave}`;
      break;
    case 'authorization-basic':
      headers['Authorization'] = `Basic ${Buffer.from(chave + ':').toString('base64')}`;
      break;
    case 'authorization-basic2':
      headers['Authorization'] = `Basic ${Buffer.from(':' + chave).toString('base64')}`;
      break;
    case 'post-body':
      method = 'POST';
      body = JSON.stringify({ apiKey: chave });
      break;
  }
  
  try {
    const opts = { method, headers };
    if (body) opts.body = body;
    const r = await fetch(finalUrl, opts);
    const text = await r.text();
    let respBody;
    try { respBody = JSON.parse(text); } catch (e) { respBody = text; }
    
    return {
      status: r.status,
      ok: r.ok,
      headers_resposta: Object.fromEntries(r.headers.entries()),
      body: respBody,
      body_preview: typeof respBody === 'string' ? respBody.substring(0, 200) : JSON.stringify(respBody).substring(0, 500)
    };
  } catch (err) {
    return { erro: err.message };
  }
}

exports.handler = async function (event) {
  // CORS
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }
  
  const params = event.queryStringParameters || {};
  const cidade = params.cidade || 'recife';
  const endpoint = params.endpoint || null;
  const metodoAuth = params.auth || null; // se null, testa todos
  
  // Pega chave da cidade
  const envKey = getCidadeKey(cidade);
  const chave = process.env[envKey];
  
  if (!chave) {
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({
        erro: `Chave não encontrada pra cidade "${cidade}"`,
        variavel_esperada: envKey,
        dica: 'Configure no Netlify > Environment Variables com esse nome exato.'
      }, null, 2)
    };
  }
  
  // ============================================================
  // MODO 1: Endpoint específico — testa todos os métodos de auth
  // ============================================================
  if (endpoint !== null && !metodoAuth) {
    const url = BASE_URL + (endpoint.startsWith('/') ? endpoint : '/' + endpoint);
    const metodos = [
      'bearer', 'x-api-key', 'api-key', 'apikey-junto',
      'query-apikey', 'query-api_key', 'query-token', 'query-key',
      'token', 'access-token', 'machine-token', 'mch-key', 'mch-api-key',
      'authorization-plain', 'authorization-token', 'authorization-apikey',
      'authorization-key', 'authorization-basic', 'authorization-basic2',
      'post-body'
    ];
    
    const resultados = {};
    for (const metodo of metodos) {
      resultados[metodo] = await tentarComAuth(url, chave, metodo);
    }
    
    // Identifica qual deu certo
    const sucessos = Object.entries(resultados).filter(([_, r]) => r.ok === true);
    
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        cidade: cidade,
        url_testada: url,
        chave_usada: chave.substring(0, 10) + '...',
        metodos_que_funcionaram: sucessos.map(([m, _]) => m),
        resultados_completos: resultados
      }, null, 2)
    };
  }
  
  // ============================================================
  // MODO 2: Endpoint + auth específicos
  // ============================================================
  if (endpoint !== null && metodoAuth) {
    const url = BASE_URL + (endpoint.startsWith('/') ? endpoint : '/' + endpoint);
    const resultado = await tentarComAuth(url, chave, metodoAuth);
    
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        cidade: cidade,
        url_testada: url,
        metodo_auth: metodoAuth,
        chave_usada: chave.substring(0, 10) + '...',
        resultado: resultado
      }, null, 2)
    };
  }
  
  // ============================================================
  // MODO 3: Sem endpoint — explora endpoints comuns
  // ============================================================
  // Primeiro descobre qual método de auth funciona
  let metodoFuncionando = null;
  let primeiraResposta = null;
  
  const metodos = [
    'bearer', 'x-api-key', 'api-key', 'apikey-junto',
    'query-apikey', 'query-api_key', 'query-token', 'query-key',
    'token', 'access-token', 'machine-token', 'mch-key', 'mch-api-key',
    'authorization-plain', 'authorization-token', 'authorization-apikey',
    'authorization-key', 'authorization-basic', 'authorization-basic2',
    'post-body'
  ];
  for (const metodo of metodos) {
    const r = await tentarComAuth(BASE_URL + '/', chave, metodo);
    if (r.ok || (r.status >= 200 && r.status < 500 && r.status !== 401 && r.status !== 403)) {
      metodoFuncionando = metodo;
      primeiraResposta = r;
      break;
    }
  }
  
  if (!metodoFuncionando) {
    // Tenta sem auth também (talvez seja público?)
    const r = await tentarComAuth(BASE_URL + '/', chave, 'nenhum');
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        cidade: cidade,
        chave_usada: chave.substring(0, 10) + '...',
        erro: 'Nenhum método de autenticação retornou sucesso',
        sugestao: 'Verifique se a chave está correta e se a Machine API está online.',
        testes_realizados: metodos,
        ultima_resposta: r
      }, null, 2)
    };
  }
  
  // Testa todos os endpoints comuns com o método que funciona
  const resultados = [];
  for (const ep of ENDPOINTS_COMUNS) {
    const url = BASE_URL + ep;
    const r = await tentarComAuth(url, chave, metodoFuncionando);
    
    resultados.push({
      endpoint: ep,
      url: url,
      status: r.status,
      ok: r.ok,
      tem_dados: r.ok && r.body && (Array.isArray(r.body) ? r.body.length > 0 : Object.keys(r.body || {}).length > 0),
      preview: r.body_preview ? r.body_preview.substring(0, 150) : null
    });
  }
  
  return {
    statusCode: 200,
    headers: cors,
    body: JSON.stringify({
      cidade: cidade,
      chave_usada: chave.substring(0, 10) + '...',
      metodo_auth_descoberto: metodoFuncionando,
      total_endpoints_testados: resultados.length,
      endpoints_que_funcionam: resultados.filter(r => r.ok).map(r => r.endpoint),
      endpoints_com_dados: resultados.filter(r => r.tem_dados).map(r => r.endpoint),
      detalhes: resultados,
      proximo_passo: 'Use ?endpoint=NOME pra ver dados completos de um endpoint específico'
    }, null, 2)
  };
};
