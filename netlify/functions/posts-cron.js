// Netlify Scheduled Function — roda a cada 15 minutos automaticamente.
// Verifica posts pendentes cuja hora já chegou e dispara a publicação.
//
// O schedule está definido em netlify.toml:
//   [functions."posts-cron"]
//     schedule = "*/15 * * * *"
//
// (não importamos '@netlify/functions' aqui pra evitar dependência;
//  o Netlify dispara handlers normais quando vê schedule no toml)

async function callPublicar(host){
  const url = host + '/.netlify/functions/posts-publicar?cron=1';
  const r = await fetch(url, { method: 'GET' });
  return await r.json();
}

exports.handler = async (event) => {
  const host = process.env.URL || 'https://gami-marketing.netlify.app';
  try {
    const result = await callPublicar(host);
    console.log('[posts-cron]', JSON.stringify(result));
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
  } catch (e) {
    console.error('[posts-cron] erro:', e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
