// netlify/functions/sync-diario-background.js
// 
// SYNC INCREMENTAL DIARIO - roda 1x ao dia via Netlify Scheduled Functions
// Pega so corridas NOVAS (desde a ultima sincronizacao)
// Salva com slug correto (hifen) - NUNCA underscore
// 
// Background Functions tem timeout de 15 minutos
// ============================================================

const SUPA_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;

// Cidades com slug CORRETO (com hifen)
const CIDADES = [
  { slug: 'maceio',       envSufixo: 'MACEIO' },
  { slug: 'fortaleza',    envSufixo: 'FORTALEZA' },
  { slug: 'joao-pessoa',  envSufixo: 'JOAO_PESSOA' },
  { slug: 'recife',       envSufixo: 'RECIFE' },
  { slug: 'natal',        envSufixo: 'NATAL' },
  { slug: 'aracaju',      envSufixo: 'ARACAJU' },
  { slug: 'sao-luis',     envSufixo: 'SAO_LUIS' },
  { slug: 'cuiaba',       envSufixo: 'CUIABA' },
  { slug: 'teresina',     envSufixo: 'TERESINA' },
  { slug: 'vitoria',      envSufixo: 'VITORIA' },
  { slug: 'campo-grande', envSufixo: 'CAMPO_GRANDE' }
];

// ====================================================================
// Helpers
// ====================================================================

async function logSync(cidade_slug, status, detalhes){
  try {
    await fetch(SUPA_URL+'/rest/v1/machine_sync_log', {
      method: 'POST',
      headers: {
        'apikey': SUPA_SERVICE_KEY,
        'Authorization': 'Bearer '+SUPA_SERVICE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        cidade_slug: cidade_slug,
        status: status,
        iniciado_em: detalhes.iniciado_em || new Date().toISOString(),
        finalizado_em: new Date().toISOString(),
        total_corridas: detalhes.total_corridas || 0,
        total_inseridas: detalhes.total_inseridas || 0,
        observacoes: (detalhes.obs || '') + ' [automatico]'
      })
    });
  } catch(e){ console.error('[log] erro:', e.message); }
}

async function pegarUltimoTimestamp(cidade_slug){
  // Pega o timestamp da corrida mais recente no Supabase
  try {
    const r = await fetch(SUPA_URL+'/rest/v1/machine_corridas?cidade_slug=eq.'+encodeURIComponent(cidade_slug)+'&select=data_hora_solicitacao&order=data_hora_solicitacao.desc&limit=1', {
      headers: { 'apikey': SUPA_SERVICE_KEY, 'Authorization': 'Bearer '+SUPA_SERVICE_KEY }
    });
    if(!r.ok) return null;
    const arr = await r.json();
    if(arr.length === 0) return null;
    return new Date(arr[0].data_hora_solicitacao);
  } catch(e){ return null; }
}

async function buscarMachine(envSufixo, recurso, dataInicio){
  const apiKey = process.env['MACHINE_API_KEY_'+envSufixo];
  const user = process.env['MACHINE_USER_'+envSufixo];
  const pass = process.env['MACHINE_PASS_'+envSufixo];
  
  if(!apiKey || !user || !pass){
    throw new Error('Credenciais Machine '+envSufixo+' nao configuradas');
  }
  
  // Endpoint Machine API
  const baseUrl = 'https://api.taximachine.com.br/api/integracao';
  let url = baseUrl + '/' + recurso + '?api_key=' + encodeURIComponent(apiKey);
  if(dataInicio && recurso === 'solicitacao'){
    const isoBR = dataInicio.toISOString().split('T')[0]; // YYYY-MM-DD
    url += '&data_inicio=' + isoBR;
  }
  
  const auth = Buffer.from(user+':'+pass).toString('base64');
  const r = await fetch(url, {
    headers: { 'Authorization': 'Basic '+auth }
  });
  
  if(!r.ok) throw new Error('Machine '+recurso+' HTTP '+r.status);
  const json = await r.json();
  return json.response || [];
}

async function salvarLote(tabela, dados){
  if(!dados || dados.length === 0) return 0;
  // Salva em lotes de 500 pra nao estourar limite 10MB do Netlify
  const TAM_LOTE = 500;
  let total = 0;
  for(let i = 0; i < dados.length; i += TAM_LOTE){
    const lote = dados.slice(i, i + TAM_LOTE);
    const r = await fetch(SUPA_URL+'/rest/v1/'+tabela+'?on_conflict=cidade_slug,id_solicitacao', {
      method: 'POST',
      headers: {
        'apikey': SUPA_SERVICE_KEY,
        'Authorization': 'Bearer '+SUPA_SERVICE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(lote)
    });
    if(r.ok) total += lote.length;
  }
  return total;
}

// ====================================================================
// Sync de uma cidade
// ====================================================================

async function syncCidade(cidade){
  const inicio = new Date();
  console.log('\n========================================');
  console.log('[SYNC] '+cidade.slug+' iniciado em', inicio.toISOString());
  
  try {
    // 1) Pega ultimo timestamp pra fazer incremental
    let dataInicio = await pegarUltimoTimestamp(cidade.slug);
    if(!dataInicio){
      // Primeira sync: pega ultimos 60 dias
      dataInicio = new Date(Date.now() - 60*24*60*60*1000);
      console.log('[SYNC] '+cidade.slug+' - primeira sync, pegando 60 dias');
    } else {
      // Volta 2 dias pra garantir overlap (idempotente devido ao on_conflict)
      dataInicio = new Date(dataInicio.getTime() - 2*24*60*60*1000);
      console.log('[SYNC] '+cidade.slug+' - incremental desde', dataInicio.toISOString().split('T')[0]);
    }
    
    // 2) Busca da Machine
    const [corridas, condutores, empresas] = await Promise.all([
      buscarMachine(cidade.envSufixo, 'solicitacao', dataInicio),
      buscarMachine(cidade.envSufixo, 'condutor', null),
      buscarMachine(cidade.envSufixo, 'empresa', null)
    ]);
    
    console.log('[SYNC] '+cidade.slug+' Machine: '+corridas.length+' corridas, '+condutores.length+' condutores, '+empresas.length+' empresas');
    
    // 3) Prepara corridas pra inserir (com slug CORRETO)
    const corridasFmt = corridas.map(c => ({
      cidade_slug: cidade.slug, // SEMPRE COM HIFEN
      id_solicitacao: String(c.id || c.id_solicitacao || ''),
      data_hora_solicitacao: c.data_hora_solicitacao || c.data || null,
      nome_passageiro: c.nome_passageiro || '',
      valor_corrida: parseFloat(c.valor_corrida || c.valor || 0),
      status_solicitacao: c.status_solicitacao || c.status || '',
      condutor_id: c.condutor_id ? String(c.condutor_id) : null,
      raw: c
    })).filter(x => x.id_solicitacao && x.data_hora_solicitacao);
    
    const condutoresFmt = condutores.map(co => ({
      cidade_slug: cidade.slug,
      id: String(co.id || ''),
      nome: co.nome || '',
      telefone_celular: co.telefone_celular || co.telefone || '',
      status: co.status || '',
      raw: co
    })).filter(x => x.id);
    
    const empresasFmt = empresas.map(e => ({
      cidade_slug: cidade.slug,
      id: String(e.id || ''),
      nome: e.nome || '',
      telefone: e.telefone || '',
      bairro: e.bairro || '',
      status_empresa: e.status_empresa || e.status || '',
      raw: e
    })).filter(x => x.id);
    
    // 4) Salva no Supabase
    const totalCorridas = await salvarLote('machine_corridas', corridasFmt);
    const totalCondutores = await salvarLote('machine_condutores', condutoresFmt);
    const totalEmpresas = await salvarLote('machine_empresas', empresasFmt);
    
    console.log('[SYNC] '+cidade.slug+' OK: '+totalCorridas+' corridas, '+totalCondutores+' condutores, '+totalEmpresas+' empresas salvos');
    
    await logSync(cidade.slug, 'concluido', {
      iniciado_em: inicio.toISOString(),
      total_corridas: corridas.length,
      total_inseridas: totalCorridas,
      obs: 'Corridas: '+totalCorridas+', Condutores: '+totalCondutores+', Empresas: '+totalEmpresas
    });
    
    return { slug: cidade.slug, ok: true, corridas: totalCorridas, condutores: totalCondutores, empresas: totalEmpresas };
    
  } catch(err) {
    console.error('[SYNC] '+cidade.slug+' ERRO:', err.message);
    await logSync(cidade.slug, 'erro', {
      iniciado_em: inicio.toISOString(),
      obs: 'ERRO: '+err.message
    });
    return { slug: cidade.slug, ok: false, erro: err.message };
  }
}

// ====================================================================
// Handler principal (Background Function)
// ====================================================================

exports.handler = async function(event){
  console.log('\n#####################################################');
  console.log('# SYNC DIARIO AUTOMATICO');
  console.log('# Inicio:', new Date().toISOString());
  console.log('#####################################################\n');
  
  const resultados = [];
  
  // Roda cidades SEQUENCIALMENTE pra nao sobrecarregar
  for(const cidade of CIDADES){
    const r = await syncCidade(cidade);
    resultados.push(r);
    // Pausa de 1 segundo entre cidades
    await new Promise(rs => setTimeout(rs, 1000));
  }
  
  console.log('\n#####################################################');
  console.log('# RESUMO FINAL:');
  resultados.forEach(r => {
    if(r.ok){
      console.log('# ✓ '+r.slug+': '+r.corridas+' corridas');
    } else {
      console.log('# ✗ '+r.slug+': '+r.erro);
    }
  });
  console.log('# Fim:', new Date().toISOString());
  console.log('#####################################################\n');
  
  return { 
    statusCode: 200, 
    body: JSON.stringify({ ok: true, resultados }) 
  };
};

// Marca como Background Function (timeout 15min)
exports.config = {
  schedule: '@daily'
};
