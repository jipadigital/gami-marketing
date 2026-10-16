// netlify/functions/geocode.js
// Geocodifica um endereço (texto) em lat/lng usando o Nominatim (OpenStreetMap).
// Server-side pra poder mandar User-Agent certo (o browser nao deixa) e respeitar
// a politica de uso. 1 endereco por chamada; o cliente guarda o lat/lng na loja,
// entao nao re-geocodifica. Usado pela Prospecção em Campo (mapa).
// ============================================================

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

exports.handler = async function(event){
  const origin = event.headers.origin || event.headers.Origin || '';
  const cors = corsHeaders(origin);

  if(event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if(event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ ok:false, erro:'Use POST' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e){ return { statusCode: 400, headers: cors, body: JSON.stringify({ ok:false, erro:'Body inválido' }) }; }

  const q = (body.q || '').toString().trim();
  if(q.length < 4){
    return { statusCode: 400, headers: cors, body: JSON.stringify({ ok:false, erro:'Endereço muito curto' }) };
  }

  try {
    const url = 'https://nominatim.openstreetmap.org/search'
      + '?format=json&limit=1&countrycodes=br&addressdetails=0'
      + '&q=' + encodeURIComponent(q);
    const r = await fetch(url, {
      headers: {
        // Nominatim EXIGE um User-Agent identificavel (politica de uso)
        'User-Agent': 'GamiDelivery-Prospeccao/1.0 (jipadigital@gmail.com)',
        'Accept': 'application/json',
        'Accept-Language': 'pt-BR'
      }
    });
    if(!r.ok){
      return { statusCode: 502, headers: cors, body: JSON.stringify({ ok:false, erro:'Nominatim HTTP '+r.status }) };
    }
    const arr = await r.json();
    if(!Array.isArray(arr) || !arr.length){
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok:true, encontrado:false }) };
    }
    const p = arr[0];
    const lat = parseFloat(p.lat), lng = parseFloat(p.lon);
    if(isNaN(lat) || isNaN(lng)){
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok:true, encontrado:false }) };
    }
    return { statusCode: 200, headers: cors, body: JSON.stringify({
      ok:true, encontrado:true, lat:lat, lng:lng, display:(p.display_name||'').slice(0,160)
    }) };
  } catch(err){
    return { statusCode: 500, headers: cors, body: JSON.stringify({ ok:false, erro: err.message }) };
  }
};
