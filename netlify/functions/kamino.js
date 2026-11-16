// netlify/functions/kamino.js
// -----------------------------------------------------------------------------
// Ponte de LEITURA com a API do Kamino (13/11/2026). Ambiente: o Kamino ANTIGO
// (gamidelivery.kamino.pro), que continua em uso porque o novo ainda não integra com o Cora.
//
// Credenciais: UMA variável de ambiente, KAMINO_API_JSON (escopo Functions), com
//   {"url":"https://...kamino.tech","app":"...","cn":"...","idusr":"...","usr":"...","hash":"..."}
// geradas no usuário dashboard@gamidelivery.com.br (só Visualizador). Elas NUNCA saem daqui:
// nenhuma resposta devolve nem parte delas.
//
// Autenticação do Kamino: 5 cabeçalhos fixos em toda chamada (App, CN, IDUsr, Usr, Hash).
// Limite deles: 20 requisições por minuto por empresa.
//
// Por enquanto só a ação 'teste' (lista as contas bancárias ativas, sem gravar nada) e só
// para o super admin. O sync pro módulo financeiro vem depois, em cima desta base.
// -----------------------------------------------------------------------------

const { exigirSessao } = require('../lib/sessao');

const SUPER_ADMIN_EMAIL = 'jipadigital@gmail.com';
const ORIGENS = ['https://gami-marketing.netlify.app', 'http://localhost:8888'];

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ORIGENS.indexOf(origin) >= 0 ? origin : ORIGENS[0],
    'Access-Control-Allow-Headers': 'Content-Type, X-Gami-User, X-Gami-Token',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
}

// Lê e confere as credenciais. Devolve { cred } ou { erro } (o erro nunca cita valores).
function credenciais() {
  const bruto = process.env.KAMINO_API_JSON || '';
  if (!bruto.trim()) return { erro: 'KAMINO_API_JSON não está configurada no Netlify (ou falta o redeploy).' };
  let j;
  try { j = JSON.parse(bruto); } catch (e) { return { erro: 'KAMINO_API_JSON não é um JSON válido (confira aspas e chaves).' }; }
  const faltam = ['url', 'app', 'cn', 'idusr', 'usr', 'hash'].filter((k) => !String((j && j[k]) || '').trim());
  if (faltam.length) return { erro: 'Faltam campos em KAMINO_API_JSON: ' + faltam.join(', ') };
  let host = '';
  try {
    const u = new URL(String(j.url).trim());
    if (u.protocol !== 'https:') return { erro: 'O "url" do Kamino precisa começar com https://' };
    host = u.host.toLowerCase();
  } catch (e) { return { erro: 'O "url" do Kamino não é um endereço válido.' }; }
  // Só manda as chaves pra servidor do próprio Kamino.
  if (!/(^|\.)kamino\.(tech|pro|com\.br)$/.test(host)) return { erro: 'O "url" não é um endereço do Kamino (esperado ...kamino.tech).' };
  return {
    cred: {
      base: String(j.url).trim().replace(/\/+$/, ''),
      headers: {
        Accept: 'application/json',
        App: String(j.app).trim(),
        CN: String(j.cn).trim(),
        IDUsr: String(j.idusr).trim(),
        Usr: String(j.usr).trim(),
        Hash: String(j.hash).trim(),
      },
    },
  };
}

// Mensagem de erro do Kamino, curta e LIMPA: qualquer trecho igual a uma das nossas chaves
// vira [oculto] (caso a resposta ecoe cabeçalhos).
function mensagemErro(cred, corpo, trecho) {
  let m = '';
  if (corpo && typeof corpo === 'object') {
    m = corpo.Mensagem || corpo.mensagem || corpo.Message || corpo.message || corpo.title || corpo.Erro || corpo.erro || '';
    if (!m && Array.isArray(corpo.Erros)) m = corpo.Erros.join('; ');
    if (!m && corpo.errors) m = JSON.stringify(corpo.errors);
    if (!m) m = JSON.stringify(corpo);
  } else m = trecho || '';
  m = String(m).slice(0, 400);
  for (const v of Object.values(cred.headers)) { if (v && v.length >= 6) m = m.split(v).join('[oculto]'); }
  return m.slice(0, 240);
}

// Formato de cada campo, SEM o valor: ajuda a achar campo trocado (ex.: IDUsr deve ser número).
function formatoCampos() {
  let j = {};
  try { j = JSON.parse(process.env.KAMINO_API_JSON || '{}'); } catch (e) { return { erro: 'JSON inválido' }; }
  const desc = (v) => {
    const t = String(v == null ? '' : v);
    const tr = t.trim();
    return {
      tamanho: tr.length,
      tipo: /^\d+$/.test(tr) ? 'número' : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tr) ? 'código (GUID)' : /^https?:\/\//i.test(tr) ? 'endereço' : 'texto',
      espacos_sobrando: t !== tr,
      aspas_dentro: /["']/.test(tr),
    };
  };
  const out = {};
  for (const k of ['url', 'app', 'cn', 'idusr', 'usr', 'hash']) out[k] = desc(j[k]);
  try { const u = new URL(String(j.url || '').trim()); out.url.host = u.host; out.url.caminho = u.pathname; } catch (e) { /* já marcado */ }
  out.chaves_extras = Object.keys(j).filter((k) => ['url', 'app', 'cn', 'idusr', 'usr', 'hash'].indexOf(k) < 0);
  return out;
}

async function kaminoGet(cred, caminho) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(cred.base + caminho, { headers: cred.headers, signal: ctrl.signal });
    let corpo = null;
    const txt = await r.text();
    try { corpo = JSON.parse(txt); } catch (e) { corpo = null; }
    return { status: r.status, corpo, trecho: corpo ? null : txt.slice(0, 160) };
  } finally {
    clearTimeout(t);
  }
}

exports.handler = async function (event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const H = cors(origin);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: H, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: H, body: JSON.stringify({ ok: false, erro: 'Use POST' }) };

  const acesso = await exigirSessao(event);
  if (!acesso.ok) return acesso.resposta(H);
  // Por enquanto só o dono (e-mail do LOGIN, que o usuário não consegue editar).
  if (!acesso.usuario || acesso.usuario.email !== SUPER_ADMIN_EMAIL) {
    return { statusCode: 403, headers: H, body: JSON.stringify({ ok: false, erro: 'Acesso restrito.' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { /* vazio */ }
  const acao = String(body.acao || 'teste');

  const c = credenciais();
  if (c.erro) return { statusCode: 200, headers: H, body: JSON.stringify({ ok: false, etapa: 'configuracao', erro: c.erro }) };

  if (acao === 'teste') {
    try {
      const r = await kaminoGet(c.cred, '/api/financeiro/contabanco/lista?ApenasAtivas=true');
      if (r.status === 401 || r.status === 403) {
        return { statusCode: 200, headers: H, body: JSON.stringify({ ok: false, etapa: 'autenticacao', status: r.status, erro: 'O Kamino recusou as chaves (confira se colou os 5 valores certos e o Link para API).' }) };
      }
      if (r.status === 429) return { statusCode: 200, headers: H, body: JSON.stringify({ ok: false, etapa: 'limite', status: 429, erro: 'Limite de 20 chamadas por minuto do Kamino. Tente em 1 minuto.' }) };
      if (r.status < 200 || r.status >= 300 || !r.corpo) {
        // Diagnóstico: tenta um segundo endereço simples pra separar "chave errada" de "esse endereço deu erro".
        let outro = null;
        try { const r2 = await kaminoGet(c.cred, '/api/financeiro/planoconta/lista'); outro = { endereco: 'planoconta/lista', status: r2.status, mensagem: (r2.status >= 200 && r2.status < 300) ? 'ok' : mensagemErro(c.cred, r2.corpo, r2.trecho) }; } catch (e) { outro = { endereco: 'planoconta/lista', erro: 'sem resposta' }; }
        return { statusCode: 200, headers: H, body: JSON.stringify({ ok: false, etapa: 'resposta', status: r.status, erro: 'Resposta inesperada do Kamino.', mensagem_kamino: mensagemErro(c.cred, r.corpo, r.trecho), segundo_teste: outro, formato: formatoCampos() }) };
      }
      // A lista pode vir direto ou dentro de um campo; pegamos só nome/banco (sem saldo nem número da conta).
      const lista = Array.isArray(r.corpo) ? r.corpo : (Array.isArray(r.corpo.Dados) ? r.corpo.Dados : Array.isArray(r.corpo.dados) ? r.corpo.dados : Array.isArray(r.corpo.Lista) ? r.corpo.Lista : []);
      const contas = lista.slice(0, 30).map((x) => ({
        nome: String(x.Nome || x.Descricao || x.Apelido || x.nome || '').slice(0, 60),
        banco: String(x.Banco || x.NomeBanco || (x.Banco && x.Banco.Nome) || x.IDBanco || '').slice(0, 40),
        ativa: x.Ativa !== undefined ? !!x.Ativa : (x.Ativo !== undefined ? !!x.Ativo : null),
      }));
      return {
        statusCode: 200,
        headers: H,
        body: JSON.stringify({ ok: true, status: r.status, total: lista.length, contas, campos: lista[0] ? Object.keys(lista[0]).slice(0, 40) : (r.corpo && !Array.isArray(r.corpo) ? Object.keys(r.corpo).slice(0, 20) : []) }),
      };
    } catch (e) {
      return { statusCode: 200, headers: H, body: JSON.stringify({ ok: false, etapa: 'rede', erro: e && e.name === 'AbortError' ? 'O Kamino não respondeu em 9 segundos.' : 'Não consegui falar com o Kamino.' }) };
    }
  }

  // 'sync_seco' (16/11/2026): roda uma rodada da sincronização SEM GRAVAR NADA (diagnóstico).
  // 'sync_agora': roda uma rodada de verdade (a mesma que o agendador roda a cada 10 min).
  if (acao === 'sync_seco' || acao === 'sync_agora') {
    const core = require('../lib/kamino-sync-core');
    const seco = acao === 'sync_seco';
    const vAte = /^\d{4}-\d{2}-\d{2}$/.test(String(body.v_ate || '')) ? body.v_ate : null;
    const horas = Math.min(Math.max(Number(body.cursor_horas) || 2, 1), 24 * 30);
    const tipos = body.tipo === 'pagar' || body.tipo === 'receber' ? [body.tipo] : undefined;
    const teste = seco ? {
      pagar: Object.assign({ cursor: new Date(Date.now() - horas * 3600e3).toISOString() }, vAte ? { v_ate: vAte, v_pag: 1, v_vistos: [] } : {}),
      receber: Object.assign({ cursor: new Date(Date.now() - horas * 3600e3).toISOString() }, vAte ? { v_ate: vAte, v_pag: 1, v_vistos: [] } : {}),
    } : undefined;
    // pagar_completo: revarre os pagamentos de uma vez (ex.: passou a ler um campo novo)
    const extra = !seco && body.pagar_completo === true ? { tipos: ['pagar'], tetoVar: { pagar: 13 }, orcamento: 15 } : {};
    const r = await core.rodada(Object.assign({ seco, orcamento: seco ? 8 : 14, estadoTeste: teste, tipos: seco ? tipos : undefined }, extra));
    if (seco && r.estado) Object.keys(r.estado).forEach((k) => { if (r.estado[k]) { delete r.estado[k].v_vistos; } });
    return { statusCode: 200, headers: H, body: JSON.stringify(r) };
  }

  // 'ponte_agora' (16/11/2026): copia o espelho pras telas antigas em lotes, até ~20 s (só banco, sem Kamino)
  if (acao === 'ponte_agora') {
    const key = process.env.FIN_SUPA_SERVICE_KEY || '';
    const t0 = Date.now(); let tot = { copiados: 0, erros: 0, faltam: null, lotes: 0 };
    while (Date.now() - t0 < 20000) {
      const r = await fetch('https://vyjjdirlgvysbalrmmih.supabase.co/rest/v1/rpc/fin_kmn_ponte_pendentes', { method: 'POST',
        headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_limite: 400 }) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) return { statusCode: 200, headers: H, body: JSON.stringify({ ok: false, erro: (j && (j.message || j.hint)) || ('HTTP ' + r.status), tot }) };
      tot.copiados += j.copiados || 0; tot.erros += j.erros || 0; tot.faltam = j.faltam; tot.lotes++;
      if (!j.faltam) break;
    }
    return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true, tot, ms: Date.now() - t0 }) };
  }

  // 'explorar' (16/11/2026): raio-x do que a API entrega, SÓ LEITURA (GET em listas), pra decidir
  // o que entra no módulo financeiro. Devolve contagens, campos e totais; nada de CPF/CNPJ, Pix
  // ou conta bancária. ~12 chamadas (o limite do Kamino é 20/min).
  if (acao === 'explorar') {
    const hoje = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
    const menos = (d) => new Date(Date.now() - 3 * 3600000 - d * 86400000).toISOString().slice(0, 10);
    const d30 = menos(30);
    const d7 = menos(7);
    const API = '/api/financeiro';
    const listaDe = (corpo) => (Array.isArray(corpo) ? corpo : corpo && (Array.isArray(corpo.Dados) ? corpo.Dados : Array.isArray(corpo.dados) ? corpo.dados : Array.isArray(corpo.Lista) ? corpo.Lista : []));
    const num = (v) => (typeof v === 'number' ? v : Number(String(v == null ? '' : v).replace(',', '.')) || 0);
    const contar = (lista, campo) => {
      const m = {};
      lista.forEach((x) => { const k = String(x[campo] == null ? '(vazio)' : x[campo]).slice(0, 60); m[k] = (m[k] || 0) + 1; });
      return m;
    };
    const somar = (lista, campo) => Math.round(lista.reduce((s, x) => s + num(x[campo]), 0) * 100) / 100;
    const preenchidos = (lista) => {
      // quais campos vêm preenchidos (em quantos itens), sem mostrar o conteúdo
      const m = {};
      lista.forEach((x) => Object.keys(x || {}).forEach((k) => { const v = x[k]; if (v !== null && v !== '' && v !== undefined && !(Array.isArray(v) && !v.length)) m[k] = (m[k] || 0) + 1; }));
      return m;
    };
    const consultas = {
      contas: { cam: `${API}/contabanco/lista?ApenasAtivas=true`, resumo: (l) => ({ itens: l.length, saldos: l.map((x) => ({ conta: String(x.Nome || x.Descricao || '').slice(0, 50), saldo: num(x.SaldoAtual), kamino: x.Kamino })) }) },
      pagamentos_30d: { cam: `${API}/pagamento/lista/paginada?PagtoDe=${d30}&PagtoAte=${hoje}&_pagina=1&_tamanhoPagina=100`, resumo: (l) => ({ por_situacao: contar(l, 'DescricaoSituacao'), por_forma: contar(l, 'DescricaoFormaPagamento'), por_usuario_inclusao: contar(l, 'UsuarioInclusao'), soma_pago_amostra: somar(l, 'ValorPagamento') }) },
      pagamentos_pendentes_vencidos: { cam: `${API}/pagamento/lista/paginada?Situacao=1&VencAte=${menos(1)}&_pagina=1&_tamanhoPagina=100`, resumo: (l) => ({ soma_amostra: somar(l, 'ValorVencimento'), por_unidade: contar(l, 'NomeUnidadeNegocio') }) },
      pagamentos_a_vencer_7d: { cam: `${API}/pagamento/lista/paginada?Situacao=1&VencDe=${hoje}&VencAte=${new Date(Date.now() - 3 * 3600000 + 7 * 86400000).toISOString().slice(0, 10)}&_pagina=1&_tamanhoPagina=100`, resumo: (l) => ({ soma_amostra: somar(l, 'ValorVencimento') }) },
      pagamentos_sem_classificacao: { cam: `${API}/pagamento/lista/paginada?ApenasSemClassificacao=true&PagtoDe=${d30}&PagtoAte=${hoje}&_pagina=1&_tamanhoPagina=50`, resumo: (l) => ({ soma_amostra: somar(l, 'ValorPagamento') }) },
      recebimentos_30d: { cam: `${API}/recebimentos/paginada?VencDe=${d30}&VencAte=${hoje}&_pagina=1&_tamanhoPagina=100`, resumo: (l) => ({ por_situacao: contar(l, 'DescricaoSituacao'), por_unidade: contar(l, 'NomeUnidadeNegocio') }) },
      pagamentos_excluidos_30d: { cam: `${API}/pagamento/excluido/lista/paginada?PeriodoDe=${d30}&PeriodoAte=${hoje}&_pagina=1&_tamanhoPagina=100`, resumo: (l) => ({ por_usuario: contar(l, 'Usuario'), por_motivo: contar(l, 'Motivo') }) },
      recebimentos_excluidos_30d: { cam: `${API}/recebimento/excluido/lista/paginada?PeriodoDe=${d30}&PeriodoAte=${hoje}&_pagina=1&_tamanhoPagina=100`, resumo: (l) => ({ por_usuario: contar(l, 'Usuario'), por_motivo: contar(l, 'Motivo') }) },
      transferencias_30d: { cam: `${API}/transferencia/lista?PeriodoDe=${d30}&PeriodoAte=${hoje}`, resumo: (l) => ({ itens: l.length }) },
      movimento_rateado_7d: { cam: `${API}/movimentoFinanceiro/listaRateada/paginada?PeriodoDe=${d7}&PeriodoAte=${hoje}&_pagina=1&_tamanhoPagina=50`, resumo: (l) => ({ por_tipo: contar(l, 'Tipo'), conciliado_origem: contar(l, 'ConciliadoOrigem') }) },
      pessoas: { cam: `/api/pessoa/lista/paginada?ApenasAtivos=true&_pagina=1&_tamanhoPagina=50`, resumo: () => ({}) },
      cadastros: { cam: `${API}/planoconta/lista?ApenasAtivos=true`, resumo: (l) => ({ itens: l.length }) },
      centros_custo: { cam: `${API}/centrocusto/lista?ApenasAtivos=true`, resumo: (l) => ({ itens: l.length }) },
      unidades: { cam: `${API}/unidadenegocio/lista?ApenasAtivos=true`, resumo: (l) => ({ itens: l.length, nomes: l.map((x) => String(x.Nome || x.Descricao || '').slice(0, 40)) }) },
    };
    const nomes = Object.keys(consultas);
    const res = await Promise.all(nomes.map(async (n) => {
      try {
        const r = await kaminoGet(c.cred, consultas[n].cam);
        if (r.status < 200 || r.status >= 300) return [n, { status: r.status, erro: mensagemErro(c.cred, r.corpo, r.trecho) }];
        const l = listaDe(r.corpo);
        const meta = r.corpo && !Array.isArray(r.corpo) ? { total_linhas: r.corpo.TotalLinhas, total_paginas: r.corpo.TotalPaginas } : {};
        return [n, Object.assign({ status: r.status }, meta, { na_amostra: l.length, campos_preenchidos: preenchidos(l) }, consultas[n].resumo(l))];
      } catch (e) {
        return [n, { erro: e && e.name === 'AbortError' ? 'sem resposta em 9s' : 'falha de rede' }];
      }
    }));
    const out = {};
    res.forEach(([n, v]) => (out[n] = v));
    return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true, hoje, desde: d30, resultado: out }) };
  }

  return { statusCode: 400, headers: H, body: JSON.stringify({ ok: false, erro: 'Ação desconhecida.' }) };
};
