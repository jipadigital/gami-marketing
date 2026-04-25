const https = require('https');

const META_USER_TOKEN = process.env.META_USER_TOKEN || '';

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    }).on('error', reject);
  });
}

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };

  const params = event.queryStringParameters || {};
  const action = params.action || 'list_accounts';
  const token  = META_USER_TOKEN;

  if (!token) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'META_USER_TOKEN não configurado' }) };
  }

  try {
    // 1. Lista todas as páginas do usuário
    if (action === 'list_accounts') {
      const pages = await httpsGet(
        `https://graph.facebook.com/v19.0/me/accounts?fields=id,name,instagram_business_account{id,name,username,followers_count,media_count,profile_picture_url}&access_token=${token}`
      );

      if (!pages.body.data) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Token inválido ou sem páginas', detail: pages.body }) };
      }

      // Filtra páginas que têm Instagram conectado
      const contas = pages.body.data
        .filter(p => p.instagram_business_account)
        .map(p => ({
          page_id:      p.id,
          page_name:    p.name,
          ig_id:        p.instagram_business_account.id,
          ig_username:  p.instagram_business_account.username,
          ig_nome:      p.instagram_business_account.name,
          seguidores:   p.instagram_business_account.followers_count || 0,
          posts:        p.instagram_business_account.media_count || 0,
          foto:         p.instagram_business_account.profile_picture_url || '',
        }));

      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ contas, total: contas.length }) };
    }

    // 2. Busca DMs de uma conta específica
    if (action === 'conversations') {
      const igId = params.ig_id;
      if (!igId) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'ig_id obrigatório' }) };

      // Pega o page access token primeiro
      const pages = await httpsGet(
        `https://graph.facebook.com/v19.0/me/accounts?fields=id,instagram_business_account&access_token=${token}`
      );
      const page = (pages.body.data || []).find(p => p.instagram_business_account?.id === igId);
      const pageToken = page ? await getPageToken(page.id, token) : token;

      const convs = await httpsGet(
        `https://graph.facebook.com/v19.0/${igId}/conversations?fields=id,updated_time,messages{id,message,from,created_time}&access_token=${pageToken}`
      );

      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(convs.body) };
    }

    // 3. Insights de uma conta
    if (action === 'insights') {
      const igId = params.ig_id;
      if (!igId) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'ig_id obrigatório' }) };

      const insights = await httpsGet(
        `https://graph.facebook.com/v19.0/${igId}/insights?metric=reach,impressions,profile_views,follower_count&period=day&access_token=${token}`
      );

      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(insights.body) };
    }

    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'action inválida' }) };

  } catch(err) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};

async function getPageToken(pageId, userToken) {
  const r = await httpsGet(`https://graph.facebook.com/v19.0/${pageId}?fields=access_token&access_token=${userToken}`);
  return r.body.access_token || userToken;
}
