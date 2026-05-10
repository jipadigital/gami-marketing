// Netlify Function: upload de mídia pro Supabase Storage (bucket posts-instagram).
// O bucket precisa existir e ser PÚBLICO (criado pela UI do Supabase).
//
// Body: { filename: 'foto.jpg', contentType: 'image/jpeg', dataBase64: '...' }
// Retorna: { url: 'https://....supabase.co/storage/v1/object/public/posts-instagram/...' }

const SUPA_URL = process.env.SUPABASE_URL || 'https://tdbyzsouhrhmhpctttps.supabase.co';
const SUPA_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY || 'sb_publishable_0y-oz0aght1rNQNQrsh2tA_EfHajL61';
const BUCKET = 'posts-instagram';

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Use POST' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e){ return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'JSON inválido' }) }; }

  const { filename, contentType, dataBase64 } = body;
  if (!filename || !dataBase64) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'filename e dataBase64 são obrigatórios' }) };
  }

  // Caminho único
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '_' + safeName;

  try {
    // Decodifica base64
    const buffer = Buffer.from(dataBase64, 'base64');

    // PUT no Supabase Storage
    const url = SUPA_URL + '/storage/v1/object/' + BUCKET + '/' + path;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + SUPA_KEY,
        'apikey': SUPA_KEY,
        'Content-Type': contentType || 'application/octet-stream',
        'x-upsert': 'true',
      },
      body: buffer,
    });
    if (!r.ok) {
      const txt = await r.text();
      return { statusCode: r.status, headers: HEADERS, body: JSON.stringify({ error: 'Upload falhou', detalhe: txt.slice(0, 300) }) };
    }

    const publicUrl = SUPA_URL + '/storage/v1/object/public/' + BUCKET + '/' + path;
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ url: publicUrl, path }) };
  } catch (err) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
