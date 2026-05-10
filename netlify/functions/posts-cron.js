// Netlify Scheduled Function — roda a cada 15 minutos automaticamente.
// Verifica posts pendentes cuja hora já chegou e dispara a publicação.
//
// O schedule é definido em netlify.toml:
//   [functions."posts-cron"]
//     schedule = "*/15 * * * *"

const { schedule } = require('@netlify/functions');

// Reusa a lógica do publicador chamando ele internamente
async function callPublicar(host){
  const url = host + '/.netlify/functions/posts-publicar?cron=1';
  const r = await fetch(url, { method: 'GET' });
  return await r.json();
}

const handler = async (event) => {
  // O Netlify dispara isso periodicamente. URL "self" do site:
  const host = process.env.URL || 'https://gami-marketing.netlify.app';
  try {
    const result = await callPublicar(host);
    console.log('[posts-cron]', JSON.stringify(result));
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, ...result }),
    };
  } catch (e) {
    console.error('[posts-cron] erro:', e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

// Schedule: a cada 15 minutos
exports.handler = schedule('*/15 * * * *', handler);
