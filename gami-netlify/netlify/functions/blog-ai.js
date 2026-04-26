const https = require('https');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY não configurada no Netlify' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } 
  catch(e) { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { prompt, json } = body;
  if (!prompt) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'prompt obrigatório' }) };

  const payload = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: json ? 1000 : 2500,
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
          const text = (d.content || []).map(b => b.text || '').join('');
          resolve({ statusCode: 200, headers: HEADERS, body: JSON.stringify({ content: text }) });
        } catch(e) {
          resolve({ statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Parse error' }) });
        }
      });
    });
    req.on('error', (e) => resolve({ statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: e.message }) }));
    req.write(payload);
    req.end();
  });
};
