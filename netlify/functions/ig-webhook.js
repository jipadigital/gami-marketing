// Netlify Function: Robô de atendimento do Instagram DM da Gâmi (FAQ)
// ---------------------------------------------------------------------
// Recebe mensagens diretas (webhook da Meta), gera uma resposta de FAQ
// com a IA (Claude) e responde pelo próprio Instagram.
//
// REGRAS DE OURO:
//   • NUNCA fala preço/valor de entrega, taxa ou quanto o entregador ganha.
//   • Só responde dúvidas frequentes. Fora disso, passa pra um humano.
//
// GET  -> verificação do webhook (hub.challenge)
// POST -> evento de mensagem recebida
//
// ENV (Netlify):
//   META_VERIFY_TOKEN   token que VOCÊ inventa e repete no painel da Meta
//   META_USER_TOKEN     (já existe) token com permissão de mensagens
//   ANTHROPIC_API_KEY   (já existe) IA
//   IG_BOT_ATIVO        'true' pra ligar o robô (default desligado = seguro)

const https = require('https');

const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'gami-atende-2026';
const META_USER_TOKEN   = process.env.META_USER_TOKEN || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const BOT_ATIVO         = String(process.env.IG_BOT_ATIVO || 'false') === 'true';
const MODELO            = 'claude-haiku-4-5-20251001';

// ====================== BASE DE CONHECIMENTO (FAQ) ======================
// Edite aqui o que o robô sabe. NADA de preço.
const FAQ = `
VOCÊ é o atendimento virtual da Gâmi Delivery no Instagram. Fale em português do Brasil, tom amigável e direto, curtinho (2 a 4 frases), pode usar 1 ou 2 emojis.

SOBRE A GÂMI:
- Logística de entregas sob demanda. "Você pede, a Gâmi entrega."
- Conecta empresas (lojas, restaurantes, farmácias) a entregadores parceiros.
- Presente em várias cidades do Nordeste.

PARA EMPRESAS:
- Tem um time de entregadores à disposição, sem precisar de frota própria.
- Cadastro simples e rápido, sem contrato de adesão e sem vínculo trabalhista.
- Rastreamento em tempo real e rotas otimizadas.
- Para cadastrar a empresa: a pessoa manda o nome da loja e a cidade que a gente encaminha pro time comercial.

PARA ENTREGADORES:
- Trabalha no seu tempo, com liberdade de horário.
- Ganha por entrega realizada e tem saque diário.
- O cadastro é feito pelo aplicativo da Gâmi.

COMO RESPONDER:
- Responda só dúvidas frequentes (o que é, como funciona, como cadastrar, cidades, como ser entregador).
- Se não souber, ou se for assunto sensível (reclamação, problema com entrega, financeiro, fechar contrato, suporte específico), responda exatamente: "Já anotei aqui e um atendente da Gâmi te responde por este chat em breve 💛"

REGRA ABSOLUTA — PREÇO:
- NUNCA diga valores, preços, taxas, porcentagens, "quanto custa", "quanto paga por entrega" ou qualquer número de dinheiro.
- Se perguntarem sobre preço/valor/taxa/quanto ganha, responda exatamente: "Sobre valores, um atendente da Gâmi te passa certinho por aqui 💛 Posso te ajudar com mais alguma dúvida?"
- Nunca invente informação que não está aqui.
`;

const HEADERS = { 'Content-Type': 'application/json' };

function httpsGet(url){
  return new Promise((resolve, reject) => {
    https.get(url, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve({status:res.statusCode,body:JSON.parse(d)});}catch(e){resolve({status:res.statusCode,body:d});} }); }).on('error', reject);
  });
}
function httpsPost(hostname, path, payloadObj, extraHeaders){
  const payload = JSON.stringify(payloadObj);
  return new Promise((resolve) => {
    const req = https.request({ hostname, path, method:'POST',
      headers: Object.assign({ 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(payload) }, extraHeaders||{}) },
      (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve({status:res.statusCode,body:JSON.parse(d)});}catch(e){resolve({status:res.statusCode,body:d});} }); });
    req.on('error', (e)=>resolve({status:0,body:{error:e.message}}));
    req.write(payload); req.end();
  });
}

// Gera a resposta de FAQ com a IA
async function gerarResposta(texto){
  if(!ANTHROPIC_API_KEY) return null;
  const prompt = FAQ + '\n\n----\nMensagem do cliente: "' + String(texto).slice(0,800) + '"\n\nResponda APENAS com o texto da resposta, nada mais.';
  const r = await httpsPost('api.anthropic.com', '/v1/messages', {
    model: MODELO, max_tokens: 300, messages: [{ role:'user', content: prompt }]
  }, { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' });
  try {
    const txt = (r.body.content || []).map(b => b.text || '').join('').trim();
    return txt || null;
  } catch(e){ return null; }
}

// Descobre o page token da conta que recebeu a mensagem
async function getPageToken(entryId){
  const pages = await httpsGet(`https://graph.facebook.com/v19.0/me/accounts?fields=id,access_token,instagram_business_account{id}&access_token=${META_USER_TOKEN}`);
  const list = (pages.body && pages.body.data) || [];
  const page = list.find(p => p.id === entryId || (p.instagram_business_account && p.instagram_business_account.id === entryId)) || list[0];
  return page ? { id: page.id, token: page.access_token || META_USER_TOKEN } : null;
}

// Envia a resposta pelo Instagram (Messenger Platform)
async function enviar(pageId, pageToken, recipientId, texto){
  return httpsPost('graph.facebook.com', `/v19.0/${pageId}/messages?access_token=${encodeURIComponent(pageToken)}`, {
    recipient: { id: recipientId },
    message: { text: texto },
    messaging_type: 'RESPONSE'
  });
}

exports.handler = async (event) => {
  // ---------- Verificação do webhook (GET) ----------
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === META_VERIFY_TOKEN) {
      return { statusCode: 200, body: q['hub.challenge'] || '' };
    }
    return { statusCode: 403, body: 'forbidden' };
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: HEADERS, body: 'method' };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch(e){ return { statusCode: 200, body: 'ok' }; }

  // Sempre responde 200 rápido pra Meta não reenviar. Processa o que der.
  try {
    const entries = body.entry || [];
    for (const entry of entries) {
      const msgs = entry.messaging || [];
      for (const m of msgs) {
        const texto = m.message && m.message.text;
        const isEcho = m.message && m.message.is_echo;
        const senderId = m.sender && m.sender.id;
        if (isEcho || !texto || !senderId) continue;            // só mensagem de texto do cliente
        if (!BOT_ATIVO) continue;                               // robô desligado: só registra, não responde

        const resposta = await gerarResposta(texto);
        if (!resposta) continue;

        const page = await getPageToken(entry.id);
        if (!page) continue;
        await enviar(page.id, page.token, senderId, resposta);
      }
    }
  } catch(e){ /* engole erro pra não gerar retry infinito da Meta */ }

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ received: true }) };
};
