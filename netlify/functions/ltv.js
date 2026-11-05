// netlify/functions/ltv.js
// Estudo LTV + CAC + CHURN por cidade/parceiro (dados SENSÍVEIS). Entrega/escreve só se a
// sessão for de um AUTORIZADO: Matheus + diretoria (sem o Carlos) OU super_admin. Validação
// 100% no servidor; nem a chave pública lê/escreve. Service key (bypassa RLS).
// Ações (POST body { acao }):
//   'dados' (padrão) -> cidades + meses (v_ltv_metricas_mes: ativas/novos/CAC/churn) + empresas
//   'set_custo'      -> grava custo de vendas+mkt (crm_ltv_custos) de uma cidade/mês
//   'detalhe'        -> lista de NOVOS e de PARADOS de uma cidade/mês (mv_ltv_empresa_mes)
// ============================================================

const SUPA_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
const SUPER_ADMIN_EMAIL = 'jipadigital@gmail.com';

// Quem vê/edita o LTV (pessoa_id). Matheus + diretoria. Carlos NÃO entra (pedido do dono).
const ALLOWLIST = ['pe001', 'pe002', 'pe003', 'pematheusfedrizzi'];

const ORIGENS_PERMITIDAS = [
  'https://gami-marketing.netlify.app',
  'http://localhost:8888',
  'http://localhost:3000'
];
function corsHeaders(origin){
  var permitido = ORIGENS_PERMITIDAS.indexOf(origin) >= 0 ? origin : ORIGENS_PERMITIDAS[0];
  return {
    'Access-Control-Allow-Origin': permitido,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Gami-User, X-Gami-Token',
    'Content-Type': 'application/json'
  };
}
function svc(extra){ return Object.assign({ 'apikey': SUPA_SERVICE_KEY, 'Authorization': 'Bearer '+SUPA_SERVICE_KEY }, extra||{}); }

// aceita o token no token_atual OU na lista sessoes_ativas (multi-dispositivo)
function tokenAtivo(u, token){
  var agora = new Date();
  if(u.token_atual && u.token_atual === token && (!u.token_expira_em || new Date(u.token_expira_em) >= agora)) return true;
  if(Array.isArray(u.sessoes_ativas)){
    for(var i=0;i<u.sessoes_ativas.length;i++){ var s=u.sessoes_ativas[i];
      if(s && s.t === token && (!s.e || new Date(s.e) >= agora)) return true; }
  }
  return false;
}

async function lerTudo(tabela, select, order){
  var out = [];
  for(var off=0; off<60000; off+=1000){
    var r = await fetch(SUPA_URL + '/rest/v1/' + tabela + '?select=' + select + (order?('&order='+order):''), {
      headers: svc({ 'Range-Unit':'items', 'Range': off + '-' + (off+999) })
    });
    if(!r.ok){ if(off===0){ var t=await r.text().catch(function(){return '';}); throw new Error('Falha ao ler '+tabela+' (rodou o ltv-cac-churn.sql?): '+t.slice(0,160)); } break; }
    var pg = await r.json();
    if(!Array.isArray(pg) || !pg.length) break;
    out = out.concat(pg);
    if(pg.length < 1000) break;
  }
  return out;
}

// 'YYYY-MM' do mês anterior
function mesAnterior(ym){
  var p = (ym||'').split('-'); if(p.length<2) return '';
  var y = parseInt(p[0],10), m = parseInt(p[1],10) - 1; if(m<1){ m=12; y--; }
  return y + '-' + String(m).padStart(2,'0');
}

// Agrega por parceiro no período via RPC ltv_periodo (GROUP BY no servidor, bounded pelo
// nº de parceiros). PAGINA porque o PostgREST corta em 1000 linhas e cidade grande tem mais.
async function periodoCidade(cid, de, ate){
  var rows = [];
  for(var off=0; off<60000; off+=1000){
    var r = await fetch(SUPA_URL + '/rest/v1/rpc/ltv_periodo?limit=1000&offset=' + off, {
      method:'POST', headers: svc({ 'Content-Type':'application/json' }),
      body: JSON.stringify({ p_cidade_slug: cid, p_de: de, p_ate: ate })
    });
    if(!r.ok){ if(off===0){ var t=await r.text().catch(function(){return '';}); throw new Error('Falha ltv_periodo (rodou o ltv-periodo.sql?): '+t.slice(0,140)); } break; }
    var pg = await r.json();
    if(!Array.isArray(pg) || !pg.length) break;
    rows = rows.concat(pg);
    if(pg.length < 1000) break;
  }
  return rows;
}

exports.handler = async function(event){
  const origin = event.headers.origin || event.headers.Origin || '';
  const cors = corsHeaders(origin);
  if(event.httpMethod === 'OPTIONS') return { statusCode:204, headers:cors, body:'' };
  if(event.httpMethod !== 'POST') return { statusCode:405, headers:cors, body:JSON.stringify({ ok:false, erro:'Use POST' }) };
  if(!SUPA_SERVICE_KEY) return { statusCode:500, headers:cors, body:JSON.stringify({ ok:false, erro:'Servidor sem SUPA_SERVICE_KEY' }) };

  const callerId = event.headers['x-gami-user'] || event.headers['X-Gami-User'] || '';
  const callerToken = event.headers['x-gami-token'] || event.headers['X-Gami-Token'] || '';
  if(!callerId) return { statusCode:401, headers:cors, body:JSON.stringify({ ok:false, erro:'Sessão não informada' }) };

  var body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch(e){ body = {}; }
  var acao = body.acao || 'dados';

  try {
    const rC = await fetch(SUPA_URL + '/rest/v1/usuarios_login?pessoa_id=eq.' + encodeURIComponent(callerId) + '&select=*&limit=1', { headers: svc() });
    if(!rC.ok) return { statusCode:500, headers:cors, body:JSON.stringify({ ok:false, erro:'Falha ao validar sessão' }) };
    const arrC = await rC.json();
    if(!Array.isArray(arrC) || !arrC.length) return { statusCode:401, headers:cors, body:JSON.stringify({ ok:false, erro:'Sessão não encontrada' }) };
    const caller = arrC[0];
    if(caller.ativo === false) return { statusCode:403, headers:cors, body:JSON.stringify({ ok:false, erro:'Usuário desativado' }) };
    if(!tokenAtivo(caller, callerToken)) return { statusCode:401, headers:cors, body:JSON.stringify({ ok:false, erro:'Sessão expirada (faça login de novo)' }) };

    const ehSuper = String(caller.email || '').toLowerCase() === SUPER_ADMIN_EMAIL;
    const autorizado = ehSuper || ALLOWLIST.indexOf(callerId) >= 0;
    if(!autorizado) return { statusCode:403, headers:cors, body:JSON.stringify({ ok:false, erro:'Sem permissão para ver o LTV' }) };

    // ---- AÇÃO: gravar custo de vendas+marketing (cidade/mês) ----
    if(acao === 'set_custo'){
      var cidade = String(body.cidade_slug||'').trim();
      var mes = String(body.mes||'').trim();
      var custo = Number(body.custo);
      if(!cidade || !/^\d{4}-\d{2}$/.test(mes)) return { statusCode:400, headers:cors, body:JSON.stringify({ ok:false, erro:'cidade_slug e mes (YYYY-MM) obrigatórios' }) };
      if(!isFinite(custo) || custo < 0) return { statusCode:400, headers:cors, body:JSON.stringify({ ok:false, erro:'custo inválido' }) };
      var rUp = await fetch(SUPA_URL + '/rest/v1/crm_ltv_custos?on_conflict=cidade_slug,mes', {
        method:'POST',
        headers: svc({ 'Content-Type':'application/json', 'Prefer':'resolution=merge-duplicates,return=representation' }),
        body: JSON.stringify([{ cidade_slug:cidade, mes:mes, custo:custo, atualizado_por:callerId, atualizado_em:new Date().toISOString() }])
      });
      if(!rUp.ok){ var tu=await rUp.text().catch(function(){return '';}); return { statusCode:500, headers:cors, body:JSON.stringify({ ok:false, erro:'Falha ao gravar custo: '+tu.slice(0,160) }) }; }
      var up = await rUp.json().catch(function(){return [];});
      return { statusCode:200, headers:cors, body:JSON.stringify({ ok:true, custo: (Array.isArray(up)&&up[0])||null }) };
    }

    // ---- AÇÃO: detalhe (novos + parados de uma cidade/mês) ----
    if(acao === 'detalhe'){
      var dcid = String(body.cidade_slug||'').trim();
      var dmes = String(body.mes||'').trim();
      if(!dcid || !/^\d{4}-\d{2}$/.test(dmes)) return { statusCode:400, headers:cors, body:JSON.stringify({ ok:false, erro:'cidade_slug e mes obrigatórios' }) };
      var dant = mesAnterior(dmes);
      var rEm = await fetch(SUPA_URL + '/rest/v1/mv_ltv_empresa_mes?cidade_slug=eq.'+encodeURIComponent(dcid)+'&select=parceiro,parceiro_key,mes,pedidos,gmv&limit=50000', { headers: svc() });
      var lin = rEm.ok ? await rEm.json() : [];
      // 1º mês de cada parceiro
      var primeiro = {};
      lin.forEach(function(x){ var k=x.parceiro_key; if(!primeiro[k] || x.mes < primeiro[k]) primeiro[k]=x.mes; });
      var noMes = {}, noAnt = {};
      lin.forEach(function(x){ if(x.mes===dmes) noMes[x.parceiro_key]={nome:x.parceiro,pedidos:x.pedidos,gmv:x.gmv}; if(x.mes===dant) noAnt[x.parceiro_key]={nome:x.parceiro,pedidos:x.pedidos,gmv:x.gmv}; });
      var novos = Object.keys(noMes).filter(function(k){ return primeiro[k]===dmes; }).map(function(k){ return { parceiro:noMes[k].nome, pedidos:noMes[k].pedidos, gmv:noMes[k].gmv }; }).sort(function(a,b){return (b.gmv||0)-(a.gmv||0);});
      var parados = Object.keys(noAnt).filter(function(k){ return !noMes[k]; }).map(function(k){ return { parceiro:noAnt[k].nome, pedidos_ant:noAnt[k].pedidos, gmv_ant:noAnt[k].gmv }; }).sort(function(a,b){return (b.gmv_ant||0)-(a.gmv_ant||0);});
      return { statusCode:200, headers:cors, body:JSON.stringify({ ok:true, cidade_slug:dcid, mes:dmes, mes_ant:dant, novos:novos, parados:parados }) };
    }

    // ---- AÇÃO: período (filtro de calendário) , KPIs de volume + ranking no intervalo ----
    if(acao === 'periodo'){
      var pde = String(body.de||'').trim(), pate = String(body.ate||'').trim();
      if(!/^\d{4}-\d{2}-\d{2}$/.test(pde) || !/^\d{4}-\d{2}-\d{2}$/.test(pate)) return { statusCode:400, headers:cors, body:JSON.stringify({ ok:false, erro:'de/ate (YYYY-MM-DD) obrigatórios' }) };
      var pcid = String(body.cidade_slug||'').trim();
      var cids;
      if(pcid){ cids = [pcid]; }
      else {
        var rc = await fetch(SUPA_URL + '/rest/v1/v_ltv_cidade?select=cidade_slug', { headers: svc() });
        cids = (rc.ok ? await rc.json() : []).map(function(x){ return x.cidade_slug; });
      }
      var todos = [];
      for(var ci=0; ci<cids.length; ci++){
        var rows = await periodoCidade(cids[ci], pde, pate);
        for(var k=0;k<rows.length;k++){ rows[k]._cid = cids[ci]; todos.push(rows[k]); }
      }
      var gmv=0, ped=0; todos.forEach(function(x){ gmv += Number(x.gmv)||0; ped += Number(x.pedidos)||0; });
      var ativas = todos.length; // cada linha = 1 parceiro que pediu no período
      var ranking = todos.slice().sort(function(a,b){ return (Number(b.gmv)||0)-(Number(a.gmv)||0); }).slice(0,300)
        .map(function(x){ return { parceiro:x.parceiro, cidade_slug:x._cid, pedidos:x.pedidos, gmv:x.gmv, ltv: Math.round((Number(x.gmv)||0)*0.14*100)/100 }; });
      return { statusCode:200, headers:cors, body:JSON.stringify({ ok:true, periodo:{ de:pde, ate:pate },
        kpis:{ gmv:gmv, pedidos:ped, ativas:ativas, ticket:(ped>0?gmv/ped:0), ltv:gmv*0.14 }, ranking:ranking }) };
    }

    // ---- AÇÃO padrão: dados do painel ----
    const [cidades, meses, empresas] = await Promise.all([
      lerTudo('v_ltv_cidade', 'cidade_slug,parceiros,parceiros_ativos,gmv_total,margem_total,ticket_medio,pedidos,ltv_medio_parceiro,desde,ate', 'gmv_total.desc'),
      lerTudo('v_ltv_metricas_mes', 'cidade_slug,mes,parceiros_ativos,pedidos,gmv,margem_14,novos_ativados,custo,cac,ativos_anterior,churnados,logo_churn_pct,churn_monetario', 'mes.asc'),
      lerTudo('mv_ltv_empresa', 'cidade_slug,parceiro,pedidos,gmv,primeiro_pedido,ultimo_pedido,meses_ativos,ticket_medio,ltv_atual,ativo', 'ltv_atual.desc')
    ]);
    return { statusCode:200, headers:cors, body:JSON.stringify({ ok:true, cidades, meses, empresas }) };

  } catch(err){
    return { statusCode:500, headers:cors, body:JSON.stringify({ ok:false, erro: err.message }) };
  }
};
