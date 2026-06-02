// netlify/functions/backup-semanal-background.js
// Roda aos domingos às 4h da manhã (7h UTC)
// Gera snapshot semanal das contagens + limpa rate_limit antigos
// ============================================================

const { schedule } = require('@netlify/functions');

const SUPA_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY || 'sb_publishable_0y-oz0aght1rNQNQrsh2tA_EfHajL61';

const handler = async function(event) {
  const inicio = Date.now();
  console.log('📦 Backup semanal iniciado às', new Date().toISOString());
  
  const resultado = { ok: true, etapas: [] };
  
  // Etapa 1: gerar backup semanal
  try {
    const r = await fetch(SUPA_URL+'/rest/v1/rpc/gerar_backup_semanal', {
      method: 'POST',
      headers: {
        'apikey': SUPA_SERVICE_KEY,
        'Authorization': 'Bearer '+SUPA_SERVICE_KEY,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    if(r.ok){
      const data = await r.json();
      resultado.etapas.push({ etapa: 'gerar_backup_semanal', ok: true, dados: data });
      console.log('✓ Backup semanal gerado:', JSON.stringify(data));
    } else {
      const txt = await r.text();
      resultado.etapas.push({ etapa: 'gerar_backup_semanal', ok: false, erro: txt });
      resultado.ok = false;
    }
  } catch(e){
    resultado.etapas.push({ etapa: 'gerar_backup_semanal', ok: false, erro: e.message });
    resultado.ok = false;
  }
  
  // Etapa 2: limpar rate_limit antigo
  try {
    const r = await fetch(SUPA_URL+'/rest/v1/rpc/limpar_rate_limit_antigo', {
      method: 'POST',
      headers: {
        'apikey': SUPA_SERVICE_KEY,
        'Authorization': 'Bearer '+SUPA_SERVICE_KEY,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    if(r.ok){
      const data = await r.json();
      resultado.etapas.push({ etapa: 'limpar_rate_limit', ok: true, removidos: data });
      console.log('✓ Rate limit antigo removido:', data);
    }
  } catch(e){
    resultado.etapas.push({ etapa: 'limpar_rate_limit', ok: false, erro: e.message });
  }
  
  // Etapa 3: limpar sessões expiradas
  try {
    const r = await fetch(SUPA_URL+'/rest/v1/rpc/limpar_sessoes_expiradas', {
      method: 'POST',
      headers: {
        'apikey': SUPA_SERVICE_KEY,
        'Authorization': 'Bearer '+SUPA_SERVICE_KEY,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    if(r.ok){
      const data = await r.json();
      resultado.etapas.push({ etapa: 'limpar_sessoes', ok: true, removidas: data });
      console.log('✓ Sessões expiradas removidas:', data);
    }
  } catch(e){
    resultado.etapas.push({ etapa: 'limpar_sessoes', ok: false, erro: e.message });
  }
  
  resultado.duracao_seg = Math.round((Date.now() - inicio) / 1000);
  console.log('📦 Backup semanal concluído em', resultado.duracao_seg, 's');
  
  return {
    statusCode: 200,
    body: JSON.stringify(resultado)
  };
};

// Roda aos domingos às 7h UTC = 4h Brasília
exports.handler = schedule('0 7 * * 0', handler);
