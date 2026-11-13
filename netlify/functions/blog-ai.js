const https = require('https');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

// Modelo padrao (valido). O modelo antigo 'claude-sonnet-4-20250514' foi
// descontinuado e a API retornava not_found_error.
// O app pode mandar um modelo por chamada (body.model) — ex: Haiku pra analise
// rapida, Sonnet pra legenda/blog. Se nao mandar, usa o default abaixo.
const DEFAULT_MODEL = 'claude-sonnet-4-6';

const { exigirSessao } = require('../lib/sessao');
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };
  // SEGURANÇA (auditoria 13/11/2026): esta função era pública. Agora exige a sessão do
  // painel (X-Gami-User + X-Gami-Token) ou chamada interna de outra function.
  const _acesso = await exigirSessao(event);
  if (!_acesso.ok) return _acesso.resposta(HEADERS);
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY nao configurada' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { prompt } = body;
  if (!prompt) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'prompt obrigatorio' }) };

  // Teto de custo: no máximo 4000 tokens de resposta, prompt de até 60 mil caracteres e só
  // modelos das linhas Haiku/Sonnet (o painel não usa outros). Fora disso cai no padrão.
  if (String(prompt).length > 60000) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'prompt muito longo' }) };
  const max_tokens = Math.max(1, Math.min(4000, parseInt(body.max_tokens, 10) || 2500));
  const _modeloPedido = (typeof body.model === 'string') ? body.model.trim() : '';
  const model = /^claude-(haiku|sonnet)-[a-z0-9.-]{1,40}$/.test(_modeloPedido) ? _modeloPedido : DEFAULT_MODEL;

  const payload = JSON.stringify({
    model: model,
    max_tokens: max_tokens,
    messages: [{ role: 'user', content: prompt }]
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const d = JSON.parse(data);
          // Return full response for debugging + extracted text
          const text = (d.content || []).map(b => b.text || '').join('');
          if (text) {
            resolve({ statusCode: 200, headers: HEADERS, body: JSON.stringify({ content: text }) });
          } else {
            // Return the full API response so we can see the error
            resolve({ statusCode: 200, headers: HEADERS, body: JSON.stringify({ 
              content: '', 
              debug: d 
            })});
          }
        } catch(e) {
          resolve({ statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Parse error', raw: data.slice(0, 200) }) });
        }
      });
    });
    req.on('error', (e) => resolve({ 
      statusCode: 500, headers: HEADERS, 
      body: JSON.stringify({ error: e.message }) 
    }));
    req.write(payload);
    req.end();
  });
};
