// netlify/functions/admin-reset-pin.js
// Reset de PIN por um ADMIN (super_admin) — sem link de e-mail, sem SQL manual.
// Volta a pessoa-alvo pro PIN inicial (gami2026) e destrava a conta.
// Só o super_admin (jipadigital@gmail.com), com sessão válida, pode chamar.
// ============================================================

const SUPA_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
const PIN_INICIAL_SENTINEL = 'gami2026_init';
const SUPER_ADMIN_EMAIL = 'jipadigital@gmail.com';

const ORIGENS_PERMITIDAS = [
  'https://gami-marketing.netlify.app',
  'http://localhost:8888',
  'http://localhost:3000'
];

function corsHeaders(origin){
  var permitido = ORIGENS_PERMITIDAS.indexOf(origin) >= 0 ? origin : ORIGENS_PERMITIDAS[0];
  return {
    'Access-Control-Allow-Origin': permitido,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Gami-User, X-Gami-Token',
    'Content-Type': 'application/json'
  };
}

function svcHeaders(extra){
  return Object.assign({
    'apikey': SUPA_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPA_SERVICE_KEY
  }, extra || {});
}

exports.handler = async function(event){
  const origin = event.headers.origin || event.headers.Origin || '';
  const cors = corsHeaders(origin);

  if(event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if(event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ ok:false, erro:'Use POST' }) };

  if(!SUPA_SERVICE_KEY){
    return { statusCode: 500, headers: cors, body: JSON.stringify({ ok:false, erro:'Servidor sem SUPA_SERVICE_KEY' }) };
  }

  // Identidade do chamador (headers de sessão, iguais ao supabase-write)
  const callerId = event.headers['x-gami-user'] || event.headers['X-Gami-User'] || '';
  const callerToken = event.headers['x-gami-token'] || event.headers['X-Gami-Token'] || '';

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e){ return { statusCode: 400, headers: cors, body: JSON.stringify({ ok:false, erro:'Body inválido' }) }; }

  const alvoUsername = (body.alvo_username || '').trim();
  const alvoPessoaId = (body.alvo_pessoa_id || '').trim();
  if(!alvoUsername && !alvoPessoaId){
    return { statusCode: 400, headers: cors, body: JSON.stringify({ ok:false, erro:'Informe alvo_username ou alvo_pessoa_id' }) };
  }
  if(!callerId){
    return { statusCode: 401, headers: cors, body: JSON.stringify({ ok:false, erro:'Sessão não informada' }) };
  }

  try {
    // 1) Valida o chamador: sessão ativa + token + é super_admin (jipadigital)
    const rC = await fetch(SUPA_URL + '/rest/v1/usuarios_login?pessoa_id=eq.' + encodeURIComponent(callerId) + '&select=pessoa_id,nome,email,token_atual,token_expira_em,ativo&limit=1', {
      headers: svcHeaders()
    });
    if(!rC.ok) return { statusCode: 500, headers: cors, body: JSON.stringify({ ok:false, erro:'Falha ao validar sessão' }) };
    const arrC = await rC.json();
    if(!Array.isArray(arrC) || !arrC.length){
      return { statusCode: 401, headers: cors, body: JSON.stringify({ ok:false, erro:'Sessão não encontrada' }) };
    }
    const caller = arrC[0];

    if(caller.ativo === false){
      return { statusCode: 403, headers: cors, body: JSON.stringify({ ok:false, erro:'Usuário desativado' }) };
    }
    if(!caller.token_atual || caller.token_atual !== callerToken){
      return { statusCode: 401, headers: cors, body: JSON.stringify({ ok:false, erro:'Token inválido (faça login de novo)' }) };
    }
    if(caller.token_expira_em && new Date(caller.token_expira_em) < new Date()){
      return { statusCode: 401, headers: cors, body: JSON.stringify({ ok:false, erro:'Sessão expirada (faça login de novo)' }) };
    }
    if(String(caller.email || '').toLowerCase() !== SUPER_ADMIN_EMAIL){
      return { statusCode: 403, headers: cors, body: JSON.stringify({ ok:false, erro:'Apenas o administrador pode resetar PINs' }) };
    }

    // 2) Localiza o alvo
    const filtroAlvo = alvoPessoaId
      ? 'pessoa_id=eq.' + encodeURIComponent(alvoPessoaId)
      : 'username=ilike.' + encodeURIComponent(alvoUsername);
    const rA = await fetch(SUPA_URL + '/rest/v1/usuarios_login?' + filtroAlvo + '&select=pessoa_id,nome,email,username&limit=1', {
      headers: svcHeaders()
    });
    const arrA = await rA.json();
    if(!Array.isArray(arrA) || !arrA.length){
      return { statusCode: 404, headers: cors, body: JSON.stringify({ ok:false, erro:'Pessoa não encontrada no login' }) };
    }
    const alvo = arrA[0];

    // 3) Reseta pro PIN inicial + destrava
    const rU = await fetch(SUPA_URL + '/rest/v1/usuarios_login?pessoa_id=eq.' + encodeURIComponent(alvo.pessoa_id), {
      method: 'PATCH',
      headers: svcHeaders({ 'Content-Type':'application/json', 'Prefer':'return=minimal' }),
      body: JSON.stringify({
        pin_hash: PIN_INICIAL_SENTINEL,
        pin_trocado: false,
        bloqueado_ate: null,
        tentativas_falhas: 0,
        token_atual: null,
        updated_at: new Date().toISOString()
      })
    });
    if(!rU.ok){
      const txt = await rU.text().catch(function(){ return ''; });
      return { statusCode: 500, headers: cors, body: JSON.stringify({ ok:false, erro:'Falha ao resetar: ' + txt.substring(0,200) }) };
    }

    // 4) Auditoria (não bloqueia)
    try {
      await fetch(SUPA_URL + '/rest/v1/audit_log', {
        method: 'POST',
        headers: svcHeaders({ 'Content-Type':'application/json', 'Prefer':'return=minimal' }),
        body: JSON.stringify([{
          pessoa_id: caller.pessoa_id,
          pessoa_nome: caller.nome,
          acao: 'reset_pin_admin',
          recurso: 'usuarios_login',
          detalhes: 'Resetou PIN de ' + (alvo.nome || alvo.username || alvo.pessoa_id)
        }])
      });
    } catch(e){}

    return { statusCode: 200, headers: cors, body: JSON.stringify({
      ok: true,
      nome: alvo.nome,
      username: alvo.username,
      email: alvo.email,
      message: 'PIN resetado para gami2026. A pessoa cria um novo no próximo acesso.'
    }) };

  } catch(err){
    console.error('[admin-reset-pin]', err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ ok:false, erro: err.message }) };
  }
};
