// netlify/functions/sync-diario-background.js
// 
// SYNC INCREMENTAL DIARIO - roda 1x ao dia via Netlify Scheduled Functions
// 
// 🆕 v5 (05/06/2026): 
//   - Aceita parâmetros via query string pra SYNC RETROATIVO
//   - ?cidade=cuiaba         → roda só essa cidade
//   - ?dias=120              → força buscar X dias (ignora incremental)
//   - ?cidade=cuiaba&dias=180 → combina ambos
//
// Background Functions tem timeout de 15 minutos
// ============================================================

const SUPA_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
const BASE_URL = 'https://api.taximachine.com.br/api/integracao';

const CIDADES = [
  { slug: 'maceio',       nome: 'Maceió/AL',         envSufixo: 'MACEIO' },
  { slug: 'fortaleza',    nome: 'Fortaleza/CE',      envSufixo: 'FORTALEZA' },
  { slug: 'joao-pessoa',  nome: 'João Pessoa/PB',    envSufixo: 'JOAO_PESSOA' },
  { slug: 'recife',       nome: 'Recife/PE',         envSufixo: 'RECIFE' },
  { slug: 'natal',        nome: 'Natal/RN',          envSufixo: 'NATAL' },
  { slug: 'aracaju',      nome: 'Aracaju/SE',        envSufixo: 'ARACAJU' },
  { slug: 'sao-luis',     nome: 'São Luís/MA',       envSufixo: 'SAO_LUIS' },
  { slug: 'cuiaba',       nome: 'Cuiabá/MT',         envSufixo: 'CUIABA' },
  { slug: 'teresina',     nome: 'Teresina/PI',       envSufixo: 'TERESINA' },
  { slug: 'vitoria',      nome: 'Vitória/ES',        envSufixo: 'VITORIA' },
  { slug: 'campo-grande', nome: 'Campo Grande/MS',   envSufixo: 'CAMPO_GRANDE' }
];

// ====================================================================
// Helpers
// ====================================================================

async function logSync(cidade, status, detalhes){
  try {
    const duracaoSeg = detalhes.iniciado_em 
      ? Math.round((new Date() - new Date(detalhes.iniciado_em)) / 1000)
      : null;
    
    await fetch(SUPA_URL+'/rest/v1/machine_sync_log', {
      method: 'POST',
      headers: {
        'apikey': SUPA_SERVICE_KEY,
        'Authorization': 'Bearer '+SUPA_SERVICE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        cidade_slug: cidade.slug,
        cidade_nome: cidade.nome,
        status: status,
        iniciado_em: detalhes.iniciado_em || new Date().toISOString(),
        finalizado_em: new Date().toISOString(),
        duracao_segundos: duracaoSeg,
        dias_solicitados: detalhes.dias_solicitados || null,
        corridas_inseridas: detalhes.corridas_inseridas || 0,
        corridas_erro: detalhes.corridas_erro || 0,
        condutores_inseridos: detalhes.condutores_inseridos || 0,
        empresas_inseridas: detalhes.empresas_inseridas || 0,
        mensagem_erro: detalhes.mensagem_erro || null,
        usuario: detalhes.usuario || 'sync-automatico'
      })
    });
  } catch(e){ console.error('[log] erro:', e.message); }
}

async function pegarUltimoTimestamp(cidade_slug){
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
  const user = process.env['MACHINE_USER_'+envSufixo] || process.env.MACHINE_USER;
  const pass = process.env['MACHINE_PASS_'+envSufixo] || process.env.MACHINE_PASS;
  
  if(!apiKey || !user || !pass){
    const faltando = [];
    if(!apiKey) faltando.push('MACHINE_API_KEY_'+envSufixo);
    if(!user) faltando.push('MACHINE_USER_'+envSufixo+' ou MACHINE_USER');
    if(!pass) faltando.push('MACHINE_PASS_'+envSufixo+' ou MACHINE_PASS');
    throw new Error('Credenciais não configuradas: '+faltando.join(', '));
  }
  
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'api-key': apiKey,
    'Authorization': 'Basic ' + Buffer.from(user + ':' + pass).toString('base64')
  };
  
  const paths = {
    'solicitacao': '/solicitacao',
    'condutor': '/condutor',
    'empresa': '/empresa'
  };
  const path = paths[recurso];
  if(!path) throw new Error('Recurso inválido: '+recurso);
  
  const LIMITE = recurso === 'condutor' ? 200 : 100;
  // 🆕 v5: aumentado pra 200 páginas (até 20k registros) pra sync retroativo
  const MAX_PAGINAS = recurso === 'solicitacao' ? 200 : 50;
  
  let todos = [];
  let pagina = 1;
  
  while(pagina <= MAX_PAGINAS){
    let url = BASE_URL + path + '?pagina=' + pagina + '&limite=' + LIMITE;
    
    if(recurso === 'solicitacao' && dataInicio){
      const dIni = dataInicio.toISOString();
      url += '&data_hora_solicitacao_min=' + encodeURIComponent(dIni);
    }
    
    const r = await fetch(url, { method: 'GET', headers: headers });
    if(!r.ok){
      if(pagina === 1){
        const txt = await r.text().catch(() => '');
        throw new Error('Machine '+recurso+' HTTP '+r.status+(txt ? ': '+txt.substring(0,200) : ''));
      }
      break;
    }
    
    const data = await r.json();
    if(!data || data.success === false){
      if(pagina === 1) throw new Error('Machine '+recurso+' retornou success=false');
      break;
    }
    
    const lote = data.response || [];
    if(!Array.isArray(lote) || lote.length === 0) break;
    
    if(pagina > 1 && lote.length && todos.some(x => x.id === lote[0].id)) break;
    
    todos = todos.concat(lote);
    if(lote.length < LIMITE) break;
    pagina++;
  }
  
  return todos;
}

async function salvarLote(tabela, dados, onConflict){
  if(!dados || dados.length === 0) return 0;
  const TAM_LOTE = 500;
  let total = 0;
  for(let i = 0; i < dados.length; i += TAM_LOTE){
    const lote = dados.slice(i, i + TAM_LOTE);
    const url = SUPA_URL+'/rest/v1/'+tabela+(onConflict ? '?on_conflict='+onConflict : '');
    const r = await fetch(url, {
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
    else {
      const txt = await r.text().catch(() => '');
      console.error('[salvarLote] '+tabela+' HTTP '+r.status+': '+txt.substring(0,200));
    }
  }
  return total;
}

// ====================================================================
// Sync de uma cidade
// 🆕 v5: aceita parâmetro diasForcar pra sync retroativo
// ====================================================================

async function syncCidade(cidade, diasForcar){
  const inicio = new Date();
  const inicioISO = inicio.toISOString();
  console.log('\n========================================');
  console.log('[SYNC] '+cidade.slug+' iniciado em', inicioISO);
  
  let diasSolicitados = null;
  
  try {
    let dataInicio;
    
    // 🆕 v5: se diasForcar passado, IGNORA o último timestamp e busca esse período
    if(diasForcar){
      dataInicio = new Date(Date.now() - diasForcar*24*60*60*1000);
      diasSolicitados = diasForcar;
      console.log('[SYNC] '+cidade.slug+' - RETROATIVO forçado '+diasForcar+' dias');
    } else {
      // Modo normal incremental
      dataInicio = await pegarUltimoTimestamp(cidade.slug);
      if(!dataInicio){
        dataInicio = new Date(Date.now() - 60*24*60*60*1000);
        diasSolicitados = 60;
        console.log('[SYNC] '+cidade.slug+' - primeira sync, pegando 60 dias');
      } else {
        dataInicio = new Date(dataInicio.getTime() - 2*24*60*60*1000);
        diasSolicitados = Math.ceil((Date.now() - dataInicio.getTime()) / (24*60*60*1000));
        console.log('[SYNC] '+cidade.slug+' - incremental desde', dataInicio.toISOString().split('T')[0]);
      }
    }
    
    const [corridas, condutores, empresas] = await Promise.all([
      buscarMachine(cidade.envSufixo, 'solicitacao', dataInicio),
      buscarMachine(cidade.envSufixo, 'condutor', null),
      buscarMachine(cidade.envSufixo, 'empresa', null)
    ]);
    
    console.log('[SYNC] '+cidade.slug+' Machine: '+corridas.length+' corridas, '+condutores.length+' condutores, '+empresas.length+' empresas');
    
    const corridasFmt = corridas.map(c => ({
      cidade_slug: cidade.slug,
      id_solicitacao: String(c.id || c.id_solicitacao || ''),
      data_hora_solicitacao: c.data_hora_solicitacao || c.data || null,
      nome_passageiro: c.nome_passageiro || '',
      valor_corrida: parseFloat(c.valor_corrida || c.valor || 0),
      status_solicitacao: c.status_solicitacao || c.status || '',
      condutor_id: (c.condutor_id && String(c.condutor_id).trim() !== '') ? String(c.condutor_id) : null,
      paradas_count: Array.isArray(c.paradas) ? c.paradas.length : 0,
      bandeira_chamada_id: (c.bandeira_chamada_id && String(c.bandeira_chamada_id).trim() !== '') ? String(c.bandeira_chamada_id) : null,
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
    
    const totalCorridas = await salvarLote('machine_corridas', corridasFmt, 'cidade_slug,id_solicitacao');
    const totalCondutores = await salvarLote('machine_condutores', condutoresFmt, 'cidade_slug,id');
    const totalEmpresas = await salvarLote('machine_empresas', empresasFmt, 'cidade_slug,id');
    
    console.log('[SYNC] '+cidade.slug+' OK: '+totalCorridas+' corridas, '+totalCondutores+' condutores, '+totalEmpresas+' empresas salvos');
    
    await logSync(cidade, 'concluido', {
      iniciado_em: inicioISO,
      dias_solicitados: diasSolicitados,
      corridas_inseridas: totalCorridas,
      corridas_erro: corridas.length - totalCorridas,
      condutores_inseridos: totalCondutores,
      empresas_inseridas: totalEmpresas,
      usuario: diasForcar ? 'sync-retroativo' : 'sync-automatico'
    });
    
    return { slug: cidade.slug, ok: true, corridas: totalCorridas, condutores: totalCondutores, empresas: totalEmpresas };
    
  } catch(err) {
    console.error('[SYNC] '+cidade.slug+' ERRO:', err.message);
    await logSync(cidade, 'erro', {
      iniciado_em: inicioISO,
      dias_solicitados: diasSolicitados,
      mensagem_erro: err.message,
      usuario: diasForcar ? 'sync-retroativo' : 'sync-automatico'
    });
    return { slug: cidade.slug, ok: false, erro: err.message };
  }
}

// ====================================================================
// Handler principal (Background Function)
// 🆕 v5: aceita ?cidade=X&dias=Y via query string pra sync retroativo
// ====================================================================

exports.handler = async function(event){
  // 🆕 v5: parse de query params
  const params = (event && event.queryStringParameters) || {};
  const cidadeAlvo = params.cidade ? String(params.cidade).toLowerCase() : null;
  const diasForcar = params.dias ? parseInt(params.dias) : null;
  
  console.log('\n#####################################################');
  console.log('# SYNC '+(diasForcar ? 'RETROATIVO ('+diasForcar+' dias)' : 'DIARIO AUTOMATICO v5'));
  if(cidadeAlvo) console.log('# Cidade alvo: '+cidadeAlvo);
  console.log('# Inicio:', new Date().toISOString());
  console.log('#####################################################\n');
  
  // Filtra cidades alvo (se especificou)
  let cidadesPraRodar = CIDADES;
  if(cidadeAlvo){
    cidadesPraRodar = CIDADES.filter(c => c.slug === cidadeAlvo);
    if(cidadesPraRodar.length === 0){
      console.warn('[WARN] Cidade não encontrada: '+cidadeAlvo);
      return { 
        statusCode: 404, 
        body: JSON.stringify({ ok: false, error: 'Cidade não encontrada', cidades_validas: CIDADES.map(c => c.slug) }) 
      };
    }
  }
  
  const resultados = [];
  
  for(const cidade of cidadesPraRodar){
    const r = await syncCidade(cidade, diasForcar);
    resultados.push(r);
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
    body: JSON.stringify({ ok: true, resultados, retroativo: !!diasForcar, dias: diasForcar }) 
  };
};

// Marca como Background Function (timeout 15min)
exports.config = {
  schedule: '@daily'
};
