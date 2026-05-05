// Netlify Function: proxy seguro para a Machine API
// Mantém credenciais escondidas no servidor (variáveis de ambiente Netlify)
//
// USO PELO FRONTEND:
//   GET  /.netlify/functions/machine?cidade=fortaleza&endpoint=consultarCorridas&data=2026-05-05
//
// VARIÁVEIS DE AMBIENTE NECESSÁRIAS (configurar no painel Netlify):
//   MACHINE_BASE_URL          ex: https://api.taximachine.com.br/api/integracao
//   MACHINE_API_KEY_FORTALEZA mch_api_9HUXyIM4TJtglW12J3JAfXLz
//   MACHINE_API_KEY_RECIFE    mch_api_1U24cU6Jrpnbo4CDiHW4XzTX
//   MACHINE_API_KEY_MACEIO    mch_api_7qZTetNUI6jLJDUUyc9rylda
//   MACHINE_API_KEY_JOAOPESSOA mch_api_GFxZZaTMSyNxHZWxh2AYBBhO
//   MACHINE_API_KEY_NATAL     mch_api_h1QuswRFxqNGQfue0RaDgEYb
//   MACHINE_API_KEY_ARACAJU   mch_api_QheteUpBZChzh7SFhbJ99S12
//   MACHINE_API_KEY_SAOLUIS   mch_api_9HUXyIM4TJtglW12J3JAfXLz
//   MACHINE_API_KEY_CUIABA    mch_api_4oL92M6ZF5eLxG5bHYsrrWMC
//   MACHINE_API_KEY_TERESINA  mch_api_RjJkmPUGdbcrSyD4cpAiUrEo
//
// Opcional (deprecated - mantido por compatibilidade):
//   MACHINE_AUTH_USERNAME / MACHINE_AUTH_PASSWORD - se precisar Basic Auth

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
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'parâmetro endpoint obrigatório (ex: consultarCorridas, condutor, empresa)' })};
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
    
    // Monta query da API real
    const apiParams = new URLSearchParams();
    Object.keys(params).forEach(k => {
      if (k !== 'cidade' && k !== 'endpoint') apiParams.set(k, params[k]);
    });
    const queryString = apiParams.toString();
    
    const url = baseUrl.replace(/\/$/, '') + '/' + endpoint + (queryString ? '?' + queryString : '');
    
    // Auth: API key vai no header (a forma mais comum em APIs REST)
    // Se a Machine usar outro padrão (querystring api_key), tentamos ambos
    const requestHeaders = {
      'Authorization': 'Bearer ' + apiKey,
      'X-API-KEY': apiKey,
      'apikey': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    
    // Se tiver Basic Auth configurado, adiciona como fallback
    const username = process.env.MACHINE_AUTH_USERNAME;
    const password = process.env.MACHINE_AUTH_PASSWORD;
    if (username && password) {
      requestHeaders['Authorization'] = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
      requestHeaders['X-API-KEY'] = apiKey;
    }
    
    const resp = await fetch(url, {
      method: event.httpMethod === 'POST' ? 'POST' : 'GET',
      headers: requestHeaders,
      body: event.httpMethod === 'POST' ? event.body : undefined
    });
    
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); }
    catch(e) { data = { success: false, error: 'resposta não-JSON', raw: text.slice(0, 500), url_chamada: url }; }
    
    return {
      statusCode: resp.status,
      headers,
      body: JSON.stringify(data)
    };
    
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: err.message, stack: err.stack ? err.stack.split('\n').slice(0,3).join(' | ') : null })
    };
  }
};
