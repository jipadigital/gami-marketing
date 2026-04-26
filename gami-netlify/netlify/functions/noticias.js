const https = require('https');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

function httpsPost(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error('Parse error: ' + data.slice(0,300))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const hoje = new Date().toLocaleDateString('pt-BR', {
    day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo'
  });

  const payload = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{
      role: 'user',
      content: `Busque as 8 principais notícias de hoje (${hoje}) sobre: marketing digital, tecnologia, inteligência artificial, empreendedorismo e negócios no Brasil e no mundo.

Para cada notícia, retorne SOMENTE um JSON array com objetos no formato:
[{"titulo":"...","resumo":"...","fonte":"...","url":"...","categoria":"Marketing|Tecnologia|IA|Negócios|Empreendedorismo"}]

Retorne APENAS o JSON array, sem texto adicional, sem markdown, sem backticks.`
    }]
  });

  try {
    const result = await httpsPost({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'interleaved-thinking-2025-05-14',
        'Content-Length': Buffer.byteLength(payload),
      }
    }, payload);

    if (result.status !== 200) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: result.body }) };
    }

    // Extract text from content blocks
    const fullText = (result.body.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Parse JSON
    let noticias = [];
    try {
      const clean = fullText.replace(/```json|```/g, '').trim();
      const match = clean.match(/\[[\s\S]*\]/);
      if (match) noticias = JSON.parse(match[0]);
      else noticias = JSON.parse(clean);
    } catch(e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Parse failed', raw: fullText.slice(0,500) }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ noticias }) };

  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
