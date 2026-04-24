const https = require('https');

const MACHINE_API_KEY = process.env.MACHINE_API_KEY || '';

// Mapeamento de cidades para IDs (será preenchido conforme Machine retornar)
const CIDADE_MAP = {
  'fortaleza':   { nome: 'Fortaleza',   uf: 'CE' },
  'recife':      { nome: 'Recife',      uf: 'PE' },
  'maceio':      { nome: 'Maceió',      uf: 'AL' },
  'joaopessoa':  { nome: 'João Pessoa', uf: 'PB' },
  'natal':       { nome: 'Natal',       uf: 'RN' },
  'aracaju':     { nome: 'Aracaju',     uf: 'SE' },
  'saoluis':     { nome: 'São Luís',    uf: 'MA' },
  'cuiaba':      { nome: 'Cuiabá',      uf: 'MT' },
  'teresina':    { nome: 'Teresina',    uf: 'PI' },
  'vitoria':     { nome: 'Vitória',     uf: 'ES' },
};

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if(body) req.write(body);
    req.end();
  });
}

async function fetchMachineAPI(path, apiKey) {
  const result = await httpsRequest({
    hostname: 'api.machine.global',
    path: '/v1' + path,
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    }
  });
  return result;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { endpoint, cidade, centralId, apiKey: clientApiKey } = body;

  // Usa chave do servidor primeiro, depois a do cliente
  const apiKey = MACHINE_API_KEY || clientApiKey;

  if (!apiKey) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'MACHINE_API_KEY não configurada no servidor' }) };
  }

  if (!endpoint) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'endpoint é obrigatório' }) };
  }

  try {
    // Se pediu TODAS as cidades (dashboard geral)
    if (endpoint === 'todas_cidades') {
      const resultados = {};

      // Busca dados gerais
      const [condutores, solicitacoes, centrais] = await Promise.all([
        fetchMachineAPI('/condutor', apiKey),
        fetchMachineAPI('/solicitacao', apiKey),
        fetchMachineAPI('/central', apiKey).catch(() => ({ status: 404, body: [] })),
      ]);

      // Tenta agrupar por cidade
      const todasSolicitacoes = Array.isArray(condutores.body) ? condutores.body : 
                                (condutores.body?.data || condutores.body?.result || []);
      const todasEntregas     = Array.isArray(solicitacoes.body) ? solicitacoes.body :
                                (solicitacoes.body?.data || solicitacoes.body?.result || []);

      resultados.condutores   = todasSolicitacoes;
      resultados.solicitacoes = todasEntregas;
      resultados.centrais     = Array.isArray(centrais.body) ? centrais.body : 
                                (centrais.body?.data || []);
      resultados.total_condutores   = todasSolicitacoes.length;
      resultados.total_solicitacoes = todasEntregas.length;

      return { statusCode: 200, headers, body: JSON.stringify({ data: resultados, ok: true }) };
    }

    // Endpoint específico por cidade
    let path = '/' + endpoint;
    if (centralId) path += '?central_id=' + centralId;
    if (cidade)    path += (centralId ? '&' : '?') + 'cidade=' + encodeURIComponent(cidade);

    const result = await fetchMachineAPI(path, apiKey);

    if (result.status === 401) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'API Key inválida', status: 401 }) };
    }
    if (result.status === 403) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Sem permissão', status: 403 }) };
    }
    if (result.status === 404) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Endpoint não encontrado', status: 404 }) };
    }

    // Normaliza resposta
    const data = Array.isArray(result.body) ? result.body :
                 (result.body?.data || result.body?.result || result.body);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ data, status: result.status, ok: result.status < 400 })
    };

  } catch(err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message, ok: false })
    };
  }
};
