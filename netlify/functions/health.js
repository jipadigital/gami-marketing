// netlify/functions/health.js
// Endpoint público de saúde do sistema
// GET /api/health → retorna JSON com status geral
// ============================================================

const SUPA_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
const SUPA_ANON_KEY = process.env.SUPA_PUBLIC_KEY || 'sb_publishable_0y-oz0aght1rNQNQrsh2tA_EfHajL61';

exports.handler = async function(event){
  var cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };
  
  if(event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if(event.httpMethod !== 'GET') return { statusCode: 405, headers: cors, body: JSON.stringify({error:'Use GET'}) };
  
  var status = {
    ok: true,
    timestamp: new Date().toISOString(),
    versao: 'v23.62',
    checks: {}
  };
  
  // Check 1: Supabase
  try {
    var t0 = Date.now();
    var r = await fetch(SUPA_URL+'/rest/v1/machine_corridas?select=cidade_slug&limit=1', {
      headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': 'Bearer '+SUPA_ANON_KEY }
    });
    status.checks.supabase = {
      status: r.ok ? 'ok' : 'falha',
      latencia_ms: Date.now() - t0,
      http: r.status
    };
    if(!r.ok) status.ok = false;
  } catch(e){
    status.checks.supabase = { status: 'falha', erro: e.message };
    status.ok = false;
  }
  
  // Check 2: Estatísticas do sistema (via função SQL)
  try {
    var r2 = await fetch(SUPA_URL+'/rest/v1/rpc/sistema_health', {
      method:'POST',
      headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': 'Bearer '+SUPA_ANON_KEY, 'Content-Type':'application/json' },
      body: '{}'
    });
    if(r2.ok){
      var dados = await r2.json();
      var stats = {};
      if(Array.isArray(dados)){
        dados.forEach(function(d){ stats[d.indicador] = { valor: d.valor, status: d.status }; });
      }
      status.checks.estatisticas = stats;
    }
  } catch(e){
    status.checks.estatisticas = { erro: e.message };
  }
  
  // Check 3: Configuração do Netlify
  status.checks.servidor = {
    status: 'ok',
    service_key_configurada: !!process.env.SUPA_SERVICE_KEY,
    machine_user_configurado: !!process.env.MACHINE_USER,
    anthropic_key_configurada: !!process.env.ANTHROPIC_API_KEY
  };
  if(!process.env.SUPA_SERVICE_KEY){
    status.ok = false;
    status.checks.servidor.status = 'falha';
  }
  
  return {
    statusCode: status.ok ? 200 : 503,
    headers: cors,
    body: JSON.stringify(status, null, 2)
  };
};
