// netlify/functions/sync-diario-background.js
// Sincronização automática Machine → Supabase
// Roda às 3h da manhã (6h UTC) todos os dias
// Pra cada cidade: puxa últimas 48h, salva no Supabase, atualiza views
// ============================================================

const { schedule } = require('@netlify/functions');

const SUPA_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
// Service key bypassa RLS — só funciona em env var do Netlify (nunca expor)
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY || process.env.SUPA_PUBLIC_KEY || 'sb_publishable_0y-oz0aght1rNQNQrsh2tA_EfHajL61';

// Cidades a sincronizar (slugs igual ao machine.js)
const CIDADES = [
  { slug: 'fortaleza', nome: 'Fortaleza/CE' },
  { slug: 'maceio', nome: 'Maceió/AL' },
  { slug: 'joao_pessoa', nome: 'João Pessoa/PB' },
  { slug: 'recife', nome: 'Recife/PE' },
  { slug: 'natal', nome: 'Natal/RN' },
  { slug: 'aracaju', nome: 'Aracaju/SE' },
  { slug: 'sao_luis', nome: 'São Luís/MA' },
  { slug: 'cuiaba', nome: 'Cuiabá/MT' },
  { slug: 'teresina', nome: 'Teresina/PI' },
  { slug: 'vitoria', nome: 'Vitória/ES' },
  { slug: 'campo_grande', nome: 'Campo Grande/MS' }
];

// Helper: chama a função machine.js do próprio Netlify
async function chamarMachine(slug, recurso, dataInicio, dataFim, siteUrl){
  const base = siteUrl + '/.netlify/functions/machine';
  let url = `${base}?cidade=${encodeURIComponent(slug)}&recurso=${recurso}`;
  if(dataInicio) url += `&data_inicio=${dataInicio}`;
  if(dataFim) url += `&data_fim=${dataFim}`;
  
  const r = await fetch(url);
  if(!r.ok) throw new Error(`Machine ${slug}/${recurso} HTTP ${r.status}`);
  const data = await r.json();
  return (data && Array.isArray(data.response)) ? data.response : [];
}

// Helper: upsert no Supabase em batches
async function upsertSupabase(tabela, registros){
  if(!registros.length) return { ok: 0, erro: 0 };
  const BATCH = 500;
  let ok = 0, erro = 0;
  
  for(let i = 0; i < registros.length; i += BATCH){
    const lote = registros.slice(i, i+BATCH);
    try {
      const r = await fetch(`${SUPA_URL}/rest/v1/${tabela}`, {
        method: 'POST',
        headers: {
          'apikey': SUPA_SERVICE_KEY,
          'Authorization': `Bearer ${SUPA_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(lote)
      });
      if(r.ok) ok += lote.length;
      else erro += lote.length;
    } catch(e) { erro += lote.length; }
  }
  return { ok, erro };
}

// Helper: cria registro de log
async function criarLog(slug, nome){
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/machine_sync_log`, {
      method: 'POST',
      headers: {
        'apikey': SUPA_SERVICE_KEY,
        'Authorization': `Bearer ${SUPA_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        cidade_slug: slug,
        cidade_nome: nome,
        dias_solicitados: 2,
        status: 'rodando',
        usuario: 'sync-automatico'
      })
    });
    if(r.ok){
      const arr = await r.json();
      return arr[0] ? arr[0].id : null;
    }
  } catch(e) {}
  return null;
}

async function atualizarLog(id, dados){
  if(!id) return;
  try {
    await fetch(`${SUPA_URL}/rest/v1/machine_sync_log?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPA_SERVICE_KEY,
        'Authorization': `Bearer ${SUPA_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(dados)
    });
  } catch(e) {}
}

// Helper: sincroniza UMA cidade (últimas 48h)
async function sincronizarCidade(cidade, siteUrl){
  const inicioTs = Date.now();
  const logId = await criarLog(cidade.slug, cidade.nome);
  
  console.log(`[sync] Iniciando ${cidade.nome}...`);
  
  try {
    // Pega últimas 48h em 2 chunks de 1 dia (em paralelo)
    const hoje = new Date(); hoje.setHours(0,0,0,0);
    const ontem = new Date(hoje); ontem.setDate(ontem.getDate() - 1);
    const dh = hoje.toISOString().split('T')[0];
    const dy = ontem.toISOString().split('T')[0];
    
    const [corridasOntem, corridasHoje] = await Promise.all([
      chamarMachine(cidade.slug, 'solicitacao', dy, dy, siteUrl).catch(e => { console.warn(`Ontem ${cidade.slug}:`, e.message); return []; }),
      chamarMachine(cidade.slug, 'solicitacao', dh, dh, siteUrl).catch(e => { console.warn(`Hoje ${cidade.slug}:`, e.message); return []; })
    ]);
    
    const todasCorridas = [...corridasOntem, ...corridasHoje];
    
    // Pega condutores e empresas (snapshot)
    const [condutores, empresas] = await Promise.all([
      chamarMachine(cidade.slug, 'condutor', null, null, siteUrl).catch(e => []),
      chamarMachine(cidade.slug, 'empresa', null, null, siteUrl).catch(e => [])
    ]);
    
    // Mapeia pra formato Supabase
    const corridasSupa = todasCorridas.map(x => ({
      cidade_slug: cidade.slug,
      id_solicitacao: String(x.id || x.id_solicitacao || ''),
      data_hora_solicitacao: x.data_hora_solicitacao || x.data_solicitacao || new Date().toISOString(),
      nome_passageiro: x.nome_passageiro || null,
      condutor_id: x.condutor_id ? String(x.condutor_id) : (x.taxista_id ? String(x.taxista_id) : null),
      nome_condutor: x.nome_condutor || x.nome_taxista || null,
      valor_corrida: parseFloat(x.valor_corrida || x.valor || 0) || null,
      status_solicitacao: x.status_solicitacao || x.status || null,
      raw: x
    })).filter(r => r.id_solicitacao);
    
    const condutoresSupa = condutores.map(x => ({
      cidade_slug: cidade.slug,
      id: String(x.id),
      nome: x.nome || null,
      telefone_celular: x.telefone_celular || x.telefone || x.celular || null,
      status: x.status || null,
      raw: x
    })).filter(r => r.id);
    
    const empresasSupa = empresas.map(x => ({
      cidade_slug: cidade.slug,
      id: String(x.id),
      nome: x.nome || null,
      telefone: x.telefone || null,
      bairro: x.bairro || null,
      status_empresa: x.status_empresa || x.status || null,
      raw: x
    })).filter(r => r.id);
    
    // Upsert em paralelo
    const [resCorr, resCond, resEmp] = await Promise.all([
      upsertSupabase('machine_corridas', corridasSupa),
      upsertSupabase('machine_condutores', condutoresSupa),
      upsertSupabase('machine_empresas', empresasSupa)
    ]);
    
    const duracao = Math.round((Date.now() - inicioTs) / 1000);
    
    await atualizarLog(logId, {
      finalizado_em: new Date().toISOString(),
      duracao_segundos: duracao,
      corridas_inseridas: resCorr.ok,
      corridas_erro: resCorr.erro,
      condutores_inseridos: resCond.ok,
      empresas_inseridas: resEmp.ok,
      status: 'concluido'
    });
    
    console.log(`[sync] ✓ ${cidade.nome}: ${resCorr.ok} corridas, ${resCond.ok} cond, ${resEmp.ok} emp em ${duracao}s`);
    return { ok: true, cidade: cidade.nome, corridas: resCorr.ok, duracao };
    
  } catch(e) {
    await atualizarLog(logId, {
      finalizado_em: new Date().toISOString(),
      duracao_segundos: Math.round((Date.now() - inicioTs) / 1000),
      status: 'erro',
      mensagem_erro: e.message
    });
    console.error(`[sync] ✗ ${cidade.nome}:`, e.message);
    return { ok: false, cidade: cidade.nome, erro: e.message };
  }
}

// Handler principal
const handler = async function(event, context) {
  const inicio = Date.now();
  const siteUrl = process.env.URL || `https://${event.headers?.host || 'gami-marketing.netlify.app'}`;
  
  console.log(`🌙 Sync diário iniciado às ${new Date().toISOString()}`);
  console.log(`Site: ${siteUrl}`);
  
  const resultados = [];
  
  // Processa cidades SEQUENCIALMENTE pra não estourar rate limit Machine
  for(const cidade of CIDADES){
    const res = await sincronizarCidade(cidade, siteUrl);
    resultados.push(res);
    // Pequena pausa entre cidades
    await new Promise(r => setTimeout(r, 1000));
  }
  
  // Refresh das materialized views
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/rpc/refresh_machine_views`, {
      method: 'POST',
      headers: {
        'apikey': SUPA_SERVICE_KEY,
        'Authorization': `Bearer ${SUPA_SERVICE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    if(r.ok) console.log('[sync] ✓ Materialized views atualizadas');
    else console.warn('[sync] ⚠ Refresh views falhou:', r.status);
  } catch(e) {
    console.warn('[sync] ⚠ Refresh views:', e.message);
  }
  
  const duracaoTotal = Math.round((Date.now() - inicio) / 1000);
  const sucessos = resultados.filter(r => r.ok).length;
  const totalCorridas = resultados.reduce((s,r) => s + (r.corridas || 0), 0);
  
  console.log(`🌙 Sync diário concluído em ${duracaoTotal}s · ${sucessos}/${CIDADES.length} cidades OK · ${totalCorridas} corridas`);
  
  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      duracao_total: duracaoTotal,
      cidades_ok: sucessos,
      cidades_total: CIDADES.length,
      corridas_totais: totalCorridas,
      resultados
    })
  };
};

// Schedule: 6h UTC = 3h Brasília (UTC-3)
// Formato cron: minuto hora dia mês dia_semana
exports.handler = schedule('0 6 * * *', handler);
