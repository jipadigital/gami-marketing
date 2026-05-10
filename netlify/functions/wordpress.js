// Netlify Function: proxy seguro para o WordPress da Gâmi (gamidelivery.com.br)
//
// Por que precisa de proxy?
//   O WordPress geralmente rejeita Authorization Basic vindo do navegador
//   (CORS + segurança), então fazer fetch direto do dashboard falha.
//   Esta function recebe a chamada do front e a repassa server-side,
//   colocando o header Authorization a partir de credenciais (Application
//   Password) enviadas pelo próprio cliente OU lidas das env vars do Netlify.
//
// USO PELO FRONTEND:
//   POST /.netlify/functions/wordpress
//   Body: {
//     action: 'test' | 'list' | 'create',
//     url:    'https://www.gamidelivery.com.br',  // opcional se WP_BASE_URL setado
//     user:   '<usuario WP>',                      // opcional se WP_USER setado
//     pass:   '<application password>',            // opcional se WP_APP_PASSWORD setado
//     post:   { title, content, status, slug, tags } // só pra action=create
//   }
//
// VARIÁVEIS DE AMBIENTE (Netlify) — todas opcionais (front pode mandar):
//   WP_BASE_URL       https://www.gamidelivery.com.br
//   WP_USER           <usuario WP>
//   WP_APP_PASSWORD   <Application Password gerada no WP>

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function authHeader(user, pass){
  return 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
}

async function wpFetch(url, opts){
  const r = await fetch(url, opts);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); }
  catch(e){ body = { raw: text.slice(0, 600) }; }
  return { status: r.status, ok: r.ok, body };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Use POST' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e){ return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const action = body.action || 'test';
  const baseUrl = (body.url || process.env.WP_BASE_URL || '').replace(/\/$/, '');
  const user    = body.user || process.env.WP_USER || '';
  const pass    = body.pass || process.env.WP_APP_PASSWORD || '';

  if (!baseUrl || !user || !pass) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({
        error: 'Credenciais incompletas',
        hint: 'Configure WP_BASE_URL, WP_USER e WP_APP_PASSWORD no Netlify ou envie url/user/pass no body.',
        missing: { url: !baseUrl, user: !user, pass: !pass },
      }),
    };
  }

  const auth = authHeader(user, pass);

  try {
    // ---------- ACTION: test ----------
    // GET /wp-json/wp/v2/users/me — confirma que credenciais funcionam
    if (action === 'test') {
      const r = await wpFetch(baseUrl + '/wp-json/wp/v2/users/me?context=edit', {
        headers: { 'Authorization': auth },
      });
      if (!r.ok) {
        return {
          statusCode: r.status,
          headers: HEADERS,
          body: JSON.stringify({
            success: false,
            error: r.body?.message || ('HTTP ' + r.status),
            wp_code: r.body?.code || null,
            hint: r.status === 401
              ? 'Verifique se está usando uma Application Password (não a senha normal). Gere em Usuários → Perfil → Senhas de aplicativo no wp-admin.'
              : (r.status === 404 ? 'Endpoint /wp-json/wp/v2/users/me não encontrado. O REST API está habilitado?' : null),
          }),
        };
      }
      // Pega também 5 posts recentes pra mostrar na UI
      const posts = await wpFetch(baseUrl + '/wp-json/wp/v2/posts?per_page=5&_fields=id,title,status,date,link', {
        headers: { 'Authorization': auth },
      });
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({
          success: true,
          user: { id: r.body.id, name: r.body.name, slug: r.body.slug, roles: r.body.roles },
          recent_posts: Array.isArray(posts.body) ? posts.body : [],
        }),
      };
    }

    // ---------- ACTION: list ----------
    if (action === 'list') {
      const per = body.per_page || 10;
      const r = await wpFetch(baseUrl + '/wp-json/wp/v2/posts?per_page=' + per + '&_fields=id,title,status,date,link', {
        headers: { 'Authorization': auth },
      });
      return { statusCode: r.status, headers: HEADERS, body: JSON.stringify(r.body) };
    }

    // ---------- ACTION: create ----------
    if (action === 'create') {
      const post = body.post || {};
      if (!post.title || !post.content) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'post.title e post.content são obrigatórios' }) };
      }
      const payload = {
        title: post.title,
        content: post.content,
        status: post.status || 'draft',
        slug: post.slug || undefined,
      };
      const r = await wpFetch(baseUrl + '/wp-json/wp/v2/posts', {
        method: 'POST',
        headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        return {
          statusCode: r.status,
          headers: HEADERS,
          body: JSON.stringify({
            success: false,
            error: r.body?.message || ('HTTP ' + r.status),
            wp_code: r.body?.code || null,
          }),
        };
      }
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({
          success: true,
          id: r.body.id,
          link: r.body.link,
          status: r.body.status,
        }),
      };
    }

    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'action inválida (use test|list|create)' }) };

  } catch (err) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
