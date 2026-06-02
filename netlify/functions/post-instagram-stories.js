// netlify/functions/post-instagram-stories.js
// Posta Stories no Instagram automaticamente nas 9 cidades Gâmi
// Usa Meta Graph API + IA Claude pra escolher imagem ideal

const CIDADES_INSTAGRAM = {
  fortaleza: { ig_id: '17841472211942074', username: 'gamideliveryfortaleza' },
  recife: { ig_id: '17841472330286485', username: 'gamideliveryrecifeejaboatao' },
  maceio: { ig_id: '17841461055254210', username: 'gamidelivery' },
  joao_pessoa: { ig_id: '17841472785074771', username: 'gamideliveryjoaopessoa' },
  aracaju: { ig_id: '17841472144504267', username: 'gamideliveryaracaju' },
  sao_luis: { ig_id: '17841472518866073', username: 'gamideliverysaoluis' },
  cuiaba: { ig_id: '17841477661312288', username: 'gamideliverycuiaba' },
  teresina: { ig_id: '17841477421114530', username: 'gamideliveryteresina' },
  vitoria: { ig_id: '17841480175012502', username: 'gamideliveryvitoria' }
};

// Mapeia horário → categoria padrão (lógica nova v2 - 14/05/2026)
// Nota: a categoria real é decidida pelo scheduled-stories.js conforme dia da semana
// Este mapeamento é só fallback caso a chamada não venha do scheduled
const HORARIO_CATEGORIA = {
  '07:00': 'bom-dia',         // Ter a Dom (Seg → otima-semana, via scheduled)
  '12:00': 'outra',           // Todo dia
  '16:30': 'motoboy',         // Todo dia
  '18:00': 'empresa',         // Todo dia
  '19:00': 'fim-de-semana'    // Só Sex (via scheduled)
};

// Categorias disponíveis (pasta /stories/CATEGORIA/)
const CATEGORIAS = ['bom-dia', 'otima-semana', 'fim-de-semana', 'motoboy', 'empresa', 'outra'];

// URL base do GitHub raw pra acessar imagens
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/jipadigital/gami-marketing/main/stories';
const GITHUB_API_BASE = 'https://api.github.com/repos/jipadigital/gami-marketing/contents/stories';

// Supabase config
const SUPA_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const TOKEN = process.env.META_SYSTEM_USER_TOKEN || process.env.META_USER_TOKEN;
  const SUPA_KEY = process.env.SUPABASE_KEY || 'sb_publishable_0y-oz0aght1rNQNQrsh2tA_EfHajL61';
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  
  if (!TOKEN) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'META_SYSTEM_USER_TOKEN não configurado' })
    };
  }

  // Parse body
  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const {
    cidades = Object.keys(CIDADES_INSTAGRAM), // por padrão, todas
    categoria = null,                          // categoria específica ou auto
    horario = null,                            // ex: '08:00' (auto se vazio)
    imagem_url = null,                         // se quiser passar URL direta
    modo = 'auto'                              // 'auto' | 'teste' | 'manual'
  } = body;

  // Determina categoria automaticamente baseado em horário se não passado
  let categoriaUsada = categoria;
  if (!categoriaUsada && horario && HORARIO_CATEGORIA[horario]) {
    categoriaUsada = HORARIO_CATEGORIA[horario];
  }
  if (!categoriaUsada) {
    // Pega horário atual do servidor (BR)
    const agora = new Date();
    const horaAtual = `${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;
    // Match mais próximo
    const hsValidos = Object.keys(HORARIO_CATEGORIA);
    let menorDiff = Infinity;
    let melhorHorario = '08:00';
    for (const h of hsValidos) {
      const [hh, mm] = h.split(':').map(Number);
      const minTotal = hh * 60 + mm;
      const minAtual = agora.getHours() * 60 + agora.getMinutes();
      const diff = Math.abs(minTotal - minAtual);
      if (diff < menorDiff) { menorDiff = diff; melhorHorario = h; }
    }
    categoriaUsada = HORARIO_CATEGORIA[melhorHorario];
  }

  if (!CATEGORIAS.includes(categoriaUsada)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Categoria inválida: ' + categoriaUsada })
    };
  }

  try {
    // PASSO 1: Buscar imagens disponíveis na pasta da categoria
    let imagemFinal = imagem_url;
    let imagemNome = '';
    
    if (!imagemFinal) {
      const imagens = await listarImagensCategoria(categoriaUsada);
      
      if (imagens.length === 0) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ 
            error: 'Nenhuma imagem encontrada em /stories/' + categoriaUsada,
            dica: 'Suba imagens nessa pasta no GitHub primeiro'
          })
        };
      }
      
      // PASSO 2: Escolher imagem (com IA Claude se disponível, senão aleatória inteligente)
      const escolha = await escolherImagem({
        imagens: imagens,
        categoria: categoriaUsada,
        horario: horario,
        anthropicKey: ANTHROPIC_KEY,
        supaUrl: SUPA_URL,
        supaKey: SUPA_KEY
      });
      
      imagemFinal = escolha.url;
      imagemNome = escolha.nome;
    }
    
    // PASSO 3: Postar nas cidades em paralelo
    const resultados = await Promise.all(
      cidades.map(async (cidadeKey) => {
        const cidadeInfo = CIDADES_INSTAGRAM[cidadeKey];
        if (!cidadeInfo) {
          return { cidade: cidadeKey, sucesso: false, erro: 'Cidade não encontrada no mapa' };
        }
        
        try {
          const result = await postarStory({
            igAccountId: cidadeInfo.ig_id,
            imagemUrl: imagemFinal,
            token: TOKEN
          });
          
          // Salva log no Supabase
          await salvarLog({
            cidade: cidadeKey,
            username: cidadeInfo.username,
            categoria: categoriaUsada,
            imagem_url: imagemFinal,
            imagem_nome: imagemNome,
            ig_media_id: result.media_id,
            ig_publish_id: result.publish_id,
            status: 'postado',
            supaUrl: SUPA_URL,
            supaKey: SUPA_KEY
          });
          
          return {
            cidade: cidadeKey,
            username: cidadeInfo.username,
            sucesso: true,
            ...result
          };
        } catch (err) {
          // Salva log de erro
          await salvarLog({
            cidade: cidadeKey,
            username: cidadeInfo.username,
            categoria: categoriaUsada,
            imagem_url: imagemFinal,
            imagem_nome: imagemNome,
            status: 'erro',
            erro_msg: err.message,
            supaUrl: SUPA_URL,
            supaKey: SUPA_KEY
          });
          
          return {
            cidade: cidadeKey,
            username: cidadeInfo.username,
            sucesso: false,
            erro: err.message
          };
        }
      })
    );
    
    const sucessos = resultados.filter(r => r.sucesso).length;
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        categoria: categoriaUsada,
        imagem: imagemNome,
        imagem_url: imagemFinal,
        total_cidades: cidades.length,
        sucessos: sucessos,
        falhas: cidades.length - sucessos,
        resultados: resultados
      })
    };
    
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: err.message,
        stack: err.stack ? err.stack.substring(0, 300) : null
      })
    };
  }
};

// =====================================
// FUNÇÕES AUXILIARES
// =====================================

// Lista imagens disponíveis numa pasta /stories/CATEGORIA/ do GitHub
async function listarImagensCategoria(categoria) {
  try {
    const r = await fetch(`${GITHUB_API_BASE}/${categoria}`);
    if (!r.ok) return [];
    const data = await r.json();
    
    return data
      .filter(item => {
        if (item.type !== 'file') return false;
        const ext = item.name.split('.').pop().toLowerCase();
        return ['jpg', 'jpeg', 'png', 'webp'].includes(ext);
      })
      .map(item => ({
        nome: item.name,
        url: `${GITHUB_RAW_BASE}/${categoria}/${item.name}`,
        sha: item.sha,
        size: item.size
      }));
  } catch (e) {
    console.warn('Erro listando imagens:', e.message);
    return [];
  }
}

// Escolhe a melhor imagem com ROTAÇÃO INTELIGENTE (anti-repetição)
// v3 - 02/06/2026 - Determinística baseada em histórico (sem viés de IA)
async function escolherImagem({ imagens, categoria, horario, anthropicKey, supaUrl, supaKey }) {
  return escolherPorRotacaoInteligente(imagens, categoria, supaUrl, supaKey);
}

// Lógica anti-repetição:
//   1. Busca histórico de até 1000 logs (cobre ~110 ciclos = ~3 semanas)
//   2. Calcula uso de cada imagem (qtd + último uso)
//   3. Ordena: menos usadas primeiro → em empate, mais antigas
//   4. Pega top 3 e sorteia entre elas (variação leve)
async function escolherPorRotacaoInteligente(imagens, categoria, supaUrl, supaKey) {
  if (!imagens || imagens.length === 0) {
    throw new Error('Sem imagens disponíveis pra escolher');
  }
  
  // Caso única imagem, retorna ela
  if (imagens.length === 1) {
    console.log(`📸 Única imagem disponível em ${categoria}: ${imagens[0].nome}`);
    return imagens[0];
  }
  
  try {
    // Busca histórico amplo (até 1000 logs = ~110 ciclos)
    const historico = await buscarHistoricoCategoria(categoria, supaUrl, supaKey, 1000);
    
    // Estatística de uso por imagem
    const stats = {};
    imagens.forEach(img => {
      stats[img.nome] = { usos: 0, ultimoUso: null, img: img };
    });
    
    // Conta usos no histórico (só considera imagens que ainda existem na pasta)
    historico.forEach(h => {
      const nome = h.imagem_nome;
      if (!nome || !stats[nome]) return;
      stats[nome].usos++;
      if (!stats[nome].ultimoUso || h.postado_em > stats[nome].ultimoUso) {
        stats[nome].ultimoUso = h.postado_em;
      }
    });
    
    // Ordena: menos usadas > nunca usadas vêm antes > mais antigas
    const ranking = Object.values(stats).sort((a, b) => {
      if (a.usos !== b.usos) return a.usos - b.usos;
      if (!a.ultimoUso && b.ultimoUso) return -1;
      if (!b.ultimoUso && a.ultimoUso) return 1;
      if (!a.ultimoUso && !b.ultimoUso) return 0;
      return new Date(a.ultimoUso) - new Date(b.ultimoUso);
    });
    
    // Top 3 candidatas pra adicionar leve aleatoriedade
    const top = ranking.slice(0, Math.min(3, ranking.length));
    const escolhida = top[Math.floor(Math.random() * top.length)];
    
    console.log(`📸 [${categoria}] Escolha: ${escolhida.img.nome} (${escolhida.usos} usos | último: ${escolhida.ultimoUso || 'nunca'})`);
    console.log(`📸 [${categoria}] Top 3: ${top.map(t => `${t.img.nome}(${t.usos})`).join(', ')}`);
    
    return escolhida.img;
    
  } catch (e) {
    console.warn('Rotação inteligente falhou, sorteio simples:', e.message);
    return imagens[Math.floor(Math.random() * imagens.length)];
  }
}

// Mantida pra compatibilidade (não é mais usada diretamente)
async function escolherImagemRotacao(imagens, categoria, supaUrl, supaKey) {
  return escolherPorRotacaoInteligente(imagens, categoria, supaUrl, supaKey);
}

// Busca últimas postagens dessa categoria
async function buscarHistoricoCategoria(categoria, supaUrl, supaKey, limit = 1000) {
  try {
    const r = await fetch(`${supaUrl}/rest/v1/stories_log?categoria=eq.${categoria}&status=eq.postado&order=postado_em.desc&limit=${limit}`, {
      headers: {
        'apikey': supaKey,
        'Authorization': 'Bearer ' + supaKey
      }
    });
    if (!r.ok) return [];
    return await r.json();
  } catch (e) {
    return [];
  }
}

// Posta o story usando Meta Graph API
async function postarStory({ igAccountId, imagemUrl, token }) {
  // PASSO 1: Cria o container do story (media container)
  const createUrl = `https://graph.facebook.com/v18.0/${igAccountId}/media`;
  const createBody = new URLSearchParams({
    image_url: imagemUrl,
    media_type: 'STORIES',
    access_token: token
  });
  
  const createRes = await fetch(createUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: createBody.toString()
  });
  
  const createData = await createRes.json();
  
  if (!createRes.ok || createData.error) {
    throw new Error('Criar container falhou: ' + JSON.stringify(createData.error || createData));
  }
  
  const containerId = createData.id;
  
  // PASSO 2: Aguarda processamento (Stories podem demorar)
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // PASSO 3: Publica o story
  const publishUrl = `https://graph.facebook.com/v18.0/${igAccountId}/media_publish`;
  const publishBody = new URLSearchParams({
    creation_id: containerId,
    access_token: token
  });
  
  const publishRes = await fetch(publishUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: publishBody.toString()
  });
  
  const publishData = await publishRes.json();
  
  if (!publishRes.ok || publishData.error) {
    throw new Error('Publicar falhou: ' + JSON.stringify(publishData.error || publishData));
  }
  
  return {
    media_id: containerId,
    publish_id: publishData.id
  };
}

// Salva log no Supabase
async function salvarLog({ cidade, username, categoria, imagem_url, imagem_nome, ig_media_id, ig_publish_id, status, erro_msg, supaUrl, supaKey }) {
  try {
    const r = await fetch(`${supaUrl}/rest/v1/stories_log`, {
      method: 'POST',
      headers: {
        'apikey': supaKey,
        'Authorization': 'Bearer ' + supaKey,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        cidade: cidade,
        username: username || null,
        categoria: categoria,
        imagem_url: imagem_url,
        imagem_nome: imagem_nome || null,
        ig_media_id: ig_media_id || null,
        ig_publish_id: ig_publish_id || null,
        status: status,
        erro_msg: erro_msg || null,
        postado_em: new Date().toISOString()
      })
    });
    return r.ok;
  } catch (e) {
    console.warn('Log falhou:', e.message);
    return false;
  }
}
