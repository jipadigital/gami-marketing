// netlify/functions/backfill-corridas.js
// -----------------------------------------------------------------------------
// BACKFILL MANUAL de corridas (machine_corridas) — funcao NORMAL, invocavel via HTTP.
// Existe porque sync-diario-background e SCHEDULED (Netlify bloqueia HTTP = 403).
// Puxa as corridas da taximachine (recurso solicitacao) num periodo e faz upsert
// com a SERVICE KEY (anon nao escreve em machine_corridas por RLS).
//
// Uso:
//   /.netlify/functions/backfill-corridas?cidade=vitoria&dias=20
//   /.netlify/functions/backfill-corridas?cidade=vitoria&ini=2026-08-24&fim=2026-09-01
//
// Timeout de funcao normal (~26s no Pro): pra periodos grandes, fatie com ini/fim.
// TEMPORARIO: remover depois que o backfill da Vitoria estiver concluido.
// -----------------------------------------------------------------------------

const SUPA_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
const BASE_URL = 'https://api.taximachine.com.br/api/integracao';

function sufixoDe(cidade){
  return String(cidade || '').toLowerCase().trim()
    .normalize('NFD').replace(/[̀-ͯ]/g,'')
    .replace(/ç/g,'c').replace(/\s+/g,'_').replace(/-/g,'_').toUpperCase();
}

exports.handler = async function(event){
  const p = (event && event.queryStringParameters) || {};
  const cidade = (p.cidade || 'vitoria').toLowerCase();
  const sufixo = sufixoDe(cidade);
  const dias = p.dias ? parseInt(p.dias) : 20;

  const apiKey = process.env['MACHINE_API_KEY_' + sufixo];
  const user   = process.env['MACHINE_USER_' + sufixo] || process.env.MACHINE_USER;
  const pass   = process.env['MACHINE_PASS_' + sufixo] || process.env.MACHINE_PASS;
  if(!apiKey || !user || !pass){
    return { statusCode:400, body: JSON.stringify({ ok:false, error:'creds ausentes', sufixo }) };
  }
  if(!SUPA_SERVICE_KEY){
    return { statusCode:500, body: JSON.stringify({ ok:false, error:'SUPA_SERVICE_KEY ausente no ambiente' }) };
  }

  const dIni = p.ini ? new Date(p.ini + 'T00:00:00.000Z') : new Date(Date.now() - dias*24*60*60*1000);
  const dFim = p.fim ? new Date(p.fim + 'T23:59:59.999Z') : null;

  const headers = {
    'Content-Type':'application/json', 'Accept':'application/json',
    'api-key': apiKey,
    'Authorization': 'Basic ' + Buffer.from(user + ':' + pass).toString('base64')
  };

  // 1) Puxa corridas paginando
  const LIMITE = 100, MAX_PAGINAS = 200, INICIO = Date.now(), TEMPO_MAX = 22000;
  let todos = [], pagina = 1, truncado = false;
  try {
    while(pagina <= MAX_PAGINAS){
      if(Date.now() - INICIO > TEMPO_MAX){ truncado = true; break; }
      let url = BASE_URL + '/solicitacao?pagina=' + pagina + '&limite=' + LIMITE
        + '&data_hora_solicitacao_min=' + encodeURIComponent(dIni.toISOString());
      if(dFim) url += '&data_hora_solicitacao_max=' + encodeURIComponent(dFim.toISOString());
      const r = await fetch(url, { method:'GET', headers });
      if(!r.ok){
        const txt = await r.text().catch(()=> '');
        if(pagina === 1) return { statusCode: r.status, body: JSON.stringify({ ok:false, error:'Machine HTTP '+r.status, detalhe: txt.slice(0,200) }) };
        break;
      }
      const data = await r.json();
      if(!data || data.success === false){ if(pagina===1) return { statusCode:502, body: JSON.stringify({ ok:false, error:'success=false', detalhe:data }) }; break; }
      const lote = data.response || [];
      if(!Array.isArray(lote) || lote.length === 0) break;
      if(pagina > 1 && lote.length && todos.some(x => x.id === lote[0].id)) break;
      todos = todos.concat(lote);
      if(lote.length < LIMITE) break;
      pagina++;
    }
  } catch(e){
    return { statusCode:504, body: JSON.stringify({ ok:false, error:'fetch falhou', detalhe:String(e), parciais: todos.length }) };
  }

  // 2) Mapeia (igual sync-diario-background)
  const corridasFmt = todos.map(c => ({
    cidade_slug: cidade,
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

  // 3) Upsert com service key
  let inseridas = 0;
  const TAM = 500;
  for(let i = 0; i < corridasFmt.length; i += TAM){
    const lote = corridasFmt.slice(i, i + TAM);
    const r = await fetch(SUPA_URL+'/rest/v1/machine_corridas?on_conflict=cidade_slug,id_solicitacao', {
      method:'POST',
      headers: { 'apikey':SUPA_SERVICE_KEY, 'Authorization':'Bearer '+SUPA_SERVICE_KEY, 'Content-Type':'application/json', 'Prefer':'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(lote)
    });
    if(r.ok) inseridas += lote.length;
    else { const t = await r.text().catch(()=> ''); return { statusCode:500, body: JSON.stringify({ ok:false, error:'upsert HTTP '+r.status, detalhe:t.slice(0,200), inseridas }) }; }
  }

  return { statusCode:200, body: JSON.stringify({
    ok:true, cidade, periodo:{ ini: dIni.toISOString().slice(0,10), fim: dFim ? dFim.toISOString().slice(0,10) : 'agora' },
    corridas_puxadas: todos.length, corridas_gravadas: inseridas, paginas: pagina, truncado
  }) };
};
