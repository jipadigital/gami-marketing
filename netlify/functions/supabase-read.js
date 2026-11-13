// netlify/functions/supabase-read.js
// LEITURA server-side com SUPA_SERVICE_KEY (ignora RLS), atrás de sessão válida.
// Etapa 3 da segurança: tirar a LEITURA das tabelas sensíveis da chave pública.
// Com isso dá pra DROPAR a policy *_sel dessas tabelas (anon não lê mais nada);
// o app lê por aqui, provando que é um usuário Gâmi logado (X-Gami-Token).
//
// USO (do frontend, via helper supaLer):
//   POST /.netlify/functions/supabase-read
//   Headers: Content-Type, X-Gami-User, X-Gami-Token
//   Body SELECT: { "tabela":"crm_leads", "query":"select=*&dono_id=eq.123&order=criado_em.desc" }
//   Body RPC:    { "rpc":"mapa_empresas_cidade", "args":{ "p_cidade":"campo-grande" } }
// ============================================================

const SUPA_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;

// Tabelas que o proxy aceita LER (lista branca). Só o sensível precisa estar aqui;
// o resto segue lendo direto com a chave pública (baixo risco).
const TABELAS_LEITURA = [
  // comercial
  'crm_leads','crm_atividades','crm_tarefas','crm_checklist','crm_metas','crm_scripts','crm_config',
  'prospeccao_lojas','prospeccao_visitas','prospeccao_rotas',
  'mv_prospeccao_mapa','mv_empresas_raiox',
  // machine (dados de cliente/corrida)
  'machine_corridas','machine_empresas','machine_condutores','machine_sync_log',
  // PII / pessoal
  'pessoas','ponto_registros','ponto_log_admin','ponto_config',
  // conteúdo interno
  'recados','tarefas',
  // varredura final: auditoria e push
  'audit_log','acessos_log','push_subscriptions','push_agendados',
  // R6: gamificação/interno (nome de funcionário + pontos). ranking_mensal é VIEW.
  'pontos_log','desafios_admin','badges_desbloqueadas','pulse_votos',
  'stories_log','estoque_itens','ranking_mensal',
  // R7: configuracoes (Cloud Mirror)
  'configuracoes'
];

// RPCs sensíveis (leitura de dado comercial/Machine/prospecção) que o proxy aceita chamar.
const RPCS_LEITURA = [
  'acoes_gestor_semana','calendario_demanda_rede','clientes_onboarding','contar_corridas_por_cidade',
  'empresas_ativas_periodos','empresas_atividade_real','empresas_churn_inteligente','empresas_fantasmas',
  'empresas_pararam_30d','empresas_pararam_60d','empresas_pararam_90d','empresas_pararam_intervalo',
  'empresas_periodo_comparado','empresas_raiox_cidade','indicadores_cidade','mapa_empresas_cidade',
  'metricas_mensais_cidade','metricas_semanais_cidade','motoboys_atividade_real','motoboys_periodo_comparado',
  'prospeccao_sinal_machine','ranking_cidades_mes',
  // estoque (estoque_vendas devolve nome/telefone de CLIENTE)
  'estoque_saldo','estoque_vendas','estoque_dashboard','estoque_vitrine',
  'estoque_distribuicao_cidades','estoque_vendas_agrupadas',
  // reservados pra lotes seguintes (PII/ponto)
  'ponto_dia_editor','tarefas_minhas',
  // varredura final: metadados de backup
  'listar_backups_diarios'
];

// 💰 Fontes que carregam VALOR em R$ (decisão do dono, 13/11/2026): só super admin,
// diretoria, gerência, gestor e financeiro recebem os valores. Pros demais níveis o proxy
// devolve os mesmos dados com os campos de dinheiro zerados (a tela deles já não mostra).
const { podeVerValores, ocultarValores, chavesAgregadasDeDinheiro, zerarChaves } = require('../lib/valores');
const TABELAS_COM_VALOR = ['machine_corridas','machine_empresas','machine_condutores','mv_empresas_raiox','mv_prospeccao_mapa','crm_leads'];
const RPCS_COM_VALOR = [
  'acoes_gestor_semana','calendario_demanda_rede','clientes_onboarding','contar_corridas_por_cidade',
  'empresas_ativas_periodos','empresas_atividade_real','empresas_churn_inteligente','empresas_fantasmas',
  'empresas_pararam_30d','empresas_pararam_60d','empresas_pararam_90d','empresas_pararam_intervalo',
  'empresas_periodo_comparado','empresas_raiox_cidade','indicadores_cidade','mapa_empresas_cidade',
  'metricas_mensais_cidade','metricas_semanais_cidade','motoboys_atividade_real','motoboys_periodo_comparado',
  'prospeccao_sinal_machine','ranking_cidades_mes'
];
// Devolve { erro: resposta503 } se não deu pra conferir, ou { ocultar: true|false }.
async function regraDeValores(userId, ehFonteComValor, cors){
  if(!ehFonteComValor) return { ocultar: false };
  const ver = await podeVerValores(userId);
  if(ver === null) return { erro: { statusCode:503, headers:cors, body:JSON.stringify({error:'Não consegui conferir sua permissão agora. Tente de novo em instantes.'}) } };
  return { ocultar: ver !== true };
}

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

// 🚀 v33.48: cache de validação de sessão (perf do mapa). O mapa dispara ~10+
// leituras por cidade, cada uma validava a sessão lendo usuarios_login = 1 round-trip
// extra ao Supabase por leitura. Aqui cacheamos o resultado por (user|token) por 2 min
// num Map de módulo (persiste enquanto o container do Netlify fica quente). Corta quase
// toda validação repetida. Risco: sessão revogada segue valendo por até 2 min (janela curta).
var _sessCache = new Map();
var _SESS_TTL = 120000; // 2 min

// Valida a sessão (user + token) contra usuarios_login com a service key.
// Qualquer usuário logado e ativo pode LER o que está na lista branca
// (a ameaça aqui é o forasteiro com a chave pública, não o insider;
//  o escopo por linha/nível o app já trata na UI).
// aceita a sessão se o token bate com o token_atual (compat) OU com qualquer
// sessão ativa não expirada da lista (multi-dispositivo: notebook + celular juntos).
function _tokenAtivo(u, token){
  var agora = new Date();
  if(u.token_atual && u.token_atual === token && (!u.token_expira_em || new Date(u.token_expira_em) >= agora)) return true;
  if(Array.isArray(u.sessoes_ativas)){
    for(var i=0;i<u.sessoes_ativas.length;i++){
      var s=u.sessoes_ativas[i];
      if(s && s.t === token && (!s.e || new Date(s.e) >= agora)) return true;
    }
  }
  return false;
}
async function validarSessao(userId, token){
  if(!userId || !token) return { valido:false, erro:'Sessão não informada' };
  var ck = userId+'|'+token;
  var now = Date.now();
  var c = _sessCache.get(ck);
  if(c && c.exp > now) return c.valido ? { valido:true } : { valido:false, erro:c.erro };
  try {
    // select=* pra não quebrar se a coluna sessoes_ativas ainda não existir (ALTER
    // pendente): _tokenAtivo cai no token_atual quando a lista vier indefinida.
    const r = await fetch(SUPA_URL+'/rest/v1/usuarios_login?pessoa_id=eq.'+encodeURIComponent(userId)+'&select=*&limit=1', {
      headers: { 'apikey': SUPA_SERVICE_KEY, 'Authorization': 'Bearer '+SUPA_SERVICE_KEY }
    });
    if(!r.ok) return { valido:false, erro:'Falha ao validar' };  // erro transitório: não cacheia
    const arr = await r.json();
    var out;
    if(!Array.isArray(arr) || !arr.length) out = { valido:false, erro:'Usuário não existe' };
    else { const u = arr[0];
      if(u.ativo === false) out = { valido:false, erro:'Usuário desativado' };
      else if(_tokenAtivo(u, token)) out = { valido:true };
      else out = { valido:false, erro:'Sessão expirada (faça login de novo)' };
    }
    // cacheia (poda simples quando cresce)
    if(_sessCache.size > 500) _sessCache.clear();
    _sessCache.set(ck, { exp: now + _SESS_TTL, valido: out.valido, erro: out.erro });
    return out;
  } catch(e){
    console.error('[read] validarSessao', e);
    return { valido:false, erro:'Erro ao validar sessão' };
  }
}

// 🛡️ RATE LIMIT por usuário (anti-raspagem , 2ª base de segurança). Janela fixa de
// 60s por pessoa_id, num Map de módulo (vive no container quente do Netlify, mesmo
// padrão do cache de sessão). O uso normal fica MUITO abaixo do teto; raspar a base
// (centenas/milhar de requisições) estoura e toma 429. Ao estourar, grava 1 alerta no
// audit_log pra você revisar quem foi. Limitação serverless: a contagem é por container
// (um atacante bem distribuído dilui), mas o burst de raspagem comum é cortado.
var _rl = new Map();
var _RL_JANELA = 60000;   // 60s
var _RL_MAX = 400;        // requisições por usuário por janela (ajuste se precisar)
async function rateLimit(userId){
  var now = Date.now();
  var e = _rl.get(userId);
  if(!e || now - e.ini > _RL_JANELA){ e = { ini: now, n: 0, alertou: false }; _rl.set(userId, e); }
  e.n++;
  if(e.n > _RL_MAX){
    if(!e.alertou){ // registra o alerta 1x por janela (não spamma)
      e.alertou = true;
      try {
        await fetch(SUPA_URL+'/rest/v1/audit_log', {
          method:'POST',
          headers: { 'apikey':SUPA_SERVICE_KEY, 'Authorization':'Bearer '+SUPA_SERVICE_KEY, 'Content-Type':'application/json', 'Prefer':'return=minimal' },
          body: JSON.stringify([{ pessoa_id:userId, pessoa_nome:'(proxy-read)', acao:'rate_limit', recurso:'supabase-read', detalhes:{ reqs:e.n, janela_s:60 } }])
        });
      } catch(_){}
    }
    return false;
  }
  if(_rl.size > 2000) _rl.clear();
  return true;
}

// Bloqueia querystring que tente embutir OUTRA tabela (ex.: select=*,outra(*))
// ou que não seja a shape esperada. Mantém o proxy restrito à tabela pedida.
function querySegura(q){
  if(typeof q !== 'string') return false;
  if(q.length > 4000) return false;
  // 13/11/2026: o NOME do parâmetro nunca precisa de % (só o valor). Sem isso, escrever
  // "%73elect=" no lugar de "select=" passava pelo teste abaixo e o PostgREST aceitava
  // como select, furando o bloqueio de embed de outra tabela.
  var partes = q.split('&');
  for(var i=0;i<partes.length;i++){
    var nome = partes[i].split('=')[0];
    if(nome.indexOf('%') >= 0 || nome.indexOf('+') >= 0 || nome.indexOf('#') >= 0) return false;
  }
  // No select: "palavra(" que NÃO seja função de agregação = embed de recurso
  // relacionado (ex.: machine_corridas(*)) → recusa. count()/sum()/avg()/min()/max() ok.
  var m = /(?:^|&)select=([^&]*)/i.exec(q);
  if(m){
    var sel = '';
    try { sel = decodeURIComponent(m[1]); } catch(e){ sel = m[1]; }
    var AGG = { count:1, sum:1, avg:1, min:1, max:1 };
    var re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g, mm;
    while((mm = re.exec(sel))){ if(!AGG[mm[1].toLowerCase()]) return false; }
  }
  return true;
}

exports.handler = async function(event){
  const origin = event.headers.origin || event.headers.Origin || '';
  const cors = corsHeaders(origin);

  if(event.httpMethod === 'OPTIONS') return { statusCode:204, headers:cors, body:'' };
  if(event.httpMethod !== 'POST') return { statusCode:405, headers:cors, body:JSON.stringify({error:'Use POST'}) };
  if(!SUPA_SERVICE_KEY) return { statusCode:500, headers:cors, body:JSON.stringify({error:'Servidor não configurado'}) };

  const userId = event.headers['x-gami-user'] || event.headers['X-Gami-User'];
  const token  = event.headers['x-gami-token'] || event.headers['X-Gami-Token'];

  const sessao = await validarSessao(userId, token);
  if(!sessao.valido) return { statusCode:401, headers:cors, body:JSON.stringify({error:sessao.erro}) };

  // 2ª base: corta raspagem (muitas leituras num minuto) mesmo de sessão válida/roubada.
  if(!(await rateLimit(userId))){
    return { statusCode:429, headers:cors, body:JSON.stringify({error:'Muitas requisições num curto período. Aguarde um instante.'}) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e){ return { statusCode:400, headers:cors, body:JSON.stringify({error:'Body inválido'}) }; }

  const svc = { 'apikey':SUPA_SERVICE_KEY, 'Authorization':'Bearer '+SUPA_SERVICE_KEY };

  try {
    let url;
    // ---- RPC ----
    if(body.rpc){
      if(RPCS_LEITURA.indexOf(body.rpc) < 0){
        return { statusCode:400, headers:cors, body:JSON.stringify({error:'RPC não permitida: '+body.rpc}) };
      }
      const rh = Object.assign({}, svc, { 'Content-Type':'application/json' });
      // paginação por Range (quando o cliente pagina um RPC que devolve setof grande)
      if(body.range){ rh['Range-Unit'] = 'items'; rh['Range'] = String(body.range); }
      const r = await fetch(SUPA_URL+'/rest/v1/rpc/'+body.rpc, {
        method:'POST', headers: rh, body: JSON.stringify(body.args || {})
      });
      const cr = r.headers.get('content-range') || '';
      const txt = await r.text();
      if(!r.ok) return { statusCode:r.status, headers:cors, body:JSON.stringify({error:'Supabase HTTP '+r.status, detalhe:txt.slice(0,300)}) };
      let resRpc = txt ? JSON.parse(txt) : [];
      const rvRpc = await regraDeValores(userId, RPCS_COM_VALOR.indexOf(body.rpc) >= 0, cors);
      if(rvRpc.erro) return rvRpc.erro;
      if(rvRpc.ocultar) resRpc = ocultarValores(resRpc);
      return { statusCode:200, headers:cors, body:JSON.stringify({ ok:true, resultado: resRpc, content_range: cr }) };
    }

    // ---- SELECT ----
    const tabela = body.tabela;
    if(TABELAS_LEITURA.indexOf(tabela) < 0){
      return { statusCode:400, headers:cors, body:JSON.stringify({error:'Tabela não permitida: '+tabela}) };
    }
    const q = body.query || 'select=*';
    if(!querySegura(q)){
      return { statusCode:400, headers:cors, body:JSON.stringify({error:'Query inválida'}) };
    }
    url = SUPA_URL+'/rest/v1/'+tabela+'?'+q;
    // count=exact quando o cliente pede (sondas que leem content-range pra contar)
    const shead = body.count ? Object.assign({}, svc, { 'Prefer':'count=exact' }) : svc;
    const r = await fetch(url, { headers: shead });
    const txt = await r.text();
    const contentRange = r.headers.get('content-range') || '';
    if(!r.ok) return { statusCode:r.status, headers:cors, body:JSON.stringify({error:'Supabase HTTP '+r.status, detalhe:txt.slice(0,300)}) };
    let resSel = txt ? JSON.parse(txt) : [];
    const rvSel = await regraDeValores(userId, TABELAS_COM_VALOR.indexOf(tabela) >= 0, cors);
    if(rvSel.erro) return rvSel.erro;
    if(rvSel.ocultar){
      resSel = ocultarValores(resSel);
      resSel = zerarChaves(resSel, chavesAgregadasDeDinheiro(q)); // somas/médias de valor também
    }
    return { statusCode:200, headers:cors, body:JSON.stringify({ ok:true, resultado: resSel, content_range: contentRange }) };

  } catch(err){
    console.error('[supabase-read]', err);
    return { statusCode:500, headers:cors, body:JSON.stringify({error: err.message}) };
  }
};
