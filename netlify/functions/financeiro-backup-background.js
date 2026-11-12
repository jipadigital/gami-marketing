// netlify/functions/financeiro-backup-background.js
// 💾 Backup DIÁRIO do financeiro (todas as tabelas fin_*) num bucket PRIVADO
// do Supabase Storage (fin-backups). Nunca sobrescreve e nunca apaga: cada dia
// é um arquivo novo. Junto vai o "último hash" da auditoria: se um dia alguém
// mexer no banco por fora, dá pra provar comparando com o backup.
// Agendado no netlify.toml (10h UTC = 7h Brasília).
// ============================================================
'use strict';
const { schedule } = require('@netlify/functions');
const zlib = require('zlib');

// Lê do banco EXCLUSIVO do financeiro (FIN_SUPA_URL) e grava a cópia em DOIS lugares:
// o cofre do próprio banco do financeiro e o cofre do banco do dashboard (redundância:
// se um projeto inteiro tiver problema, o outro ainda tem todos os dias de backup).
const MAIN_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
const MAIN_KEY = process.env.SUPA_SERVICE_KEY;
// Liga o banco exclusivo quando existe FIN_SUPA_SERVICE_KEY (URL fixa aqui: limite de 4 KB de env vars)
const EXCLUSIVO = !!process.env.FIN_SUPA_SERVICE_KEY;
const SUPA_URL = EXCLUSIVO ? (process.env.FIN_SUPA_URL || 'https://vyjjdirlgvysbalrmmih.supabase.co') : MAIN_URL;
const KEY = EXCLUSIVO ? process.env.FIN_SUPA_SERVICE_KEY : MAIN_KEY;
const hMain = extra => Object.assign({ apikey: MAIN_KEY, Authorization: 'Bearer ' + MAIN_KEY }, extra || {});
const TABELAS = ['fin_config', 'fin_acesso', 'fin_contas', 'fin_importacoes', 'fin_extrato', 'fin_conferencias',
                 'fin_lancamentos', 'fin_conciliacoes', 'fin_alertas', 'fin_benef_confiaveis', 'fin_auditoria',
                 // v2 (réplica do Kamino); se a tabela não existir ainda, o backup pula e avisa
                 'fin_unidades', 'fin_centros_custo', 'fin_classificacoes', 'fin_pessoas', 'fin_baixas', 'fin_transferencias',
                 'fin_regras_extrato', 'fin_anexos', 'fin_entradas',
                 // v3 (FLYP): vai pros mesmos cofres privados
                 'fin_flyp_importacoes', 'fin_flyp_transacoes', 'fin_flyp_acesso', 'fin_flyp_leituras',
                 // v4 (Controles: Empresas semanal, Créditos) + equipe
                 'fin_ctl_importacoes', 'fin_ctl_cobrancas', 'fin_ctl_cob_receb', 'fin_ctl_creditos', 'fin_ctl_conferencias', 'fin_equipe',
                 // v5 (as outras planilhas)
                 'fin_ctl_registros', 'fin_ctl_reg_pag',
                 // v6 (Motoboys pela Machine)
                 'fin_ctl_machine_dias', 'fin_ctl_machine_corridas',
                 // v7 (contas recorrentes)
                 'fin_recorrencias'];
// dado da FLYP NUNCA sai do banco exclusivo: a 2ª cópia (no banco do dashboard) vai sem essas tabelas
const SO_NO_EXCLUSIVO = /^fin_flyp_/;
const ORDEM = { fin_config: 'chave', fin_acesso: 'pessoa_id', fin_flyp_acesso: 'pessoa_id', fin_flyp_importacoes: 'importado_em',
                fin_ctl_importacoes: 'importado_em', fin_equipe: 'pessoa_id', fin_ctl_machine_dias: 'dia', fin_ctl_machine_corridas: 'corrida_id', fin_contas: 'id', fin_importacoes: 'importado_em', fin_auditoria: 'seq' };
const h = extra => Object.assign({ apikey: KEY, Authorization: 'Bearer ' + KEY }, extra || {});

async function lerTabela(t){
  let out = [];
  for(let off = 0; off < 2000000; off += 1000){
    const r = await fetch(SUPA_URL + '/rest/v1/' + t + '?select=*&order=' + (ORDEM[t] || 'id') + '.asc', { headers: h({ 'Range-Unit': 'items', Range: off + '-' + (off + 999) }) });
    if(!r.ok) throw new Error(t + ': HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const pg = await r.json();
    out = out.concat(pg);
    if(pg.length < 1000) break;
  }
  return out;
}

const handler = async function(){
  if(!KEY) return { statusCode: 500, body: 'sem SUPA_SERVICE_KEY' };
  const inicio = Date.now();
  try {
    const dump = { gerado_em: new Date().toISOString(), versao: 1, tabelas: {}, contagens: {} };
    dump.faltando = [];
    for(const t of TABELAS){
      try { dump.tabelas[t] = await lerTabela(t); dump.contagens[t] = dump.tabelas[t].length; }
      catch(e){ if(/404|PGRST205|does not exist/.test(e.message)) dump.faltando.push(t); else throw e; }
    }
    dump.banco = EXCLUSIVO ? 'exclusivo' : 'dashboard';
    const aud = dump.tabelas.fin_auditoria;
    dump.ultimo_hash_auditoria = aud.length ? aud[aud.length - 1].hash : null;
    const ri = await fetch(SUPA_URL + '/rest/v1/rpc/fin_verificar_cadeia', { method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: '{}' });
    dump.integridade = ri.ok ? await ri.json() : { ok: false, erro: 'HTTP ' + ri.status };

    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(dump)));
    const d = new Date(Date.now() - 3 * 3600e3).toISOString();
    const caminho = d.slice(0, 4) + '/' + d.slice(5, 7) + '/fin-' + d.slice(0, 10) + '-' + d.slice(11, 19).replace(/:/g, '') + '.json.gz';
    const up = await fetch(SUPA_URL + '/storage/v1/object/fin-backups/' + caminho, {
      method: 'POST', headers: h({ 'Content-Type': 'application/gzip', 'x-upsert': 'false' }), body: gz
    });
    if(!up.ok) throw new Error('upload: HTTP ' + up.status + ' ' + (await up.text()).slice(0, 200));
    // 2ª cópia no banco do dashboard (só quando o financeiro está num banco separado)
    if(EXCLUSIVO && MAIN_KEY){
      const copia = Object.assign({}, dump, { tabelas: {}, contagens: {}, sem_flyp: true });
      Object.keys(dump.tabelas).forEach(t => { if(!SO_NO_EXCLUSIVO.test(t)){ copia.tabelas[t] = dump.tabelas[t]; copia.contagens[t] = dump.contagens[t]; } });
      const gz2 = zlib.gzipSync(Buffer.from(JSON.stringify(copia)));
      const up2 = await fetch(MAIN_URL + '/storage/v1/object/fin-backups/' + caminho, { method: 'POST', headers: hMain({ 'Content-Type': 'application/gzip', 'x-upsert': 'false' }), body: gz2 });
      if(!up2.ok) await alertar('Backup do financeiro: 2ª cópia (banco do dashboard) falhou', { status: up2.status });
    }
    console.log('✅ backup financeiro', caminho, JSON.stringify(dump.contagens), 'integridade=' + JSON.stringify(dump.integridade), Math.round((Date.now() - inicio) / 1000) + 's');
    if(dump.integridade && dump.integridade.ok === false) await alertar('Cadeia de auditoria do financeiro QUEBRADA', dump.integridade);
    return { statusCode: 200, body: JSON.stringify({ ok: true, caminho, contagens: dump.contagens }) };
  } catch(e){
    console.error('❌ backup financeiro falhou:', e.message);
    await alertar('Backup do financeiro falhou', { erro: e.message });
    return { statusCode: 500, body: JSON.stringify({ ok: false, erro: e.message }) };
  }
};

async function alertar(msg, det){
  try {
    await fetch(MAIN_URL + '/rest/v1/alertas_log', {
      method: 'POST', headers: hMain({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify([{ tipo: 'financeiro_backup', severidade: 'critico', origem: 'financeiro-backup-background', mensagem: msg, detalhes: det }])
    });
  } catch(e){}
}

exports.handler = schedule('0 10 * * *', handler);
