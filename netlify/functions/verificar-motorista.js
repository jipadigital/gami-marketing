// netlify/functions/verificar-motorista.js
// Modulo Verificacao de Motoristas (Driver Status).
// Cruza antecedentes + processos + CNH por CPF e devolve APTO / ANALISE / REPROVADO.
//
// SEGURANCA (mesmo padrao do admin-reset-pin.js):
//   - A API key do agregador externo (AGREGADOR_API_KEY) fica SO aqui, no servidor.
//   - Grava/le a tabela com a SUPA_SERVICE_KEY (bypassa RLS; a tabela e fechada pro anon).
//   - Valida a sessao do chamador (X-Gami-User + X-Gami-Token vs usuarios_login) e
//     exige super_admin (jipadigital@gmail.com) — as meninas entram na Fase 2.
//   - NUNCA loga CPF nem dado sensivel.
//
// FASE 1 (mock): sem AGREGADOR_API_KEY (ou USE_MOCK=true) => usa mockResposta().
// FASE 2 (real): setar AGREGADOR_API_KEY + USE_MOCK=false e implementar consultarAgregador().
// ============================================================

const crypto = require('crypto');
const SUPA_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
const SUPER_ADMIN_EMAIL = 'jipadigital@gmail.com';

const ORIGENS_PERMITIDAS = [
  'https://gami-marketing.netlify.app',
  'http://localhost:8888',
  'http://localhost:3000'
];

function corsHeaders(origin){
  const permitido = ORIGENS_PERMITIDAS.indexOf(origin) >= 0 ? origin : ORIGENS_PERMITIDAS[0];
  return {
    'Access-Control-Allow-Origin': permitido,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Gami-User, X-Gami-Token',
    'Content-Type': 'application/json'
  };
}
function svcHeaders(extra){
  return Object.assign({
    'apikey': SUPA_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPA_SERVICE_KEY
  }, extra || {});
}
function json(cors, body, status){
  return { statusCode: status || 200, headers: cors, body: JSON.stringify(body) };
}

// ---- Storage (documentos): bucket PRIVADO + URLs assinadas ----
const DOCS_BUCKET = 'motorista-docs';
const DOC_TIPOS = ['cnh', 'rg', 'comprovante', 'outro'];
function nomeSeguro(s){
  return String(s || 'arquivo').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '_').replace(/_+/g, '_').slice(-80) || 'arquivo';
}
// Cria uma URL assinada de UPLOAD (o navegador manda o arquivo direto pro Storage)
async function storageSignUpload(path){
  const r = await fetch(SUPA_URL + '/storage/v1/object/upload/sign/' + DOCS_BUCKET + '/' + encodeURI(path), {
    method: 'POST', headers: svcHeaders({ 'Content-Type': 'application/json' })
  });
  if(!r.ok){ const t = await r.text().catch(() => ''); throw new Error('sign_upload HTTP ' + r.status + ' ' + t.substring(0,180)); }
  const j = await r.json();                 // { url: '/object/upload/sign/<bucket>/<path>?token=...' }
  return SUPA_URL + '/storage/v1' + (j.url || j.signedUrl || '');
}
// Cria uma URL assinada de LEITURA (curta duracao)
async function storageSignView(path, expiresIn){
  const r = await fetch(SUPA_URL + '/storage/v1/object/sign/' + DOCS_BUCKET + '/' + encodeURI(path), {
    method: 'POST', headers: svcHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ expiresIn: expiresIn || 300 })
  });
  if(!r.ok) return null;
  const j = await r.json();                 // { signedURL: '/object/sign/<bucket>/<path>?token=...' }
  return SUPA_URL + '/storage/v1' + (j.signedURL || j.signedUrl || '');
}
async function storageRemover(path){
  await fetch(SUPA_URL + '/storage/v1/object/' + DOCS_BUCKET + '/' + encodeURI(path), {
    method: 'DELETE', headers: svcHeaders()
  }).catch(function(){});
}

// ---- CPF: valida formato + digitos verificadores -----------
function soDigitos(s){ return String(s || '').replace(/\D/g, ''); }
function cpfValido(cpfRaw){
  const cpf = soDigitos(cpfRaw);
  if(cpf.length !== 11) return false;
  if(/^(\d)\1{10}$/.test(cpf)) return false; // 00000000000, 11111111111...
  let soma = 0;
  for(let i = 0; i < 9; i++) soma += parseInt(cpf[i], 10) * (10 - i);
  let d1 = (soma * 10) % 11; if(d1 === 10) d1 = 0;
  if(d1 !== parseInt(cpf[9], 10)) return false;
  soma = 0;
  for(let i = 0; i < 10; i++) soma += parseInt(cpf[i], 10) * (11 - i);
  let d2 = (soma * 10) % 11; if(d2 === 10) d2 = 0;
  return d2 === parseInt(cpf[10], 10);
}

// ---- comparacao de nome (homonimo) -------------------------
function normNome(s){
  return String(s || '')
    .toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- MOCK: varia o resultado pelo ultimo digito do CPF -----
// Assim da pra demonstrar os 3 status digitando qualquer CPF valido:
//   final 0/1 -> REPROVADO (antecedente criminal)   | 2/3 -> REPROVADO (CNH suspensa)
//   final 4/5 -> ANALISE (processo civel + CNH venc) | 6/7 -> ANALISE (homonimo: criminal de OUTRA pessoa)
//   final 8/9 -> APTO
function mockResposta(cpfRaw, nome){
  const cpf = soDigitos(cpfRaw);
  const d = parseInt(cpf[10] || '8', 10);
  const nomeEcho = normNome(nome) || 'PORTADOR NAO IDENTIFICADO';
  const base = {
    fonte: 'mock',
    nome: nomeEcho,
    cpf_situacao: 'regular',
    antecedentes: { criminal_positivo: false, detalhe: 'Nada consta (mock).' },
    processos: [],
    cnh: { numero: '0000' + (cpf.slice(0,7)), categoria: 'AB', situacao: 'valida', validade: '2028-04-15' }
  };
  if(d <= 1){
    base.antecedentes = { criminal_positivo: true, detalhe: 'Condenacao criminal transitada em julgado (mock).' };
  } else if(d <= 3){
    base.cnh.situacao = 'suspensa';
  } else if(d <= 5){
    base.processos = [{ numero: '0001234-56.2025.8.11.0001', esfera: 'civel', polo: 'reu', ativo: true, assunto: 'Cobranca (mock)' }];
    base.cnh.situacao = 'vencida'; base.cnh.validade = '2024-02-10';
  } else if(d <= 7){
    // Homonimo: o agregador retorna criminal, MAS com nome diferente do informado.
    base.nome = 'JOSE ROBERTO DA SILVA SANTOS';
    base.antecedentes = { criminal_positivo: true, detalhe: 'Anotacao criminal (possivel homonimo - nome diverge).' };
  }
  return base;
}

// ---- normaliza o retorno do agregador (mock ou real) -------
function normalizar(bruto){
  bruto = bruto || {};
  return {
    nome: bruto.nome || null,
    cpf_situacao: bruto.cpf_situacao || 'regular',
    antecedentes: bruto.antecedentes || { criminal_positivo: false },
    processos: Array.isArray(bruto.processos) ? bruto.processos : [],
    cnh: bruto.cnh || { situacao: 'desconhecida' }
  };
}

// ---- regra do Driver Status --------------------------------
function calcularDriverStatus(norm, nomeInformado){
  const nomeRet = norm.nome;
  const homonimo = !!(nomeInformado && nomeRet && normNome(nomeInformado) !== normNome(nomeRet));

  const antCriminal = norm.antecedentes && norm.antecedentes.criminal_positivo === true;
  const antRevisao = norm.antecedentes && norm.antecedentes.revisao === true;
  const procs = norm.processos || [];
  const procCriminalReu = procs.some(p => p.esfera === 'criminal' && p.polo === 'reu' && p.ativo);
  const cnhSit = (norm.cnh && norm.cnh.situacao) || 'desconhecida';
  const cnhSuspensa = (cnhSit === 'suspensa' || cnhSit === 'cassada');
  const cnhVencida = (cnhSit === 'vencida');
  const cpfIrregular = norm.cpf_situacao && norm.cpf_situacao !== 'regular';
  const procCivelTrab = procs.some(p => p.esfera === 'civel' || p.esfera === 'trabalhista');

  let status;
  if(antCriminal || procCriminalReu || cnhSuspensa) status = 'REPROVADO';
  else if(procCivelTrab || cnhVencida || homonimo || cpfIrregular || antRevisao) status = 'ANALISE';
  else status = 'APTO';

  // Homonimo NUNCA reprova automatico (pode ser outra pessoa com o mesmo nome).
  if(homonimo && status === 'REPROVADO') status = 'ANALISE';

  let score = 100;
  if(antCriminal) score -= 60;
  if(procCriminalReu) score -= 50;
  if(cnhSuspensa) score -= 40;
  if(cnhVencida) score -= 12;
  if(procCivelTrab) score -= 15;
  if(cpfIrregular) score -= 12;
  if(antRevisao) score -= 15;
  if(homonimo) score -= 8;
  if(score < 0) score = 0; if(score > 100) score = 100;

  return { status, score, homonimo };
}

function resumoTexto(status, norm){
  if(status === 'REPROVADO') return 'Restricao grave encontrada. Nao recomendado.';
  if(status === 'ANALISE') return 'Ha pontos que exigem analise humana antes de decidir.';
  return 'Nada consta. CNH e situacao regulares.';
}

// monta o JSON enxuto pro front (nunca devolve o raw)
function resposta(reg){
  return {
    driver_status: reg.driver_status,
    score: reg.score,
    resumo: reg.resumo || null,
    homonimo_risco: reg.homonimo_risco === true,
    nome_retornado: reg.nome_retornado || null,
    nome_informado: reg.nome_informado || null,
    cpf: reg.cpf,
    consultado_em: reg.consultado_em,
    detalhes: {
      antecedentes: reg.antecedentes || null,
      processos: reg.processos || [],
      cnh: reg.cnh || null
    }
  };
}

// ============================================================
// FASE 2 — AGREGADOR REAL (Infosimples v2)  [processos + CNH]
// Transporte padrao da Infosimples: POST form-urlencoded, auth por `token`,
// resposta { code:200, data:[...], errors:[...] }.
// Config por ENV (nada hardcodado):
//   AGREGADOR_API_KEY   = token da Infosimples
//   AGREGADOR_CNH_PATH  = caminho da consulta de CNH   (ex: 'senatran/validar-cnh' ou 'detran/ro/cnh') — vazio = pula CNH
//   AGREGADOR_PROC_PATH = caminho da consulta de processos por CPF (ex: 'tribunal/.../processos') — vazio = pula processos
// OBS: o mapeamento dos campos abaixo e PROVISORIO — ajusto pro shape exato do
// endpoint que voce contratar assim que a chave chegar (por isso fica em MOCK ate la).
// ============================================================
async function infosimplesConsulta(path, params){
  const token = process.env.AGREGADOR_API_KEY;
  const url = 'https://api.infosimples.com/api/v2/consultas/' + path;
  const form = new URLSearchParams(Object.assign({ token: token, timeout: '600' }, params || {}));
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  const j = await r.json().catch(function(){ return {}; });
  return j; // { code, code_message, data:[...], errors:[...] }
}
// So confia nos dados quando code === 200 (sucesso). Qualquer outro code = falha.
function infosimplesOk(j){ return !!(j && j.code === 200 && Array.isArray(j.data)); }

// Candidatos de slug por consulta (a Infosimples nao expoe o slug na pagina publica).
// code 602 = "servico invalido" e NAO e cobrado, entao da pra testar candidatos de
// graca ate achar o que existe. O slug correto ainda pode ser fixado por ENV.
// Slugs OFICIAIS confirmados no catalogo da Infosimples (26/08/2026):
const SLUGS_CNH = ['senatran/validar-cnh'];               // Restrito (precisa liberar acesso)
const SLUGS_ANTECEDENTES = ['antecedentes-criminais/pf/emit', 'antecedentes-criminais/pf/val'];
const SLUGS_MANDADOS = ['cnj/mandados-prisao'];
// cache do slug descoberto (persiste em container quente)
const _slugCache = {};
async function infosimplesAuto(chave, envSlug, candidatos, params){
  // ENV fixa tem prioridade; senao usa o cache; senao testa os candidatos.
  const lista = envSlug ? [envSlug] : (_slugCache[chave] ? [_slugCache[chave]] : candidatos);
  let ultima = null;
  for(const s of lista){
    const j = await infosimplesConsulta(s, params);
    ultima = j;
    if(j && j.code !== 602){ _slugCache[chave] = s; return j; } // 602 = servico inexistente
  }
  return ultima;
}
function mapSituacaoCnh(s){
  s = String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); // tira acento: "válida" -> "valida"
  if(/suspens/.test(s)) return 'suspensa';
  if(/cassa|cancelad/.test(s)) return 'cassada';
  if(/vencid|expirad/.test(s)) return 'vencida';
  if(/regular|valid|ativ|apto/.test(s)) return 'valida';
  return 'desconhecida';
}
function mapEsfera(txt){
  txt = String(txt || '').toLowerCase();
  if(/crim|penal/.test(txt)) return 'criminal';
  if(/trabalh/.test(txt)) return 'trabalhista';
  return 'civel';
}
// Monta o shape interno (igual ao mock) a partir das respostas da Infosimples.
// Stack nacional: SENATRAN Validar CNH + PF Antecedentes + CNJ Mandados de Prisao.
// Cada consulta e opcional (so roda se o path estiver setado no ENV).
async function consultarAgregador(cpf, nome, extra){
  extra = extra || {};
  const out = {
    fonte: 'infosimples', nome: nome ? normNome(nome) : null, cpf_situacao: 'regular',
    antecedentes: { criminal_positivo: false, detalhe: 'Sem consulta de antecedentes configurada.' },
    processos: [], cnh: { situacao: 'desconhecida' }, identidade: null, mandados: [], fontes: []
  };
  const revisaoMotivos = [];
  function _fonte(nome, j){ out.fontes.push({ fonte: nome, code: (j && j.code) || null, msg: (j && j.code_message) || null }); }

  // ---- CNH: SENATRAN / Validar CNH (campos exatos da Infosimples) ----
  if(process.env.AGREGADOR_CNH_PATH !== 'off'){
    try {
      const jc = await infosimplesAuto('cnh', process.env.AGREGADOR_CNH_PATH, SLUGS_CNH, {
        cpf: cpf,
        registro: extra.registro || '',
        codigo_seguranca: extra.codigo_seguranca || '',
        nome_condutor: nome || '',
        nome_mae: extra.nome_mae || '',
        // credenciais de acesso ao portal SENATRAN (login gov.br) OU certificado A1:
        login_cpf: process.env.SENATRAN_LOGIN_CPF || '',
        login_senha: process.env.SENATRAN_LOGIN_SENHA || '',
        pkcs12_cert: process.env.SENATRAN_PKCS12_CERT || '',
        pkcs12_pass: process.env.SENATRAN_PKCS12_PASS || ''
      });
      _fonte('CNH', jc);
      if(infosimplesOk(jc) && jc.data[0]){
        const d = jc.data[0];
        out.cnh = {
          numero: d.registro || null, categoria: d.categoria || null,
          validade: d.validade_data || null, emissao: d.emissao_data || null,
          situacao: mapSituacaoCnh(d.situacao)
        };
        if(d.nome) out.nome = normNome(d.nome);
        out.identidade = { nome_confere: d.nome_condutor_identico_ao_informado, mae_confere: d.nome_mae_identico_ao_informado };
      } else {
        revisaoMotivos.push('CNH nao confirmada (' + ((jc && jc.code_message) || 'sem retorno') + ')');
      }
    } catch(e){ revisaoMotivos.push('CNH indisponivel'); }
  }

  // ---- ANTECEDENTES: Policia Federal / SINIC (campo chave: conseguiu_emitir_certidao_negativa) ----
  if(process.env.AGREGADOR_ANTECEDENTES_PATH !== 'off'){
    try {
      const ja = await infosimplesAuto('antecedentes', process.env.AGREGADOR_ANTECEDENTES_PATH, SLUGS_ANTECEDENTES, {
        cpf: cpf, nome: nome || '', nome_mae: extra.nome_mae || '', nome_pai: extra.nome_pai || '',
        birthdate: extra.nascimento || '', uf_nascimento: extra.uf_nascimento || ''
      });
      _fonte('Antecedentes PF', ja);
      if(infosimplesOk(ja) && ja.data[0]){
        const d = ja.data[0];
        const negativa = (d.conseguiu_emitir_certidao_negativa === true);
        // Negativa emitida = nada consta. NAO emitida NAO prova crime (pode ser divergencia
        // de dados) => nao reprova; marca REVISAO (vira ANALISE) pra conferencia humana.
        out.antecedentes = {
          criminal_positivo: false,
          revisao: !negativa,
          detalhe: negativa
            ? 'Nada consta - certidao negativa emitida (PF/SINIC).'
            : ((d.mensagem || 'Nao foi possivel emitir a certidao negativa') + ' - conferir manualmente (PF/SINIC).'),
          certidao: d.numero || d.certidao_codigo || null,
          validade: d.validade_data || null
        };
      } else {
        revisaoMotivos.push('Antecedentes PF nao confirmados (' + ((ja && ja.code_message) || 'sem retorno') + ')');
      }
    } catch(e){ revisaoMotivos.push('Antecedentes PF indisponivel'); }
  }

  // ---- MANDADOS DE PRISAO: CNJ / BNMP (mandado em aberto = restricao grave) ----
  if(process.env.AGREGADOR_MANDADOS_PATH !== 'off'){
    try {
      const jm = await infosimplesAuto('mandados', process.env.AGREGADOR_MANDADOS_PATH, SLUGS_MANDADOS, { cpf: cpf, nome: nome || '', nome_mae: extra.nome_mae || '' });
      _fonte('Mandados CNJ', jm);
      if(infosimplesOk(jm)){
        const mandados = jm.data.filter(function(x){ return x && (x.mandado || x.processo || x.tipificacao_penal); });
        out.mandados = mandados.map(function(m){
          return { mandado: m.mandado || null, processo: m.processo || null, tipificacao: m.tipificacao_penal || m.artigo || null, situacao: m.situacao || null, orgao: m.orgao_judicial || m.tribunal || null, expedicao: m.expedicao_datahora || null };
        });
        if(out.mandados.length){
          out.antecedentes.criminal_positivo = true;   // mandado de prisao em aberto = REPROVADO
          out.antecedentes.revisao = false;
          out.antecedentes.detalhe = 'MANDADO DE PRISAO em aberto (CNJ/BNMP): ' + (out.mandados[0].tipificacao || out.mandados[0].situacao || 'ver detalhes') + '.';
        }
      } else {
        revisaoMotivos.push('Mandados CNJ nao confirmados (' + ((jm && jm.code_message) || 'sem retorno') + ')');
      }
    } catch(e){ revisaoMotivos.push('Mandados CNJ indisponivel'); }
  }

  // FAIL-SAFE: se alguma consulta configurada nao confirmou e NAO ha reprovacao
  // definitiva, manda pra ANALISE (nunca deixa passar como APTO por falha tecnica).
  if(revisaoMotivos.length && !out.antecedentes.criminal_positivo){
    out.antecedentes.revisao = true;
    var base = (out.antecedentes.detalhe && out.antecedentes.detalhe.indexOf('Sem consulta') < 0) ? (out.antecedentes.detalhe + ' | ') : '';
    out.antecedentes.detalhe = base + 'Conferir: ' + revisaoMotivos.join('; ') + '.';
  }

  return out;
}

exports.handler = async function(event){
  const origin = event.headers.origin || event.headers.Origin || '';
  const cors = corsHeaders(origin);

  if(event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if(event.httpMethod !== 'POST') return json(cors, { ok:false, erro:'Use POST' }, 405);
  if(!SUPA_SERVICE_KEY) return json(cors, { ok:false, erro:'Servidor sem SUPA_SERVICE_KEY' }, 500);

  const callerId = event.headers['x-gami-user'] || event.headers['X-Gami-User'] || '';
  const callerToken = event.headers['x-gami-token'] || event.headers['X-Gami-Token'] || '';

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e){ return json(cors, { ok:false, erro:'Body invalido' }, 400); }

  if(!callerId || !callerToken) return json(cors, { ok:false, erro:'Sessao nao informada' }, 401);

  try {
    // ---- 1) valida sessao + super_admin (igual admin-reset-pin) ----
    const rC = await fetch(SUPA_URL + '/rest/v1/usuarios_login?pessoa_id=eq.' + encodeURIComponent(callerId) + '&select=pessoa_id,nome,email,token_atual,token_expira_em,ativo&limit=1', { headers: svcHeaders() });
    if(!rC.ok) return json(cors, { ok:false, erro:'Falha ao validar sessao' }, 500);
    const arrC = await rC.json();
    if(!Array.isArray(arrC) || !arrC.length) return json(cors, { ok:false, erro:'Sessao nao encontrada' }, 401);
    const caller = arrC[0];
    if(caller.ativo === false) return json(cors, { ok:false, erro:'Usuario desativado' }, 403);
    if(!caller.token_atual || caller.token_atual !== callerToken) return json(cors, { ok:false, erro:'Token invalido (faca login de novo)' }, 401);
    if(caller.token_expira_em && new Date(caller.token_expira_em) < new Date()) return json(cors, { ok:false, erro:'Sessao expirada (faca login de novo)' }, 401);
    if(String(caller.email || '').toLowerCase() !== SUPER_ADMIN_EMAIL) return json(cors, { ok:false, erro:'Acesso restrito.' }, 403);

    const action = body.action || 'consultar';

    // ---- 2) HISTORICO ----
    if(action === 'historico'){
      const rH = await fetch(SUPA_URL + '/rest/v1/motorista_consultas?select=id,cpf,nome_informado,nome_retornado,driver_status,score,homonimo_risco,consultado_em,consultado_por_nome,fonte&order=consultado_em.desc&limit=50', { headers: svcHeaders() });
      if(!rH.ok) return json(cors, { ok:false, erro:'Falha ao ler historico' }, 500);
      const lista = await rH.json();
      return json(cors, { ok:true, historico: Array.isArray(lista) ? lista : [] });
    }

    // ---- OCR: le CPF/nome/CNH de uma FOTO do documento (sem digitar) ----
    if(action === 'doc_ocr'){
      if(!process.env.ANTHROPIC_API_KEY) return json(cors, { ok:false, erro:'OCR indisponivel (sem ANTHROPIC_API_KEY)' }, 501);
      const img = body.image_base64 || '';
      const mime = body.mime || 'image/jpeg';
      if(!img) return json(cors, { ok:false, erro:'imagem_ausente' }, 400);
      try {
        const prompt = 'Voce recebe uma CNH (Carteira Nacional de Habilitacao) brasileira, em foto ou PDF. Extraia os campos e responda SOMENTE com um JSON valido, sem nenhum texto fora do JSON, no formato exato: {"cpf":"11 digitos ou null","nome":"nome completo do condutor ou null","nome_mae":"nome da mae (filiacao) ou null","nome_pai":"nome do pai (filiacao) ou null","nascimento":"AAAA-MM-DD ou null","cnh_registro":"numero de registro da CNH (11 digitos) ou null","cnh_seguranca":"numero de seguranca da CNH / codigo de seguranca ou null","cnh_categoria":"ex AB ou null","cnh_validade":"AAAA-MM-DD ou null"}. Se nao for uma CNH legivel, retorne todos os campos como null.';
        // PDF vai como bloco 'document'; imagem como 'image'.
        const ehPdf = String(mime).toLowerCase().indexOf('pdf') >= 0;
        const blocoMidia = ehPdf
          ? { type:'document', source:{ type:'base64', media_type:'application/pdf', data: img } }
          : { type:'image', source:{ type:'base64', media_type: mime, data: img } };
        const rA = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'content-type':'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 400,
            messages: [{ role:'user', content: [ blocoMidia, { type:'text', text: prompt } ] }]
          })
        });
        if(!rA.ok) return json(cors, { ok:false, erro:'OCR falhou (' + rA.status + ')' }, 502);
        const jA = await rA.json();
        let txt = (jA.content && jA.content[0] && jA.content[0].text) || '';
        txt = txt.replace(/```json|```/g, '').trim();
        let dados = {};
        try { dados = JSON.parse(txt); }
        catch(e){ const m = txt.match(/\{[\s\S]*\}/); if(m){ try { dados = JSON.parse(m[0]); } catch(_){} } }
        const cpfOcr = soDigitos(dados.cpf);
        return json(cors, {
          ok: true,
          cpf: cpfValido(cpfOcr) ? cpfOcr : null,
          cpf_bruto: cpfOcr || null,
          nome: dados.nome || null,
          cnh: { numero: dados.cnh_registro || null, categoria: dados.cnh_categoria || null, validade: dados.cnh_validade || null },
          // campos extras que o SENATRAN/PF exigem — vao junto na hora do Verificar:
          extra: {
            registro: dados.cnh_registro || null,
            codigo_seguranca: dados.cnh_seguranca || null,
            nome_mae: dados.nome_mae || null,
            nome_pai: dados.nome_pai || null,
            nascimento: dados.nascimento || null
          }
        });
      } catch(e){
        return json(cors, { ok:false, erro:'Erro no OCR' }, 500);
      }
    }

    // ---- DOCUMENTOS (anexos): bucket privado + URLs assinadas ----
    if(action === 'doc_sign_upload'){
      const cpfD = soDigitos(body.cpf);
      if(!cpfValido(cpfD)) return json(cors, { ok:false, erro:'cpf_invalido' }, 400);
      const nome = nomeSeguro(body.filename);
      const path = cpfD + '/' + crypto.randomUUID() + '-' + nome;
      try {
        const uploadUrl = await storageSignUpload(path);
        return json(cors, { ok:true, uploadUrl, storage_path: path, nome_arquivo: nome });
      } catch(e){
        return json(cors, { ok:false, erro:'Falha ao preparar upload: ' + (e && e.message || 'erro') }, 500);
      }
    }
    if(action === 'doc_registrar'){
      const cpfD = soDigitos(body.cpf);
      if(!cpfValido(cpfD)) return json(cors, { ok:false, erro:'cpf_invalido' }, 400);
      if(!body.storage_path) return json(cors, { ok:false, erro:'storage_path_ausente' }, 400);
      const tipo = DOC_TIPOS.indexOf(body.tipo) >= 0 ? body.tipo : 'outro';
      const rIns = await fetch(SUPA_URL + '/rest/v1/motorista_documentos', {
        method: 'POST',
        headers: svcHeaders({ 'Content-Type':'application/json', 'Prefer':'return=minimal' }),
        body: JSON.stringify({
          cpf: cpfD, tipo, nome_arquivo: (body.nome_arquivo || null),
          storage_path: body.storage_path, mime: (body.mime || null),
          tamanho: (body.tamanho || null),
          enviado_por: caller.pessoa_id, enviado_por_nome: caller.nome || null
        })
      });
      if(!rIns.ok){ const t = await rIns.text().catch(()=> ''); return json(cors, { ok:false, erro:'Falha ao registrar: ' + t.substring(0,150) }, 500); }
      return json(cors, { ok:true });
    }
    if(action === 'doc_listar'){
      const cpfD = soDigitos(body.cpf);
      if(!cpfValido(cpfD)) return json(cors, { ok:true, documentos: [] });
      const rD = await fetch(SUPA_URL + '/rest/v1/motorista_documentos?cpf=eq.' + encodeURIComponent(cpfD) + '&select=id,tipo,nome_arquivo,storage_path,mime,tamanho,enviado_por_nome,enviado_em&order=enviado_em.desc', { headers: svcHeaders() });
      if(!rD.ok) return json(cors, { ok:false, erro:'Falha ao listar' }, 500);
      const docs = await rD.json();
      // gera URL assinada de leitura pra cada um (5 min)
      for(const d of (Array.isArray(docs) ? docs : [])){
        d.url = await storageSignView(d.storage_path, 300);
        delete d.storage_path;
      }
      return json(cors, { ok:true, documentos: Array.isArray(docs) ? docs : [] });
    }
    if(action === 'doc_excluir'){
      const id = String(body.id || '');
      if(!id) return json(cors, { ok:false, erro:'id_ausente' }, 400);
      const rGet = await fetch(SUPA_URL + '/rest/v1/motorista_documentos?id=eq.' + encodeURIComponent(id) + '&select=storage_path&limit=1', { headers: svcHeaders() });
      const arr = rGet.ok ? await rGet.json() : [];
      if(Array.isArray(arr) && arr.length) await storageRemover(arr[0].storage_path);
      await fetch(SUPA_URL + '/rest/v1/motorista_documentos?id=eq.' + encodeURIComponent(id), { method:'DELETE', headers: svcHeaders({ 'Prefer':'return=minimal' }) }).catch(function(){});
      return json(cors, { ok:true });
    }

    // ---- 3) CONSULTAR ----
    const cpf = soDigitos(body.cpf);
    const nome = (body.nome || '').trim();
    if(body.consentimento !== true) return json(cors, { ok:false, erro:'consentimento_obrigatorio' }, 400);
    if(!cpfValido(cpf)) return json(cors, { ok:false, erro:'cpf_invalido' }, 400);

    // 3.1) cache 24h
    const desde24h = new Date(Date.now() - 864e5).toISOString();
    const rCache = await fetch(SUPA_URL + '/rest/v1/motorista_consultas?cpf=eq.' + encodeURIComponent(cpf) + '&consultado_em=gte.' + encodeURIComponent(desde24h) + '&order=consultado_em.desc&limit=1', { headers: svcHeaders() });
    if(rCache.ok){
      const cacheArr = await rCache.json();
      if(Array.isArray(cacheArr) && cacheArr.length){
        return json(cors, { ok:true, cache:true, resultado: resposta(cacheArr[0]) });
      }
    }

    // 3.2) chama agregador (ou mock)
    const useMock = (process.env.USE_MOCK === 'true') || !process.env.AGREGADOR_API_KEY;
    let bruto;
    if(useMock){
      bruto = mockResposta(cpf, nome);
    } else {
      // FASE 2: agregador real (Infosimples). So roda quando AGREGADOR_API_KEY estiver
      // setado e USE_MOCK != 'true'. `extra` traz os campos lidos do OCR da CNH.
      bruto = await consultarAgregador(cpf, nome, body.extra || {});
    }

    const norm = normalizar(bruto);
    const { status, score, homonimo } = calcularDriverStatus(norm, nome);
    const resumo = resumoTexto(status, norm);

    // 3.3) grava (service key) com raw pra auditoria
    const registro = {
      cpf,
      nome_informado: nome || null,
      nome_retornado: norm.nome,
      driver_status: status,
      score,
      antecedentes: norm.antecedentes,
      processos: norm.processos,
      cnh: norm.cnh,
      homonimo_risco: homonimo,
      consentimento: true,
      consultado_por: caller.pessoa_id,
      consultado_por_nome: caller.nome || null,
      consultado_por_email: caller.email || null,
      fonte: bruto.fonte || (useMock ? 'mock' : 'agregador'),
      raw: bruto
    };
    const rIns = await fetch(SUPA_URL + '/rest/v1/motorista_consultas', {
      method: 'POST',
      headers: svcHeaders({ 'Content-Type':'application/json', 'Prefer':'return=representation' }),
      body: JSON.stringify(registro)
    });
    if(!rIns.ok){
      const txt = await rIns.text().catch(() => '');
      return json(cors, { ok:false, erro:'Falha ao gravar: ' + txt.substring(0,200) }, 500);
    }
    const inseridoArr = await rIns.json();
    const reg = Array.isArray(inseridoArr) ? inseridoArr[0] : inseridoArr;
    reg.resumo = resumo;
    const rResp = resposta(reg);
    if(bruto && bruto.fontes) rResp.fontes = bruto.fontes; // status de cada consulta (diagnostico)

    return json(cors, { ok:true, cache:false, resultado: rResp });

  } catch(err){
    console.error('[verificar-motorista]', err && err.message);
    return json(cors, { ok:false, erro: 'Erro interno' }, 500);
  }
};
