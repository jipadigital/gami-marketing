// netlify/functions/push-enviar.js
// -----------------------------------------------------------------------------
// Dispara PUSH de compromisso mesmo com o app FECHADO.
// Lê push_agendados vencidos (quando <= agora, enviado=false), acha a inscrição
// da pessoa em push_subscriptions e manda o web-push (VAPID). Marca enviado.
//
// Roda de minuto em minuto (schedule) OU via HTTP p/ teste (enquanto sem schedule).
// Env necessárias no Netlify: SUPA_SERVICE_KEY, VAPID_PUBLIC, VAPID_PRIVATE,
//   VAPID_SUBJECT (opcional, default mailto:jipadigital@gmail.com).
// -----------------------------------------------------------------------------

const webpush = require('web-push');

const SUPA_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
const SVC = process.env.SUPA_SERVICE_KEY;

function sh(){ return { 'apikey': SVC, 'Authorization': 'Bearer ' + SVC, 'Content-Type': 'application/json' }; }

async function processar(){
  if(!SVC) return { ok:false, error:'SUPA_SERVICE_KEY ausente' };
  if(!process.env.VAPID_PUBLIC || !process.env.VAPID_PRIVATE) return { ok:false, error:'VAPID_PUBLIC/PRIVATE ausentes' };
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:jipadigital@gmail.com', process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);

  var agora = new Date().toISOString();
  // 1) avisos vencidos e ainda não enviados
  var r = await fetch(SUPA_URL + '/rest/v1/push_agendados?enviado=eq.false&quando=lte.' + encodeURIComponent(agora) + '&select=id,pessoa_id,titulo,quando,tipo&order=quando.asc&limit=300', { headers: sh() });
  if(!r.ok) return { ok:false, error:'ler push_agendados HTTP '+r.status };
  var pend = await r.json();
  if(!Array.isArray(pend) || !pend.length){ await limpar(); return { ok:true, enviados:0, nada:true }; }

  // 2) cache de inscrições por pessoa
  var subsCache = {};
  async function subsDe(pid){
    if(subsCache[pid]) return subsCache[pid];
    var rs = await fetch(SUPA_URL + '/rest/v1/push_subscriptions?pessoa_id=eq.' + encodeURIComponent(pid) + '&select=id,endpoint,p256dh,auth', { headers: sh() });
    subsCache[pid] = rs.ok ? await rs.json() : [];
    return subsCache[pid];
  }

  var enviados = 0, falhas = 0;
  for(var i=0; i<pend.length; i++){
    var a = pend[i];
    var subs = await subsDe(a.pessoa_id);
    var quando = a.tipo === 'pre' ? 'em ~10 min' : 'agora';
    var payload = JSON.stringify({ title: '⏰ Compromisso Gâmi', body: quando + ' · ' + a.titulo, tag: 'gami-ag-' + a.id });
    for(var j=0; j<subs.length; j++){
      var s = subs[j];
      var sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
      try {
        await webpush.sendNotification(sub, payload);
        enviados++;
      } catch(err){
        falhas++;
        // inscrição expirada/inválida → remove
        if(err && (err.statusCode === 404 || err.statusCode === 410)){
          try { await fetch(SUPA_URL + '/rest/v1/push_subscriptions?id=eq.' + s.id, { method:'DELETE', headers: sh() }); } catch(e){}
        }
      }
    }
    // marca como enviado (mesmo sem inscrição, pra não reprocessar eternamente)
    try { await fetch(SUPA_URL + '/rest/v1/push_agendados?id=eq.' + a.id, { method:'PATCH', headers: Object.assign(sh(), {'Prefer':'return=minimal'}), body: JSON.stringify({ enviado: true }) }); } catch(e){}
  }
  await limpar();
  return { ok:true, processados: pend.length, enviados: enviados, falhas: falhas };
}

// remove agendados antigos (>2 dias) pra não crescer
async function limpar(){
  try {
    var corte = new Date(Date.now() - 2*24*60*60*1000).toISOString();
    await fetch(SUPA_URL + '/rest/v1/push_agendados?quando=lt.' + encodeURIComponent(corte), { method:'DELETE', headers: Object.assign(sh(), {'Prefer':'return=minimal'}) });
  } catch(e){}
}

exports.handler = async function(){
  try {
    var res = await processar();
    return { statusCode: res.ok ? 200 : 500, body: JSON.stringify(res) };
  } catch(e){
    return { statusCode: 500, body: JSON.stringify({ ok:false, error: String(e && e.message || e) }) };
  }
};

// SCHEDULE desligado por ora (pra permitir teste via HTTP). Depois de validar,
// ligar: exports.config = { schedule: '* * * * *' };  (roda a cada minuto)
