// netlify/functions/download-backup.js
// Permite super_admin baixar backup completo de uma data específica
// GET /api/download-backup?data=YYYY-MM-DD
// Headers: X-Gami-User, X-Gami-Token
// Retorna: JSON com todos os dados daquele dia (download attachment)
// ============================================================

const SUPA_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
const SUPA_ANON_KEY = process.env.SUPA_PUBLIC_KEY || 'sb_publishable_0y-oz0aght1rNQNQrsh2tA_EfHajL61';

const ORIGENS_PERMITIDAS = [
  'https://gami-marketing.netlify.app',
  'http://localhost:8888',
  'http://localhost:3000'
];

function corsHeaders(origin){
  var permitido = ORIGENS_PERMITIDAS.indexOf(origin) >= 0 ? origin : ORIGENS_PERMITIDAS[0];
  return {
    'Access-Control-Allow-Origin': permitido,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'X-Gami-User, X-Gami-Token'
  };
}

// Valida sessão (mesma lógica do supabase-write)
async function validarSessao(userId, token){
  if(!userId) return { valido: false, erro: 'Usuário não informado' };
  
  try {
    const r = await fetch(SUPA_URL+'/rest/v1/usuarios_login?pessoa_id=eq.'+encodeURIComponent(userId)+'&select=pessoa_id,nome,token_atual,token_expira_em,ativo&limit=1', {
      headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': 'Bearer '+SUPA_ANON_KEY }
    });
    if(!r.ok) return { valido: false, erro: 'Falha ao validar' };
    const arr = await r.json();
    if(!arr || !arr.length) return { valido: false, erro: 'Usuário não existe' };
    
    const u = arr[0];
    if(u.ativo === false) return { valido: false, erro: 'Usuário desativado' };
    
    if(token){
      if(!u.token_atual) return { valido: false, erro: 'Sessão não encontrada' };
      if(u.token_atual !== token) return { valido: false, erro: 'Token inválido' };
      if(u.token_expira_em && new Date(u.token_expira_em) < new Date()){
        return { valido: false, erro: 'Sessão expirada' };
      }
    }
    
    const rP = await fetch(SUPA_URL+'/rest/v1/pessoas?id=eq.'+encodeURIComponent(userId)+'&select=id,nome,nivel,super_admin&limit=1', {
      headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': 'Bearer '+SUPA_ANON_KEY }
    });
    const arrP = await rP.json();
    const pessoa = (Array.isArray(arrP) && arrP[0]) ? arrP[0] : null;
    
    return { 
      valido: true, 
      usuario: { 
        id: userId, 
        nome: u.nome,
        super_admin: pessoa ? (pessoa.super_admin === true || pessoa.nivel === 'super_admin') : false
      } 
    };
  } catch(e){ return { valido: false, erro: 'Erro ao validar' }; }
}

exports.handler = async function(event){
  const origin = event.headers.origin || event.headers.Origin || '';
  const cors = corsHeaders(origin);
  
  if(event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if(event.httpMethod !== 'GET') return { statusCode: 405, headers: { ...cors, 'Content-Type':'application/json' }, body: JSON.stringify({ error:'Use GET' }) };
  
  // Valida sessão
  const userId = event.headers['x-gami-user'] || event.headers['X-Gami-User'];
  const token = event.headers['x-gami-token'] || event.headers['X-Gami-Token'];
  
  const sessao = await validarSessao(userId, token);
  if(!sessao.valido){
    return { statusCode: 401, headers: { ...cors, 'Content-Type':'application/json' }, body: JSON.stringify({ error: sessao.erro }) };
  }
  
  if(!sessao.usuario.super_admin){
    return { statusCode: 403, headers: { ...cors, 'Content-Type':'application/json' }, body: JSON.stringify({ error: 'Apenas super_admin pode baixar backups' }) };
  }
  
  // Pega data dos query params (ou hoje)
  const params = event.queryStringParameters || {};
  let dataBackup = params.data;
  if(!dataBackup){
    dataBackup = new Date().toISOString().split('T')[0];
  }
  
  // Valida formato YYYY-MM-DD
  if(!/^\d{4}-\d{2}-\d{2}$/.test(dataBackup)){
    return { statusCode: 400, headers: { ...cors, 'Content-Type':'application/json' }, body: JSON.stringify({ error:'Data inválida (use YYYY-MM-DD)' }) };
  }
  
  // Busca o backup (usa SERVICE_KEY pra ler completo)
  if(!SUPA_SERVICE_KEY){
    return { statusCode: 500, headers: { ...cors, 'Content-Type':'application/json' }, body: JSON.stringify({ error:'Servidor não configurado' }) };
  }
  
  try {
    const r = await fetch(SUPA_URL+'/rest/v1/backups_diarios?data_backup=eq.'+dataBackup+'&select=*', {
      headers: { 'apikey': SUPA_SERVICE_KEY, 'Authorization': 'Bearer '+SUPA_SERVICE_KEY }
    });
    if(!r.ok){
      return { statusCode: r.status, headers: { ...cors, 'Content-Type':'application/json' }, body: JSON.stringify({ error:'Erro ao buscar backup', status: r.status }) };
    }
    
    const arr = await r.json();
    if(!arr || !arr.length){
      return { statusCode: 404, headers: { ...cors, 'Content-Type':'application/json' }, body: JSON.stringify({ error:'Backup não encontrado pra essa data' }) };
    }
    
    const backup = arr[0];
    
    // Audit log
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
          pessoa_id: sessao.usuario.id,
          pessoa_nome: sessao.usuario.nome,
          acao: 'download_backup',
          recurso: 'backups_diarios',
          detalhes: { data_backup: dataBackup, tamanho_bytes: backup.tamanho_bytes }
        }])
      });
    } catch(e){}
    
    // Monta o JSON de download
    const jsonBody = JSON.stringify({
      gerado_em: backup.criado_em,
      data_backup: backup.data_backup,
      total_registros: backup.total_registros,
      tamanho_bytes: backup.tamanho_bytes,
      tabelas: {
        pessoas: backup.pessoas || [],
        usuarios_login: backup.usuarios_login || [],
        tarefas: backup.tarefas || [],
        configuracoes: backup.configuracoes || [],
        blog_posts: backup.blog_posts || [],
        ranking_mensal: backup.ranking_mensal || [],
        cidades_extra: backup.cidades_extra || []
      }
    }, null, 2);
    
    return {
      statusCode: 200,
      headers: {
        ...cors,
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="gami-backup-'+dataBackup+'.json"'
      },
      body: jsonBody
    };
    
  } catch(e){
    return { statusCode: 500, headers: { ...cors, 'Content-Type':'application/json' }, body: JSON.stringify({ error: e.message }) };
  }
};
