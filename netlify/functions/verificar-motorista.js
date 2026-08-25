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
  const procs = norm.processos || [];
  const procCriminalReu = procs.some(p => p.esfera === 'criminal' && p.polo === 'reu' && p.ativo);
  const cnhSit = (norm.cnh && norm.cnh.situacao) || 'desconhecida';
  const cnhSuspensa = (cnhSit === 'suspensa' || cnhSit === 'cassada');
  const cnhVencida = (cnhSit === 'vencida');
  const cpfIrregular = norm.cpf_situacao && norm.cpf_situacao !== 'regular';
  const procCivelTrab = procs.some(p => p.esfera === 'civel' || p.esfera === 'trabalhista');

  let status;
  if(antCriminal || procCriminalReu || cnhSuspensa) status = 'REPROVADO';
  else if(procCivelTrab || cnhVencida || homonimo || cpfIrregular) status = 'ANALISE';
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
      // FASE 2: implementar consultarAgregador(cpf, nome) usando process.env.AGREGADOR_API_KEY.
      return json(cors, { ok:false, erro:'Agregador real ainda nao configurado (defina USE_MOCK=false + AGREGADOR_API_KEY e implemente consultarAgregador).' }, 501);
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

    return json(cors, { ok:true, cache:false, resultado: resposta(reg) });

  } catch(err){
    console.error('[verificar-motorista]', err && err.message);
    return json(cors, { ok:false, erro: 'Erro interno' }, 500);
  }
};
