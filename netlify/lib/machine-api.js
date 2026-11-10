// netlify/lib/machine-api.js
// Busca as corridas de UM dia de uma cidade direto na API da Machine (Gaudium), do mesmo jeito que
// netlify/functions/machine.js (mesmos parâmetros de data: foi esse recorte que bateu com a planilha
// MOTOBOYS). Credenciais = as mesmas env vars de sempre (MACHINE_API_KEY_<CIDADE>, MACHINE_USER/PASS).
// Devolve só o necessário: id, data/hora, motoboy, valor e status (sem passageiro, sem endereço).
'use strict';
const BASE_URL = 'https://api.taximachine.com.br/api/integracao';

function sufixo(slug){
  return String(slug || '').toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '_').replace(/-/g, '_').toUpperCase();
}
function credenciais(slug){
  const s = sufixo(slug);
  if(!/^[A-Z_]{2,40}$/.test(s)) return null;
  const apiKey = process.env['MACHINE_API_KEY_' + s];
  const user = process.env['MACHINE_USER_' + s] || process.env.MACHINE_USER;
  const pass = process.env['MACHINE_PASS_' + s] || process.env.MACHINE_PASS;
  return apiKey && user && pass ? { apiKey, user, pass } : null;
}

// dia = 'aaaa-mm-dd'. Lança erro com mensagem amigável se não conseguir.
async function corridasDoDia(slug, dia, tempoMaxMs){
  const cred = credenciais(slug);
  if(!cred) throw new Error('Essa cidade não tem as credenciais da Machine configuradas');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(dia)) throw new Error('Dia inválido');
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'api-key': cred.apiKey,
    Authorization: 'Basic ' + Buffer.from(cred.user + ':' + cred.pass).toString('base64') };
  const LIMITE = 100, MAX_PAG = 150, inicio = Date.now(), tempoMax = tempoMaxMs || 21000;
  const vistos = new Set(), saida = [];
  let completo = true;
  for(let p = 1; p <= MAX_PAG; p++){
    if(Date.now() - inicio > tempoMax){ completo = false; break; }
    const url = BASE_URL + '/solicitacao?pagina=' + p + '&limite=' + LIMITE +
      '&data_hora_solicitacao_min=' + encodeURIComponent(dia + 'T00:00:00.000Z') + '&data_hora_solicitacao_max=' + encodeURIComponent(dia + 'T23:59:59.999Z');
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
    let j;
    try { const r = await fetch(url, { headers, signal: ctrl.signal }); j = await r.json(); if(!r.ok || !j || j.success === false) throw new Error('HTTP ' + r.status); }
    catch(e){ clearTimeout(t); if(p === 1) throw new Error('A Machine não respondeu (' + (e.name === 'AbortError' ? 'demorou demais' : 'erro') + '). Tente de novo.'); completo = false; break; }
    clearTimeout(t);
    const lote = Array.isArray(j.response) ? j.response : [];
    if(!lote.length) break;
    if(p > 1 && lote.every(x => vistos.has(String(x.id)))) break;   // página inteira repetida: a API voltou ao começo, acabou
    for(const x of lote){
      const id = String(x.id || ''); if(!id || vistos.has(id)) continue; vistos.add(id);
      const cond = String(x.condutor_id || x.taxista_id || '').trim();
      if(!cond) continue;
      const v = Number(x.valor_corrida); if(!isFinite(v)) continue;
      saida.push({ id: id.slice(0, 40).replace(/[^0-9A-Za-z_-]/g, ''), data_hora: String(x.data_hora_solicitacao || '').slice(0, 25),
        condutor_id: cond.slice(0, 40), condutor_nome: String(x.nome_condutor || x.nome_taxista || '').trim().slice(0, 200),
        valor: Math.round(v * 100) / 100, status: String(x.status_solicitacao || '').slice(0, 5) });
    }
    if(lote.length < LIMITE) break;
    if(p === MAX_PAG) completo = false;
  }
  return { corridas: saida, completo };
}

module.exports = { corridasDoDia, credenciais, sufixo };
