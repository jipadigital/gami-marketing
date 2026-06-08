// Netlify Function: publica um post Instagram via Graph API.
// Pode ser chamada manualmente (?id=…) ou pelo cron (?cron=1).
//
// 🆕 v2 (03/06/2026): LOCK ATÔMICO pra evitar duplicação.
// Em vez de SELECT-depois-UPDATE (race condition), usamos UPDATE-WHERE-RETURNING
// que serve como lock. Só uma execução pode marcar como 'publicando'.
//
// Fluxo Instagram Content Publishing API:
//   1) POST /{ig-user-id}/media         → cria container (recebe creation_id)
//   2) POST /{ig-user-id}/media_publish → publica usando creation_id

const META_USER_TOKEN = process.env.META_USER_TOKEN || '';
const SUPA_URL = process.env.SUPABASE_URL || '';
const SUPA_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY || '';

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};
const GRAPH = 'https://graph.facebook.com/v19.0';

function supaHeaders(){
  return { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY, 'Content-Type': 'application/json' };
}

// ⚙️ Select genérico (mantido pra compatibilidade)
async function supaSelect(query){
  const r = await fetch(SUPA_URL + '/rest/v1/posts_agendados?' + query, { headers: supaHeaders() });
  if(!r.ok) throw new Error('Supa select: ' + r.status);
  return r.json();
}

// 🔒 LOCK ATÔMICO: tenta marcar como 'publicando' SE ainda estiver 'pendente'.
// Retorna o post atualizado SE conseguiu o lock, ou null se OUTRA execução já pegou.
async function tentarLockPost(id, tentativasAtuais){
  const r = await fetch(SUPA_URL + '/rest/v1/posts_agendados?id=eq.' + encodeURIComponent(id) + '&status=eq.pendente', {
    method: 'PATCH',
    headers: Object.assign({}, supaHeaders(), { 'Prefer': 'return=representation' }),
    body: JSON.stringify({
      status: 'publicando',
      tentativas: (tentativasAtuais || 0) + 1,
      lock_em: new Date().toISOString()  // 🆕 timestamp do lock
    }),
  });
  if(!r.ok) throw new Error('Lock falhou: ' + r.status + ' ' + await r.text());
  const arr = await r.json();
  // Se arr está vazio → status já não era 'pendente' (outra execução ganhou)
  return arr.length > 0 ? arr[0] : null;
}

// Update normal (pra marcar publicado/falho depois do lock)
async function supaUpdate(id, patch){
  const r = await fetch(SUPA_URL + '/rest/v1/posts_agendados?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: Object.assign({}, supaHeaders(), { 'Prefer': 'return=representation' }),
    body: JSON.stringify(patch),
  });
  if(!r.ok) throw new Error('Supa update: ' + r.status + ' ' + await r.text());
  return r.json();
}

// ---------- Token de Página específica ----------
let _pageTokenCache = null;
let _pageTokenCacheTs = 0;
async function getPageTokens(){
  if (_pageTokenCache && (Date.now() - _pageTokenCacheTs) < 300000) return _pageTokenCache;
  const r = await fetch(GRAPH + '/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=' + META_USER_TOKEN);
  const d = await r.json();
  if (!d.data) throw new Error('Falha ao buscar páginas: ' + JSON.stringify(d.error || d));
  const map = {};
  d.data.forEach(p => {
    const igId = p.instagram_business_account && p.instagram_business_account.id;
    if (igId) map[igId] = { page_id: p.id, page_token: p.access_token, page_name: p.name };
  });
  _pageTokenCache = map; _pageTokenCacheTs = Date.now();
  return map;
}

// ---------- Cria container de mídia ----------
async function criarContainer(igId, pageToken, post){
  // 🆕 Se já tem ig_creation_id de tentativa anterior, REUSA (evita duplicar container)
  if (post.ig_creation_id) {
    console.log('[post '+post.id+'] reusando creation_id existente: ' + post.ig_creation_id);
    return post.ig_creation_id;
  }
  
  const url = GRAPH + '/' + igId + '/media';
  const params = new URLSearchParams();
  params.set('access_token', pageToken);

  if (post.legenda) params.set('caption', post.legenda);

  const midias = post.midia_urls;
  const primeiraMidia = midias[0];

  if (post.tipo === 'feed') {
    params.set('image_url', primeiraMidia);
  } else if (post.tipo === 'story') {
    params.set('media_type', 'STORIES');
    if (/\.(mp4|mov)$/i.test(primeiraMidia)) params.set('video_url', primeiraMidia);
    else params.set('image_url', primeiraMidia);
  } else if (post.tipo === 'reel') {
    params.set('media_type', 'REELS');
    params.set('video_url', primeiraMidia);
    params.set('share_to_feed', 'true');
  } else if (post.tipo === 'carousel') {
    const childIds = [];
    for (const midiaUrl of midias) {
      const subParams = new URLSearchParams();
      subParams.set('access_token', pageToken);
      subParams.set('is_carousel_item', 'true');
      if (/\.(mp4|mov)$/i.test(midiaUrl)) subParams.set('video_url', midiaUrl);
      else subParams.set('image_url', midiaUrl);
      const subR = await fetch(url, { method: 'POST', body: subParams });
      const subD = await subR.json();
      if (subD.error) throw new Error('Sub-container falhou: ' + subD.error.message);
      childIds.push(subD.id);
    }
    params.set('media_type', 'CAROUSEL');
    params.set('children', childIds.join(','));
  } else {
    throw new Error('Tipo não suportado: ' + post.tipo);
  }

  const r = await fetch(url, { method: 'POST', body: params });
  const d = await r.json();
  if (d.error) throw new Error('Container falhou: ' + d.error.message);
  return d.id;
}

// ---------- Publica container ----------
async function publicarContainer(igId, pageToken, creationId){
  const url = GRAPH + '/' + igId + '/media_publish';
  const params = new URLSearchParams();
  params.set('access_token', pageToken);
  params.set('creation_id', creationId);
  const r = await fetch(url, { method: 'POST', body: params });
  const d = await r.json();
  if (d.error) throw new Error('Publish falhou: ' + d.error.message);
  return d.id;
}

// ---------- Pega permalink ----------
async function getPermalink(postId, pageToken){
  try {
    const r = await fetch(GRAPH + '/' + postId + '?fields=permalink&access_token=' + pageToken);
    const d = await r.json();
    return d.permalink || null;
  } catch(e) { return null; }
}

// ---------- Publica UM post (já com lock garantido) ----------
async function publicarUmPost(post){
  if (!META_USER_TOKEN) throw new Error('META_USER_TOKEN não configurado');
  const tokens = await getPageTokens();
  const t = tokens[post.ig_id];
  if (!t) throw new Error('Página não encontrada pro ig_id ' + post.ig_id + ' (token sem acesso?)');

  // Parse midia_urls se veio como string
  if (typeof post.midia_urls === 'string') {
    try { post.midia_urls = JSON.parse(post.midia_urls); } catch(e){ post.midia_urls = [post.midia_urls]; }
  }

  // 1. Cria container (reusa se já tinha de tentativa anterior)
  const creationId = await criarContainer(post.ig_id, t.page_token, post);
  if (creationId !== post.ig_creation_id) {
    await supaUpdate(post.id, { ig_creation_id: creationId });
  }

  // 2. Pra reels e carrossel pode demorar processar
  if (post.tipo === 'reel' || post.tipo === 'carousel') {
    await new Promise(r => setTimeout(r, 5000));
  }

  // 3. Publica
  const igPostId = await publicarContainer(post.ig_id, t.page_token, creationId);

  // 4. Pega permalink
  const permalink = await getPermalink(igPostId, t.page_token);

  // 5. Status: publicado
  await supaUpdate(post.id, {
    status: 'publicado',
    ig_post_id: igPostId,
    ig_permalink: permalink,
    publicado_em: new Date().toISOString(),
    erro: null,
  });
  return { id: post.id, ig_post_id: igPostId, permalink };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };

  const params = event.queryStringParameters || {};

  try {
    // ===== MODO CRON =====
    if (params.cron === '1') {
      const agora = new Date().toISOString();
      // Busca pendentes (até 10)
      const pendentes = await supaSelect('select=*&status=eq.pendente&agendado_para=lte.' + encodeURIComponent(agora) + '&limit=10&order=agendado_para.asc');
      const resultados = [];
      
      for (const post of pendentes) {
        // 🔒 TENTA LOCK ATÔMICO. Se outra execução já pegou esse post, pula.
        const lockado = await tentarLockPost(post.id, post.tentativas);
        if (!lockado) {
          console.log('[cron] post ' + post.id + ' já estava sendo processado por outra execução. Pulando.');
          resultados.push({ id: post.id, skipped: true, motivo: 'lock' });
          continue;
        }
        
        try {
          const r = await publicarUmPost(lockado);
          resultados.push({ id: post.id, ok: true, ig_post_id: r.ig_post_id });
        } catch (e) {
          console.error('[cron] post ' + post.id + ' falhou:', e.message);
          await supaUpdate(post.id, { status: 'falho', erro: e.message });
          resultados.push({ id: post.id, ok: false, erro: e.message });
        }
      }
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, processados: resultados.length, resultados }) };
    }

    // ===== MODO MANUAL =====
    const id = params.id;
    if (!id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'id obrigatório (ou use ?cron=1)' }) };
    
    const lista = await supaSelect('select=*&id=eq.' + encodeURIComponent(id) + '&limit=1');
    if (!lista.length) return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'post não encontrado' }) };
    
    const post = lista[0];
    
    // 🆕 Idempotência: se já foi publicado, NÃO publica de novo
    if (post.status === 'publicado') {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, ja_publicado: true, ig_post_id: post.ig_post_id, permalink: post.ig_permalink }) };
    }
    
    // 🆕 Se está 'publicando' (outra execução em andamento), bloqueia
    if (post.status === 'publicando') {
      // Verifica se o lock é recente (< 5 minutos) — se for, sai. Se for antigo, deixa tentar de novo (lock travado)
      const lockEm = post.lock_em ? new Date(post.lock_em).getTime() : 0;
      const agora = Date.now();
      if (lockEm && (agora - lockEm) < 300000) {
        return { statusCode: 202, headers: HEADERS, body: JSON.stringify({ ok: false, em_publicacao: true, motivo: 'Outra execução em andamento (lock ativo)' }) };
      }
      console.log('[manual] post ' + id + ' tinha lock antigo (' + Math.round((agora - lockEm)/1000) + 's), liberando...');
    }
    
    // 🔒 TENTA LOCK ATÔMICO (só permite UPDATE se status era 'pendente' OU lock antigo)
    let lockado;
    if (post.status === 'pendente') {
      lockado = await tentarLockPost(id, post.tentativas);
    } else if (post.status === 'publicando' || post.status === 'falho') {
      // Permite re-tentar: força volta pra pendente + nova tentativa de lock
      await supaUpdate(id, { status: 'pendente' });
      lockado = await tentarLockPost(id, post.tentativas);
    }
    
    if (!lockado) {
      return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ ok: false, conflito: true, motivo: 'Não conseguiu obter lock — post está sendo processado em paralelo' }) };
    }

    try {
      const r = await publicarUmPost(lockado);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, ig_post_id: r.ig_post_id, permalink: r.permalink }) };
    } catch (e) {
      await supaUpdate(post.id, { status: 'falho', erro: e.message });
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ ok: false, erro: e.message }) };
    }
  } catch (err) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
