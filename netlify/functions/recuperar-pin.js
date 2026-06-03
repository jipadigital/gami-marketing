// netlify/functions/recuperar-pin.js
// Envia email com link de recuperação de PIN
// Usa Resend.com (3000 emails/mês grátis)
// ============================================================

const SUPA_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const APP_URL = 'https://gami-marketing.netlify.app';

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
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
}

function gerarToken(){
  // 32 caracteres aleatórios
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for(let i=0; i<32; i++) token += chars[Math.floor(Math.random() * chars.length)];
  return token;
}

exports.handler = async function(event){
  const origin = event.headers.origin || event.headers.Origin || '';
  const cors = corsHeaders(origin);
  
  if(event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if(event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({error:'Use POST'}) };
  
  if(!RESEND_API_KEY){
    console.error('RESEND_API_KEY não configurada');
    return { statusCode: 500, headers: cors, body: JSON.stringify({error:'Servidor de email não configurado (avise o admin)'}) };
  }
  
  let body;
  try { body = JSON.parse(event.body); }
  catch(e){ return { statusCode: 400, headers: cors, body: JSON.stringify({error:'Body inválido'}) }; }
  
  const email = (body.email || '').toLowerCase().trim();
  if(!email || !email.includes('@')){
    return { statusCode: 400, headers: cors, body: JSON.stringify({error:'Email inválido'}) };
  }
  
  try {
    // 1) Verifica se o email existe em usuarios_login
    const r = await fetch(SUPA_URL+'/rest/v1/usuarios_login?email=eq.'+encodeURIComponent(email)+'&select=pessoa_id,nome,email,ativo&limit=1', {
      headers: { 'apikey': SUPA_SERVICE_KEY, 'Authorization': 'Bearer '+SUPA_SERVICE_KEY }
    });
    const arr = await r.json();
    
    // Resposta genérica pra não revelar se email existe ou não (segurança)
    const respostaOk = { statusCode: 200, headers: cors, body: JSON.stringify({
      ok: true, 
      message: 'Se o email estiver cadastrado, você receberá instruções em alguns instantes.'
    }) };
    
    if(!Array.isArray(arr) || arr.length === 0) return respostaOk;
    
    const usuario = arr[0];
    if(!usuario.ativo) return respostaOk;
    
    // 2) Gera token válido por 1 hora
    const token = gerarToken();
    const expiraEm = new Date(Date.now() + 60*60*1000).toISOString(); // 1 hora
    
    // 3) Salva token em usuarios_login
    await fetch(SUPA_URL+'/rest/v1/usuarios_login?pessoa_id=eq.'+encodeURIComponent(usuario.pessoa_id), {
      method: 'PATCH',
      headers: {
        'apikey': SUPA_SERVICE_KEY,
        'Authorization': 'Bearer '+SUPA_SERVICE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        token_recuperacao: token,
        token_recuperacao_exp: expiraEm
      })
    });
    
    // 4) Monta link de recuperação
    const linkReset = APP_URL+'/?reset_pin='+token+'&email='+encodeURIComponent(email);
    
    // 5) Envia email via Resend
    const emailHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Recuperar PIN — Dashboard Gâmi</title></head>
<body style="font-family:-apple-system,Segoe UI,sans-serif;background:#F5F7FA;padding:24px;margin:0">
  <div style="max-width:560px;margin:0 auto;background:white;border-radius:12px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,0.06)">
    <div style="text-align:center;margin-bottom:24px">
      <div style="font-size:28px;font-weight:800;color:#0B2542;font-family:Syne,sans-serif">Gâmi Dashboard</div>
    </div>
    
    <h2 style="color:#0B2542;font-size:18px;margin:0 0 12px">Olá, ${usuario.nome}!</h2>
    
    <p style="color:#56627a;font-size:14px;line-height:1.6;margin:0 0 18px">
      Recebemos uma solicitação para recuperar seu PIN do Dashboard Gâmi.
    </p>
    
    <p style="color:#56627a;font-size:14px;line-height:1.6;margin:0 0 24px">
      Clique no botão abaixo para criar um novo PIN. <strong>O link expira em 1 hora.</strong>
    </p>
    
    <div style="text-align:center;margin:28px 0">
      <a href="${linkReset}" style="display:inline-block;padding:14px 32px;background:#1D9E75;color:white;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px">
        🔐 Criar novo PIN
      </a>
    </div>
    
    <p style="color:#56627a;font-size:12px;line-height:1.6;margin:24px 0 0;padding-top:18px;border-top:1px solid #E5E7EB">
      Se não foi você que solicitou, ignore este email. Seu PIN atual continua válido.
    </p>
    
    <p style="color:#999;font-size:11px;margin:18px 0 0;word-break:break-all">
      Link direto: ${linkReset}
    </p>
  </div>
  
  <p style="text-align:center;color:#999;font-size:11px;margin:18px 0 0">
    Gâmi Delivery · Dashboard interno
  </p>
</body></html>`;
    
    const resendResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer '+RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Gâmi Dashboard <onboarding@resend.dev>',
        to: [email],
        subject: '🔐 Recuperar PIN — Dashboard Gâmi',
        html: emailHtml
      })
    });
    
    if(!resendResp.ok){
      const errTxt = await resendResp.text();
      console.error('Resend erro:', errTxt);
      return { statusCode: 500, headers: cors, body: JSON.stringify({error:'Erro ao enviar email. Avise o admin.'}) };
    }
    
    return respostaOk;
    
  } catch(err){
    console.error('[recuperar-pin]', err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({error: err.message}) };
  }
};
