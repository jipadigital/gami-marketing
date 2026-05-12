// netlify/functions/send-push.js
// Envia push notification via OneSignal
// Suporta: enviar pra todos OU pra usuário específico (por player_id)

exports.handler = async function(event, context) {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { 
      statusCode: 405, 
      headers, 
      body: JSON.stringify({ error: 'Method not allowed. Use POST.' }) 
    };
  }

  // Read env vars
  const APP_ID = process.env.ONESIGNAL_APP_ID;
  const REST_KEY = process.env.ONESIGNAL_REST_API_KEY;
  
  if (!APP_ID || !REST_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'OneSignal not configured. Set ONESIGNAL_APP_ID and ONESIGNAL_REST_API_KEY env vars in Netlify.' 
      })
    };
  }

  // Parse body
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid JSON' })
    };
  }

  const { titulo, mensagem, destinatario, url, icone } = body;

  if (!titulo || !mensagem) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Faltam "titulo" e "mensagem" no body' })
    };
  }

  // Monta payload do OneSignal
  const payload = {
    app_id: APP_ID,
    headings: { en: titulo, pt: titulo },
    contents: { en: mensagem, pt: mensagem },
    url: url || 'https://gami-marketing.netlify.app',
    chrome_web_icon: icone || 'https://gami-marketing.netlify.app/icon-192.png',
    firefox_icon: icone || 'https://gami-marketing.netlify.app/icon-192.png'
  };

  // Decide destinatário
  if (destinatario === 'todos' || !destinatario) {
    // Envia pra todos os inscritos
    payload.included_segments = ['Subscribed Users'];
  } else if (typeof destinatario === 'string') {
    // Player ID específico
    payload.include_player_ids = [destinatario];
  } else if (Array.isArray(destinatario)) {
    // Array de player IDs
    payload.include_player_ids = destinatario;
  }

  // Chama API do OneSignal
  try {
    const response = await fetch('https://api.onesignal.com/notifications', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + REST_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({ 
          error: 'OneSignal returned error', 
          details: data 
        })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        success: true, 
        id: data.id, 
        recipients: data.recipients,
        external_id: data.external_id
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Erro chamando OneSignal API', 
        message: err.message 
      })
    };
  }
};
