// Netlify Function: proxy seguro para a Machine API
// Mantém credenciais escondidas no servidor (variáveis de ambiente Netlify)
//
// USO PELO FRONTEND:
//   GET  /.netlify/functions/machine?cidade=fortaleza&endpoint=consultarCorridas&data=2026-05-05
//
// VARIÁVEIS DE AMBIENTE NECESSÁRIAS (configurar no painel Netlify):
//   MACHINE_BASE_URL          ex: https://api.taximachine.com.br/api/integracao
//   MACHINE_AUTH_USERNAME     login do usuário Gestor na Machine
//   MACHINE_AUTH_PASSWORD     senha do usuário Gestor
//   MACHINE_API_KEY_FORTALEZA mch_api_9HUXyIM4TJtglW12J3JAfXLz
//   MACHINE_API_KEY_RECIFE    mch_api_1U24cU6Jrpnbo4CDiHW4XzTX
//   MACHINE_API_KEY_MACEIO    mch_api_7qZTetNUI6jLJDUUyc9rylda
//   MACHINE_API_KEY_JOAOPESSOA mch_api_GFxZZaTMSyNxHZWxh2AYBBhO
//   MACHINE_API_KEY_NATAL     mch_api_h1QuswRFxqNGQfue0RaDgEYb
//   MACHINE_API_KEY_ARACAJU   mch_api_QheteUpBZChzh7SFhbJ99S12
//   MACHINE_API_KEY_SAOLUIS   mch_api_9HUXyIM4TJtglW12J3JAfXLz
//   MACHINE_API_KEY_CUIABA    mch_api_4oL92M6ZF5eLxG5bHYsrrWMC
//   MACHINE_API_KEY_TERESINA  mch_api_RjJkmPUGdbcrSyD4cpAiUrEo

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
  // CORS pro frontend
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
    const endpoint = params.endpoint;  // ex: 'consultarCorridas', 'condutor', 'empresa'
    
    if (!cidade) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'parâmetro cidade obrigatório' })};
    }
    if (!endpoint) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'parâmetro endpoint obrigatório' })};
    }
    
    // Resolve a chave da cidade
    const envKeyName = CITY_KEY_MAP[cidade];
    if (!envKeyName) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'cidade não mapeada: ' + cidade })};
    }
    const apiKey = process.env[envKeyName];
    if (!apiKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'chave da cidade não configurada no Netlify: ' + envKeyName })};
    }
    
    const baseUrl = process.env.MACHINE_BASE_URL;
    const username = process.env.MACHINE_AUTH_USERNAME;
    const password = process.env.MACHINE_AUTH_PASSWORD;
    
    if (!baseUrl || !username || !password) {
      return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'credenciais Machine não configuradas no Netlify (MACHINE_BASE_URL, MACHINE_AUTH_USERNAME, MACHINE_AUTH_PASSWORD)' })};
    }
    
    // Monta query da API real (passa todos os params exceto cidade e endpoint)
    const apiParams = new URLSearchParams();
    apiParams.set('api_key', apiKey);
    Object.keys(params).forEach(k => {
      if (k !== 'cidade' && k !== 'endpoint') apiParams.set(k, params[k]);
    });
    
    const url = baseUrl.replace(/\/$/, '') + '/' + endpoint + '?' + apiParams.toString();
    const basicAuth = Buffer.from(username + ':' + password).toString('base64');
    
    const resp = await fetch(url, {
      method: event.httpMethod === 'POST' ? 'POST' : 'GET',
      headers: {
        'Authorization': 'Basic ' + basicAuth,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: event.httpMethod === 'POST' ? event.body : undefined
    });
    
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); }
    catch(e) { data = { success: false, error: 'resposta não-JSON', raw: text.slice(0, 500) }; }
    
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
