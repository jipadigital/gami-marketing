// netlify/functions/backup-diario-background.js
// Roda TODO DIA às 5h da manhã (8h UTC)
// Snapshot completo das tabelas operacionais
// Mantém 60 dias de histórico (limpeza automática)
// ============================================================

const { schedule } = require('@netlify/functions');

const SUPA_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY || 'sb_publishable_0y-oz0aght1rNQNQrsh2tA_EfHajL61';

const handler = async function(event) {
  const inicio = Date.now();
  console.log('💾 Backup diário iniciado às', new Date().toISOString());
  
  try {
    const r = await fetch(SUPA_URL+'/rest/v1/rpc/gerar_backup_diario', {
      method: 'POST',
      headers: {
        'apikey': SUPA_SERVICE_KEY,
        'Authorization': 'Bearer '+SUPA_SERVICE_KEY,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    
    if(!r.ok){
      const txt = await r.text();
      console.error('❌ Backup falhou:', txt);
      
      // Registra alerta crítico
      try {
        await fetch(SUPA_URL+'/rest/v1/alertas_log', {
          method: 'POST',
          headers: {
            'apikey': SUPA_SERVICE_KEY,
            'Authorization': 'Bearer '+SUPA_SERVICE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify([{
            tipo: 'backup_falhou',
            severidade: 'critico',
            origem: 'backup-diario-background',
            mensagem: 'Backup diário não conseguiu rodar',
            detalhes: { status: r.status, erro: txt.substring(0, 500) }
          }])
        });
      } catch(e){}
      
      return { statusCode: 500, body: JSON.stringify({ ok: false, erro: txt }) };
    }
    
    const data = await r.json();
    const duracao = Math.round((Date.now() - inicio) / 1000);
    console.log('✅ Backup diário concluído em', duracao+'s:', JSON.stringify(data));
    
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, duracao_seg: duracao, resultado: data })
    };
    
  } catch(e){
    console.error('❌ Backup error:', e.message);
    
    // Registra alerta crítico
    try {
      await fetch(SUPA_URL+'/rest/v1/alertas_log', {
        method: 'POST',
        headers: {
          'apikey': SUPA_SERVICE_KEY,
          'Authorization': 'Bearer '+SUPA_SERVICE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify([{
          tipo: 'backup_erro',
          severidade: 'critico',
          origem: 'backup-diario-background',
          mensagem: 'Backup diário lançou exception',
          detalhes: { erro: e.message }
        }])
      });
    } catch(e2){}
    
    return { statusCode: 500, body: JSON.stringify({ ok: false, erro: e.message }) };
  }
};

// Roda todo dia às 8h UTC = 5h Brasília
exports.handler = schedule('0 8 * * *', handler);
