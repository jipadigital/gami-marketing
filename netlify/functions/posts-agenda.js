// Netlify Function: CRUD do agendamento de posts Instagram.
// Endpoints (via query param ?action=…):
//   ?action=listar[&status=…&cidade=…]   — GET, retorna posts
//   ?action=criar                         — POST body com dados do post
//   ?action=cancelar&id=…                 — POST cancela agendamento
//   ?action=republicar&id=…               — POST volta status pra pendente
//   ?action=apagar&id=…                   — DELETE

const SUPA_URL  = process.env.SUPABASE_URL  || 'https://tdbyzsouhrhmhpctttps.supabase.co';
const SUPA_KEY  = process.env.SUPABASE_KEY  || process.env.SUPABASE_SERVICE_KEY || 'sb_publishable_0y-oz0aght1rNQNQrsh2tA_EfHajL61';

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function supaHeaders(){
  return { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY, 'Content-Type': 'application/json' };
}

async function supaSelect(query){
  const r = await fetch(SUPA_URL + '/rest/v1/posts_agendados?' + query, { headers: supaHeaders() });
  if(!r.ok) throw new Error('Supa select: ' + r.status + ' ' + await r.text());
  return r.json();
}
async function supaInsert(row){
  const r = await fetch(SUPA_URL + '/rest/v1/posts_agendados', {
    method: 'POST',
    headers: Object.assign({}, supaHeaders(), { 'Prefer': 'return=representation' }),
    body: JSON.stringify(row),
  });
  if(!r.ok) throw new Error('Supa insert: ' + r.status + ' ' + await r.text());
  return r.json();
}
async function supaUpdate(id, patch){
  const r = await fetch(SUPA_URL + '/rest/v1/posts_agendados?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: Object.assign({}, supaHeaders(), { 'Prefer': 'return=representation' }),
    body: JSON.stringify(patch),
  });
  if(!r.ok) throw new Error('Supa update: ' + r.status + ' ' + await r.text());
  return r.json();
}
async function supaDelete(id){
  const r = await fetch(SUPA_URL + '/rest/v1/posts_agendados?id=eq.' + encodeURIComponent(id), {
    method: 'DELETE',
    headers: supaHeaders(),
  });
  if(!r.ok) throw new Error('Supa delete: ' + r.status + ' ' + await r.text());
  return { ok: true };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };

  const params = event.queryStringParameters || {};
  const action = params.action || 'listar';

  try {
    // ---------- LISTAR ----------
    if (action === 'listar') {
      const filtros = ['select=*', 'order=agendado_para.desc'];
      if (params.status)    filtros.push('status=eq.' + encodeURIComponent(params.status));
      if (params.cidade)    filtros.push('cidade_id=eq.' + encodeURIComponent(params.cidade));
      if (params.desde)     filtros.push('agendado_para=gte.' + encodeURIComponent(params.desde));
      if (params.ate)       filtros.push('agendado_para=lte.' + encodeURIComponent(params.ate));
      if (params.limite)    filtros.push('limit=' + parseInt(params.limite));
      const data = await supaSelect(filtros.join('&'));
      // Parse midia_urls (text com JSON) → array
      const out = data.map(p => ({ ...p, midia_urls: safeParse(p.midia_urls) }));
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ posts: out, total: out.length }) };
    }

    // ---------- CRIAR ----------
    if (action === 'criar') {
      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch(e){ return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'JSON inválido' }) }; }

      const obrig = ['ig_id', 'tipo', 'midia_urls', 'agendado_para'];
      for (const k of obrig) {
        if (!body[k]) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Falta campo: ' + k }) };
      }
      const tipos = ['feed', 'story', 'reel', 'carousel'];
      if (tipos.indexOf(body.tipo) < 0) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'tipo inválido (use ' + tipos.join('|') + ')' }) };
      }
      const id = body.id || ('pa_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
      const midiasStr = Array.isArray(body.midia_urls) ? JSON.stringify(body.midia_urls) : body.midia_urls;

      const row = {
        id,
        cidade_id:    body.cidade_id || null,
        cidade_nome:  body.cidade_nome || null,
        ig_id:        body.ig_id,
        ig_username:  body.ig_username || null,
        tipo:         body.tipo,
        midia_urls:   midiasStr,
        legenda:      body.legenda || '',
        agendado_para: body.agendado_para,
        status:       'pendente',
        criado_por:   body.criado_por || 'dashboard',
      };
      const inserted = await supaInsert(row);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, post: inserted[0] }) };
    }

    // ---------- CANCELAR ----------
    if (action === 'cancelar') {
      const id = params.id;
      if (!id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'id obrigatório' }) };
      const updated = await supaUpdate(id, { status: 'cancelado' });
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, post: updated[0] }) };
    }

    // ---------- REPUBLICAR ----------
    if (action === 'republicar') {
      const id = params.id;
      if (!id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'id obrigatório' }) };
      const updated = await supaUpdate(id, { status: 'pendente', erro: null, tentativas: 0 });
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, post: updated[0] }) };
    }

    // ---------- APAGAR ----------
    if (action === 'apagar') {
      const id = params.id;
      if (!id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'id obrigatório' }) };
      await supaDelete(id);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'action inválida' }) };
  } catch (err) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};

function safeParse(s){
  if (!s) return [];
  if (Array.isArray(s)) return s;
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch(e){ return []; }
}
