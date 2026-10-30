// netlify/functions/supabase-write.js
// Função pra escritas no Supabase com SUPA_SERVICE_KEY (bypassa RLS)
// Valida usuário antes de executar.
//
// USO (do frontend):
//   POST /.netlify/functions/supabase-write
//   Headers:
//     Content-Type: application/json
//     X-Gami-User: <user_id> (ex: pe016)
//   Body:
//     {
//       "tabela": "machine_corridas",
//       "operacao": "upsert" | "patch" | "delete",
//       "dados": [...],          // pra upsert
//       "filtro": "id=eq.123",   // pra patch/delete
//       "patch": { campo: val }  // pra patch
//     }
// ============================================================

const SUPA_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
const SUPA_ANON_KEY = process.env.SUPA_PUBLIC_KEY || 'sb_publishable_0y-oz0aght1rNQNQrsh2tA_EfHajL61';

// Tabelas permitidas (whitelist)
const TABELAS_PERMITIDAS = [
  'machine_corridas',
  'machine_condutores',
  'machine_empresas',
  'machine_sync_log',
  'audit_log',         // pra registrar ações de auditoria
  'acessos_log',       // log de acesso (login) , escrita pelo servidor p/ poder travar leitura
  // App Gâmi — tabelas operacionais
  'tarefas',           // delegação, tarefas pessoais
  'pessoas',           // cadastros do time
  'recados',           // mural de recados
  'anotacoes_cidade',  // anotações por cidade
  'ranking_mensal',    // ranking gamificação
  'blog_posts',        // posts do blog
  'cidades_extra',     // dados adicionais das cidades
  'configuracoes',     // configurações do dashboard
  'reconhecimentos',   // reconhecimentos da semana
  'badges_desbloqueadas', // conquistas/badges dos colaboradores (gamificação)
  'notificacoes',      // notificações (delegação avisa o delegante, etc.)
  'prospeccao_lojas',  // CRM de campo: lojas prospectadas/ativadas (Carlos + gestores)
  'prospeccao_visitas', // CRM de campo: log de visitas
  'prospeccao_rotas',  // CRM de campo: rota de visitas por gestor
  // CRM Gâmi (comercial): inside (BDR) + field (vendedor/gestor)
  'crm_leads', 'crm_atividades', 'crm_tarefas', 'crm_checklist', 'crm_metas', 'crm_scripts', 'crm_config',
  // Push (cada usuário logado inscreve o próprio aparelho / agenda os próprios lembretes)
  'push_subscriptions', 'push_agendados',
  'pulse_votos',       // voto do pulse (humor do dia)
  'estoque_itens', 'estoque_mov',  // estoque de brindes (tela admin)
  'desafios_admin',    // desafios da gamificação (tela admin)
  // Gamificação escrita pelo cliente (o lote 2 travou o anon; precisa ir pelo servidor)
  'pontos_log', 'calendario_pessoal', 'streaks', 'reconhecimentos_pares',
  'stories_log', 'vencedores_mensais'
];

// 🆕 Tabelas de COLABORAÇÃO: qualquer usuário com SESSÃO VÁLIDA pode gravar aqui
// (não precisa ser super_admin). Necessário pra fluxos entre colaboradores, ex.:
// o Mazinho concluir uma tarefa que a Suzi delegou (UPDATE em tarefas) e avisá-la
// (INSERT em notificacoes). Fora dessas, segue só super_admin.
const TABELAS_COLAB = ['tarefas', 'notificacoes', 'prospeccao_lojas', 'prospeccao_visitas', 'prospeccao_rotas',
  'crm_leads', 'crm_atividades', 'crm_tarefas', 'crm_checklist', 'crm_metas', 'crm_scripts', 'crm_config',
  'push_subscriptions', 'push_agendados',
  'pessoas',   // edição do time: qualquer logado escreve pelo servidor (bloqueia anon; auditável). UI já restringe quem edita.
  'recados', 'pulse_votos',  // mural e voto do pulse: ação de qualquer usuário logado
  'estoque_itens', 'estoque_mov', 'desafios_admin',  // telas admin (UI já restringe por isAdminPontos / gestor)
  'configuracoes',   // Cloud Mirror: todo usuário logado espelha suas chaves gami_* (blacklist filtra o sensível)
  'audit_log', 'acessos_log',  // trilha de auditoria/acesso: qualquer logado registra (log secundário)
  // Gamificação: cada colaborador registra os próprios pontos/badges/streak/etc.
  'pontos_log', 'badges_desbloqueadas', 'calendario_pessoal', 'streaks',
  'reconhecimentos_pares', 'reconhecimentos', 'stories_log', 'vencedores_mensais',
  'ranking_mensal', 'anotacoes_cidade'];

// Funções RPC permitidas (whitelist)
const RPCS_PERMITIDAS = [
  'refresh_machine_views',
  'limpar_sessoes_expiradas',
  // escrita do estoque (antes chamável direto pela chave pública; agora só pelo servidor)
  'estoque_registrar_entrada',
  'estoque_registrar_venda'
];
// RPCs que qualquer usuário com sessão válida pode chamar (não só super_admin).
// A UI já restringe quem opera a tela de estoque (EST_SESSAO / cidade permitida).
const RPCS_COLAB = ['estoque_registrar_entrada', 'estoque_registrar_venda'];

// Origens permitidas (CORS)
const ORIGENS_PERMITIDAS = [
  'https://gami-marketing.netlify.app',
  'http://localhost:8888',     // dev local Netlify
  'http://localhost:3000'      // dev local genérico
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
// Valida o usuário + token de sessão
async function validarSessao(userId, token){
  if(!userId) return { valido: false, erro: 'Usuário não informado' };

  try {
    // Busca o usuário em usuarios_login (que tem token + expiração)
    // 🔒 Fase 1c: usa SERVICE KEY — token_atual não é mais legível pela anon key.
    // select=* pra não quebrar se a coluna sessoes_ativas ainda não existir (ALTER
    // pendente): _tokenAtivo cai no token_atual quando a lista vier indefinida.
    const r = await fetch(SUPA_URL+'/rest/v1/usuarios_login?pessoa_id=eq.'+encodeURIComponent(userId)+'&select=*&limit=1', {
      headers: { 'apikey': SUPA_SERVICE_KEY, 'Authorization': 'Bearer '+SUPA_SERVICE_KEY }
    });
    if(!r.ok) return { valido: false, erro: 'Falha ao validar' };
    const arr = await r.json();
    if(!Array.isArray(arr) || arr.length === 0) return { valido: false, erro: 'Usuário não existe' };

    const u = arr[0];

    if(u.ativo === false) return { valido: false, erro: 'Usuário desativado' };

    // Se token foi enviado, valida (mais seguro)
    // Se token não foi enviado (sistema antigo), valida só user_id (compatibilidade)
    if(token){
      if(!_tokenAtivo(u, token)) return { valido: false, erro: 'Sessão expirada (faça login de novo)' };
    }
    
    // Busca o nivel na tabela pessoas (super_admin pode estar em várias colunas)
    const rP = await fetch(SUPA_URL+'/rest/v1/pessoas?id=eq.'+encodeURIComponent(userId)+'&select=id,nome,nivel,niveis,cargo,super_admin&limit=1', {
      headers: { 'apikey': SUPA_SERVICE_KEY, 'Authorization': 'Bearer '+SUPA_SERVICE_KEY }
    });
    const arrP = await rP.json();
    const pessoa = (Array.isArray(arrP) && arrP[0]) ? arrP[0] : null;
    
    // super_admin pode estar em:
    // - coluna super_admin === true       (boolean dedicado, recomendado)
    // - nivel === 'super_admin'           (string)
    // - niveis array contém 'super_admin' (array de níveis)
    // - cargo === 'Super Admin'           (cargo descritivo, fallback)
    function ehSuperAdmin(p){
      if(!p) return false;
      if(p.super_admin === true) return true;
      if(p.nivel === 'super_admin') return true;
      if(Array.isArray(p.niveis) && p.niveis.indexOf('super_admin') >= 0) return true;
      if(typeof p.cargo === 'string' && p.cargo.toLowerCase().replace(/\s/g,'_') === 'super_admin') return true;
      return false;
    }
    
    return { 
      valido: true, 
      usuario: { 
        id: userId, 
        nome: u.nome,
        nivel: pessoa ? pessoa.nivel : null,
        niveis: pessoa ? pessoa.niveis : null,
        cargo: pessoa ? pessoa.cargo : null,
        super_admin: ehSuperAdmin(pessoa)
      } 
    };
  } catch(e){
    console.error('validarSessao:', e);
    return { valido: false, erro: 'Erro ao validar sessão' };
  }
}

// Registra evento no audit_log (não bloqueia o fluxo se falhar)
async function auditar(usuario, acao, recurso, detalhes, ip, userAgent){
  try {
    await fetch(SUPA_URL+'/rest/v1/audit_log', {
      method: 'POST',
      headers: {
        'apikey': SUPA_SERVICE_KEY,
        'Authorization': 'Bearer '+SUPA_SERVICE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify([{
        pessoa_id: usuario.id,
        pessoa_nome: usuario.nome,
        acao: acao,
        recurso: recurso,
        detalhes: detalhes || null,
        ip: ip || null,
        user_agent: userAgent || null
      }])
    });
  } catch(e){ /* silencioso */ }
}

// Rate limit: usa função SQL atômica
const RATE_LIMIT_POR_MIN = 30; // 30 escritas/min por usuário
async function verificarRateLimit(chave){
  try {
    const r = await fetch(SUPA_URL+'/rest/v1/rpc/verificar_rate_limit', {
      method: 'POST',
      headers: {
        'apikey': SUPA_SERVICE_KEY,
        'Authorization': 'Bearer '+SUPA_SERVICE_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_chave: chave, p_limite: RATE_LIMIT_POR_MIN })
    });
    if(!r.ok) return { ok: true }; // se o check falha, deixa passar (fail-open)
    const data = await r.json();
    return Array.isArray(data) && data[0] ? data[0] : { ok: true };
  } catch(e){ return { ok: true }; }
}

// Registra alerta de segurança (não bloqueia)
async function alertar(tipo, severidade, mensagem, detalhes){
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
        tipo: tipo,
        severidade: severidade,
        origem: 'supabase-write',
        mensagem: mensagem,
        detalhes: detalhes
      }])
    });
  } catch(e){}
}

exports.handler = async function(event){
  const origin = event.headers.origin || event.headers.Origin || '';
  const cors = corsHeaders(origin);
  
  // OPTIONS (preflight)
  if(event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, headers: cors, body: JSON.stringify({error:'Use POST'}) };
  }
  
  // Verifica service key configurada
  if(!SUPA_SERVICE_KEY){
    console.error('SUPA_SERVICE_KEY não configurada!');
    return { statusCode: 500, headers: cors, body: JSON.stringify({error:'Servidor não configurado (SUPA_SERVICE_KEY ausente)'}) };
  }
  
  // Valida usuário + token de sessão
  const userId = event.headers['x-gami-user'] || event.headers['X-Gami-User'];
  const token = event.headers['x-gami-token'] || event.headers['X-Gami-Token'];
  const ip = event.headers['x-forwarded-for'] || event.headers['x-nf-client-connection-ip'] || '';
  const userAgent = event.headers['user-agent'] || '';
  
  if(!userId){
    return { statusCode: 401, headers: cors, body: JSON.stringify({error:'Usuário não informado (header X-Gami-User)'}) };
  }
  
  // RATE LIMIT: 30 escritas/min por usuário
  const rl = await verificarRateLimit('user:'+userId);
  if(!rl.ok){
    alertar('rate_limit_excedido', 'aviso', 'User excedeu rate limit', { userId, contagem: rl.contagem, ip });
    return { 
      statusCode: 429, 
      headers: cors, 
      body: JSON.stringify({error:'Muitas requisições. Aguarde 1 minuto.', contagem: rl.contagem, limite: rl.limite}) 
    };
  }
  
  const sessao = await validarSessao(userId, token);
  if(!sessao.valido){
    alertar('auth_falhou', 'aviso', sessao.erro, { userId, ip });
    return { statusCode: 401, headers: cors, body: JSON.stringify({error: sessao.erro}) };
  }
  
  const usuario = sessao.usuario;

  // Parse do body
  let body;
  try { body = JSON.parse(event.body); }
  catch(e){ return { statusCode: 400, headers: cors, body: JSON.stringify({error:'Body inválido'}) }; }

  const { tabela, operacao, dados, filtro, patch } = body;

  // Valida tabela (rpc não usa tabela; a função é validada mais abaixo por RPCS_PERMITIDAS)
  if(operacao !== 'rpc' && TABELAS_PERMITIDAS.indexOf(tabela) < 0){
    return { statusCode: 400, headers: cors, body: JSON.stringify({error:'Tabela não permitida: '+tabela}) };
  }

  // Permissão: super_admin escreve em qualquer tabela permitida; usuário com
  // sessão válida escreve nas tabelas de COLABORAÇÃO (tarefas, notificacoes).
  // Antes SÓ super_admin podia gravar aqui, então colaborador (ex: Mazinho) não
  // conseguia concluir tarefa delegada nem notificar o delegante → "Não consegui salvar".
  var _permColab = (operacao === 'rpc')
    ? (RPCS_COLAB.indexOf(body.funcao) >= 0)
    : (TABELAS_COLAB.indexOf(tabela) >= 0);
  if(!usuario.super_admin && !_permColab){
    return { statusCode: 403, headers: cors, body: JSON.stringify({error:'Permissão negada (não é super_admin)'}) };
  }
  
  // Constrói chamada ao Supabase com SERVICE_KEY (bypassa RLS)
  const supaHeaders = {
    'apikey': SUPA_SERVICE_KEY,
    'Authorization': 'Bearer '+SUPA_SERVICE_KEY,
    'Content-Type': 'application/json'
  };
  
  try {
    let url = SUPA_URL+'/rest/v1/'+tabela;
    let method;
    let supaBody;
    
    if(operacao === 'insert'){
      // 🔧 v33.54: INSERT puro (append). Usado pelo log de pontos/gamificação
      // (pontos_log etc). Sem on_conflict: só cria linha nova. Antes o proxy
      // recusava 'insert' (400) e caía no fallback anon, que a RLS bloqueia ->
      // os pontos sumiam em silêncio. Agora grava pela service key.
      if(!Array.isArray(dados) || dados.length === 0){
        return { statusCode: 400, headers: cors, body: JSON.stringify({error:'dados deve ser array não-vazio pra insert'}) };
      }
      method = 'POST';
      supaBody = JSON.stringify(dados);
      supaHeaders['Prefer'] = body.retornar ? 'return=representation' : 'return=minimal';
    }
    else if(operacao === 'upsert'){
      if(!Array.isArray(dados) || dados.length === 0){
        return { statusCode: 400, headers: cors, body: JSON.stringify({error:'dados deve ser array não-vazio pra upsert'}) };
      }
      method = 'POST';
      supaBody = JSON.stringify(dados);
      // resolução do conflito: merge (padrão) ou ignore (não mexe no que já existe)
      var resol = (body.resolution === 'ignore-duplicates') ? 'ignore-duplicates' : 'merge-duplicates';
      // Se cliente pediu retornar=true, devolve registros criados
      var prefer = body.retornar
        ? 'resolution='+resol+',return=representation'
        : 'resolution='+resol+',return=minimal';
      supaHeaders['Prefer'] = prefer;
      // on_conflict: deduplica por coluna(s) específica(s) em vez da PK (ex.: endpoint do push)
      if(body.on_conflict){ url += '?on_conflict='+encodeURIComponent(body.on_conflict); }
    }
    else if(operacao === 'patch'){
      if(!filtro || !patch){
        return { statusCode: 400, headers: cors, body: JSON.stringify({error:'patch precisa de filtro e patch'}) };
      }
      method = 'PATCH';
      url += '?'+filtro;
      supaBody = JSON.stringify(patch);
      supaHeaders['Prefer'] = 'return=minimal';
    }
    else if(operacao === 'delete'){
      if(!filtro){
        return { statusCode: 400, headers: cors, body: JSON.stringify({error:'delete precisa de filtro'}) };
      }
      method = 'DELETE';
      url += '?'+filtro;
      supaBody = undefined;
      supaHeaders['Prefer'] = 'return=minimal';
    }
    else if(operacao === 'rpc'){
      // Pra chamar functions (refresh_machine_views etc)
      if(!body.funcao){
        return { statusCode: 400, headers: cors, body: JSON.stringify({error:'rpc precisa de funcao'}) };
      }
      if(RPCS_PERMITIDAS.indexOf(body.funcao) < 0){
        return { statusCode: 400, headers: cors, body: JSON.stringify({error:'RPC não permitida: '+body.funcao}) };
      }
      url = SUPA_URL+'/rest/v1/rpc/'+body.funcao;
      method = 'POST';
      supaBody = JSON.stringify(body.argumentos || {});
    }
    else {
      return { statusCode: 400, headers: cors, body: JSON.stringify({error:'operacao inválida: '+operacao+' (use insert/upsert/patch/delete/rpc)'}) };
    }
    
    const r = await fetch(url, { method, headers: supaHeaders, body: supaBody });
    
    if(!r.ok){
      const txt = await r.text().catch(()=>'');
      return { statusCode: r.status, headers: cors, body: JSON.stringify({
        error:'Supabase HTTP '+r.status, detalhe: txt.substring(0,300)
      }) };
    }
    
    const respBody = await r.text();
    const resultado = respBody ? JSON.parse(respBody) : null;
    
    // Audit log (não bloqueia se falhar)
    auditar(usuario, operacao, tabela || (body.funcao || ''), {
      qtd: Array.isArray(dados) ? dados.length : 0,
      filtro: filtro || null,
      funcao: body.funcao || null
    }, ip, userAgent);
    
    return { statusCode: 200, headers: cors, body: JSON.stringify({
      ok: true,
      operacao: operacao,
      tabela: tabela,
      afetados: Array.isArray(dados) ? dados.length : (resultado && Array.isArray(resultado) ? resultado.length : 0),
      resultado: resultado
    }) };
    
  } catch(err){
    console.error('[supabase-write]', err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({error: err.message}) };
  }
};
