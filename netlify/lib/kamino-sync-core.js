// netlify/lib/kamino-sync-core.js
// -----------------------------------------------------------------------------
// Motor da sincronização Kamino -> banco do financeiro (espelho fin_kmn_*). SÓ LÊ do Kamino.
//
// Cada rodada (a cada 10 min, functions/kamino-sync.js) gasta no máximo ~14 chamadas
// (o Kamino aceita 20/min) e ~20 s, e continua de onde parou na próxima:
//  1) INCREMENTAL: o que foi criado/alterado desde a última rodada (AtualizadoDe).
//  2) PESSOAS: varre o cadastro aos poucos (troca de chave Pix / CPF).
//  3) VARREDURA por janelas de vencimento, do futuro pro passado. A 1ª volta completa É a
//     carga inicial (silenciosa, sem alertas). Nas voltas seguintes, o que existia aqui e não
//     veio mais na janela é conferido pelo ID; se o Kamino não acha mais, é EXCLUSÃO.
// -----------------------------------------------------------------------------
'use strict';
const K = require('./kamino-api');

const FIN_URL = 'https://vyjjdirlgvysbalrmmih.supabase.co';
const API = '/api/financeiro';
const CFG = {
  pagar: { lista: API + '/pagamento/lista/paginada', map: K.mapPagamento, janela: 31, inicio: '2025-07-01', idParam: 'ID' },
  receber: { lista: API + '/recebimentos/paginada', map: K.mapRecebimento, janela: 7, inicio: '2026-01-01', idParam: 'ID' },
};
const PAGINA = 200;          // itens por chamada
const FUTURO_DIAS = 90;      // varredura começa 90 dias à frente (contas futuras)
const SOBREPOSICAO_MIN = 30; // incremental relê os últimos 30 min (relógio do Kamino x nosso)

const hojeBR = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const addDias = (iso, d) => { const t = new Date(iso + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };
// horário de Brasília sem fuso (o Kamino trabalha em hora local)
const horaBR = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 19);

function finKey() { return process.env.FIN_SUPA_SERVICE_KEY || ''; }
async function fin(path, opts) {
  const key = finKey();
  const r = await fetch(FIN_URL + '/rest/v1/' + path, Object.assign({}, opts, {
    headers: Object.assign({ apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, (opts && opts.headers) || {}),
  }));
  const txt = await r.text();
  let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) { /* texto */ }
  if (!r.ok) throw new Error('banco do financeiro: ' + ((j && (j.message || j.hint)) || txt.slice(0, 160) || ('HTTP ' + r.status)));
  return j;
}
const rpc = (fn, args) => fin('rpc/' + fn, { method: 'POST', body: JSON.stringify(args) });

async function lerEstado() {
  const linhas = (await fin('fin_kmn_sync?select=chave,estado')) || [];
  const m = {}; linhas.forEach((l) => { m[l.chave] = l.estado || {}; });
  return m;
}
async function salvarEstado(chave, estado, erro) {
  const agora = new Date().toISOString();
  const linha = { chave, estado, atualizado_em: agora };
  if (erro) { linha.ultimo_erro = String(erro).slice(0, 300); linha.ultimo_erro_em = agora; } else linha.ultimo_ok = agora;
  await fin('fin_kmn_sync?on_conflict=chave', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(linha) });
}

// Uma rodada. opcoes: { seco: true } = não grava nada (diagnóstico), orcamento, limiteMs
async function rodada(opcoes) {
  const o = Object.assign({ seco: false, orcamento: 14, limiteMs: 20000 }, opcoes || {});
  const ini = Date.now();
  const c = K.credenciais();
  if (c.erro) return { ok: false, erro: c.erro };
  if (!o.seco && !finKey()) return { ok: false, erro: 'FIN_SUPA_SERVICE_KEY não configurada' };
  const cred = c.cred;
  let chamadas = 0, parado = null;
  const log = [];
  // reserva = chamadas guardadas pro que vem depois (a varredura não come a vez das pessoas)
  const podeChamar = (reserva) => {
    if (parado) return false;
    if (chamadas >= o.orcamento - (reserva || 0)) { if (!reserva) parado = 'orçamento de chamadas da rodada'; return false; }
    if (Date.now() - ini > o.limiteMs) { parado = 'tempo da rodada'; return false; }
    return true;
  };
  async function kget(caminho) {
    chamadas++;
    const r = await K.get(cred, caminho, 8000);
    if (r.status === 429) { parado = 'limite do Kamino (429)'; return null; }
    if (r.status < 200 || r.status >= 300) throw new Error('Kamino ' + r.status + ': ' + K.mensagemErro(cred, r.corpo, r.trecho));
    return r.corpo;
  }
  // tem mais página? usa o total que o Kamino devolve (se ele limitar o tamanho da página, não perdemos nada)
  function temMais(corpo, itens, pag) {
    const tp = corpo && !Array.isArray(corpo) ? Number(corpo.TotalPaginas) : NaN;
    if (Number.isFinite(tp) && tp > 0) return pag < tp;
    return itens.length >= PAGINA;
  }
  async function aplicar(tipo, itens, silencioso) {
    if (!itens.length || o.seco) return { novos: 0, mudaram: 0, iguais: itens.length };
    return rpc('fin_kmn_aplicar', { p_tipo: tipo, p_itens: itens, p_silencioso: !!silencioso });
  }

  const estado = o.seco ? (o.estadoTeste || {}) : await lerEstado();
  const stats = {};

  for (const tipo of (o.tipos || ['pagar', 'receber'])) {
    const cfg = CFG[tipo];
    const st = Object.assign({ volta: 1 }, estado[tipo] || {});
    const s = stats[tipo] = { incremental: 0, varridos: 0, novos: 0, mudaram: 0, sumiram: 0 };
    try {
      // ---------- 1) incremental (só depois da carga inicial) ----------
      if (st.cursor && podeChamar()) {
        const inicioRodada = Date.now();
        const de = horaBR(Date.parse(st.cursor) - SOBREPOSICAO_MIN * 60e3);
        let pag = 1, completo = false;
        while (podeChamar()) {
          const corpo = await kget(cfg.lista + '?AtualizadoDe=' + encodeURIComponent(de) + '&_pagina=' + pag + '&_tamanhoPagina=' + PAGINA);
          if (!corpo) break;
          const itens = K.listaDe(corpo).map(cfg.map).filter(Boolean);
          const r = await aplicar(tipo, itens, false);
          s.incremental += itens.length; s.novos += r.novos || 0; s.mudaram += r.mudaram || 0;
          if (!temMais(corpo, itens, pag)) { completo = true; break; }
          pag++;
        }
        if (completo) st.cursor = new Date(inicioRodada).toISOString();
      }

      // ---------- 2) confirmar exclusões pendentes (busca pelo ID) ----------
      st.confirmar = Array.isArray(st.confirmar) ? st.confirmar : [];
      const sumidos = [];
      while (st.confirmar.length && podeChamar()) {
        const id = st.confirmar[0];
        const corpo = await kget(cfg.lista + '?' + cfg.idParam + '=' + id + '&_pagina=1&_tamanhoPagina=5');
        if (!corpo) break;
        st.confirmar.shift();
        const achou = K.listaDe(corpo).map(cfg.map).filter((x) => x && x.kamino_id === id);
        if (achou.length) { const r = await aplicar(tipo, achou, st.volta === 1); s.mudaram += r.mudaram || 0; }
        else sumidos.push(id);
      }
      if (sumidos.length && !o.seco) s.sumiram += await rpc('fin_kmn_sumiram', { p_tipo: tipo, p_ids: sumidos, p_silencioso: false });

      // ---------- 3) varredura por janela de vencimento ----------
      if (!st.v_ate) { st.v_ate = addDias(hojeBR(), FUTURO_DIAS); st.v_pag = 1; st.v_vistos = []; st.carga_inicio = st.carga_inicio || new Date().toISOString(); }
      // teto da varredura por tipo: na carga inicial anda rápido; depois só 2 chamadas por rodada
      // (o incremental já pega o que muda; a varredura serve pra achar exclusão)
      const tetoVar = (o.tetoVar && o.tetoVar[tipo]) || (st.volta === 1 ? (tipo === 'pagar' ? 5 : 8) : 2);
      const inicioVar = chamadas;
      while (chamadas - inicioVar < tetoVar && podeChamar(1)) {
        const vDe = addDias(st.v_ate, -(cfg.janela - 1));
        const corpo = await kget(cfg.lista + '?VencDe=' + vDe + '&VencAte=' + st.v_ate + '&_pagina=' + st.v_pag + '&_tamanhoPagina=' + PAGINA);
        if (!corpo) break;
        const itens = K.listaDe(corpo).map(cfg.map).filter(Boolean);
        if (o.seco && tipo === 'pagar') {
          s.series = s.series || {};
          itens.forEach((x) => { const k = x.dados.serie || '(sem)'; const g = s.series[k] = s.series[k] || { n: 0, pessoas: [], valores: [], venc: [] };
            g.n++; if (g.pessoas.indexOf(x.dados.pessoa) < 0) g.pessoas.push(x.dados.pessoa); g.valores.push(x.dados.valor); g.venc.push(x.dados.vencimento); });
        }
        if (o.seco && !s.amostra && itens.length) { s.amostra = itens[0].dados; s.total_kamino = corpo && corpo.TotalLinhas; s.paginas_kamino = corpo && corpo.TotalPaginas; s.itens_pagina = itens.length; s.janela = vDe + ' a ' + st.v_ate; }
        const r = await aplicar(tipo, itens, st.volta === 1);
        s.varridos += itens.length; s.novos += r.novos || 0; s.mudaram += r.mudaram || 0;
        st.v_vistos = (st.v_vistos || []).concat(itens.map((x) => x.kamino_id));
        if (temMais(corpo, itens, st.v_pag)) { st.v_pag++; continue; }
        // janela completa: o que tínhamos nela e não veio vai pra confirmação pelo ID
        if (st.volta > 1 && !o.seco) {
          const nossos = (await fin('fin_kmn_lanc?tipo=eq.' + tipo + '&sumiu_em=is.null&vencimento=gte.' + vDe + '&vencimento=lte.' + st.v_ate + '&select=kamino_id&limit=5000')) || [];
          const vistos = new Set(st.v_vistos);
          nossos.forEach((n) => { if (!vistos.has(Number(n.kamino_id)) && st.confirmar.indexOf(Number(n.kamino_id)) < 0) st.confirmar.push(Number(n.kamino_id)); });
          st.confirmar = st.confirmar.slice(0, 300);
        }
        st.v_vistos = []; st.v_pag = 1;
        st.v_ate = addDias(vDe, -1);
        if (st.v_ate < cfg.inicio) {
          // volta completa: recomeça do futuro; a 1ª volta liga o incremental a partir do início da carga
          if (st.volta === 1 && !st.cursor) st.cursor = st.carga_inicio;
          st.volta++;
          st.v_ate = addDias(hojeBR(), FUTURO_DIAS);
          st.voltas_ok = (st.voltas_ok || 0) + 1;
          st.ultima_volta = new Date().toISOString();
        }
      }
      if (!o.seco) await salvarEstado(tipo, st, null);
      log.push(tipo + ': ok');
    } catch (e) {
      log.push(tipo + ': ' + e.message);
      if (!o.seco) { try { await salvarEstado(tipo, st, e.message); } catch (x) { /* banco fora */ } }
    }
    estado[tipo] = st;
  }

  // ---------- 4) pessoas (troca de Pix/CPF) ----------
  const sp = Object.assign({ pag: 1, volta: 1 }, estado.pessoas || {});
  stats.pessoas = { lidas: 0, novos: 0, mudaram: 0 };
  try {
    if (podeChamar()) {
      const corpo = await kget('/api/pessoa/lista/paginada?_pagina=' + sp.pag + '&_tamanhoPagina=' + PAGINA);
      if (corpo) {
        const itens = K.listaDe(corpo).map(K.mapPessoa).filter(Boolean);
        stats.pessoas.lidas = itens.length;
        if (itens.length && !o.seco) {
          const r = await rpc('fin_kmn_pessoas_aplicar', { p_itens: itens, p_silencioso: sp.volta === 1 });
          stats.pessoas.novos = r.novos; stats.pessoas.mudaram = r.mudaram;
        }
        if (!temMais(corpo, itens, sp.pag)) { sp.pag = 1; sp.volta++; sp.ultima_volta = new Date().toISOString(); } else sp.pag++;
      }
    }
    if (!o.seco) await salvarEstado('pessoas', sp, null);
  } catch (e) {
    log.push('pessoas: ' + e.message);
    if (!o.seco) { try { await salvarEstado('pessoas', sp, e.message); } catch (x) { /* banco fora */ } }
  }

  // ---------- 5) ponte: espelho -> telas (Pagar, Receber, Relatórios, Empresas semanal). Só banco, sem Kamino ----------
  if (!o.seco && Date.now() - ini < 24000) {
    try { stats.ponte = await rpc('fin_kmn_ponte_pendentes', { p_limite: o.ponteLimite || 600 }); }
    catch (e) { log.push('ponte: ' + e.message); }
  }

  return { ok: true, chamadas, ms: Date.now() - ini, parado, log, stats, estado: o.seco ? estado : undefined };
}

module.exports = { rodada, CFG };
