// Netlify Function: proxy seguro para a Machine API (Gaudium)
// Autenticação via header "api-key" (descoberto na documentação oficial)
//
// USO PELO FRONTEND:
//   GET  /.netlify/functions/machine?cidade=fortaleza&endpoint=empresa
//
// VARIÁVEIS DE AMBIENTE (Netlify):
//   MACHINE_BASE_URL          ex: https://api.taximachine.com.br/api/integracao
//                              ou: https://api-trial.taximachine.com.br/api/integracao (testes)
//   MACHINE_API_KEY_FORTALEZA mch_api_xxx
//   ...etc para cada cidade

const CITY_KEY_MAP = {
  'fortaleza':    'MACHINE_API_KEY_FORTALEZA',
  'recife':       'MACHINE_API_KEY_RECIFE',
  'maceio':       'MACHINE_API_KEY_MACEIO',
  'maceió':       'MACHINE_API_KEY_MACEIO',
  'joaopessoa':   'MACHINE_API_KEY_JOAOPESSOA',
  'joao pessoa':  'MACHINE_API_KEY_JOAOPESSOA',
  'joão pessoa':  'MACHINE_API_KEY_JOAOPESSOA',
  'natal':        'MACHINE_API_KEY_NATAL',
  'aracaju':      'MACHINE_API_KEY_ARACAJU',
  'saoluis':      'MACHINE_API_KEY_SAOLUIS',
  'sao luis':     'MACHINE_API_KEY_SAOLUIS',
  'são luís':     'MACHINE_API_KEY_SAOLUIS',
  'cuiaba':       'MACHINE_API_KEY_CUIABA',
  'cuiabá':       'MACHINE_API_KEY_CUIABA',
  'teresina':     'MACHINE_API_KEY_TERESINA',
};

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  
  try {
    const params = event.queryStringParameters || {};
    const cidade = (params.cidade || '').toLowerCase().trim();
    const endpoint = params.endpoint;
    
    if (!cidade) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'parâmetro cidade obrigatório' })};
    }
    if (!endpoint) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'parâmetro endpoint obrigatório (ex: empresa, condutor, consultarSolicitacao)' })};
    }
    
    const envKeyName = CITY_KEY_MAP[cidade];
    if (!envKeyName) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'cidade não mapeada: ' + cidade, cidades_validas: Object.keys(CITY_KEY_MAP) })};
    }
    const apiKey = process.env[envKeyName];
    if (!apiKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'chave da cidade não configurada no Netlify: ' + envKeyName })};
    }
    
    const baseUrl = process.env.MACHINE_BASE_URL;
    if (!baseUrl) {
      return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'MACHINE_BASE_URL não configurada no Netlify' })};
    }
    
    // Monta query (sem cidade e endpoint, que são internos)
    const apiParams = new URLSearchParams();
    Object.keys(params).forEach(k => {
      if (k !== 'cidade' && k !== 'endpoint') apiParams.set(k, params[k]);
    });
    const queryString = apiParams.toString();
    const url = baseUrl.replace(/\/$/, '') + '/' + endpoint + (queryString ? '?' + queryString : '');
    
    // ⭐ Header CORRETO descoberto na documentação:
    //    api-key: <chave>
    const requestHeaders = {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    
    const fetchOpts = {
      method: event.httpMethod === 'POST' ? 'POST' : 'GET',
      headers: requestHeaders,
    };
    if (event.httpMethod === 'POST' && event.body) {
      fetchOpts.body = event.body;
    }
    
    const resp = await fetch(url, fetchOpts);
    const text = await resp.text();
    
    let data;
    try { data = JSON.parse(text); }
    catch(e) { 
      data = { 
        success: false, 
        error: 'resposta não-JSON', 
        raw: text.slice(0, 500), 
        status: resp.status,
        url_chamada: url 
      }; 
    }
    
    return {
      statusCode: resp.status,
      headers,
      body: JSON.stringify(data)
    };
    
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
};
