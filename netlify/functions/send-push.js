// Netlify Function: envia push notification via Web Push API
// Endpoint: /.netlify/functions/send-push
// 
// Body (POST):
// {
//   "pessoa_ids": ["id1", "id2"],   // ou
//   "pessoa_id": "id_unico",
//   "titulo": "Nova tarefa de Cleyton",
//   "mensagem": "Postar 3 stories sobre..." ,
//   "tipo": "tarefa_nova",            // opcional
//   "url": "/?aba=tarefas"            // opcional
// }

const webpush = require('web-push');

const SUPA_URL = process.env.SUPABASE_URL || 'https://tdbyzsouhrhmhpctttps.supabase.co';
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:jipadigital@gmail.com';

if(VAPID_PUBLIC && VAPID_PRIVATE){
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

exports.handler = async function(event){
  // CORS
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if(event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors };
  if(event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Use POST' };
  
  if(!VAPID_PUBLIC || !VAPID_PRIVATE){
    return { statusCode: 500, headers: cors, body: JSON.stringify({ erro: 'VAPID não configurado nas env vars' }) };
  }
  
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e){ return { statusCode: 400, headers: cors, body: 'JSON inválido' }; }
  
  const titulo = body.titulo || 'Notificação Gâmi';
  const mensagem = body.mensagem || '';
  const tipo = body.tipo || 'geral';
  const url = body.url || '/';
  
  // Coleta IDs de destinatários
  let pessoaIds = [];
  if(Array.isArray(body.pessoa_ids)) pessoaIds = body.pessoa_ids;
  else if(body.pessoa_id) pessoaIds = [body.pessoa_id];
  
  if(!pessoaIds.length){
    return { statusCode: 400, headers: cors, body: 'pessoa_id ou pessoa_ids obrigatório' };
  }
  
  // Busca subscriptions ativas dessas pessoas
  const queryIds = pessoaIds.map(id => `"${id}"`).join(',');
  const supaResp = await fetch(SUPA_URL + '/rest/v1/push_subscriptions?ativa=eq.true&pessoa_id=in.(' + encodeURIComponent(pessoaIds.map(id=>'"'+id+'"').join(',')) + ')&select=id,pessoa_id,subscription_json', {
    headers: { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY }
  });
  
  if(!supaResp.ok){
    const t = await supaResp.text();
    return { statusCode: 500, headers: cors, body: JSON.stringify({ erro: 'Supabase HTTP ' + supaResp.status, detalhe: t }) };
  }
  
  const subs = await supaResp.json();
  
  if(!subs.length){
    return { statusCode: 200, headers: cors, body: JSON.stringify({ enviados: 0, motivo: 'Nenhuma subscription ativa' }) };
  }
  
  const payload = JSON.stringify({
    titulo: titulo,
    mensagem: mensagem,
    tipo: tipo,
    url: url,
    ts: Date.now()
  });
  
  let enviados = 0, falhas = 0, invalidadas = [];
  
  await Promise.all(subs.map(async function(sub){
    try {
      const sObj = typeof sub.subscription_json === 'string' ? JSON.parse(sub.subscription_json) : sub.subscription_json;
      await webpush.sendNotification(sObj, payload, { TTL: 60 * 60 * 24 });
      enviados++;
    } catch(err){
      falhas++;
      // 410 Gone ou 404 = subscription expirou. Marca como inativa.
      if(err && (err.statusCode === 410 || err.statusCode === 404)){
        invalidadas.push(sub.id);
      }
    }
  }));
  
  // Desativa subscriptions inválidas
  if(invalidadas.length > 0){
    try {
      await fetch(SUPA_URL + '/rest/v1/push_subscriptions?id=in.(' + invalidadas.join(',') + ')', {
        method: 'PATCH',
        headers: { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ativa: false })
      });
    } catch(e){}
  }
  
  return {
    statusCode: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enviados, falhas, invalidadas: invalidadas.length })
  };
};
