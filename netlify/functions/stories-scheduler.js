// Netlify Function: Scheduler de Stories automáticos
// Roda 4x por dia (08:00, 12:00, 16:30, 19:00 BRT)
// 
// O QUE FAZ:
// 1. Detecta qual horário disparou
// 2. Identifica categoria correspondente (BOM_DIA, CONTEUDOS, MOTOBOY, EMPRESA)
// 3. Lista imagens disponíveis na pasta da categoria
// 4. Usa IA Claude pra escolher a melhor (não repete últimas 7)
// 5. Cria um agendamento na tabela posts_agendados (uma row por cidade)
// 6. O posts-cron.js (existente) vai publicar nos próximos 15 minutos
//
// VARIÁVEIS DE AMBIENTE:
//   ANTHROPIC_API_KEY  — pra IA escolher imagem
//   SUPABASE_URL / SUPABASE_KEY — banco

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const SUPA_URL = process.env.SUPABASE_URL || '';
const SUPA_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY || '';

// 9 cidades Gâmi (Natal fora — em outro portfolio)
const CIDADES_INSTAGRAM = [
  { key: 'fortaleza',   ig_id: '17841472211942074', username: 'gamideliveryfortaleza',         nome: 'Fortaleza' },
  { key: 'recife',      ig_id: '17841472330286485', username: 'gamideliveryrecifeejaboatao',   nome: 'Recife' },
  { key: 'maceio',      ig_id: '17841461055254210', username: 'gamidelivery',                  nome: 'Maceió' },
  { key: 'joao_pessoa', ig_id: '17841472785074771', username: 'gamideliveryjoaopessoa',        nome: 'João Pessoa' },
  { key: 'aracaju',     ig_id: '17841472144504267', username: 'gamideliveryaracaju',           nome: 'Aracaju' },
  { key: 'sao_luis',    ig_id: '17841472518866073', username: 'gamideliverysaoluis',           nome: 'São Luís' },
  { key: 'cuiaba',      ig_id: '17841477661312288', username: 'gamideliverycuiaba',            nome: 'Cuiabá' },
  { key: 'teresina',    ig_id: '17841477421114530', username: 'gamideliveryteresina',          nome: 'Teresina' },
  { key: 'vitoria',     ig_id: '17841480175012502', username: 'gamideliveryvitoria',           nome: 'Vitória' }
];

// Horário (BRT) → categoria
const HORARIO_CATEGORIA = {
  '08:00': 'bom-dia',
  '12:00': 'conteudos',
  '16:30': 'motoboy',
  '19:00': 'empresa'
};

// URLs do GitHub pra listar/baixar imagens das pastas
const GITHUB_API_BASE = 'https://api.github.com/repos/jipadigital/gami-marketing/contents/stories';
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/jipadigital/gami-marketing/main/stories';

const HEADERS_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async function(event, context) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: HEADERS_CORS, body: '' };
  }

  // Body opcional (pra teste manual)
  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch(e) {}

  // ============ DETECTA HORÁRIO/CATEGORIA ============
  let categoria = body.categoria || null;
  let cidadesAlvo = body.cidades || null; // null = todas
  let horario_label = body.horario || null;
  
  // Modo: scheduler automático
  if (!categoria) {
    const agoraUTC = new Date();
    const agoraBR = new Date(agoraUTC.getTime() - (3 * 60 * 60 * 1000));
    const horaAtual = agoraBR.getHours() * 60 + agoraBR.getMinutes();
    
    // Encontra horário mais próximo (tolerância 15min)
    let menorDiff = Infinity;
    let melhorHorario = null;
    for (const h of Object.keys(HORARIO_CATEGORIA)) {
      const [hh, mm] = h.split(':').map(Number);
      const minH = hh * 60 + mm;
      const diff = Math.abs(minH - horaAtual);
      if (diff <= 15 && diff < menorDiff) {
        menorDiff = diff;
        melhorHorario = h;
      }
    }
    
    if (!melhorHorario) {
      return {
        statusCode: 200,
        headers: HEADERS_CORS,
        body: JSON.stringify({
          ok: false,
          message: 'Fora dos horários de postagem',
          hora_atual_brt: `${String(agoraBR.getHours()).padStart(2,'0')}:${String(agoraBR.getMinutes()).padStart(2,'0')}`
        })
      };
    }
    
    categoria = HORARIO_CATEGORIA[melhorHorario];
    horario_label = melhorHorario;
  }
  
  // Lista de cidades alvo
  const cidades = cidadesAlvo
    ? CIDADES_INSTAGRAM.filter(c => cidadesAlvo.includes(c.key))
    : CIDADES_INSTAGRAM;

  try {
    // ============ LISTA IMAGENS DA CATEGORIA ============
    const imagens = await listarImagens(categoria);
    
    if (imagens.length === 0) {
      return {
        statusCode: 404,
        headers: HEADERS_CORS,
        body: JSON.stringify({
          ok: false,
          error: `Pasta /stories/${categoria}/ vazia. Suba imagens primeiro.`
        })
      };
    }
    
    // ============ ESCOLHE IMAGEM (com IA Claude) ============
    const escolha = await escolherImagem(imagens, categoria);
    
    // ============ AGENDA UM POST POR CIDADE ============
    // Agenda pra "agora" — o posts-cron vai publicar nos próximos 15min
    const agendarPara = new Date().toISOString();
    
    const resultados = await Promise.all(
      cidades.map(async (cidade) => {
        try {
          const row = {
            id: `story_${Date.now()}_${cidade.key}_${Math.random().toString(36).slice(2, 7)}`,
            cidade_id: cidade.key,
            cidade_nome: cidade.nome,
            ig_id: cidade.ig_id,
            ig_username: cidade.username,
            tipo: 'story',
            midia_urls: JSON.stringify([escolha.url]),
            legenda: '',
            agendado_para: agendarPara,
            status: 'pendente',
            criado_por: 'stories-scheduler-auto'
          };
          
          const inserted = await criarAgendamento(row);
          return {
            cidade: cidade.key,
            sucesso: true,
            agendamento_id: inserted.id || row.id,
            imagem: escolha.nome
          };
        } catch (e) {
          return {
            cidade: cidade.key,
            sucesso: false,
            erro: e.message
          };
        }
      })
    );
    
    const sucessos = resultados.filter(r => r.sucesso).length;
    
    return {
      statusCode: 200,
      headers: HEADERS_CORS,
      body: JSON.stringify({
        ok: true,
        horario: horario_label,
        categoria: categoria,
        imagem_escolhida: escolha.nome,
        imagem_url: escolha.url,
        total_cidades: cidades.length,
        sucessos: sucessos,
        falhas: cidades.length - sucessos,
        resultados: resultados,
        observacao: 'Posts agendados. Cron posts-cron vai publicar nos próximos 15 minutos.'
      })
    };
    
  } catch (err) {
    return {
      statusCode: 500,
      headers: HEADERS_CORS,
      body: JSON.stringify({
        ok: false,
        error: err.message,
        stack: err.stack ? err.stack.substring(0, 300) : null
      })
    };
  }
};

// ====================================================
// FUNÇÕES AUXILIARES
// ====================================================

// Lista imagens disponíveis na pasta /stories/CATEGORIA/ do GitHub
async function listarImagens(categoria) {
  const url = `${GITHUB_API_BASE}/${categoria}`;
  const r = await fetch(url);
  if (!r.ok) {
    if (r.status === 404) return [];
    throw new Error(`GitHub API erro: ${r.status}`);
  }
  const data = await r.json();
  
  return data
    .filter(item => {
      if (item.type !== 'file') return false;
      if (item.name.startsWith('.')) return false; // ignora .gitkeep
      const ext = item.name.split('.').pop().toLowerCase();
      return ['jpg', 'jpeg', 'png', 'webp'].includes(ext);
    })
    .map(item => ({
      nome: item.name,
      url: `${GITHUB_RAW_BASE}/${categoria}/${item.name}`,
      sha: item.sha,
      size: item.size
    }));
}

// Escolhe imagem usando IA Claude (com fallback aleatório)
async function escolherImagem(imagens, categoria) {
  // Busca últimas 7 postagens dessa categoria pra não repetir
  let usadasRecente = [];
  try {
    usadasRecente = await buscarHistoricoCategoria(categoria);
  } catch(e) {
    console.warn('Histórico falhou:', e.message);
  }
  
  const disponiveis = imagens.filter(img => !usadasRecente.includes(img.nome));
  const candidatas = disponiveis.length > 0 ? disponiveis : imagens;
  
  // Se só tem 1, retorna direto
  if (candidatas.length === 1) return candidatas[0];
  
  // IA Claude escolhe
  if (ANTHROPIC_KEY) {
    try {
      const dataHoje = new Date().toLocaleDateString('pt-BR', { 
        weekday: 'long', day: '2-digit', month: '2-digit'
      });
      
      const prompt = `Você é o gestor de conteúdo do Instagram da Gâmi Delivery (logística brasileira em 9 cidades).
Hoje é ${dataHoje}.
Categoria: ${categoria}

Imagens disponíveis (não usadas nos últimos 7 posts):
${candidatas.map((img, i) => `${i + 1}. ${img.nome}`).join('\n')}

Escolha a MELHOR pra postar agora. Responda APENAS com o NÚMERO (1, 2, 3...). Nada mais.`;

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 50,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      
      const data = await r.json();
      const texto = data.content?.[0]?.text || '';
      const num = parseInt(texto.trim().match(/\d+/)?.[0] || '1');
      return candidatas[num - 1] || candidatas[0];
    } catch(e) {
      console.warn('Claude falhou, usando aleatório:', e.message);
    }
  }
  
  // Fallback: aleatório entre candidatas
  return candidatas[Math.floor(Math.random() * candidatas.length)];
}

// Busca histórico das últimas postagens dessa categoria
// Usa tabela posts_agendados, filtrando por tipo=story
async function buscarHistoricoCategoria(categoria) {
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/posts_agendados?select=midia_urls&tipo=eq.story&criado_por=eq.stories-scheduler-auto&status=eq.publicado&order=publicado_em.desc&limit=15`, {
      headers: {
        'apikey': SUPA_KEY,
        'Authorization': 'Bearer ' + SUPA_KEY
      }
    });
    if (!r.ok) return [];
    const data = await r.json();
    
    // Extrai nomes das imagens das URLs (last part)
    return data.flatMap(p => {
      let urls = [];
      try {
        urls = typeof p.midia_urls === 'string' ? JSON.parse(p.midia_urls) : p.midia_urls;
      } catch(e) {}
      return urls.map(u => {
        const partes = u.split('/');
        return partes[partes.length - 1];
      });
    }).filter(nome => nome.includes(categoria) || true); // todos os recentes
  } catch(e) {
    return [];
  }
}

// Cria agendamento via posts-agenda OU direto no Supabase
async function criarAgendamento(row) {
  // Chama direto Supabase (mais rápido que via posts-agenda)
  const r = await fetch(`${SUPA_URL}/rest/v1/posts_agendados`, {
    method: 'POST',
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': 'Bearer ' + SUPA_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(row)
  });
  
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Supabase insert: ${r.status} - ${txt.substring(0, 200)}`);
  }
  
  const data = await r.json();
  return data[0] || row;
}
