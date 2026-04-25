const https = require('https');

const META_USER_TOKEN = process.env.META_USER_TOKEN || '';
const META_APP_ID     = process.env.META_APP_ID     || '1730617081649073';
const META_APP_SECRET = process.env.META_APP_SECRET || '';

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

// Troca token curto por token longo
async function getLongLivedToken(shortToken) {
  if (!META_APP_SECRET) return shortToken;
  const r = await httpsGet(
    `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${shortToken}`
  );
  return r.body.access_token || shortToken;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };

  const params = event.queryStringParameters || {};
  const action = params.action || 'list_accounts';

  if (!META_USER_TOKEN) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'META_USER_TOKEN não configurado' }) };
  }

  try {
    // Tenta usar token como está, se falhar tenta renovar
    let token = META_USER_TOKEN;

    if (action === 'list_accounts') {
      // Tenta com token atual
      let pages = await httpsGet(
        `https://graph.facebook.com/v19.0/me/accounts?fields=id,name,instagram_business_account{id,name,username,followers_count,media_count,profile_picture_url}&access_token=${token}`
      );

      // Se expirado e tem app secret, tenta renovar
      if (pages.body.error && META_APP_SECRET) {
        token = await getLongLivedToken(META_USER_TOKEN);
        pages = await httpsGet(
          `https://graph.facebook.com/v19.0/me/accounts?fields=id,name,instagram_business_account{id,name,username,followers_count,media_count,profile_picture_url}&access_token=${token}`
        );
      }

      if (!pages.body.data) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ 
          error: 'Token inválido ou sem páginas', 
          detail: pages.body,
          tip: 'Gere um novo token no Graph API Explorer e atualize META_USER_TOKEN no Netlify'
        })};
      }

      const contas = pages.body.data
        .filter(p => p.instagram_business_account)
        .map(p => ({
          page_id:     p.id,
          page_name:   p.name,
          ig_id:       p.instagram_business_account.id,
          ig_username: p.instagram_business_account.username,
          ig_nome:     p.instagram_business_account.name,
          seguidores:  p.instagram_business_account.followers_count || 0,
          posts:       p.instagram_business_account.media_count || 0,
          foto:        p.instagram_business_account.profile_picture_url || '',
        }));

      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ contas, total: contas.length }) };
    }

    if (action === 'conversations') {
      const igId = params.ig_id;
      if (!igId) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'ig_id obrigatório' }) };

      const pages = await httpsGet(
        `https://graph.facebook.com/v19.0/me/accounts?fields=id,access_token,instagram_business_account&access_token=${token}`
      );
      const page = (pages.body.data || []).find(p => p.instagram_business_account?.id === igId);
      const pageToken = page?.access_token || token;

      const convs = await httpsGet(
        `https://graph.facebook.com/v19.0/${igId}/conversations?fields=id,updated_time,messages{id,message,from,created_time}&access_token=${pageToken}`
      );

      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(convs.body) };
    }

    if (action === 'insights') {
      const igId = params.ig_id;
      if (!igId) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'ig_id obrigatório' }) };

      const insights = await httpsGet(
        `https://graph.facebook.com/v19.0/${igId}/insights?metric=reach,impressions,profile_views&period=day&access_token=${token}`
      );

      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(insights.body) };
    }

    // Renovar token
    if (action === 'refresh_token') {
      if (!META_APP_SECRET) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'META_APP_SECRET não configurado' }) };
      const newToken = await getLongLivedToken(META_USER_TOKEN);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ 
        access_token: newToken,
        message: 'Atualize META_USER_TOKEN no Netlify com esse token'
      })};
    }

    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'action inválida' }) };

  } catch(err) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
