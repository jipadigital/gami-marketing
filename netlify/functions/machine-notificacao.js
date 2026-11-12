// netlify/functions/machine-notificacao.js
// Disparo de NOTIFICAÇÃO PUSH pela API OFICIAL da Machine (Gaudium) v2, reaproveitando
// as credenciais MACHINE_* por cidade (api-key + Basic) que já usamos pra ler dados.
// Sem robô, sem senha no cliente. Separa MOTOBOYS (condutores) de EMPRESAS (passageiros).
// SÓ super_admin. Modo TESTE: manda pra uma lista de IDs (ex: 1 condutor) sem listar todos.
//
// POST body: { cidade, publico: 'motoboys'|'empresas', titulo, mensagem, teste_ids?: number[] }
// Docs: /notificacoes/condutor/push (condutores[]), /notificacoes/push (passageiros[]),
//       /condutores (status_condutor=A), /empresas. Limite 1000 ids/lote.
'use strict';

const { credenciais } = require('../lib/machine-api.js');

const BASE = 'https://api.taximachine.com.br/api/v2/integracao';
const SUPA_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
const SUPER_ADMIN_EMAIL = 'jipadigital@gmail.com';
// Cidades ENCERRADAS: somem da lista e não podem receber disparo, mesmo que a chave
// ainda exista no env. (Cuiabá e Vitória encerradas.) Adicione aqui se encerrar outra.
const CIDADES_EXCLUIDAS = ['cuiaba', 'vitoria'];
const ORIGENS = ['https://gami-marketing.netlify.app', 'http://localhost:8888', 'http://localhost:3000'];

function corsHeaders(origin) {
  const ok = ORIGENS.indexOf(origin) >= 0 ? origin : ORIGENS[0];
  return {
    'Access-Control-Allow-Origin': ok,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Gami-User, X-Gami-Token',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
  };
}

function tokenAtivo(u, token) {
  const agora = new Date();
  if (u.token_atual && u.token_atual === token && (!u.token_expira_em || new Date(u.token_expira_em) >= agora)) return true;
  if (Array.isArray(u.sessoes_ativas)) {
    for (const s of u.sessoes_ativas) {
      if (s && s.t === token && (!s.e || new Date(s.e) >= agora)) return true;
    }
  }
  return false;
}

// Valida a sessão (igual machine.js) e devolve o usuário; null se inválida.
async function validarCaller(userId, token) {
  const chave = process.env.SUPA_SERVICE_KEY || '';
  if (!chave || !userId || !token || !/^[A-Za-z0-9_\-]{2,80}$/.test(userId)) return null;
  try {
    const r = await fetch(
      SUPA_URL + '/rest/v1/usuarios_login?pessoa_id=eq.' + encodeURIComponent(userId) + '&select=pessoa_id,email,token_atual,token_expira_em,sessoes_ativas,ativo&limit=1',
      { headers: { apikey: chave, Authorization: 'Bearer ' + chave } },
    );
    if (!r.ok) return null;
    const arr = await r.json();
    const u = Array.isArray(arr) && arr[0];
    if (!u || u.ativo === false || !tokenAtivo(u, token)) return null;
    return u;
  } catch (e) {
    return null;
  }
}

// Nível/cargo da pessoa (fonte canônica: pessoas.nivel_permissao). Pra liberar o disparo
// pra super_admin + diretoria + gerência, validado no SERVIDOR (não confia no cliente).
async function nivelDaPessoa(pessoaId) {
  const chave = process.env.SUPA_SERVICE_KEY || '';
  if (!chave || !pessoaId) return null;
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/pessoas?id=eq.' + encodeURIComponent(pessoaId) + '&select=nivel_permissao,cargo,email&limit=1', {
      headers: { apikey: chave, Authorization: 'Bearer ' + chave },
    });
    if (!r.ok) return null;
    const arr = await r.json();
    return (Array.isArray(arr) && arr[0]) || null;
  } catch (e) { return null; }
}
const DISPARO_BLOQUEADOS_EMAIL = ['matheus@mfedrizziconsultoria.com'];
const DISPARO_BLOQUEADOS_ID = ['pecarlosvinicius', 'pematheusfedrizzi'];
function autorizadoDisparo(pessoa, emailLogin, pessoaId) {
  const email = String((pessoa && pessoa.email) || emailLogin || '').toLowerCase();
  if (email === SUPER_ADMIN_EMAIL) return true;
  // Exclusões explícitas (pedido do dono 12/11): Carlos e Matheus NÃO, mesmo sendo diretoria/gerência.
  if (DISPARO_BLOQUEADOS_EMAIL.indexOf(email) >= 0) return false;
  if (DISPARO_BLOQUEADOS_ID.indexOf(String(pessoaId || '')) >= 0) return false;
  const np = String((pessoa && pessoa.nivel_permissao) || '').toLowerCase().trim();
  if (np === 'super_admin' || np === 'diretoria' || np === 'gerencia') return true;
  if (np) return false; // nível canônico definido e não é diretoria/gerência → nega
  const cargo = String((pessoa && pessoa.cargo) || '').toLowerCase();
  if (cargo.indexOf('diretor') >= 0) return true; // diretor / diretoria
  if (cargo.indexOf('gerente') >= 0) return true; // gerência (ex: Thiago, Leo)
  return false;
}

function headersMachine(cred) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'api-key': cred.apiKey,
    Authorization: 'Basic ' + Buffer.from(cred.user + ':' + cred.pass).toString('base64'),
  };
}

// Lista TODOS os IDs do público (condutores status A, ou empresas status A), paginado (100/pág).
async function listarIds(publico, cred, tempoMaxMs) {
  const path = publico === 'empresas' ? '/empresas' : '/condutores';
  const ids = [];
  const inicio = Date.now();
  let completo = true;
  for (let pg = 1; pg <= 500; pg++) {
    if (Date.now() - inicio > tempoMaxMs) { completo = false; break; }
    const url = BASE + path + '?pagina=' + pg + '&limite=100' + (publico === 'empresas' ? '' : '&status_condutor=A');
    let r, j;
    try {
      r = await fetch(url, { headers: headersMachine(cred) });
      j = await r.json();
    } catch (e) {
      if (pg === 1) throw new Error('Não consegui listar ' + publico + ' na Machine.');
      completo = false;
      break;
    }
    if (r.status === 404) break; // sem registros / fim
    if (!r.ok || !j || j.success === false) {
      if (pg === 1) throw new Error('Falha ao listar ' + publico + ' (HTTP ' + r.status + '). Confira a permissão "API - Corrida" da chave.');
      completo = false;
      break;
    }
    const lote = Array.isArray(j.data) ? j.data : [];
    if (!lote.length) break;
    for (const x of lote) {
      if (publico === 'empresas' && x.status_empresa && x.status_empresa !== 'A') continue;
      const id = parseInt(x.id, 10);
      if (Number.isInteger(id) && id > 0) ids.push(id);
    }
    if (lote.length < 100) break;
  }
  return { ids: Array.from(new Set(ids)), completo };
}

// Dispara 1 lote (<=1000 ids) pro endpoint certo. Trata 207 (parcial) lendo data.falhas.
async function enviarLote(publico, cred, idsLote, titulo, mensagem) {
  const path = publico === 'empresas' ? '/notificacoes/push' : '/notificacoes/condutor/push';
  const campo = publico === 'empresas' ? 'passageiros' : 'condutores';
  const body = { [campo]: idsLote, mensagem };
  if (titulo) body.titulo = titulo;
  const r = await fetch(BASE + path, { method: 'POST', headers: headersMachine(cred), body: JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch (e) { /* sem corpo */ }
  const falhas = j && j.data && Array.isArray(j.data.falhas) ? j.data.falhas.length : (r.ok || r.status === 207 ? 0 : idsLote.length);
  return { status: r.status, enviados: Math.max(0, idsLote.length - falhas), falhas, erro: !r.ok && r.status !== 207 ? (j && (j.message || j.error)) || ('HTTP ' + r.status) : null };
}

exports.handler = async function (event) {
  const origin = event.headers.origin || event.headers.Origin || '';
  const cors = corsHeaders(origin);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ success: false, error: 'Use POST' }) };

  const hdr = event.headers || {};
  const caller = await validarCaller(hdr['x-gami-user'] || hdr['X-Gami-User'], hdr['x-gami-token'] || hdr['X-Gami-Token']);
  if (!caller) return { statusCode: 401, headers: cors, body: JSON.stringify({ success: false, error: 'Sessão inválida ou expirada. Faça login de novo.' }) };
  const _pessoaCaller = await nivelDaPessoa(caller.pessoa_id);
  if (!autorizadoDisparo(_pessoaCaller, caller.email, caller.pessoa_id)) {
    return { statusCode: 403, headers: cors, body: JSON.stringify({ success: false, error: 'Sem permissão (só super admin, diretoria e gerência).' }) };
  }

  let b = {};
  try { b = event.body ? JSON.parse(event.body) : {}; } catch (e) { b = {}; }

  // Modo 'historico': lê os disparos já feitos (pro painel). Service key (ignora RLS).
  if (b.acao === 'historico') {
    const chave = process.env.SUPA_SERVICE_KEY || '';
    try {
      const r = await fetch(SUPA_URL + '/rest/v1/disparos_log?select=*&order=criado_em.desc&limit=400', {
        headers: { apikey: chave, Authorization: 'Bearer ' + chave },
      });
      const rows = r.ok ? await r.json() : [];
      return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, disparos: Array.isArray(rows) ? rows : [] }) };
    } catch (e) {
      return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, disparos: [], aviso: 'Crie a tabela disparos_log pra guardar o histórico.' }) };
    }
  }

  // Modo 'excluir': apaga um disparo do histórico (por lote, ou por id). Service key.
  if (b.acao === 'excluir') {
    const chave = process.env.SUPA_SERVICE_KEY || '';
    const lote = String(b.lote || '').trim();
    const id = b.id != null ? String(b.id).trim() : '';
    if (!lote && !id) return { statusCode: 400, headers: cors, body: JSON.stringify({ success: false, error: 'Informe lote ou id.' }) };
    try {
      const q = lote ? ('lote=eq.' + encodeURIComponent(lote)) : ('id=eq.' + encodeURIComponent(id));
      const r = await fetch(SUPA_URL + '/rest/v1/disparos_log?' + q, {
        method: 'DELETE',
        headers: { apikey: chave, Authorization: 'Bearer ' + chave, Prefer: 'return=minimal' },
      });
      return { statusCode: r.ok ? 200 : 500, headers: cors, body: JSON.stringify({ success: r.ok }) };
    } catch (e) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ success: false, error: e.message }) };
    }
  }

  // Modo 'cidades': devolve as cidades que têm credenciais Machine no env (pra UI montar a lista).
  if (b.acao === 'cidades') {
    const cids = Object.keys(process.env)
      .filter((k) => /^MACHINE_API_KEY_[A-Z0-9_]+$/.test(k))
      .map((k) => k.replace('MACHINE_API_KEY_', '').toLowerCase().replace(/_/g, '-'))
      .filter((slug) => !!credenciais(slug)) // precisa de apiKey + user + pass
      .filter((slug) => CIDADES_EXCLUIDAS.indexOf(slug) < 0) // tira as encerradas
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort();
    return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, cidades: cids }) };
  }

  const cidade = String(b.cidade || '').toLowerCase().trim();
  const publico = b.publico === 'empresas' ? 'empresas' : 'motoboys';
  const titulo = String(b.titulo || '').slice(0, 40);
  const mensagem = String(b.mensagem || '').trim().slice(0, 255);
  const testeIds = Array.isArray(b.teste_ids)
    ? b.teste_ids.map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0).slice(0, 1000)
    : null;

  if (!cidade) return { statusCode: 400, headers: cors, body: JSON.stringify({ success: false, error: 'Informe a cidade.' }) };
  if (CIDADES_EXCLUIDAS.indexOf(cidade) >= 0) return { statusCode: 400, headers: cors, body: JSON.stringify({ success: false, error: 'Cidade encerrada, disparo bloqueado: ' + cidade }) };
  if (!mensagem) return { statusCode: 400, headers: cors, body: JSON.stringify({ success: false, error: 'A mensagem é obrigatória (até 255 caracteres).' }) };

  const cred = credenciais(cidade);
  if (!cred) return { statusCode: 400, headers: cors, body: JSON.stringify({ success: false, error: 'Cidade sem credenciais da Machine configuradas: ' + cidade }) };

  try {
    let alvos;
    let listaCompleta = true;
    const testeAuto = b.teste_auto === true; // lista e manda só pro PRIMEIRO (teste sem precisar de ID)
    if (testeIds && testeIds.length) {
      alvos = testeIds;
    } else {
      const lista = await listarIds(publico, cred, 7500);
      alvos = lista.ids;
      listaCompleta = lista.completo;
      if (testeAuto) alvos = alvos.slice(0, 1); // teste: só o primeiro da lista
    }
    const ehTeste = !!((testeIds && testeIds.length) || testeAuto);
    if (!alvos.length) {
      return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, cidade, publico, total: 0, enviados: 0, falhas: 0, aviso: 'Nenhum destinatário encontrado.' }) };
    }

    let enviados = 0;
    let falhas = 0;
    let lotes = 0;
    let ultimoErro = null;
    for (let k = 0; k < alvos.length; k += 1000) {
      const lote = alvos.slice(k, k + 1000);
      const res = await enviarLote(publico, cred, lote, titulo, mensagem);
      lotes++;
      enviados += res.enviados;
      falhas += res.falhas;
      if (res.erro) ultimoErro = res.erro;
      if (res.status === 429) await new Promise((r) => setTimeout(r, 1500)); // respeita Retry-After de forma simples
    }

    // Histórico: guarda o disparo real (não o teste) pro painel. Nunca trava o retorno.
    if (!ehTeste) {
      try {
        const chave = process.env.SUPA_SERVICE_KEY || '';
        await fetch(SUPA_URL + '/rest/v1/disparos_log', {
          method: 'POST',
          headers: { apikey: chave, Authorization: 'Bearer ' + chave, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify([{
            lote: String(b.lote || '').slice(0, 60) || null,
            autor_id: caller.pessoa_id,
            autor_nome: String(b.autor_nome || '').slice(0, 120) || null,
            publico,
            cidade,
            titulo: titulo || null,
            mensagem,
            total: alvos.length,
            enviados,
            falhas,
          }]),
        });
      } catch (e) { /* histórico não pode travar o disparo */ }
    }

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        success: true,
        cidade,
        publico,
        teste: ehTeste,
        total: alvos.length,
        enviados,
        falhas,
        lotes,
        lista_completa: ehTeste ? true : listaCompleta,
        ...(testeAuto ? { alvo_teste: alvos[0] } : {}),
        ...(ultimoErro ? { aviso: 'Alguns lotes falharam: ' + ultimoErro } : {}),
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
