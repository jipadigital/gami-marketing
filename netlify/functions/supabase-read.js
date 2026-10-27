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
  'audit_log','acessos_log','push_subscriptions','push_agendados'
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

// Valida a sessão (user + token) contra usuarios_login com a service key.
// Qualquer usuário logado e ativo pode LER o que está na lista branca
// (a ameaça aqui é o forasteiro com a chave pública, não o insider;
//  o escopo por linha/nível o app já trata na UI).
async function validarSessao(userId, token){
  if(!userId || !token) return { valido:false, erro:'Sessão não informada' };
  try {
    const r = await fetch(SUPA_URL+'/rest/v1/usuarios_login?pessoa_id=eq.'+encodeURIComponent(userId)+'&select=pessoa_id,token_atual,token_expira_em,ativo&limit=1', {
      headers: { 'apikey': SUPA_SERVICE_KEY, 'Authorization': 'Bearer '+SUPA_SERVICE_KEY }
    });
    if(!r.ok) return { valido:false, erro:'Falha ao validar' };
    const arr = await r.json();
    if(!Array.isArray(arr) || !arr.length) return { valido:false, erro:'Usuário não existe' };
    const u = arr[0];
    if(u.ativo === false) return { valido:false, erro:'Usuário desativado' };
    if(!u.token_atual) return { valido:false, erro:'Sessão não encontrada (faça login de novo)' };
    if(u.token_atual !== token) return { valido:false, erro:'Token inválido' };
    if(u.token_expira_em && new Date(u.token_expira_em) < new Date()) return { valido:false, erro:'Sessão expirada (faça login de novo)' };
    return { valido:true };
  } catch(e){
    console.error('[read] validarSessao', e);
    return { valido:false, erro:'Erro ao validar sessão' };
  }
}

// Bloqueia querystring que tente embutir OUTRA tabela (ex.: select=*,outra(*))
// ou que não seja a shape esperada. Mantém o proxy restrito à tabela pedida.
function querySegura(q){
  if(typeof q !== 'string') return false;
  if(q.length > 4000) return false;
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
      return { statusCode:200, headers:cors, body:JSON.stringify({ ok:true, resultado: txt ? JSON.parse(txt) : [], content_range: cr }) };
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
    return { statusCode:200, headers:cors, body:JSON.stringify({ ok:true, resultado: txt ? JSON.parse(txt) : [], content_range: contentRange }) };

  } catch(err){
    console.error('[supabase-read]', err);
    return { statusCode:500, headers:cors, body:JSON.stringify({error: err.message}) };
  }
};
