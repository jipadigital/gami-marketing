/* ============================================================
   🛡️ FINANCEIRO v2 (UI): réplica do Kamino que a Gâmi usa.
   Painel · Pagar (central, lista, caixa de entrada, novo) · Receber (central, cobranças, novo)
   Contas (saldos, transferências, conciliação) · Relatórios (DRE, fluxo diário, fluxo mensal, resultado)
   Cadastros (pessoas, plano de contas, unidades/centros, regras de extrato).
   Autorização é toda no servidor. Aqui só tela.
   ============================================================ */
(function(){
'use strict';
var U = window._FINUI; if(!U){ console.error('financeiro-ui-v2: carregue financeiro-ui.js antes'); return; }
var api = U.api, esc = U.esc, moeda = U.moeda, dataBR = U.dataBR, dataHoraBR = U.dataHoraBR, nome = U.nome, hoje = U.hoje, inicioMes = U.inicioMes,
    uid = U.uid, pode = U.pode, toast = U.toast, modal = U.modal, baixar = U.baixar, $ = U.$;
var F = window._FIN;
var T = window._FIN_TELAS = window._FIN_TELAS || {};

/* ---------- utilidades ---------- */
function n(v){ return Number(v) || 0; }
function moedaCurta(v){ var x = n(v); return (x < 0 ? '-' : '') + Math.abs(x).toLocaleString('pt-BR', { maximumFractionDigits: 0 }); }
function addDias(iso, d){ var t = new Date(iso + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); }
function fimMes(iso){ var p = iso.split('-').map(Number); return new Date(Date.UTC(p[0], p[1], 0)).toISOString().slice(0, 10); }
function diaSemana(iso){ return ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][new Date(iso + 'T12:00:00Z').getUTCDay()]; }
var MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
function carregando(el){ el.innerHTML = '<div class="fin-vazio">Carregando...</div>'; }
function erroEm(el, e){ el.innerHTML = '<div class="fin-erro">' + esc(e.message || e) + '</div>'; }
function parseBR(s){
  if(s == null || s === '') return 0;
  var t = String(s).trim().replace(/\s|R\$/g, ''); if(!t) return 0;
  var neg = /^-/.test(t); t = t.replace(/^-/, '');
  if(t.indexOf(',') >= 0){ if((t.match(/,/g) || []).length > 1) return NaN; t = t.replace(/\./g, '').replace(',', '.'); }   // 1.234,56
  else if(/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');                                                         // 1.500 = mil e quinhentos
  if(!/^\d+(\.\d+)?$/.test(t)) return NaN;
  var x = Number(t); return isFinite(x) ? Math.round((neg ? -x : x) * 100) / 100 : NaN;
}
function fmtIn(v){ return v == null || v === '' ? '' : n(v).toFixed(2).replace('.', ','); }
var SIT = {
  pendente: { t: 'Pendente', c: '#B7791F', bg: 'rgba(214,137,16,.15)' }, atrasado: { t: 'Atrasado', c: '#fff', bg: '#C0392B' },
  pago: { t: 'Pago', c: '#1D9E75', bg: 'rgba(29,158,117,.15)' }, cancelado: { t: 'Cancelado', c: '#7F8C8D', bg: 'rgba(127,140,141,.15)' }
};
function chipSit(s, tipo){ var x = SIT[s] || SIT.pendente; var t = (s === 'pago' && tipo === 'receber') ? 'Recebido' : x.t; return '<span class="fin-chip" style="color:' + x.c + ';background:' + x.bg + '">' + t + '</span>'; }
var FORMA = { boleto: 'Boleto', ted: 'TED', pix: 'Pix', outros: 'Outros', manual: 'Recebimento manual', pix_conta: 'Pix na conta' };

function css2(){
  if($('fin-css2')) return;
  var s = document.createElement('style'); s.id = 'fin-css2';
  s.textContent = [
    '.fin-dias{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}',
    '.fin-dia{background:var(--surface2);border:1px solid var(--border);border-radius:11px;padding:12px;display:flex;flex-direction:column;gap:6px}',
    '.fin-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
    '.fin-g3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}@media(max-width:760px){.fin-g3{grid-template-columns:1fr}}',
    '.fin-g4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}@media(max-width:760px){.fin-g4{grid-template-columns:1fr 1fr}}',
    '.fin-lbl{font-size:11px;color:var(--text3);margin-bottom:3px;font-weight:600}',
    '.fin-sec{border-top:1px solid var(--border);margin-top:14px;padding-top:12px}',
    '.fin-sec>h4{margin:0 0 8px;font-size:13px}',
    '.fin-forma{display:flex;gap:6px;flex-wrap:wrap}.fin-forma button{min-width:72px}',
    '.fin-pills{display:flex;gap:6px;flex-wrap:wrap}',
    '.fin-rec-tog{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px;padding:9px 11px;border:1px dashed var(--border);border-radius:9px;font-size:13px;cursor:pointer}',
    '.fin-aviso-rec{margin-top:8px;padding:8px 11px;border-radius:9px;background:rgba(214,137,16,.12);color:#B7791F;font-size:12px;font-weight:600}',
    '.fin-ac{position:relative}.fin-ac-lista{position:absolute;z-index:5;left:0;right:0;top:100%;background:var(--surface);border:1px solid var(--border);border-radius:8px;max-height:240px;overflow:auto;box-shadow:0 8px 24px rgba(0,0,0,.15)}',
    '.fin-ac-lista div{padding:7px 10px;font-size:12px;cursor:pointer}.fin-ac-lista div:hover{background:var(--surface2)}',
    '.fin-num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}',
    '.fin-dre td,.fin-dre th{padding:6px 8px;font-size:12px;white-space:nowrap}.fin-dre tr.tot td{font-weight:800;background:var(--surface2)}.fin-dre tr.sub td:first-child{padding-left:22px;color:var(--text2)}',
    '.fin-dre tr.cls td:first-child{padding-left:38px;color:var(--text3)}.fin-dre tr.exp{cursor:pointer}',
    '.fin-conc{display:grid;grid-template-columns:1fr 1fr;gap:10px;align-items:start;margin-bottom:8px}@media(max-width:760px){.fin-conc{grid-template-columns:1fr}}',
    '.fin-conc>.fin-card.ok{background:rgba(29,158,117,.08);border-color:rgba(29,158,117,.4)}',
    '.fin-hbar{display:flex;align-items:center;gap:8px;font-size:12px;margin:4px 0}.fin-hbar>span:first-child{flex:0 0 38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fin-hbar>i{display:block;height:10px;border-radius:5px;background:#0E7AB8}',
    '.fin-rateio{display:flex;height:16px;border-radius:5px;overflow:hidden;font-size:9px;color:#fff}.fin-rateio>div{display:flex;align-items:center;justify-content:center;overflow:hidden;white-space:nowrap}'
  ].join('\n');
  document.head.appendChild(s);
}

/* ---------- cadastros base (cache por sessão de tela) ---------- */
async function base(forcar){
  if(F.base && !forcar) return F.base;
  F.base = await api('base');
  return F.base;
}
function optsLista(lista, sel, vazio, rot){ return (vazio !== false ? '<option value="">' + esc(vazio || 'Selecione...') + '</option>' : '') + lista.map(function(x){ return '<option value="' + esc(x.id) + '"' + (String(sel) === String(x.id) ? ' selected' : '') + '>' + esc(rot ? rot(x) : x.nome) + (x.ativo === false ? ' (inativo)' : '') + '</option>'; }).join(''); }
function optsClass(sel, tipo, vazio){
  var grupos = tipo === 'receber' ? ['receita', 'aporte', 'transferencia'] : tipo === 'pagar' ? ['despesa', 'retirada', 'transferencia'] : ['receita', 'despesa', 'aporte', 'retirada', 'transferencia'];
  var nomesG = { receita: 'Receitas', despesa: 'Despesas', aporte: 'Aportes', retirada: 'Retiradas', transferencia: 'Transferência' };
  var h = '<option value="">' + esc(vazio || 'Selecione...') + '</option>';
  grupos.forEach(function(g){
    var lista = F.base.classificacoes.filter(function(c){ return c.grupo === g && (c.ativo || String(c.id) === String(sel)); });
    var subs = {}; lista.forEach(function(c){ var k = c.subgrupo || nomesG[g]; (subs[k] = subs[k] || []).push(c); });
    Object.keys(subs).forEach(function(k){ h += '<optgroup label="' + esc(k) + '">' + subs[k].map(function(c){ return '<option value="' + c.id + '"' + (String(sel) === String(c.id) ? ' selected' : '') + '>' + esc((c.codigo ? c.codigo + ' ' : '') + c.nome) + '</option>'; }).join('') + '</optgroup>'; });
  });
  return h;
}
function optsContas(sel, vazio){ return optsLista(F.base.contas.filter(function(c){ return c.ativo || c.id === sel; }), sel, vazio); }

/* ---------- campo de pessoa com busca (autocomplete) + nova pessoa ---------- */
function campoPessoa(id, pessoa, tipo){
  return '<div class="fin-ac"><input class="fin-in" id="' + id + '-txt" placeholder="Pesquise o nome, CPF/CNPJ ou razão social" autocomplete="off" value="' + esc(pessoa ? pessoa.nome : '') + '">' +
    '<input type="hidden" id="' + id + '" value="' + esc(pessoa ? pessoa.id : '') + '"><div class="fin-ac-lista" id="' + id + '-lista" style="display:none"></div></div>' +
    '<a href="#" class="fin-sub" id="' + id + '-nova" style="display:inline-block;margin-top:3px">+ Inserir nova pessoa</a>';
}
function ligarPessoa(id, tipo, aoEscolher){
  var txt = $(id + '-txt'), hid = $(id), lista = $(id + '-lista'), tm = null, seq = 0;
  txt.oninput = function(){
    hid.value = ''; clearTimeout(tm);
    var q = txt.value.trim(); if(q.length < 2){ lista.style.display = 'none'; return; }
    tm = setTimeout(async function(){
      var meu = ++seq;
      try {
        var j = await api('pessoas_listar', { q: q, limite: 15 });
        if(meu !== seq) return;
        lista.innerHTML = j.pessoas.length ? j.pessoas.map(function(p){ return '<div data-id="' + p.id + '" data-nome="' + esc(p.nome) + '"><b>' + esc(p.nome) + '</b> <span class="fin-sub">' + esc(p.documento || '') + (p.cliente ? ' · cliente' : '') + (p.fornecedor ? ' · fornecedor' : '') + '</span></div>'; }).join('') : '<div class="fin-sub">Ninguém encontrado. Use "Inserir nova pessoa".</div>';
        lista.style.display = '';
        lista.querySelectorAll('[data-id]').forEach(function(d){ d.onmousedown = function(e){ e.preventDefault(); hid.value = d.getAttribute('data-id'); txt.value = d.getAttribute('data-nome'); lista.style.display = 'none'; if(aoEscolher) aoEscolher({ id: hid.value, nome: txt.value }); }; });
      } catch(e){}
    }, 250);
  };
  txt.onblur = function(){ setTimeout(function(){ lista.style.display = 'none'; if(!hid.value) txt.value = txt.value; }, 150); };
  $(id + '-nova').onclick = function(e){ e.preventDefault(); editarPessoa(null, function(p){ hid.value = p.id; txt.value = p.nome; if(aoEscolher) aoEscolher(p); }, tipo, txt.value.trim()); };
}

/* ---------- editor de rateio por unidade ---------- */
function rateioHTML(id, rateio){
  return '<div id="' + id + '"><div class="fin-sub" style="margin-bottom:6px">Divida o valor entre as unidades (precisa somar 100%). Sem rateio, 100% vai pra unidade do lançamento.</div><div id="' + id + '-linhas"></div>' +
    '<div class="fin-row" style="margin-top:6px"><button type="button" class="fin-bt" id="' + id + '-add">+ Unidade</button><button type="button" class="fin-bt" id="' + id + '-igual">Dividir igual</button><span class="fin-sub" id="' + id + '-soma"></span></div></div>';
}
function ligarRateio(id, rateio, totalFn){
  var linhas = (rateio || []).map(function(r){ return { unidade_id: String(r.unidade_id), pct: n(r.pct) }; });
  function desenhar(){
    var tot = totalFn ? totalFn() : 0;
    $(id + '-linhas').innerHTML = linhas.map(function(r, k){ return '<div class="fin-row" style="margin-bottom:4px"><select class="fin-in" style="flex:2" data-k="' + k + '" data-c="u">' + optsLista(F.base.unidades.filter(function(u){ return u.ativo || String(u.id) === r.unidade_id; }), r.unidade_id) + '</select>' +
      '<input class="fin-in" style="flex:0 0 80px;text-align:right" data-k="' + k + '" data-c="p" value="' + fmtIn(r.pct) + '"><span class="fin-sub" style="flex:0 0 100px">% = ' + moeda(tot * r.pct / 100) + '</span><button type="button" class="fin-bt" data-k="' + k + '" data-c="x">✕</button></div>'; }).join('');
    var s = linhas.reduce(function(a, r){ return a + n(r.pct); }, 0);
    $(id + '-soma').innerHTML = linhas.length ? ('Soma: <b style="color:' + (Math.abs(s - 100) < 0.01 ? '#1D9E75' : '#C0392B') + '">' + s.toFixed(2).replace('.', ',') + '%</b>') : '';
    $(id + '-linhas').querySelectorAll('[data-c]').forEach(function(el){
      var k = Number(el.getAttribute('data-k')), c = el.getAttribute('data-c');
      if(c === 'x') el.onclick = function(){ linhas.splice(k, 1); desenhar(); };
      else el.onchange = function(){ if(c === 'u') linhas[k].unidade_id = el.value; else linhas[k].pct = parseBR(el.value) || 0; desenhar(); };
    });
  }
  $(id + '-add').onclick = function(){ linhas.push({ unidade_id: '', pct: 0 }); desenhar(); };
  $(id + '-igual').onclick = function(){ if(!linhas.length) return; var p = Math.floor(10000 / linhas.length) / 100; linhas.forEach(function(r, k){ r.pct = k === linhas.length - 1 ? Math.round((100 - p * (linhas.length - 1)) * 100) / 100 : p; }); desenhar(); };
  desenhar();
  return { valor: function(){ return linhas.filter(function(r){ return r.unidade_id; }).map(function(r){ return { unidade_id: Number(r.unidade_id), pct: r.pct }; }); }, redesenhar: desenhar };
}
function barraRateio(rateio){
  if(!rateio || !rateio.length) return '';
  var cores = ['#0E7AB8', '#1D9E75', '#D68910', '#8E44AD', '#C0392B', '#16A085', '#2C3E50', '#E67E22', '#2980B9', '#27AE60', '#7F8C8D'];
  var un = {}; (F.base ? F.base.unidades : []).forEach(function(u){ un[u.id] = u.nome; });
  return '<div class="fin-rateio">' + rateio.map(function(r, k){ return '<div title="' + esc((un[r.unidade_id] || r.unidade_id) + ' ' + r.pct + '%') + '" style="width:' + r.pct + '%;background:' + cores[k % cores.length] + '">' + esc((un[r.unidade_id] || '').replace(/^Gam[iy] (Delivery )?/, '')) + ' ' + r.pct + '%</div>'; }).join('') + '</div>';
}

/* ---------- arquivo -> base64 ---------- */
function lerBase64(file){ return new Promise(function(ok, falha){ var r = new FileReader(); r.onload = function(){ ok(String(r.result).split(',')[1]); }; r.onerror = function(){ falha(new Error('Não consegui ler o arquivo')); }; r.readAsDataURL(file); }); }
async function enviarAnexos(files, alvo){
  var erros = [];
  for(var i = 0; i < files.length; i++){
    var f = files[i];
    if(f.size > 4 * 1024 * 1024){ erros.push(f.name + ': maior que 4 MB'); continue; }
    try { await api('anexo_enviar', Object.assign({ nome: f.name, mime: f.type, base64: await lerBase64(f) }, alvo)); }
    catch(e){ erros.push(f.name + ': ' + e.message); }
  }
  if(erros.length) toast('Anexo: ' + erros.join(' | '), 'erro');
}
async function abrirAnexo(id){
  var w = window.open('', '_blank');   // aberta já no clique (Safari bloqueia window.open depois de um await)
  try { var j = await api('anexo_baixar', { id: id }); if(w){ w.opener = null; w.location = j.url; } else toast('Libere pop-up para abrir o anexo', 'aviso'); }
  catch(e){ if(w) w.close(); toast(e.message, 'erro'); }
}

/* ================= RECORRÊNCIA: campos comuns ================= */
var FREQ = { semanal: 'Toda semana', quinzenal: 'A cada 15 dias', mensal: 'Todo mês', bimestral: 'A cada 2 meses', trimestral: 'A cada 3 meses', semestral: 'A cada 6 meses', anual: 'Todo ano' };
function camposRec(r){
  r = r || {};
  return '<div class="fin-g3" style="margin-top:8px"><div><div class="fin-lbl">Repete</div>' +
    (r.id ? '<input class="fin-in" value="' + esc(FREQ[r.frequencia] || r.frequencia) + '" disabled>'
          : '<select class="fin-in" id="lf-rec-freq">' + Object.keys(FREQ).map(function(k){ return '<option value="' + k + '"' + (k === 'mensal' ? ' selected' : '') + '>' + FREQ[k] + '</option>'; }).join('') + '</select>') + '</div>' +
    '<div><div class="fin-lbl">Termina em (vazio = sem fim)</div><input type="date" class="fin-in" id="lf-rec-fim" value="' + esc(r.fim || '') + '"></div>' +
    '<div style="display:flex;align-items:flex-end"><label class="fin-row" style="font-size:12px"><input type="checkbox" id="lf-rec-var"' + (r.valor_variavel ? ' checked' : '') + '> Valor muda todo mês (luz, água, comissão)</label></div></div>' +
    '<div class="fin-sub" style="margin-top:6px">O sistema já coloca no calendário este vencimento e os próximos até o fim do mês que vem; os seguintes aparecem sozinhos, todo dia de manhã. ' +
    'Com "valor muda", cada conta nasce com o valor previsto e um aviso <b>confirmar valor</b> até alguém conferir.</div>';
}
function chipRec(l){
  return (l.recorrencia_id ? ' <span class="fin-chip" style="background:rgba(91,43,224,.12);color:#5b2be0" title="Conta recorrente #' + l.recorrencia_id + '">🔁</span>' : '') +
    (l.valor_a_confirmar && l.status === 'pendente' ? ' <span class="fin-chip" style="background:rgba(214,137,16,.18);color:#B7791F" title="Valor previsto: confirme o valor deste mês">confirmar valor</span>' : '');
}

/* ================= FORMULÁRIO DE LANÇAMENTO (Novo pagamento / Novo recebimento) ================= */
async function formLanc(tipo, lanc, opcoes){
  opcoes = opcoes || {};
  try { await base(); } catch(e){ toast(e.message, 'erro'); return; }
  var REC = opcoes.rec || null;                    // editando o MODELO de uma recorrência (gestor)
  var ed = !!(lanc && lanc.id && !opcoes.duplicar);
  var simples = ed || !!REC;                         // sem anexo, parcelamento e "Salvar + Novo"
  var L = lanc || {};
  if(REC) L = Object.assign({}, REC.modelo || {}, { valor: REC.valor, vencimento: REC.inicio, pessoa_nome: REC.pessoa_nome });
  var forma = L.forma || (tipo === 'pagar' ? 'pix' : 'pix_conta');
  var titulo = REC ? ('Editar recorrência #' + REC.id) : ed ? ('Editar ' + (tipo === 'pagar' ? 'pagamento' : 'recebimento') + ' #' + L.id) : (tipo === 'pagar' ? 'Novo pagamento' : 'Novo recebimento');
  var m = modal('<div class="fin-row" style="justify-content:space-between"><div style="font-weight:800;font-size:16px">' + titulo + '</div><button class="fin-bt" id="lf-x">✕</button></div>' +
    (tipo === 'pagar' ? '<div class="fin-row" style="margin-top:12px;justify-content:space-between;align-items:flex-start"><div class="fin-forma">' + ['boleto', 'ted', 'pix', 'outros'].map(function(f){ return '<button type="button" class="fin-bt" data-forma="' + f + '">' + FORMA[f] + '</button>'; }).join('') + '</div>' +
      '<div style="min-width:220px"><div class="fin-lbl">Conta de pagamento preferencial</div><select class="fin-in" id="lf-conta">' + optsContas(L.conta_id, 'Selecione...') + '</select></div></div>' +
      '<div id="lf-forma-extra" style="margin-top:8px"></div>'
    : '<div style="margin-top:12px"><div class="fin-lbl">Forma de recebimento</div><div class="fin-row"><select class="fin-in" id="lf-forma-rec" style="flex:1"><option value="manual"' + (forma === 'manual' ? ' selected' : '') + '>Recebimento manual (dinheiro, depósito)</option><option value="pix_conta"' + (forma !== 'manual' ? ' selected' : '') + '>Pix na conta</option></select>' +
      '<select class="fin-in" id="lf-conta" style="flex:1">' + optsContas(L.conta_id, 'Conta que recebe...') + '</select></div></div>') +
    '<div class="fin-grid2" style="margin-top:10px"><div><div class="fin-lbl">Pessoa</div>' + campoPessoa('lf-pessoa', L.pessoa_id ? { id: L.pessoa_id, nome: L.pessoa_nome } : null, tipo) + '</div>' +
      '<div class="fin-grid2"><div><div class="fin-lbl">' + (tipo === 'pagar' ? 'Valor bruto' : 'Valor total') + ' *</div><input class="fin-in fin-num" id="lf-valor" inputmode="decimal" placeholder="0,00" value="' + fmtIn(L.valor) + '"></div>' +
      '<div><div class="fin-lbl">Valor final</div><div id="lf-final" style="font-weight:800;font-size:16px;padding-top:6px">-</div></div></div></div>' +
    '<div class="fin-g3" style="margin-top:8px"><div style="grid-column:span 1"><div class="fin-lbl">Descrição</div><input class="fin-in" id="lf-desc" maxlength="300" value="' + esc(L.descricao || '') + '"></div>' +
      '<div><div class="fin-lbl">' + (REC ? '1º vencimento' : 'Vencimento *') + '</div><input type="date" class="fin-in" id="lf-venc" value="' + esc(L.vencimento || '') + '"' + (REC ? ' disabled' : '') + '></div>' +
      '<div><div class="fin-lbl">Competência</div><input type="date" class="fin-in" id="lf-comp" value="' + esc(L.competencia || '') + '"' + (REC ? ' disabled' : '') + '></div></div>' +
    (ed && L.valor_a_confirmar ? '<div class="fin-aviso-rec">🔁 Conta recorrente de valor variável: confira o valor deste mês. Ao salvar, o valor fica confirmado.</div>' : '') +
    (!simples ? '<label class="fin-rec-tog"><input type="checkbox" id="lf-rec"> <b>🔁 Conta recorrente</b> <span class="fin-sub">repete sozinha todo período (aluguel, internet, salário, mensalidade de cliente)</span></label><div id="lf-rec-box" style="display:none">' + camposRec(null) + '</div>' : '') +
    (REC ? '<div class="fin-sec"><h4>🔁 Recorrência (' + esc(FREQ[REC.frequencia] || REC.frequencia) + ')</h4>' + camposRec(REC) +
      '<label class="fin-row" style="font-size:12px;margin-top:8px"><input type="checkbox" id="lf-rec-aplicar" checked> Aplicar também nas contas já geradas que ainda estão pendentes (de hoje em diante)</label></div>' : '') +
    '<div class="fin-g3" style="margin-top:8px"><div><div class="fin-lbl">Classificação</div><select class="fin-in" id="lf-class">' + optsClass(L.classificacao_id, tipo) + '</select></div>' +
      '<div><div class="fin-lbl">Centro de custo</div><select class="fin-in" id="lf-cc">' + optsLista(F.base.centros.filter(function(c){ return c.ativo || String(c.id) === String(L.centro_custo_id); }), L.centro_custo_id || (F.base.centros[0] && F.base.centros[0].id)) + '</select></div>' +
      '<div><div class="fin-lbl">Unidade de negócio</div><select class="fin-in" id="lf-un">' + optsLista(F.base.unidades.filter(function(u){ return u.ativo || u.id === L.unidade_id; }), L.unidade_id) + '</select></div></div>' +
    '<div style="margin-top:8px"><div class="fin-lbl">Observação</div><textarea class="fin-in" id="lf-obs" rows="2" maxlength="1000">' + esc(L.observacao || '') + '</textarea></div>' +
    (!simples ? '<div style="margin-top:8px"><div class="fin-lbl">Anexos (boleto, NF, comprovante: PDF ou imagem até 4 MB)</div><input type="file" class="fin-in" id="lf-anexo" multiple accept="application/pdf,image/png,image/jpeg,image/webp"></div>' : '') +
    '<div class="fin-pills" style="margin-top:14px">' + (!simples ? '<button type="button" class="fin-bt" id="lf-pill-parc" data-sec="parc">Parcelamento</button>' : '') + '<button type="button" class="fin-bt" data-sec="fiscal">Fiscal e impostos</button><button type="button" class="fin-bt" data-sec="rateio">Rateio</button>' + (REC ? '' : '<button type="button" class="fin-bt" data-sec="comp">Composição de valores</button>') + '</div>' +
    (!simples ? '<div class="fin-sec" id="lf-sec-parc" style="display:none"><h4>Parcelamento</h4>' +
      '<label class="fin-row" style="font-size:12px"><input type="radio" name="lf-pm" value="" checked> Sem parcelamento</label>' +
      '<label class="fin-row" style="font-size:12px"><input type="radio" name="lf-pm" value="compra"> <b>Parcelamento de uma compra</b> <span class="fin-sub">o valor é dividido; competência fixa; "1/N" na descrição</span></label>' +
      '<label class="fin-row" style="font-size:12px"><input type="radio" name="lf-pm" value="mensal"> <b>Conta mensal</b> <span class="fin-sub">repete o mesmo valor todo mês (aluguel, IPTU); competência varia</span></label>' +
      '<label class="fin-row" style="font-size:12px"><input type="radio" name="lf-pm" value="avancado"> <b>Avançado</b> <span class="fin-sub">você define cada parcela</span></label>' +
      '<div class="fin-row" style="margin-top:6px" id="lf-parc-n"><input class="fin-in" id="lf-parcelas" style="width:110px" placeholder="Parcelas" inputmode="numeric"><span class="fin-sub" id="lf-parc-info"></span></div>' +
      '<div id="lf-parc-av" style="display:none"></div></div>' : '') +
    '<div class="fin-sec" id="lf-sec-fiscal" style="display:none"><h4>Fiscal e impostos</h4><div class="fin-g3"><div><div class="fin-lbl">Número da NF</div><input class="fin-in" id="lf-nf" maxlength="40" value="' + esc(L.nf_numero || '') + '"></div>' +
      '<div><div class="fin-lbl">Imposto retido</div><select class="fin-in" id="lf-rett"><option value="">Nenhum</option>' + ['ISS', 'IRRF', 'INSS', 'PIS/COFINS/CSLL', 'Outros'].map(function(x){ return '<option' + (L.retencao_tipo === x ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select></div>' +
      '<div><div class="fin-lbl">Valor retido</div><input class="fin-in fin-num" id="lf-ret" value="' + fmtIn(L.retencao || '') + '"></div></div></div>' +
    '<div class="fin-sec" id="lf-sec-rateio" style="display:none"><h4>Rateio</h4>' + rateioHTML('lf-rat') + '</div>' +
    '<div class="fin-sec" id="lf-sec-comp" style="display:none"><h4>Composição de valores</h4><div class="fin-g3"><div><div class="fin-lbl">Juros (+)</div><input class="fin-in fin-num" id="lf-juros" value="' + fmtIn(L.juros || '') + '"></div>' +
      '<div><div class="fin-lbl">Multa (+)</div><input class="fin-in fin-num" id="lf-multa" value="' + fmtIn(L.multa || '') + '"></div><div><div class="fin-lbl">Desconto (−)</div><input class="fin-in fin-num" id="lf-desconto" value="' + fmtIn(L.desconto || '') + '"></div></div></div>' +
    '<div id="lf-msg"></div><div class="fin-row" style="justify-content:flex-end;margin-top:14px"><button class="fin-bt" id="lf-cancel">Cancelar</button>' +
      (!simples ? '<button class="fin-bt ok" id="lf-salvar-novo">Salvar + Novo</button>' : '') + '<button class="fin-bt pri" id="lf-salvar">Salvar</button></div>');
  m.el.style.maxWidth = '900px';

  var rat = ligarRateio('lf-rat', L.rateio, function(){ return parseBR($('lf-valor').value) || 0; });
  ligarPessoa('lf-pessoa', tipo);
  var formaAtual = forma;
  function desenharForma(){
    if(tipo !== 'pagar') return;
    m.el.querySelectorAll('[data-forma]').forEach(function(b){ b.classList.toggle('pri', b.getAttribute('data-forma') === formaAtual); });
    var ex = $('lf-forma-extra');
    if(formaAtual === 'boleto') ex.innerHTML = '<div class="fin-lbl">Linha digitável / código de barras</div><input class="fin-in" id="lf-cb" maxlength="120" value="' + esc(L.codigo_barras || '') + '">';
    else if(formaAtual === 'pix') ex.innerHTML = '<div class="fin-lbl">Pix copia e cola (opcional)</div><input class="fin-in" id="lf-pix" maxlength="600" value="' + esc(L.pix_copia_cola || '') + '"><div class="fin-sub">Sem copia e cola, usa a chave Pix do cadastro da pessoa.</div>';
    else if(formaAtual === 'ted') ex.innerHTML = '<div class="fin-sub">TED usa os dados bancários do cadastro da pessoa.</div>';
    else ex.innerHTML = '';
  }
  m.el.querySelectorAll('[data-forma]').forEach(function(b){ b.onclick = function(){ var cb = $('lf-cb'), px = $('lf-pix'); if(cb) L.codigo_barras = cb.value; if(px) L.pix_copia_cola = px.value; formaAtual = b.getAttribute('data-forma'); desenharForma(); }; });
  desenharForma();
  m.el.querySelectorAll('[data-sec]').forEach(function(b){ b.onclick = function(){ var s = $('lf-sec-' + b.getAttribute('data-sec')); s.style.display = s.style.display === 'none' ? '' : 'none'; b.classList.toggle('sel', s.style.display !== 'none');
    if(b.getAttribute('data-sec') === 'parc' && s.style.display === 'none'){ var s0 = m.el.querySelector('[name=lf-pm][value=""]'); if(s0){ s0.checked = true; atualizar(); } } }; });
  ['rateio', 'comp', 'fiscal'].forEach(function(s){ if((s === 'rateio' && L.rateio && L.rateio.length) || (s === 'comp' && (n(L.juros) || n(L.multa) || n(L.desconto))) || (s === 'fiscal' && (L.nf_numero || n(L.retencao)))){ $('lf-sec-' + s).style.display = ''; } });

  function valorFinal(){ return (parseBR($('lf-valor').value) || 0) + (parseBR($('lf-juros').value) || 0) + (parseBR($('lf-multa').value) || 0) - (parseBR($('lf-desconto').value) || 0) - (parseBR($('lf-ret').value) || 0); }
  function atualizar(){
    $('lf-final').textContent = moeda(valorFinal()); rat.redesenhar();
    if($('lf-parc-info')){
      var modo = (m.el.querySelector('[name=lf-pm]:checked') || {}).value, np = Math.round(n($('lf-parcelas').value)), v = parseBR($('lf-valor').value) || 0, ve = $('lf-venc').value;
      $('lf-parc-n').style.display = modo && modo !== 'avancado' ? '' : 'none';
      $('lf-parc-av').style.display = modo === 'avancado' ? '' : 'none';
      if(modo && modo !== 'avancado' && np >= 2) $('lf-parc-info').innerHTML = np + ' x ' + moeda(modo === 'compra' ? v / np : v) + ' = <b>' + moeda(modo === 'compra' ? v : v * np) + '</b>' + (ve ? ' · última parcela ' + dataBR(addMesUI(ve, np - 1)) : '');
      else $('lf-parc-info').textContent = '';
    }
  }
  ['lf-valor', 'lf-juros', 'lf-multa', 'lf-desconto', 'lf-ret', 'lf-parcelas', 'lf-venc'].forEach(function(i){ if($(i)) $(i).addEventListener('input', atualizar); });
  m.el.querySelectorAll('[name=lf-pm]').forEach(function(r){ r.onchange = function(){ if(r.value === 'avancado') desenharAvancado(); atualizar(); }; });
  var avancado = [];
  function desenharAvancado(){
    if(!avancado.length){ var v = parseBR($('lf-valor').value) || 0, ve = $('lf-venc').value || hoje(); avancado = [0, 1].map(function(k){ return { valor: Math.round(v / 2 * 100) / 100, vencimento: addMesUI(ve, k) }; }); }
    var el = $('lf-parc-av');
    el.innerHTML = avancado.map(function(p, k){ return '<div class="fin-row" style="margin-bottom:4px"><span class="fin-sub" style="width:30px">' + (k + 1) + 'ª</span><input type="date" class="fin-in" style="flex:1" data-k="' + k + '" data-c="v" value="' + p.vencimento + '"><input class="fin-in fin-num" style="flex:1" data-k="' + k + '" data-c="r" value="' + fmtIn(p.valor) + '"><button type="button" class="fin-bt" data-k="' + k + '" data-c="x">✕</button></div>'; }).join('') +
      '<div class="fin-row"><button type="button" class="fin-bt" id="lf-av-add">+ Parcela</button><span class="fin-sub">Total: <b>' + moeda(avancado.reduce(function(a, p){ return a + n(p.valor); }, 0)) + '</b></span></div>';
    el.querySelectorAll('[data-c]').forEach(function(x){ var k = Number(x.getAttribute('data-k')), c = x.getAttribute('data-c');
      if(c === 'x') x.onclick = function(){ avancado.splice(k, 1); desenharAvancado(); };
      else x.onchange = function(){ if(c === 'v') avancado[k].vencimento = x.value; else avancado[k].valor = parseBR(x.value) || 0; desenharAvancado(); }; });
    $('lf-av-add').onclick = function(){ var u = avancado[avancado.length - 1]; avancado.push({ valor: u ? u.valor : 0, vencimento: u ? addMesUI(u.vencimento, 1) : hoje() }); desenharAvancado(); };
  }
  atualizar();
  if($('lf-rec') && opcoes.recorrente){ $('lf-rec').checked = true; $('lf-rec-box').style.display = ''; $('lf-pill-parc').style.display = 'none'; }
  if($('lf-rec')) $('lf-rec').onchange = function(){
    var on = this.checked; $('lf-rec-box').style.display = on ? '' : 'none';
    // recorrente e parcelado não combinam: esconde o parcelamento
    $('lf-pill-parc').style.display = on ? 'none' : '';
    if(on){ $('lf-sec-parc').style.display = 'none'; var s0 = m.el.querySelector('[name=lf-pm][value=""]'); if(s0) s0.checked = true; atualizar(); }
  };
  var fechar = function(){ m.fechar(); };
  $('lf-x').onclick = fechar; $('lf-cancel').onclick = fechar;

  async function salvar(novo){
    var msg = $('lf-msg'); msg.innerHTML = '';
    var cb = $('lf-cb'), px = $('lf-pix');
    var d = {
      tipo: tipo, pessoa_id: $('lf-pessoa').value || null, valor: parseBR($('lf-valor').value), descricao: $('lf-desc').value.trim(),
      vencimento: $('lf-venc').value, competencia: $('lf-comp').value || null, classificacao_id: $('lf-class').value || null,
      centro_custo_id: $('lf-cc').value || null, unidade_id: $('lf-un').value || null, conta_id: $('lf-conta').value || null,
      forma: tipo === 'pagar' ? formaAtual : $('lf-forma-rec').value, observacao: $('lf-obs').value.trim(),
      codigo_barras: cb ? cb.value.trim() : (L.codigo_barras || ''), pix_copia_cola: px ? px.value.trim() : (L.pix_copia_cola || ''),
      nf_numero: $('lf-nf').value.trim(), retencao_tipo: $('lf-rett').value, retencao: parseBR($('lf-ret').value) || 0,
      juros: parseBR($('lf-juros').value) || 0, multa: parseBR($('lf-multa').value) || 0, desconto: parseBR($('lf-desconto').value) || 0,
      rateio: rat.valor()
    };
    var probs = [];
    if(!(d.valor > 0)) probs.push('valor');
    if(!d.vencimento) probs.push('vencimento');
    if(!d.classificacao_id) probs.push('classificação');
    if(!d.pessoa_id && $('lf-pessoa-txt').value.trim()) probs.push('pessoa (escolha da lista ou cadastre)');
    if(probs.length){ msg.innerHTML = '<div class="fin-erro">Preencha: ' + probs.join(', ') + '.</div>'; return; }
    if(d.rateio.length){ var s = d.rateio.reduce(function(a, r){ return a + r.pct; }, 0); if(Math.abs(s - 100) > 0.01){ msg.innerHTML = '<div class="fin-erro">O rateio precisa somar 100%.</div>'; return; } }
    if(REC){
      var o = lerRec(); if(o.erro){ msg.innerHTML = '<div class="fin-erro">' + esc(o.erro) + '</div>'; return; }
      d = Object.assign(d, { id: REC.id, fim: o.fim, variavel: o.variavel, aplicar: $('lf-rec-aplicar').checked });
    } else if(!ed){
      var modo = (m.el.querySelector('[name=lf-pm]:checked') || {}).value;
      if($('lf-rec') && $('lf-rec').checked){
        var o2 = lerRec(); if(o2.erro){ msg.innerHTML = '<div class="fin-erro">' + esc(o2.erro) + '</div>'; return; }
        d.parcelamento = { modo: 'recorrente', frequencia: o2.frequencia, fim: o2.fim, variavel: o2.variavel };
      }
      else if(modo === 'avancado') d.parcelamento = { modo: modo, lista: avancado };
      else if(modo) d.parcelamento = { modo: modo, parcelas: Math.round(n($('lf-parcelas').value)) };
      if(opcoes.entrada_id) d.entrada_id = opcoes.entrada_id;
    } else { d.id = L.id; if(L.valor_a_confirmar) d.confirmar_valor = true; }
    var bts = m.el.querySelectorAll('#lf-salvar,#lf-salvar-novo'); bts.forEach(function(b){ b.disabled = true; });
    try {
      var r = await api(REC ? 'rec_salvar' : ed ? 'lanc_editar' : 'lanc_criar', d);
      var files = $('lf-anexo') ? $('lf-anexo').files : [];
      if(!simples && files.length && r.ids && r.ids[0]) await enviarAnexos(files, { lancamento_id: r.ids[0] });
      if(r.aviso) toast(r.aviso, 'erro');
      else toast(REC ? ('Recorrência salva' + (r.atualizados ? ': ' + r.atualizados + ' conta(s) pendente(s) atualizada(s)' : '') + (r.mexidos_a_mao ? '; ' + r.mexidos_a_mao + ' editada(s) à mão ficaram como estavam' : '') + (r.cancelados ? ', ' + r.cancelados + ' cancelada(s) pela nova data final' : ''))
        : ed ? 'Alterações salvas'
        : r.recorrencia_id ? ('🔁 Recorrência #' + r.recorrencia_id + ' criada: ' + (r.ids || []).length + ' conta(s) já no calendário; as próximas aparecem sozinhas')
        : ((r.ids && r.ids.length > 1) ? r.ids.length + ' lançamentos criados' : 'Lançamento #' + (r.ids && r.ids[0]) + ' criado'));
      m.fechar();
      if(opcoes.aoSalvar) opcoes.aoSalvar(r);
      if(novo) formLanc(tipo, { conta_id: d.conta_id, centro_custo_id: d.centro_custo_id, unidade_id: d.unidade_id, forma: d.forma }, Object.assign({}, opcoes, { entrada_id: null, recorrente: false }));
    } catch(e){ msg.innerHTML = '<div class="fin-erro">' + esc(e.message) + '<br>Nada foi gravado pela metade. Corrija e salve de novo.</div>'; bts.forEach(function(b){ b.disabled = false; }); }
  }
  function lerRec(){
    var fq = $('lf-rec-freq') ? $('lf-rec-freq').value : (REC && REC.frequencia), fim = $('lf-rec-fim').value || null, venc = $('lf-venc').value;
    if(!fq) return { erro: 'Escolha a frequência da recorrência.' };
    if(fim && venc && fim < venc) return { erro: 'A data final não pode ser antes do 1º vencimento.' };
    return { frequencia: fq, fim: fim, variavel: $('lf-rec-var').checked };
  }
  $('lf-salvar').onclick = function(){ salvar(false); };
  if($('lf-salvar-novo')) $('lf-salvar-novo').onclick = function(){ salvar(true); };
}
function addMesUI(iso, k){ var p = iso.split('-').map(Number); var dt = new Date(Date.UTC(p[0], p[1] - 1 + k, 1)); var ult = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate(); return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(Math.min(p[2], ult)).padStart(2, '0'); }

/* ================= RECORRÊNCIAS ================= */
var REC_ST = { ativa: { t: 'Ativa', c: '#1D9E75', bg: 'rgba(29,158,117,.15)' }, pausada: { t: 'Pausada', c: '#B7791F', bg: 'rgba(214,137,16,.15)' }, encerrada: { t: 'Encerrada', c: '#7F8C8D', bg: 'rgba(127,140,141,.15)' } };
function chipRecSt(s){ var x = REC_ST[s] || REC_ST.ativa; return '<span class="fin-chip" style="color:' + x.c + ';background:' + x.bg + '">' + x.t + '</span>'; }

function tornarRecorrente(l, depois){
  var m = modal('<div style="font-weight:800;font-size:16px">🔁 Tornar recorrente</div><div class="fin-sub" style="margin:4px 0 8px">Esta conta (' + esc(l.pessoa_nome || l.descricao || '#' + l.id) + ', ' + moeda(l.valor) + ') vira o modelo. Ela continua como está; a próxima nasce sozinha no período seguinte.</div>' +
    camposRec(null) + '<div id="tr-msg"></div><div class="fin-row" style="justify-content:flex-end;margin-top:12px"><button class="fin-bt" id="tr-x">Cancelar</button><button class="fin-bt pri" id="tr-ok">Criar recorrência</button></div>');
  $('tr-x').onclick = m.fechar;
  $('tr-ok').onclick = async function(){
    var b = this; b.disabled = true;
    try {
      var r = await api('rec_de_lanc', { id: l.id, frequencia: $('lf-rec-freq').value, fim: $('lf-rec-fim').value || null, variavel: $('lf-rec-var').checked });
      toast('🔁 Recorrência #' + r.id + ' criada: ' + (r.gerados || 0) + ' próxima(s) conta(s) já no calendário'); m.fechar(); if(depois) depois();
    } catch(e){ $('tr-msg').innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; b.disabled = false; }
  };
}

async function verRec(id, aoMudar){
  try { await base(); } catch(e){ toast(e.message, 'erro'); return; }
  var m = modal('<div class="fin-vazio">Carregando...</div>'); m.el.style.maxWidth = '820px';
  var d;
  try { d = await api('rec_ver', { id: id }); } catch(e){ m.el.innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div><button class="fin-bt" id="rv-x">Fechar</button>'; $('rv-x').onclick = m.fechar; return; }
  var r = d.rec, tipo = r.tipo, md = r.modelo || {};
  var recarregar = function(){ m.fechar(); verRec(id, aoMudar); if(aoMudar) aoMudar(); };
  var h = '<div class="fin-row" style="justify-content:space-between;align-items:flex-start"><div><div class="fin-sub">🔁 Recorrência #' + r.id + ' · ' + (tipo === 'pagar' ? 'a pagar' : 'a receber') + '</div>' +
    '<div style="font-size:18px;font-weight:800">' + esc(r.pessoa_nome || r.descricao || r.classificacao_nome || '-') + '</div><div class="fin-sub">' + esc(r.descricao || '') + '</div></div>' +
    '<div style="text-align:right"><div style="font-size:20px;font-weight:800" class="' + (tipo === 'pagar' ? 'fin-sai' : 'fin-ent') + '">' + moeda(r.valor) + '</div>' + chipRecSt(r.status) + (r.valor_variavel ? ' <span class="fin-chip" style="background:rgba(214,137,16,.18);color:#B7791F">valor variável</span>' : '') + '</div></div>';
  h += '<div class="fin-row" style="margin:12px 0;gap:6px">';
  if(pode('gestor') && r.status !== 'encerrada') h += '<button class="fin-bt" id="rv-editar">Editar (valor, dados, data final)</button>';
  if(pode('gestor') && r.status === 'ativa') h += '<button class="fin-bt" id="rv-pausar">⏸ Pausar</button>';
  if(pode('gestor') && r.status === 'pausada') h += '<button class="fin-bt ok" id="rv-retomar">▶ Retomar</button>';
  if(pode('gestor') && r.status !== 'encerrada') h += '<button class="fin-bt sus" id="rv-encerrar">Encerrar</button>';
  if(!pode('gestor')) h += '<span class="fin-sub">Mudar valor, pausar ou encerrar: peça a um gestor.</span>';
  h += '</div>';
  h += '<div class="fin-grid2"><div class="fin-card" style="font-size:12px;line-height:1.9"><b>Modelo</b><br>Classificação: ' + esc(r.classificacao_nome || '-') + '<br>Unidade: ' + esc(r.unidade_nome || '-') +
    '<br>Forma: ' + esc(FORMA[md.forma] || md.forma || '-') + (md.observacao ? '<br>Obs: ' + esc(md.observacao) : '') + (md.rateio && md.rateio.length ? '<br>Rateado entre ' + md.rateio.length + ' unidades' : '') + '</div>' +
    '<div class="fin-card" style="font-size:12px;line-height:1.9"><b>Repetição</b><br>' + esc(FREQ[r.frequencia] || r.frequencia) + ' · desde ' + dataBR(r.inicio) + '<br>Termina: <b>' + (r.fim ? dataBR(r.fim) : 'sem fim') + '</b>' +
    (r.proximo_venc ? '<br>Próxima a entrar no calendário: ' + dataBR(r.proximo_venc) : '') + '<br>Criada por ' + esc(nome(r.criado_por)) + ' em ' + dataBR(r.criado_em) +
    (r.motivo ? '<br>' + (r.status === 'encerrada' ? 'Encerrada' : 'Último motivo') + ': ' + esc(r.motivo) : '') + '</div></div>';
  h += '<div class="fin-card" style="margin-top:10px;padding:0;overflow-x:auto"><table class="fin-tbl"><thead><tr><th>#</th><th>Vencimento</th><th class="fin-num">Valor</th><th>' + (tipo === 'pagar' ? 'Pago em' : 'Recebido em') + '</th><th>Situação</th></tr></thead><tbody>' +
    (d.lancs.length ? d.lancs.map(function(l){ return '<tr class="clic" data-id="' + l.id + '"><td class="fin-sub">' + l.id + '</td><td>' + dataBR(l.vencimento) + '</td><td class="fin-num">' + moeda(l.valor_final) + (l.valor_a_confirmar && l.status === 'pendente' ? ' <span class="fin-chip" style="background:rgba(214,137,16,.18);color:#B7791F">confirmar</span>' : '') + '</td><td>' + dataBR(l.data_pagamento) + '</td><td>' + chipSit(l.situacao_calc, tipo) + '</td></tr>'; }).join('')
      : '<tr><td colspan="5" class="fin-sub">Nenhuma conta gerada ainda.</td></tr>') + '</tbody></table></div>';
  h += '<div class="fin-card" style="margin-top:10px"><b style="font-size:12px">📜 Histórico (permanente)</b>' + (d.historico.length ? d.historico.slice().reverse().map(function(x){ return '<div style="font-size:12px;margin-top:4px">' + dataHoraBR(x.ts) + ' · <b>' + esc(nome(x.ator)) + '</b> · ' + esc(descHistRec(x)) + '</div>'; }).join('') : '<div class="fin-sub">Sem histórico.</div>') + '</div>';
  h += '<div class="fin-row" style="justify-content:flex-end;margin-top:12px"><button class="fin-bt" id="rv-x">Fechar</button></div>';
  m.el.innerHTML = h;
  $('rv-x').onclick = m.fechar;
  m.el.querySelectorAll('tr[data-id]').forEach(function(tr){ tr.onclick = function(){ m.fechar(); verLanc(Number(tr.getAttribute('data-id')), aoMudar); }; });
  if($('rv-editar')) $('rv-editar').onclick = function(){ m.fechar(); formLanc(tipo, null, { rec: r, aoSalvar: function(){ verRec(id, aoMudar); if(aoMudar) aoMudar(); } }); };
  var mudar = async function(acao, titulo, ajuda){
    var mo = await U.pedirTexto({ titulo: titulo, ajuda: ajuda, min: 10 }); if(!mo) return;
    var canc = false;
    if(acao === 'encerrar') canc = confirm('Cancelar também as contas desta recorrência que ainda estão pendentes, de hoje em diante?\n\nOK = cancelar as futuras · Cancelar = deixar as que já estão no calendário');
    try { var x = await api('rec_status', { id: id, operacao: acao, motivo: mo, cancelar_futuros: canc }); toast(acao === 'encerrar' ? 'Recorrência encerrada' + (x.cancelados ? ': ' + x.cancelados + ' conta(s) futura(s) cancelada(s)' : '') : acao === 'pausar' ? 'Pausada: não gera mais contas até retomar' : 'Retomada'); recarregar(); }
    catch(e){ toast(e.message, 'erro'); }
  };
  if($('rv-pausar')) $('rv-pausar').onclick = function(){ mudar('pausar', 'Pausar a recorrência', 'Para de gerar contas novas. As que já estão no calendário continuam.'); };
  if($('rv-retomar')) $('rv-retomar').onclick = function(){ mudar('retomar', 'Retomar a recorrência', 'Volta a gerar a partir de hoje (os períodos da pausa não são criados).'); };
  if($('rv-encerrar')) $('rv-encerrar').onclick = function(){ mudar('encerrar', 'Encerrar a recorrência', 'Não gera mais contas e não pode ser reaberta (fica no histórico).'); };
}
function descHistRec(x){
  var d = x.depois || {}, a = x.antes || {};
  if(x.acao === 'INSERT') return 'criou a recorrência (' + (FREQ[d.frequencia] || d.frequencia) + ', ' + moeda(d.valor) + ')';
  var mud = [];
  if(a.status !== d.status) mud.push('situação: ' + (a.status || '-') + ' → ' + d.status + (d.motivo ? ' (' + d.motivo + ')' : ''));
  if(String(a.valor) !== String(d.valor)) mud.push('valor: ' + moeda(a.valor) + ' → ' + moeda(d.valor));
  if(a.fim !== d.fim) mud.push('data final: ' + (a.fim ? dataBR(a.fim) : 'sem fim') + ' → ' + (d.fim ? dataBR(d.fim) : 'sem fim'));
  if(a.valor_variavel !== d.valor_variavel) mud.push(d.valor_variavel ? 'passou a ter valor variável' : 'passou a ter valor fixo');
  if(JSON.stringify(a.modelo) !== JSON.stringify(d.modelo)) mud.push('mudou os dados da conta');
  if(a.gerados !== d.gerados && !mud.length) return 'colocou ' + (n(d.gerados) - n(a.gerados)) + ' conta(s) no calendário';
  return mud.length ? mud.join(' · ') : 'atualizou';
}

function recorrencias(tipo){
  return async function(el){
    css2(); carregando(el);
    try { await base(); } catch(e){ return erroEm(el, e); }
    var f = F['rec_' + tipo] = F['rec_' + tipo] || { status: 'ativa', q: '' };
    var aba = function(v, t){ return '<button class="fin-bt' + (f.status === v ? ' pri' : '') + '" data-rst="' + v + '">' + t + '</button>'; };
    el.innerHTML = '<div class="fin-card" style="margin-bottom:10px;font-size:12px">🔁 <b>Contas recorrentes</b>: ' + (tipo === 'pagar' ? 'aluguel, internet, salários, sistemas' : 'mensalidades e contratos de clientes') +
      '. Cada uma entra sozinha no calendário (até o fim do mês que vem), pra dar baixa normalmente na Central e na Lista. Pra criar, marque <b>🔁 Conta recorrente</b> no novo ' + (tipo === 'pagar' ? 'pagamento' : 'recebimento') + '.</div>' +
      '<div class="fin-row" style="margin-bottom:8px">' + aba('ativa', 'Ativas') + aba('pausada', 'Pausadas') + aba('encerrada', 'Encerradas') + aba('', 'Todas') +
      '<input class="fin-in" id="rc-q" placeholder="Buscar pessoa, descrição, classificação" value="' + esc(f.q || '') + '" style="flex:1;min-width:180px"><button class="fin-bt pri" id="rc-qok">Buscar</button>' +
      (pode('conferente') ? '<button class="fin-bt pri" id="rc-novo">+ Nova recorrente</button>' : '') + '</div><div id="rc-out"></div>';
    el.querySelectorAll('[data-rst]').forEach(function(b){ b.onclick = function(){ f.status = b.getAttribute('data-rst'); recorrencias(tipo)(el); }; });
    var busca = function(){ f.q = $('rc-q').value.trim(); recorrencias(tipo)(el); };
    $('rc-qok').onclick = busca; $('rc-q').onkeydown = function(e){ if(e.key === 'Enter') busca(); };
    if($('rc-novo')) $('rc-novo').onclick = function(){ formLanc(tipo, null, { recorrente: true, aoSalvar: function(){ recorrencias(tipo)(el); } }); };
    var out = $('rc-out'); carregando(out);
    try {
      var j = await api('rec_listar', { tipo: tipo, status: f.status, q: f.q });
      if(!j.itens.length){ out.innerHTML = '<div class="fin-vazio">Nenhuma recorrência ' + (f.status ? (REC_ST[f.status] || {}).t.toLowerCase() : '') + '.</div>'; return; }
      var mensal = j.itens.filter(function(r){ return r.status === 'ativa'; }).reduce(function(a, r){ var fat = { semanal: 52 / 12, quinzenal: 26 / 12, mensal: 1, bimestral: 1 / 2, trimestral: 1 / 3, semestral: 1 / 6, anual: 1 / 12 }[r.frequencia] || 1; return a + n(r.valor) * fat; }, 0);
      out.innerHTML = '<div class="fin-sub" style="margin-bottom:6px">' + j.itens.length + ' recorrência(s)' + (mensal ? ' · ativas somam cerca de <b>' + moeda(mensal) + ' por mês</b>' : '') + '</div>' +
        '<div class="fin-card" style="padding:0;overflow-x:auto"><table class="fin-tbl"><thead><tr><th>#</th><th>' + (tipo === 'pagar' ? 'Fornecedor' : 'Cliente') + '</th><th>Detalhe</th><th>Repete</th><th class="fin-num">Valor</th><th>Próximo vencimento</th><th>Termina</th><th>Situação</th></tr></thead><tbody>' +
        j.itens.map(function(r){ return '<tr class="clic" data-rec="' + r.id + '"><td class="fin-sub">' + r.id + '</td><td><b>' + esc(r.pessoa_nome || '-') + '</b></td><td>' + esc(r.classificacao_nome || '') + ' <span class="fin-sub">' + esc(r.descricao || '') + '</span></td>' +
          '<td>' + esc(FREQ[r.frequencia] || r.frequencia) + '</td><td class="fin-num"><b>' + moeda(r.valor).replace('R$ ', '') + '</b>' + (r.valor_variavel ? ' <span class="fin-sub" title="valor variável">~</span>' : '') + '</td>' +
          '<td>' + ((r.proximo_pendente || r.proximo_venc) ? dataBR(r.proximo_pendente || r.proximo_venc) : '-') + '</td><td>' + (r.fim ? dataBR(r.fim) : '<span class="fin-sub">sem fim</span>') + '</td>' +
          '<td>' + chipRecSt(r.status) + (n(r.atrasados) ? ' <span class="fin-chip" style="color:#fff;background:#C0392B">' + r.atrasados + ' atrasada(s)</span>' : '') + '</td></tr>'; }).join('') + '</tbody></table></div>';
      out.querySelectorAll('tr[data-rec]').forEach(function(tr){ tr.onclick = function(){ verRec(Number(tr.getAttribute('data-rec')), function(){ recorrencias(tipo)(el); }); }; });
    } catch(e){ erroEm(out, e); }
  };
}
T.pagar_recorrencias = recorrencias('pagar');
T.receber_recorrencias = recorrencias('receber');

/* ================= DETALHE DO LANÇAMENTO ================= */
async function verLanc(id, aoMudar){
  try { await base(); } catch(e){ toast(e.message, 'erro'); return; }
  var m = modal('<div class="fin-vazio">Carregando...</div>'); m.el.style.maxWidth = '860px';
  var d;
  try { d = await api('lanc_ver', { id: id }); } catch(e){ m.el.innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div><button class="fin-bt" id="lv-x">Fechar</button>'; $('lv-x').onclick = m.fechar; return; }
  var l = d.lanc, tipo = l.tipo, pend = l.status === 'pendente';
  var recarregar = function(){ m.fechar(); verLanc(id, aoMudar); if(aoMudar) aoMudar(); };
  var h = '<div class="fin-row" style="justify-content:space-between;align-items:flex-start"><div><div class="fin-sub">' + (tipo === 'pagar' ? 'Pagamento' : 'Recebimento') + ' #' + l.id + (l.parcela_num ? ' · parcela ' + l.parcela_num + '/' + l.parcela_total : '') + (l.origem !== 'manual' ? ' · veio do Kamino' : '') + '</div>' +
    '<div style="font-size:18px;font-weight:800">' + esc(l.descricao || l.classificacao_nome || '-') + '</div></div><div style="text-align:right"><div style="font-size:20px;font-weight:800" class="' + (tipo === 'pagar' ? 'fin-sai' : 'fin-ent') + '">' + moeda(l.valor_final) + '</div>' + chipSit(l.situacao_calc, tipo) + '</div></div>';
  h += '<div class="fin-row" style="margin:12px 0;gap:6px">';
  if(pend && pode('conferente')) h += '<button class="fin-bt ok" id="lv-baixa">' + (tipo === 'pagar' ? '✓ Baixa manual (paguei)' : '✓ Baixa manual (recebi)') + '</button>';
  if(pend && pode('conferente')) h += '<button class="fin-bt" id="lv-editar">Editar</button><button class="fin-bt" id="lv-split" title="Separa este lançamento em dois (ex.: pagou só uma parte)">Dividir em dois</button>';
  if(pend && l.valor_a_confirmar && pode('conferente')) h += '<button class="fin-bt ok" id="lv-confval">✓ Confirmar valor do mês</button>';
  if(pode('conferente')) h += '<button class="fin-bt" id="lv-dup">Duplicar</button>';
  if(!l.recorrencia_id && l.status !== 'cancelado' && l.origem === 'manual' && pode('conferente')) h += '<button class="fin-bt" id="lv-tornarrec" title="Usa esta conta como modelo: a próxima nasce sozinha no período seguinte">🔁 Tornar recorrente</button>';
  h += '<button class="fin-bt" id="lv-print">Imprimir rateio</button>';
  if(pend && pode('gestor')) h += '<button class="fin-bt sus" id="lv-cancelar">Cancelar lançamento</button>';
  if(l.status === 'pago' && l.baixa_id && pode('gestor')) h += '<button class="fin-bt div" id="lv-estornar">Estornar baixa</button>';
  h += '</div>';
  h += '<div class="fin-grid2"><div class="fin-card" style="font-size:12px;line-height:1.9"><b>Dados</b><br>Pessoa: <b>' + esc(l.pessoa_nome || '-') + '</b> ' + esc(l.pessoa_doc || '') +
    '<br>Classificação: ' + esc(l.classificacao_nome || '-') + (l.classificacao_subgrupo ? ' <span class="fin-sub">(' + esc(l.classificacao_subgrupo) + ')</span>' : '') +
    '<br>Centro de custo: ' + esc(l.centro_custo_nome || '-') + '<br>Unidade: ' + esc(l.unidade_nome || '-') +
    '<br>Forma: ' + esc(FORMA[l.forma] || l.forma || '-') + ' · Conta: ' + esc(l.conta_nome || '-') +
    (l.codigo_barras ? '<br>Código de barras: <span style="font-family:monospace">' + esc(l.codigo_barras) + '</span>' : '') +
    (l.pix_copia_cola ? '<br>Pix copia e cola: <span style="font-family:monospace;word-break:break-all">' + esc(l.pix_copia_cola.slice(0, 80)) + '…</span>' : '') +
    (l.nf_numero ? '<br>NF: ' + esc(l.nf_numero) : '') + (l.observacao ? '<br>Obs: ' + esc(l.observacao) : '') + '</div>' +
    '<div class="fin-card" style="font-size:12px;line-height:1.9"><b>Valores e datas</b><br>Vencimento: <b>' + dataBR(l.vencimento) + '</b> · Competência: ' + dataBR(l.competencia) +
    '<br>Valor bruto: ' + moeda(l.valor) + (n(l.juros) ? '<br>Juros: +' + moeda(l.juros) : '') + (n(l.multa) ? '<br>Multa: +' + moeda(l.multa) : '') + (n(l.desconto) ? '<br>Desconto: −' + moeda(l.desconto) : '') +
    (n(l.retencao) ? '<br>Retenção ' + esc(l.retencao_tipo || '') + ': −' + moeda(l.retencao) : '') + '<br>Valor final: <b>' + moeda(l.valor_final) + '</b>' +
    (l.data_pagamento ? '<br>' + (tipo === 'pagar' ? 'Pago' : 'Recebido') + ' em <b>' + dataBR(l.data_pagamento) + '</b>' : '') +
    (d.extrato ? '<br>🔗 Conciliado com o extrato: ' + dataBR(d.extrato.data) + ' ' + esc(d.extrato.conta_nome) + ' ' + moeda(d.extrato.valor) : (l.status === 'pago' ? '<br><span style="color:#B7791F">⚠️ Ainda sem conciliação com o extrato</span>' : '')) +
    (l.cancelado_por ? '<br>Cancelado por ' + esc(nome(l.cancelado_por)) + ': ' + esc(l.motivo_cancelamento || '') : '') + '</div></div>';
  if(l.recorrencia_id) h += '<div class="fin-card" style="margin-top:10px;font-size:12px"><div class="fin-row" style="justify-content:space-between"><span>🔁 <b>Conta recorrente #' + l.recorrencia_id + '</b> · ocorrência nº ' + (n(l.recorrencia_seq) + 1) +
    (l.valor_a_confirmar && pend ? ' · <span style="color:#B7791F;font-weight:700">valor previsto, confirme o valor deste mês</span>' : '') + '</span><button class="fin-bt" id="lv-verrec">Ver a recorrência</button></div></div>';
  if(l.rateio && l.rateio.length) h += '<div class="fin-card" style="margin-top:10px"><b style="font-size:12px">Rateio por unidade</b><div style="margin-top:6px">' + barraRateio(l.rateio) + '</div></div>';
  if(d.parcelas.length > 1) h += '<div class="fin-card" style="margin-top:10px"><b style="font-size:12px">Parcelas</b><table class="fin-tbl" style="margin-top:4px"><tbody>' + d.parcelas.map(function(p){ return '<tr' + (p.id === l.id ? ' style="font-weight:800"' : '') + '><td>' + p.parcela_num + '/' + p.parcela_total + '</td><td>' + dataBR(p.vencimento) + '</td><td class="fin-num">' + moeda(p.valor_final) + '</td><td>' + chipSit(p.situacao_calc, tipo) + '</td></tr>'; }).join('') + '</tbody></table></div>';
  if(d.alertas.length) h += '<div class="fin-card" style="margin-top:10px"><b style="font-size:12px">🚨 Alertas</b>' + d.alertas.map(function(a){ return '<div style="font-size:12px;margin-top:4px">' + U.chipSev(a.severidade) + ' ' + esc(a.titulo) + ' <span class="fin-sub">' + esc(a.status) + '</span></div>'; }).join('') + '</div>';
  h += '<div class="fin-card" style="margin-top:10px"><div class="fin-row" style="justify-content:space-between"><b style="font-size:12px">📎 Anexos</b>' + (pode('conferente') ? '<label class="fin-bt" style="cursor:pointer">+ Anexar<input type="file" id="lv-anexo" multiple accept="application/pdf,image/png,image/jpeg,image/webp" style="display:none"></label>' : '') + '</div>' +
    (d.anexos.length ? d.anexos.map(function(a){ return '<div style="font-size:12px;margin-top:4px"><a href="#" data-anexo="' + a.id + '">' + esc(a.nome) + '</a> <span class="fin-sub">' + Math.round(a.bytes / 1024) + ' KB · ' + esc(nome(a.por)) + ' · ' + dataHoraBR(a.em) + '</span></div>'; }).join('') : '<div class="fin-sub">Nenhum anexo.</div>') + '</div>';
  if(d.baixas.length) h += '<div class="fin-card" style="margin-top:10px"><b style="font-size:12px">Baixas</b>' + d.baixas.map(function(b){ return '<div style="font-size:12px;margin-top:4px' + (b.estornada ? ';text-decoration:line-through;opacity:.6' : '') + '">' + dataBR(b.data) + ' · ' + moeda(n(b.valor) + n(b.juros) + n(b.multa) - n(b.desconto)) + ' · ' + esc((F.base.contas.filter(function(c){ return c.id === b.conta_id; })[0] || {}).nome || '') + ' · ' + (b.origem === 'conciliacao' ? 'pela conciliação' : 'manual') + ' por ' + esc(nome(b.por)) + '</div>' + (b.estornada ? '<div class="fin-sub">Estornada por ' + esc(nome(b.estornada_por)) + ': ' + esc(b.motivo_estorno) + '</div>' : ''); }).join('') + '</div>';
  h += '<div class="fin-card" style="margin-top:10px"><b style="font-size:12px">📜 Histórico (permanente)</b>' + (d.historico.length ? d.historico.slice().reverse().map(function(x){ return '<div style="font-size:12px;margin-top:4px">' + dataHoraBR(x.ts) + ' · <b>' + esc(nome(x.ator)) + '</b> · ' + esc(descHist(x)) + '</div>'; }).join('') : '<div class="fin-sub">Sem histórico.</div>') + '</div>';
  h += '<div class="fin-row" style="justify-content:flex-end;margin-top:12px"><button class="fin-bt" id="lv-x">Fechar</button></div>';
  m.el.innerHTML = h;
  $('lv-x').onclick = m.fechar;
  m.el.querySelectorAll('[data-anexo]').forEach(function(a){ a.onclick = function(e){ e.preventDefault(); abrirAnexo(a.getAttribute('data-anexo')); }; });
  if($('lv-anexo')) $('lv-anexo').onchange = async function(){ var f = this.files; if(!f.length) return; toast('Enviando...', 'aviso'); await enviarAnexos(f, { lancamento_id: id }); recarregar(); };
  if($('lv-baixa')) $('lv-baixa').onclick = function(){ baixaModal([l], recarregar); };
  if($('lv-editar')) $('lv-editar').onclick = function(){ m.fechar(); formLanc(tipo, l, { aoSalvar: function(){ verLanc(id, aoMudar); if(aoMudar) aoMudar(); } }); };
  if($('lv-dup')) $('lv-dup').onclick = function(){ m.fechar(); var c = Object.assign({}, l); delete c.id; c.vencimento = ''; c.competencia = ''; formLanc(tipo, c, { duplicar: true, aoSalvar: aoMudar }); };
  if($('lv-print')) $('lv-print').onclick = function(){ imprimirRateio(l); };
  if($('lv-verrec')) $('lv-verrec').onclick = function(){ m.fechar(); verRec(l.recorrencia_id, aoMudar); };
  if($('lv-confval')) $('lv-confval').onclick = async function(){
    var v = await U.pedirTexto({ titulo: 'Valor deste mês', ajuda: 'Valor previsto: ' + moeda(l.valor) + '. Digite o valor da conta deste mês (o mesmo, se não mudou).', tipo: 'valor', obrigatorio: true, valor: fmtIn(l.valor) }); if(!v) return;
    if(!(parseBR(v) > 0)) return toast('Valor inválido', 'erro');
    try { await api('rec_confirmar_valor', { id: id, valor: parseBR(v) }); toast('Valor confirmado'); recarregar(); } catch(e){ toast(e.message, 'erro'); }
  };
  if($('lv-tornarrec')) $('lv-tornarrec').onclick = function(){ tornarRecorrente(l, function(){ m.fechar(); if(aoMudar) aoMudar(); }); };
  if($('lv-split')) $('lv-split').onclick = async function(){
    var v = await U.pedirTexto({ titulo: 'Dividir em dois: valor da 2ª parte', ajuda: 'O resto fica neste lançamento.', tipo: 'valor', obrigatorio: true }); if(!v) return;
    if(!(parseBR(v) > 0)) return toast('Valor inválido', 'erro');
    var iso = await U.pedirTexto({ titulo: 'Vencimento da 2ª parte', ajuda: 'Deixe em branco para manter o mesmo vencimento.', tipo: 'date' }); if(iso === null) return;
    iso = iso || null;
    try { var r = await api('lanc_split', { id: id, valor2: parseBR(v), vencimento2: iso }); toast('Dividido: novo lançamento #' + r.novo_id); recarregar(); } catch(e){ toast(e.message, 'erro'); }
  };
  if($('lv-cancelar')) $('lv-cancelar').onclick = async function(){
    var mo = await U.pedirTexto({ titulo: 'Cancelar o lançamento', ajuda: 'Ele não some: fica registrado como cancelado, com o seu nome e o motivo.', min: 10 }); if(!mo) return;
    try { await api('lanc_cancelar', { id: id, motivo: mo }); toast('Cancelado'); recarregar(); } catch(e){ toast(e.message, 'erro'); }
  };
  if($('lv-estornar')) $('lv-estornar').onclick = async function(){
    var mo = await U.pedirTexto({ titulo: 'Estornar a baixa', ajuda: 'O lançamento volta a ficar pendente. Fica registrado com o seu nome.', min: 10 }); if(!mo) return;
    try { await api('lanc_estornar', { id: id, motivo: mo }); toast('Baixa estornada'); recarregar(); } catch(e){ toast(e.message, 'erro'); }
  };
}
function descHist(x){
  var d = x.depois || {}, a = x.antes || {};
  if(x.tabela === 'fin_baixas') return x.acao === 'INSERT' ? 'deu baixa (' + dataBR(d.data) + ')' : 'estornou a baixa: ' + (d.motivo_estorno || '');
  if(x.acao === 'INSERT') return 'criou o lançamento';
  var mud = [];
  ['valor', 'vencimento', 'competencia', 'pessoa_id', 'classificacao_id', 'unidade_id', 'conta_id', 'status', 'descricao', 'juros', 'multa', 'desconto'].forEach(function(k){
    if(JSON.stringify(a[k]) !== JSON.stringify(d[k])) mud.push(k + ': ' + (a[k] == null ? '-' : a[k]) + ' → ' + (d[k] == null ? '-' : d[k]));
  });
  return mud.length ? 'alterou ' + mud.join(', ') : 'atualizou';
}
function imprimirRateio(l){
  var un = {}; F.base.unidades.forEach(function(u){ un[u.id] = u.nome; });
  var r = (l.rateio && l.rateio.length) ? l.rateio : [{ unidade_id: l.unidade_id, pct: 100 }];
  var w = window.open('', '_blank', 'width=700,height=600'); if(!w) return toast('Libere pop-up pra imprimir', 'aviso'); w.opener = null;
  w.document.write('<html><head><title>Rateio #' + l.id + '</title><style>body{font-family:Arial;padding:24px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px;text-align:left}td.n{text-align:right}</style></head><body>' +
    '<h3>Rateio do lançamento #' + l.id + '</h3><p>' + esc(l.pessoa_nome || '') + ' · ' + esc(l.descricao || '') + '<br>Classificação: ' + esc(l.classificacao_nome || '-') + ' · Vencimento ' + dataBR(l.vencimento) + ' · Total ' + moeda(l.valor_final) + '</p>' +
    '<table><tr><th>Unidade</th><th>%</th><th>Valor</th></tr>' + r.map(function(x){ return '<tr><td>' + esc(un[x.unidade_id] || '-') + '</td><td class="n">' + x.pct + '%</td><td class="n">' + moeda(n(l.valor_final) * x.pct / 100) + '</td></tr>'; }).join('') + '</table>' +
    '<p style="color:#888;font-size:11px">Gerado em ' + new Date().toLocaleString('pt-BR') + '</p><script>window.print()<\/script></body></html>');
  w.document.close();
}

/* ---------- baixa manual (1 ou vários) ---------- */
function baixaModal(lancs, aoMudar){
  var um = lancs.length === 1, L = lancs[0], tipo = L.tipo;
  var tot = lancs.reduce(function(a, l){ return a + n(l.valor_final); }, 0);
  var m = modal('<div style="font-weight:800;font-size:15px">' + (tipo === 'pagar' ? 'Registrar pagamento' : 'Registrar recebimento') + (um ? ' #' + L.id : ' de ' + lancs.length + ' lançamentos') + '</div>' +
    '<div class="fin-sub" style="margin:4px 0 10px">' + (um ? esc(L.pessoa_nome || '') + ' · ' : '') + 'Total ' + moeda(tot) + '. A baixa NÃO move dinheiro: ela registra que já ' + (tipo === 'pagar' ? 'saiu' : 'entrou') + '. O extrato do banco é quem confirma (se não bater, vira alerta).</div>' +
    '<div class="fin-grid2"><div><div class="fin-lbl">Data do ' + (tipo === 'pagar' ? 'pagamento' : 'recebimento') + '</div><input type="date" class="fin-in" id="bx-data" value="' + hoje() + '" max="' + hoje() + '"></div>' +
    '<div><div class="fin-lbl">Conta</div><select class="fin-in" id="bx-conta">' + optsContas(L.conta_id, 'Escolha a conta...') + '</select></div></div>' +
    (um ? '<div class="fin-g3" style="margin-top:8px"><div><div class="fin-lbl">Juros</div><input class="fin-in fin-num" id="bx-j" value="' + fmtIn(L.juros) + '"></div><div><div class="fin-lbl">Multa</div><input class="fin-in fin-num" id="bx-m" value="' + fmtIn(L.multa) + '"></div><div><div class="fin-lbl">Desconto</div><input class="fin-in fin-num" id="bx-d" value="' + fmtIn(L.desconto) + '"></div></div>' : '') +
    '<div style="margin-top:8px"><div class="fin-lbl">Observação</div><input class="fin-in" id="bx-obs" maxlength="500"></div><div id="bx-msg"></div>' +
    '<div class="fin-row" style="justify-content:flex-end;margin-top:12px"><button class="fin-bt" id="bx-x">Cancelar</button><button class="fin-bt ok" id="bx-ok">Confirmar baixa</button></div>');
  $('bx-x').onclick = m.fechar;
  $('bx-ok').onclick = async function(){
    var b = this; if(!$('bx-conta').value){ $('bx-msg').innerHTML = '<div class="fin-erro">Escolha a conta.</div>'; return; }
    b.disabled = true;
    var d = { ids: lancs.map(function(l){ return l.id; }), data: $('bx-data').value, conta_id: $('bx-conta').value, observacao: $('bx-obs').value };
    if(um){ d.juros = parseBR($('bx-j').value) || 0; d.multa = parseBR($('bx-m').value) || 0; d.desconto = parseBR($('bx-d').value) || 0; }
    try {
      var r = await api('lanc_baixar', d);
      if(r.erros && r.erros.length){ $('bx-msg').innerHTML = '<div class="fin-aviso">' + r.baixados + ' baixado(s). Com problema: ' + esc(r.erros.join(' | ')) + '<br>Os que deram certo já estão baixados; feche e tente de novo só os que ficaram pendentes.</div>'; b.textContent = 'Fechar'; b.disabled = false; b.onclick = function(){ m.fechar(); }; }
      else { toast(r.baixados + ' baixa(s) registrada(s)'); m.fechar(); }
      if(aoMudar) aoMudar();
    } catch(e){ $('bx-msg').innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; b.disabled = false; }
  };
}

/* ================= PAINEL ================= */
T.painel = async function(el){
  css2(); carregando(el);
  try {
    try { await base(); } catch(e){ toast(e.message, 'erro'); return; }
    var p = (await api('painel')).painel;
    var saldo = p.saldos.reduce(function(a, s){ return a + n(s.saldo); }, 0);
    var h = '<div class="fin-row" style="justify-content:flex-end;margin-bottom:10px">' + (pode('conferente') ? '<button class="fin-bt pri" id="pn-np">+ Novo pagamento</button><button class="fin-bt ok" id="pn-nr">+ Novo recebimento</button>' : '') + '</div>';
    h += '<div class="fin-kpis">' + kpi('Saldo nas contas', moeda(saldo), saldo < 0 ? '#E24B4A' : '', p.saldos.length + ' contas ativas') +
      kpi('A pagar atrasado', moeda(p.pagar.atrasado), n(p.pagar.atrasado) ? '#C0392B' : '', p.pagar.qtd_atrasado + ' lançamento(s)') +
      kpi('A pagar hoje', moeda(p.pagar.hoje), '', p.pagar.qtd_hoje + ' · próximos 7 dias ' + moeda(p.pagar.semana)) +
      kpi('A receber atrasado', moeda(p.receber.atrasado), n(p.receber.atrasado) ? '#C0392B' : '', p.receber.qtd_atrasado + ' lançamento(s)') +
      kpi('A receber 7 dias', moeda(p.receber.semana), '#1D9E75', 'hoje ' + moeda(p.receber.hoje)) +
      (p.entradas_pendentes ? kpi('Caixa de entrada', String(p.entradas_pendentes), '#D68910', 'documento(s) esperando lançamento') : '') + '</div>';
    h += '<div class="fin-grid2"><div class="fin-card"><b style="font-size:13px">Classificações mais utilizadas</b><div class="fin-sub">Mês atual x mês anterior (despesas por competência)</div>';
    var max = Math.max.apply(null, p.top_classificacoes.map(function(c){ return Math.max(n(c.atual), n(c.anterior)); }).concat([1]));
    h += p.top_classificacoes.length ? p.top_classificacoes.map(function(c, k){ return '<div style="margin-top:8px;font-size:12px"><div class="fin-row" style="justify-content:space-between"><span><b>' + (k + 1) + '</b> ' + esc(c.nome || '(Sem classificação)') + '</span><span class="fin-num"><b>' + moeda(c.atual) + '</b><br><span class="fin-sub">' + moeda(c.anterior) + '</span></span></div>' +
      '<div class="fin-bar" style="margin-top:2px"><i style="width:' + (n(c.atual) / max * 100) + '%;background:#0E7AB8"></i></div><div class="fin-bar" style="margin-top:2px;height:5px"><i style="width:' + (n(c.anterior) / max * 100) + '%;background:#9DB4D6"></i></div></div>'; }).join('') : '<div class="fin-vazio">Sem despesas lançadas.</div>';
    h += '</div><div class="fin-card"><b style="font-size:13px">Evolução das despesas</b><div class="fin-sub">Realizado (pago) e previsto, por mês de competência</div>' + barrasMes(p.evolucao) + '</div></div>';
    h += '<div class="fin-card" style="margin-top:12px;overflow-x:auto"><b style="font-size:13px">Saldos</b><table class="fin-tbl" style="margin-top:6px"><tbody>' + p.saldos.map(function(s){ return '<tr><td>' + esc(s.nome) + '<div class="fin-sub">' + esc(s.banco || '') + '</div></td><td class="fin-num" style="font-weight:700' + (n(s.saldo) < 0 ? ';color:#E24B4A' : '') + '">' + moeda(s.saldo) + '</td><td class="fin-sub">' + (s.origem === 'extrato' ? 'extrato de ' + dataBR(s.saldo_data) : 'calculado pelo sistema') + '</td></tr>'; }).join('') + '</tbody></table></div>';
    el.innerHTML = h;
    if($('pn-np')) $('pn-np').onclick = function(){ formLanc('pagar', null, { aoSalvar: function(){ T.painel(el); } }); };
    if($('pn-nr')) $('pn-nr').onclick = function(){ formLanc('receber', null, { aoSalvar: function(){ T.painel(el); } }); };
  } catch(e){ erroEm(el, e); }
};
function kpi(l, v, cor, sub){ return '<div class="fin-card"><div class="fin-kl">' + l + '</div><div class="fin-kv"' + (cor ? ' style="color:' + cor + '"' : '') + '>' + v + '</div>' + (sub ? '<div class="fin-sub" style="margin-top:2px">' + sub + '</div>' : '') + '</div>'; }
function barrasMes(lista){
  if(!lista.length) return '<div class="fin-vazio">Sem dados.</div>';
  var max = Math.max.apply(null, lista.map(function(x){ return n(x.realizado) + n(x.previsto); }).concat([1]));
  return '<div style="display:flex;gap:8px;align-items:flex-end;height:170px;margin-top:10px">' + lista.map(function(x){
    var r = n(x.realizado), p = n(x.previsto), mes = x.mes.split('-');
    return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;height:100%;justify-content:flex-end"><div class="fin-sub" style="font-size:10px">' + moedaCurta(r + p) + '</div>' +
      '<div style="width:70%;display:flex;flex-direction:column;justify-content:flex-end;height:' + ((r + p) / max * 120) + 'px"><div title="Previsto ' + moeda(p) + '" style="background:#F5B041;height:' + (p / (r + p || 1) * 100) + '%;border-radius:4px 4px 0 0"></div><div title="Realizado ' + moeda(r) + '" style="background:#E24B4A;height:' + (r / (r + p || 1) * 100) + '%"></div></div>' +
      '<div class="fin-sub" style="font-size:10px">' + MESES[Number(mes[1]) - 1] + '/' + mes[0].slice(2) + '</div></div>';
  }).join('') + '</div><div class="fin-sub" style="margin-top:4px"><span style="color:#E24B4A">■</span> realizado <span style="color:#F5B041">■</span> previsto</div>';
}

/* ================= PAGAR / RECEBER: CENTRAL (cards por dia) ================= */
function central(tipo){
  return async function(el){
    css2();
    var f = F['central_' + tipo] = F['central_' + tipo] || { ini: hoje(), fim: addDias(hoje(), 30), situacao: 'pendentes', q: '' };
    el.innerHTML = '<div class="fin-filtros"><input id="ce-q" placeholder="Buscar pessoa ou descrição" value="' + esc(f.q) + '" style="min-width:200px">' +
      '<button class="fin-bt" id="ce-ant">‹</button><input type="date" id="ce-ini" value="' + f.ini + '"><input type="date" id="ce-fim" value="' + f.fim + '"><button class="fin-bt" id="ce-prox">›</button>' +
      '<select id="ce-sit"><option value="pendentes"' + (f.situacao === 'pendentes' ? ' selected' : '') + '>Situação: pendentes</option><option value="pagos"' + (f.situacao === 'pagos' ? ' selected' : '') + '>' + (tipo === 'pagar' ? 'Pagos' : 'Recebidos') + '</option><option value="todos"' + (f.situacao === 'todos' ? ' selected' : '') + '>Todos</option></select>' +
      '<button class="fin-bt pri" id="ce-ok">Filtrar</button><div style="flex:1"></div>' + (pode('conferente') ? '<button class="fin-bt ok" id="ce-novo">+ ' + (tipo === 'pagar' ? 'Novo pagamento' : 'Novo recebimento') + '</button>' : '') + '</div><div id="ce-out"></div>';
    var ap = function(){ f.q = $('ce-q').value.trim(); f.ini = $('ce-ini').value; f.fim = $('ce-fim').value; f.situacao = $('ce-sit').value; central(tipo)(el); };
    $('ce-ok').onclick = ap; $('ce-q').onkeydown = function(e){ if(e.key === 'Enter') ap(); };
    var datasOk = function(){ if(!f.ini || !f.fim || f.fim < f.ini){ toast('Preencha as duas datas (início antes do fim)', 'aviso'); return false; } return true; };
    $('ce-ant').onclick = function(){ if(!datasOk()) return; var d = (new Date(f.fim) - new Date(f.ini)) / 864e5 + 1; f.ini = addDias(f.ini, -d); f.fim = addDias(f.fim, -d); central(tipo)(el); };
    $('ce-prox').onclick = function(){ if(!datasOk()) return; var d = (new Date(f.fim) - new Date(f.ini)) / 864e5 + 1; f.ini = addDias(f.ini, d); f.fim = addDias(f.fim, d); central(tipo)(el); };
    if($('ce-novo')) $('ce-novo').onclick = function(){ formLanc(tipo, null, { aoSalvar: function(){ central(tipo)(el); } }); };
    var out = $('ce-out'); carregando(out);
    try {
      try { await base(); } catch(e){ toast(e.message, 'erro'); return; }
      var j = await api('central', f);
      var h = '';
      if(j.atrasados_antes.qtd) h += '<div class="fin-erro" style="cursor:pointer" id="ce-atr">⏰ ' + j.atrasados_antes.qtd + ' lançamento(s) atrasado(s) antes deste período, total ' + moeda(j.atrasados_antes.total) + '. Clique para ver.</div>';
      if(!j.dias.length) h += '<div class="fin-vazio">Nada no período.</div>';
      h += '<div class="fin-dias">' + j.dias.map(function(d, k){
        var cls = Object.keys(d.por_class).sort(function(a, b){ return d.por_class[b] - d.por_class[a]; });
        var status = d.pendentes + d.atrasados === 0 ? chipSit('pago', tipo) : (d.atrasados ? chipSit('atrasado') : chipSit('pendente'));
        return '<div class="fin-dia"><div class="fin-row" style="justify-content:space-between"><div><b>' + dataBR(d.dia).slice(0, 5) + '</b><div class="fin-sub">' + diaSemana(d.dia) + '</div></div>' + status + '</div>' +
          '<div style="text-align:center;margin:4px 0"><div class="fin-sub">Valor total do lote</div><div style="font-size:18px;font-weight:800">' + moeda(d.total) + '</div><div class="fin-sub">' + d.qtd + ' ' + (tipo === 'pagar' ? 'pagamento(s)' : 'recebimento(s)') + '</div></div>' +
          cls.slice(0, 4).map(function(c){ return '<div class="fin-row" style="justify-content:space-between;font-size:11px"><span>' + esc(c) + '</span><span class="fin-num">' + moeda(d.por_class[c]) + '</span></div>'; }).join('') + (cls.length > 4 ? '<div class="fin-sub">+' + (cls.length - 4) + ' classificações</div>' : '') +
          '<div style="flex:1"></div><button class="fin-bt pri" data-dia="' + k + '">Ver lançamentos</button></div>';
      }).join('') + '</div>';
      out.innerHTML = h;
      out.querySelectorAll('[data-dia]').forEach(function(b){ b.onclick = function(){ listaDia(j.dias[Number(b.getAttribute('data-dia'))], tipo, function(){ central(tipo)(el); }); }; });
      if($('ce-atr')) $('ce-atr').onclick = function(){ F['lista_' + tipo] = { situacao: ['atrasado'] }; U.irPara(tipo === 'pagar' ? 'pagar_lista' : 'receber_lista'); };
    } catch(e){ erroEm(out, e); }
  };
}
function listaDia(d, tipo, aoMudar){
  var m = modal('<div class="fin-row" style="justify-content:space-between"><b style="font-size:15px">' + dataBR(d.dia) + ' · ' + moeda(d.total) + '</b><button class="fin-bt" id="ld-x">✕</button></div>' +
    '<table class="fin-tbl" style="margin-top:8px"><thead><tr><th>' + (pode('conferente') ? '<input type="checkbox" id="ld-all">' : '') + '</th><th>Pessoa</th><th>Classificação</th><th class="fin-num">Valor</th><th>Situação</th></tr></thead><tbody>' +
    d.itens.map(function(l){ return '<tr class="clic" data-id="' + l.id + '"><td>' + (l.status === 'pendente' && pode('conferente') ? '<input type="checkbox" data-sel="' + l.id + '">' : '') + '</td><td><b>' + esc(l.pessoa_nome || '-') + '</b>' + chipRec(l) + '<div class="fin-sub">' + esc(l.descricao || '') + '</div></td><td class="fin-sub">' + esc(l.classificacao_nome || '') + '</td><td class="fin-num">' + moeda(l.valor_final) + '</td><td>' + chipSit(l.situacao_calc, tipo) + (l.extrato_id ? ' 🔗' : '') + '</td></tr>'; }).join('') +
    '</tbody></table>' + (pode('conferente') ? '<div class="fin-row" style="justify-content:flex-end;margin-top:10px"><button class="fin-bt ok" id="ld-baixa">Baixa dos selecionados</button></div>' : ''));
  $('ld-x').onclick = m.fechar;
  m.el.querySelectorAll('tr[data-id]').forEach(function(tr){ tr.onclick = function(e){ if(e.target.type === 'checkbox') return; m.fechar(); verLanc(Number(tr.getAttribute('data-id')), aoMudar); }; });
  if($('ld-all')) $('ld-all').onchange = function(){ var c = this.checked; m.el.querySelectorAll('[data-sel]').forEach(function(x){ x.checked = c; }); };
  if($('ld-baixa')) $('ld-baixa').onclick = function(){
    var ids = [].map.call(m.el.querySelectorAll('[data-sel]:checked'), function(x){ return Number(x.getAttribute('data-sel')); });
    if(!ids.length) return toast('Selecione ao menos um', 'aviso');
    m.fechar(); baixaModal(d.itens.filter(function(l){ return ids.indexOf(l.id) >= 0; }).map(function(l){ return Object.assign({ tipo: tipo }, l); }), aoMudar);
  };
}
T.pagar_central = central('pagar');

/* ================= PAGAR / RECEBER: LISTA (filtros completos do Kamino) ================= */
function lista(tipo){
  return async function(el){
    css2(); carregando(el);
    try { await base(); } catch(e){ return erroEm(el, e); }
    var f = F['lista_' + tipo] = Object.assign({ situacao: ['pendente', 'atrasado'] }, F['lista_' + tipo] || {});
    F['pag_' + tipo] = F['pag_' + tipo] || 0;
    var chk = function(v, t){ return '<label style="display:flex;gap:4px;align-items:center;font-size:12px"><input type="checkbox" data-sit="' + v + '"' + (f.situacao.indexOf(v) >= 0 ? ' checked' : '') + '>' + t + '</label>'; };
    var sel3 = function(id, v, a, b){ return '<select class="fin-in" id="' + id + '"><option value="">Indiferente</option><option value="sim"' + (v === 'sim' ? ' selected' : '') + '>' + a + '</option><option value="nao"' + (v === 'nao' ? ' selected' : '') + '>' + b + '</option></select>'; };
    el.innerHTML = '<div class="fin-card" style="margin-bottom:10px"><div class="fin-row" style="justify-content:space-between;cursor:pointer" id="li-tog"><b>Filtros</b><span class="fin-sub">' + (F['filtros_abertos_' + tipo] ? '▲' : '▼') + '</span></div><div id="li-filtros" style="' + (F['filtros_abertos_' + tipo] ? '' : 'display:none') + ';margin-top:10px">' +
      '<div class="fin-g3"><div><div class="fin-lbl">Pessoa</div>' + campoPessoa('li-pessoa', f.pessoa_id ? { id: f.pessoa_id, nome: f.pessoa_nome } : null) + '</div>' +
      '<div><div class="fin-lbl">Conta</div><select class="fin-in" id="li-conta">' + optsContas(f.conta_id, 'Todas') + '</select></div>' +
      '<div><div class="fin-lbl">Situação</div><div class="fin-row">' + chk('pendente', 'Pendentes') + chk('atrasado', 'Atrasados') + chk('pago', tipo === 'pagar' ? 'Pagos' : 'Recebidos') + chk('cancelado', 'Cancelados') + '</div></div></div>' +
      '<div class="fin-g4" style="margin-top:8px">' + [['venc_de', 'Vencimento de'], ['venc_ate', 'Vencimento até'], ['pag_de', (tipo === 'pagar' ? 'Pagamento' : 'Recebimento') + ' de'], ['pag_ate', (tipo === 'pagar' ? 'Pagamento' : 'Recebimento') + ' até'], ['comp_de', 'Competência de'], ['comp_ate', 'Competência até']].map(function(x){ return '<div><div class="fin-lbl">' + x[1] + '</div><input type="date" class="fin-in" id="li-' + x[0] + '" value="' + esc(f[x[0]] || '') + '"></div>'; }).join('') +
      '<div><div class="fin-lbl">Código</div><input class="fin-in" id="li-codigo" value="' + esc(f.codigo || '') + '"></div><div><div class="fin-lbl">Valor (R$)</div><input class="fin-in fin-num" id="li-valor" value="' + esc(f.valor || '') + '"></div></div>' +
      '<div class="fin-g4" style="margin-top:8px"><div><div class="fin-lbl">Descrição contém</div><input class="fin-in" id="li-descricao" value="' + esc(f.descricao || '') + '"></div>' +
      '<div><div class="fin-lbl">Forma</div><select class="fin-in" id="li-forma"><option value="">Todas</option>' + Object.keys(FORMA).map(function(k){ return '<option value="' + k + '"' + (f.forma === k ? ' selected' : '') + '>' + FORMA[k] + '</option>'; }).join('') + '</select></div>' +
      '<div><div class="fin-lbl">Conciliação no extrato</div>' + sel3('li-conciliado', f.conciliado, 'Conciliado', 'Não conciliado') + '</div><div><div class="fin-lbl">Tem anexo</div>' + sel3('li-anexo', f.anexo, 'Com anexo', 'Sem anexo') + '</div></div>' +
      '<div class="fin-g4" style="margin-top:8px"><div><div class="fin-lbl">Número da NF</div><input class="fin-in" id="li-nf" value="' + esc(f.nf || '') + '"></div><div><div class="fin-lbl">Observação contém</div><input class="fin-in" id="li-observacao" value="' + esc(f.observacao || '') + '"></div>' +
      '<div><div class="fin-lbl">Classificação</div><select class="fin-in" id="li-class">' + optsClass(f.classificacao_id, tipo, 'Todas') + '</select></div>' +
      '<div><div class="fin-lbl">Centro de custo</div><select class="fin-in" id="li-cc">' + optsLista(F.base.centros, f.centro_custo_id, 'Todos') + '</select></div></div>' +
      '<div class="fin-g4" style="margin-top:8px"><div><div class="fin-lbl">Unidade de negócio</div><select class="fin-in" id="li-un">' + optsLista(F.base.unidades, f.unidade_id, 'Todas') + '</select></div>' +
      '<div><div class="fin-lbl">Ordenar por</div><select class="fin-in" id="li-ordem"><option value="">Vencimento</option><option value="pagamento"' + (f.ordem === 'pagamento' ? ' selected' : '') + '>Data de pagamento</option><option value="recente"' + (f.ordem === 'recente' ? ' selected' : '') + '>Mais recentes</option></select></div></div>' +
      '<div class="fin-row" style="justify-content:flex-end;margin-top:10px"><button class="fin-bt" id="li-limpar">Limpar</button><button class="fin-bt pri" id="li-buscar">Buscar</button></div></div></div>' +
      '<div class="fin-row" style="margin-bottom:8px"><input class="fin-in" id="li-q" placeholder="Busca rápida: pessoa, descrição, classificação" value="' + esc(f.q || '') + '" style="flex:1;min-width:200px"><button class="fin-bt pri" id="li-qok">Buscar</button>' +
      (pode('conferente') ? '<button class="fin-bt ok" id="li-baixa">Baixa dos selecionados</button><button class="fin-bt pri" id="li-novo">+ Novo</button>' : '') + (pode('gestor') ? '<button class="fin-bt" id="li-csv">⬇️ Exportar</button>' : '') + '</div><div id="li-out"></div>';
    ligarPessoa('li-pessoa', tipo);
    $('li-tog').onclick = function(){ F['filtros_abertos_' + tipo] = !F['filtros_abertos_' + tipo]; $('li-filtros').style.display = F['filtros_abertos_' + tipo] ? '' : 'none'; };
    function ler(){
      var g = function(i){ return $('li-' + i).value.trim(); };
      F['lista_' + tipo] = { pessoa_id: $('li-pessoa').value, pessoa_nome: $('li-pessoa-txt').value, conta_id: g('conta'), situacao: [].map.call(el.querySelectorAll('[data-sit]:checked'), function(x){ return x.getAttribute('data-sit'); }),
        venc_de: g('venc_de'), venc_ate: g('venc_ate'), pag_de: g('pag_de'), pag_ate: g('pag_ate'), comp_de: g('comp_de'), comp_ate: g('comp_ate'), codigo: g('codigo'), valor: g('valor'),
        descricao: g('descricao'), forma: g('forma'), conciliado: g('conciliado'), anexo: g('anexo'), nf: g('nf'), observacao: g('observacao'), classificacao_id: g('class'),
        centro_custo_id: g('cc'), unidade_id: g('un'), ordem: g('ordem'), q: g('q') };
      F['pag_' + tipo] = 0;
    }
    $('li-buscar').onclick = $('li-qok').onclick = function(){ ler(); lista(tipo)(el); };
    $('li-q').onkeydown = function(e){ if(e.key === 'Enter'){ ler(); lista(tipo)(el); } };
    $('li-limpar').onclick = function(){ F['lista_' + tipo] = null; lista(tipo)(el); };
    if($('li-novo')) $('li-novo').onclick = function(){ formLanc(tipo, null, { aoSalvar: function(){ lista(tipo)(el); } }); };
    if($('li-csv')) $('li-csv').onclick = async function(){ var b = this; b.disabled = true; try { var j = await api('lanc_exportar', Object.assign({ tipo: tipo }, F['lista_' + tipo])); baixar((tipo === 'pagar' ? 'pagamentos' : 'recebimentos') + '-' + hoje() + '.csv', j.csv, 'text/csv;charset=utf-8'); toast(j.qtd + ' linhas exportadas'); } catch(e){ toast(e.message, 'erro'); } b.disabled = false; };
    var out = $('li-out'); carregando(out);
    try {
      var j = await api('lanc_listar', Object.assign({ tipo: tipo, pagina: F['pag_' + tipo] }, f));
      if(!j.itens.length){ out.innerHTML = '<div class="fin-vazio">Nada encontrado. Use os filtros acima.</div>'; return; }
      var tot = j.itens.reduce(function(a, l){ return a + n(l.valor_final); }, 0);
      var pags = Math.ceil(j.total / j.tam);
      out.innerHTML = '<div class="fin-row" style="justify-content:space-between;margin-bottom:6px"><span class="fin-sub">' + j.total + ' lançamento(s) · nesta página ' + moeda(tot) + '</span>' +
        (pags > 1 ? '<span class="fin-row"><button class="fin-bt" id="li-ant"' + (F['pag_' + tipo] <= 0 ? ' disabled' : '') + '>‹</button><span class="fin-sub">Página ' + (F['pag_' + tipo] + 1) + ' de ' + pags + '</span><button class="fin-bt" id="li-prox"' + (F['pag_' + tipo] + 1 >= pags ? ' disabled' : '') + '>›</button></span>' : '') + '</div>' +
        '<div class="fin-card" style="padding:0;overflow-x:auto"><table class="fin-tbl"><thead><tr><th>' + (pode('conferente') ? '<input type="checkbox" id="li-all">' : '') + '</th><th>#</th><th>Pessoa</th><th>Detalhe</th><th>Unidade</th><th class="fin-num">Valor (R$)</th><th>Vencimento</th><th>' + (tipo === 'pagar' ? 'Pago' : 'Recebido') + '</th><th>Situação</th></tr></thead><tbody>' +
        j.itens.map(function(l){ return '<tr class="clic" data-id="' + l.id + '"><td>' + (l.status === 'pendente' && pode('conferente') ? '<input type="checkbox" data-sel="' + l.id + '">' : '') + '</td><td class="fin-sub">' + l.id + '</td><td><b>' + esc(l.pessoa_nome || '-') + '</b></td>' +
          '<td>' + esc(l.classificacao_nome || '') + ' <span class="fin-sub">' + esc(l.descricao || '') + '</span>' + (l.parcela_num ? ' <span class="fin-chip" style="background:var(--border)">' + l.parcela_num + '/' + l.parcela_total + '</span>' : '') + chipRec(l) + (n(l.anexos) ? ' 📎' : '') + '</td>' +
          '<td class="fin-sub">' + esc(l.unidade_nome || '') + (l.rateio && l.rateio.length ? ' (rateado)' : '') + '</td><td class="fin-num"><b>' + moeda(l.valor_final).replace('R$ ', '') + '</b></td><td>' + dataBR(l.vencimento) + '</td><td>' + dataBR(l.data_pagamento) + '</td>' +
          '<td>' + chipSit(l.situacao_calc, tipo) + (l.extrato_id ? ' <span title="Conciliado com o extrato">🔗</span>' : '') + '</td></tr>'; }).join('') + '</tbody></table></div>';
      out.querySelectorAll('tr[data-id]').forEach(function(tr){ tr.onclick = function(e){ if(e.target.type === 'checkbox') return; verLanc(Number(tr.getAttribute('data-id')), function(){ lista(tipo)(el); }); }; });
      if($('li-all')) $('li-all').onchange = function(){ var c = this.checked; out.querySelectorAll('[data-sel]').forEach(function(x){ x.checked = c; }); };
      if($('li-ant')) $('li-ant').onclick = function(){ F['pag_' + tipo]--; lista(tipo)(el); };
      if($('li-prox')) $('li-prox').onclick = function(){ F['pag_' + tipo]++; lista(tipo)(el); };
      if($('li-baixa')) $('li-baixa').onclick = function(){
        var ids = [].map.call(out.querySelectorAll('[data-sel]:checked'), function(x){ return Number(x.getAttribute('data-sel')); });
        if(!ids.length) return toast('Selecione ao menos um pendente', 'aviso');
        baixaModal(j.itens.filter(function(l){ return ids.indexOf(l.id) >= 0; }), function(){ lista(tipo)(el); });
      };
    } catch(e){ erroEm(out, e); }
  };
}
T.pagar_lista = lista('pagar');
T.receber_lista = lista('receber');

/* ================= CAIXA DE ENTRADA ================= */
T.entradas = async function(el){
  css2();
  var st = F.entradas_st = F.entradas_st || 'pendente';
  var abas = [['pendente', 'Pagamentos pendentes'], ['nao_identificado', 'Não identificados'], ['lancado', 'Lançados'], ['arquivado', 'Arquivo']];
  el.innerHTML = '<div class="fin-row" style="justify-content:space-between;margin-bottom:10px"><div class="fin-subtabs" style="margin:0">' + abas.map(function(a){ return '<div class="fin-subtab' + (st === a[0] ? ' on' : '') + '" data-st="' + a[0] + '">' + a[1] + '</div>'; }).join('') + '</div>' +
    (pode('conferente') ? '<button class="fin-bt pri" id="en-novo">+ Adicionar boleto / documento</button>' : '') + '</div><div class="fin-sub" style="margin-bottom:8px">Boleto, NF ou cobrança que chegou e ainda não virou conta a pagar. Anexe o PDF, confira e clique em "Lançar".</div><div id="en-out"></div>';
  el.querySelectorAll('[data-st]').forEach(function(t){ t.onclick = function(){ F.entradas_st = t.getAttribute('data-st'); T.entradas(el); }; });
  if($('en-novo')) $('en-novo').onclick = function(){ editarEntrada(null, function(){ T.entradas(el); }); };
  var out = $('en-out'); carregando(out);
  try {
    try { await base(); } catch(e){ toast(e.message, 'erro'); return; }
    var j = await api('entradas_listar', { status: st });
    if(!j.entradas.length){ out.innerHTML = '<div class="fin-vazio">Nada aqui.</div>'; return; }
    out.innerHTML = '<div class="fin-card" style="padding:0;overflow-x:auto"><table class="fin-tbl"><thead><tr><th>Beneficiário</th><th>Vencimento</th><th class="fin-num">Valor a pagar</th><th>Documento</th><th>Recebido</th><th></th></tr></thead><tbody>' +
      j.entradas.map(function(e){ return '<tr><td><b>' + esc(e.beneficiario || '(sem nome)') + '</b><div class="fin-sub">' + esc(e.documento || '') + '</div>' + (e.motivo_arquivo ? '<div class="fin-sub">Arquivado: ' + esc(e.motivo_arquivo) + '</div>' : '') + '</td><td>' + dataBR(e.vencimento) + '</td><td class="fin-num"><b>' + (e.valor != null ? moeda(e.valor) : '-') + '</b></td>' +
        '<td>' + e.anexos.map(function(a){ return '<a href="#" data-anexo="' + a.id + '">📄 ' + esc(a.nome) + '</a>'; }).join('<br>') + '</td><td class="fin-sub">' + esc(nome(e.por)) + '<br>' + dataHoraBR(e.em) + '</td>' +
        '<td style="white-space:nowrap">' + (e.status === 'lancado' ? (e.lancamento_id ? '<button class="fin-bt" data-ver="' + e.lancamento_id + '">Ver #' + e.lancamento_id + '</button>' : '') :
          (pode('conferente') && e.status !== 'arquivado' ? '<button class="fin-bt ok" data-lancar="' + e.id + '">Lançar</button> <button class="fin-bt" data-ed="' + e.id + '">Editar</button>' : '')) + '</td></tr>'; }).join('') + '</tbody></table></div>';
    out.querySelectorAll('[data-anexo]').forEach(function(a){ a.onclick = function(ev){ ev.preventDefault(); abrirAnexo(a.getAttribute('data-anexo')); }; });
    out.querySelectorAll('[data-ver]').forEach(function(b){ b.onclick = function(){ verLanc(Number(b.getAttribute('data-ver'))); }; });
    out.querySelectorAll('[data-ed]').forEach(function(b){ b.onclick = function(){ editarEntrada(j.entradas.filter(function(x){ return x.id === Number(b.getAttribute('data-ed')); })[0], function(){ T.entradas(el); }); }; });
    out.querySelectorAll('[data-lancar]').forEach(function(b){ b.onclick = function(){
      var e = j.entradas.filter(function(x){ return x.id === Number(b.getAttribute('data-lancar')); })[0];
      formLanc('pagar', { forma: 'boleto', valor: e.valor, vencimento: e.vencimento, codigo_barras: e.linha_digitavel, descricao: e.beneficiario, observacao: e.observacao },
        { entrada_id: e.id, aoSalvar: function(){ T.entradas(el); } });
    }; });
  } catch(e){ erroEm(out, e); }
};
function editarEntrada(e, aoSalvar){
  e = e || {};
  var m = modal('<div style="font-weight:800;font-size:15px;margin-bottom:10px">' + (e.id ? 'Editar documento' : 'Novo documento na caixa de entrada') + '</div>' +
    '<div class="fin-grid2"><div><div class="fin-lbl">Beneficiário</div><input class="fin-in" id="ee-b" value="' + esc(e.beneficiario || '') + '"></div><div><div class="fin-lbl">CPF/CNPJ</div><input class="fin-in" id="ee-d" value="' + esc(e.documento || '') + '"></div>' +
    '<div><div class="fin-lbl">Vencimento</div><input type="date" class="fin-in" id="ee-v" value="' + esc(e.vencimento || '') + '"></div><div><div class="fin-lbl">Valor</div><input class="fin-in fin-num" id="ee-val" value="' + fmtIn(e.valor) + '"></div></div>' +
    '<div style="margin-top:8px"><div class="fin-lbl">Linha digitável</div><input class="fin-in" id="ee-l" value="' + esc(e.linha_digitavel || '') + '"></div>' +
    '<div style="margin-top:8px"><div class="fin-lbl">Observação</div><input class="fin-in" id="ee-o" value="' + esc(e.observacao || '') + '"></div>' +
    (!e.id ? '<div style="margin-top:8px"><div class="fin-lbl">Arquivo (PDF/imagem)</div><input type="file" class="fin-in" id="ee-f" accept="application/pdf,image/png,image/jpeg,image/webp"></div>' : '') +
    (e.id ? '<div style="margin-top:8px"><div class="fin-lbl">Mover para</div><select class="fin-in" id="ee-st"><option value="">(manter)</option><option value="pendente">Pendentes</option><option value="nao_identificado">Não identificados</option><option value="arquivado">Arquivo (não vai ser pago)</option></select><input class="fin-in" id="ee-mot" placeholder="Motivo do arquivamento" style="margin-top:4px"></div>' : '') +
    '<div id="ee-msg"></div><div class="fin-row" style="justify-content:flex-end;margin-top:12px"><button class="fin-bt" id="ee-x">Cancelar</button><button class="fin-bt pri" id="ee-ok">Salvar</button></div>');
  $('ee-x').onclick = m.fechar;
  $('ee-ok').onclick = async function(){
    var b = this; b.disabled = true;
    try {
      var r = await api('entrada_salvar', { id: e.id || null, beneficiario: $('ee-b').value, documento: $('ee-d').value, vencimento: $('ee-v').value, valor: $('ee-val').value ? parseBR($('ee-val').value) : '',
        linha_digitavel: $('ee-l').value, observacao: $('ee-o').value, status: $('ee-st') ? $('ee-st').value : '', motivo_arquivo: $('ee-mot') ? $('ee-mot').value : '' });
      var f = $('ee-f') && $('ee-f').files;
      if(f && f.length && r.id) await enviarAnexos(f, { entrada_id: r.id });
      toast('Salvo'); m.fechar(); aoSalvar && aoSalvar();
    } catch(x){ $('ee-msg').innerHTML = '<div class="fin-erro">' + esc(x.message) + '</div>'; b.disabled = false; }
  };
}

/* ================= RECEBER: CENTRAL (dashboard de cobranças) ================= */
T.receber_dash = async function(el){
  css2(); carregando(el);
  try {
    try { await base(); } catch(e){ toast(e.message, 'erro'); return; }
    var un = F.receber_un || '';
    var d = (await api('receber_dash', { unidade_id: un })).dash;
    var varMes = n(d.venc_mes_ant) ? Math.round((n(d.venc_mes) / n(d.venc_mes_ant) - 1) * 100) : null;
    var h = '<div class="fin-row" style="justify-content:space-between;margin-bottom:10px"><select class="fin-in" id="rd-un" style="max-width:260px">' + optsLista(F.base.unidades, un, 'Todas as unidades') + '</select>' + (pode('conferente') ? '<button class="fin-bt ok" id="rd-novo">+ Novo recebimento</button>' : '') + '</div>';
    h += '<div class="fin-kpis">' + kpi('Vencimentos no mês', moeda(d.venc_mes), '', varMes == null ? '' : (varMes >= 0 ? '▲ ' : '▼ ') + Math.abs(varMes) + '% em relação ao mês anterior') +
      kpi('Inadimplência atual', moeda(d.inadimplencia), n(d.inadimplencia) ? '#C0392B' : '#1D9E75', d.qtd_inadimplentes + ' cliente(s) com atraso') + '</div>';
    h += '<div class="fin-grid2"><div class="fin-card"><b style="font-size:13px">Últimos recebimentos</b>' + tabelaMini(d.ultimos_recebidos, true) + '</div><div class="fin-card"><b style="font-size:13px">Últimos em atraso</b>' + tabelaMini(d.ultimos_atrasados, false) + '</div></div>';
    h += '<div class="fin-grid2" style="margin-top:10px"><div class="fin-card"><b style="font-size:13px">Últimos 6 meses</b><div class="fin-sub">Emitido x recebido (por vencimento)</div>' + barras6(d.meses) + '</div>' +
      '<div class="fin-card" style="overflow-x:auto"><b style="font-size:13px">Atrasos por cliente (dias em atraso)</b><table class="fin-tbl" style="margin-top:6px"><thead><tr><th>Pessoa</th><th class="fin-num">1-30</th><th class="fin-num">31-60</th><th class="fin-num">61-90</th><th class="fin-num">&gt;90</th><th class="fin-num">%</th><th class="fin-num">% acum.</th></tr></thead><tbody>';
    var acum = 0;
    h += d.aging.map(function(a){ var p = n(d.inadimplencia) ? n(a.total) / n(d.inadimplencia) * 100 : 0; acum += p; return '<tr><td>' + esc(a.pessoa) + '</td><td class="fin-num">' + (a.d30 ? moedaCurta(a.d30) : '-') + '</td><td class="fin-num">' + (a.d60 ? moedaCurta(a.d60) : '-') + '</td><td class="fin-num">' + (a.d90 ? moedaCurta(a.d90) : '-') + '</td><td class="fin-num">' + (a.d90mais ? moedaCurta(a.d90mais) : '-') + '</td><td class="fin-num">' + p.toFixed(0) + '%</td><td class="fin-num">' + acum.toFixed(0) + '%</td></tr>'; }).join('') || '<tr><td colspan="7" class="fin-vazio">Ninguém em atraso 🎉</td></tr>';
    h += '</tbody></table></div></div>';
    el.innerHTML = h;
    $('rd-un').onchange = function(){ F.receber_un = this.value; T.receber_dash(el); };
    if($('rd-novo')) $('rd-novo').onclick = function(){ formLanc('receber', null, { aoSalvar: function(){ T.receber_dash(el); } }); };
    el.querySelectorAll('[data-lanc]').forEach(function(tr){ tr.onclick = function(){ verLanc(Number(tr.getAttribute('data-lanc')), function(){ T.receber_dash(el); }); }; });
  } catch(e){ erroEm(el, e); }
};
function tabelaMini(lista, pago){
  if(!lista.length) return '<div class="fin-vazio">Nada.</div>';
  return '<table class="fin-tbl" style="margin-top:6px"><thead><tr><th>Pessoa</th><th>Classificação</th><th class="fin-num">Valor</th><th>' + (pago ? 'Recebido em' : 'Vencimento') + '</th></tr></thead><tbody>' +
    lista.map(function(l){ return '<tr class="clic" data-lanc="' + l.id + '"><td>' + esc(l.pessoa_nome || '-') + '</td><td class="fin-sub">' + esc(l.classificacao_nome || '') + '</td><td class="fin-num">' + moeda(l.valor_final) + '</td><td>' + dataBR(pago ? l.data_pagamento : l.vencimento) + '</td></tr>'; }).join('') + '</tbody></table>';
}
function barras6(meses){
  if(!meses.length) return '<div class="fin-vazio">Sem dados.</div>';
  var max = Math.max.apply(null, meses.map(function(x){ return n(x.emitido); }).concat([1]));
  return '<div style="display:flex;gap:10px;align-items:flex-end;height:170px;margin-top:10px">' + meses.map(function(x){
    var mm = x.mes.split('-');
    return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;height:100%;justify-content:flex-end"><div class="fin-sub" style="font-size:10px">' + moedaCurta(x.recebido) + '</div>' +
      '<div style="display:flex;gap:3px;align-items:flex-end;width:80%;justify-content:center"><div title="Emitido ' + moeda(x.emitido) + '" style="width:45%;background:#9DB4D6;height:' + (n(x.emitido) / max * 120) + 'px;border-radius:3px 3px 0 0"></div><div title="Recebido ' + moeda(x.recebido) + '" style="width:45%;background:#1D9E75;height:' + (n(x.recebido) / max * 120) + 'px;border-radius:3px 3px 0 0"></div></div>' +
      '<div class="fin-sub" style="font-size:10px">' + MESES[Number(mm[1]) - 1] + '</div></div>';
  }).join('') + '</div><div class="fin-sub"><span style="color:#9DB4D6">■</span> emitido <span style="color:#1D9E75">■</span> recebido</div>';
}

/* ================= CONTAS E SALDOS + TRANSFERÊNCIAS ================= */
T.contas_saldos = async function(el){
  css2(); carregando(el);
  try {
    await base(true);
    var [p, tr] = await Promise.all([api('painel'), api('transf_listar', { ini: addDias(hoje(), -90) })]);
    var cn = {}; F.base.contas.forEach(function(c){ cn[c.id] = c.nome; });
    var saldos = p.painel.saldos, tot = saldos.reduce(function(a, s){ return a + n(s.saldo); }, 0);
    el.innerHTML = '<div class="fin-row" style="justify-content:flex-end;margin-bottom:10px">' + (pode('conferente') ? '<button class="fin-bt pri" id="cs-tr">⇄ Nova transferência</button>' : '') + '<button class="fin-bt" id="cs-conc">Abrir conciliação</button></div>' +
      '<div class="fin-grid2"><div class="fin-card"><b style="font-size:13px">Contas</b><table class="fin-tbl" style="margin-top:6px"><thead><tr><th>Conta</th><th class="fin-num">Saldo (R$)</th><th></th></tr></thead><tbody>' +
      saldos.map(function(s){ return '<tr><td>' + esc(s.nome) + '</td><td class="fin-num" style="font-weight:700' + (n(s.saldo) < 0 ? ';color:#E24B4A' : '') + '">' + moeda(s.saldo).replace('R$ ', '') + '</td><td class="fin-sub">' + (s.origem === 'extrato' ? 'extrato ' + dataBR(s.saldo_data) : 'sistema') + '</td></tr>'; }).join('') +
      '<tr><td><b>Saldo total (' + saldos.length + ' contas)</b></td><td class="fin-num"><b>' + moeda(tot).replace('R$ ', '') + '</b></td><td></td></tr></tbody></table>' +
      '<div class="fin-sub" style="margin-top:6px">Com extrato importado, vale o saldo que o banco informou. Sem extrato, o sistema calcula: saldo inicial + baixas + transferências.</div></div>' +
      '<div class="fin-card"><b style="font-size:13px">Transferências entre contas (90 dias)</b>' + (tr.transferencias.length ? '<table class="fin-tbl" style="margin-top:6px"><tbody>' + tr.transferencias.map(function(t){ return '<tr' + (t.cancelada ? ' style="opacity:.5;text-decoration:line-through"' : '') + '><td>' + dataBR(t.data) + '</td><td>' + esc(cn[t.conta_origem_id] || '') + ' → ' + esc(cn[t.conta_destino_id] || '') + '<div class="fin-sub">' + esc(t.descricao || '') + ' · ' + esc(nome(t.por)) + '</div></td><td class="fin-num">' + moeda(t.valor) + '</td><td>' + (!t.cancelada && pode('gestor') ? '<button class="fin-bt" data-ctr="' + t.id + '">Cancelar</button>' : '') + '</td></tr>'; }).join('') + '</tbody></table>' : '<div class="fin-vazio">Nenhuma.</div>') + '</div></div>';
    if($('cs-tr')) $('cs-tr').onclick = function(){ novaTransf(function(){ T.contas_saldos(el); }); };
    $('cs-conc').onclick = function(){ U.irPara('conciliacao'); };
    el.querySelectorAll('[data-ctr]').forEach(function(b){ b.onclick = async function(){ var mo = await U.pedirTexto({ titulo: 'Cancelar a transferência', min: 10 }); if(!mo) return; try { await api('transf_cancelar', { id: Number(b.getAttribute('data-ctr')), motivo: mo }); toast('Cancelada'); T.contas_saldos(el); } catch(e){ toast(e.message, 'erro'); } }; });
  } catch(e){ erroEm(el, e); }
};
function novaTransf(aoSalvar, pre){
  pre = pre || {};
  var m = modal('<div style="font-weight:800;font-size:15px;margin-bottom:10px">Nova transferência entre contas</div><div class="fin-grid2"><div><div class="fin-lbl">De (origem)</div><select class="fin-in" id="nt-o">' + optsContas(pre.origem) + '</select></div><div><div class="fin-lbl">Para (destino)</div><select class="fin-in" id="nt-d">' + optsContas(pre.destino) + '</select></div>' +
    '<div><div class="fin-lbl">Data</div><input type="date" class="fin-in" id="nt-dt" value="' + (pre.data || hoje()) + '"></div><div><div class="fin-lbl">Valor</div><input class="fin-in fin-num" id="nt-v" value="' + fmtIn(pre.valor) + '"></div></div>' +
    '<div style="margin-top:8px"><div class="fin-lbl">Descrição</div><input class="fin-in" id="nt-ds" value="' + esc(pre.descricao || '') + '"></div><div id="nt-msg"></div><div class="fin-row" style="justify-content:flex-end;margin-top:12px"><button class="fin-bt" id="nt-x">Cancelar</button><button class="fin-bt pri" id="nt-ok">Salvar</button></div>');
  $('nt-x').onclick = m.fechar;
  $('nt-ok').onclick = async function(){ var b = this; b.disabled = true;
    try { var r = await api('transf_criar', { conta_origem_id: $('nt-o').value, conta_destino_id: $('nt-d').value, data: $('nt-dt').value, valor: parseBR($('nt-v').value), descricao: $('nt-ds').value }); toast('Transferência registrada'); m.fechar(); aoSalvar && aoSalvar(r); }
    catch(e){ $('nt-msg').innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; b.disabled = false; } };
}

/* ================= CONCILIAÇÃO (banco x lançamentos) ================= */
T.conciliacao = async function(el){
  css2();
  try { await base(); } catch(e){ return erroEm(el, e); }
  var f = F.conc = F.conc || { conta_id: '', ini: addDias(hoje(), -7), fim: hoje(), mostrar: false };
  el.innerHTML = '<div class="fin-filtros"><select id="cc-conta">' + optsContas(f.conta_id, 'Escolha a conta do extrato...') + '</select><input type="date" id="cc-ini" value="' + f.ini + '"><input type="date" id="cc-fim" value="' + f.fim + '"><button class="fin-bt pri" id="cc-ok">Abrir</button>' +
    '<label class="fin-sub" style="display:flex;gap:4px;align-items:center"><input type="checkbox" id="cc-mostrar"' + (f.mostrar ? ' checked' : '') + '>Exibir conciliados</label><div style="flex:1"></div>' +
    (pode('conferente') ? '<button class="fin-bt" id="cc-auto" title="Casa sozinho quando só existe UM lançamento com o mesmo valor e data próxima">⚡ Conciliar automático</button>' : '') + '</div><div id="cc-out"><div class="fin-vazio">Escolha a conta e o período. As linhas vêm do extrato importado (Contas › Importar).</div></div>';
  var abrir = function(){ f.conta_id = $('cc-conta').value; f.ini = $('cc-ini').value; f.fim = $('cc-fim').value; f.mostrar = $('cc-mostrar').checked; T.conciliacao(el); };
  $('cc-ok').onclick = abrir; $('cc-mostrar').onchange = abrir;
  if($('cc-auto')) $('cc-auto').onclick = async function(){ var b = this; b.disabled = true; try { var r = await api('conciliar_auto'); toast(r.conciliadas + ' linha(s) conciliada(s) automaticamente'); T.conciliacao(el); } catch(e){ toast(e.message, 'erro'); b.disabled = false; } };
  if(!f.conta_id) return;
  var out = $('cc-out'); carregando(out);
  try {
    var j = await api('conciliacao', f), c = j.cards;
    var h = '<div class="fin-g4" style="margin-bottom:12px">' + kpi('Extrato: créditos', moeda(c.cred), '', c.nCred + ' lançamento(s)') + kpi('Extrato: débitos', moeda(c.deb), '', c.nDeb + ' lançamento(s)') +
      kpi('Créditos sem conciliação', moeda(c.credSem), c.nCredSem ? '#C0392B' : '#1D9E75', c.nCredSem + ' lançamento(s)') + kpi('Débitos sem conciliação', moeda(c.debSem), c.nDebSem ? '#C0392B' : '#1D9E75', c.nDebSem + ' lançamento(s)') + '</div>';
    h += '<div class="fin-conc" style="font-weight:700;font-size:13px"><div>Lançamentos do banco</div><div>Lançamentos no sistema</div></div>';
    var linhas = j.linhas.filter(function(l){ return f.mostrar || !l.conc; });
    if(!linhas.length) h += '<div class="fin-vazio">' + (j.linhas.length ? 'Tudo conciliado neste período 🎉' : 'Sem extrato importado nesse período para esta conta.') + '</div>';
    h += linhas.map(function(l){
      var dir;
      if(l.conc && l.conc.lanc){ var L = l.conc.lanc; dir = '<div class="fin-card ok"><div class="fin-row" style="justify-content:space-between"><b>' + moeda(L.valor_final) + '</b><span class="fin-sub">' + (l.conc.metodo === 'auto' ? '⚡ automático' : 'manual') + ' · ' + esc(nome(l.conc.por)) + '</span></div><div style="font-size:12px;margin-top:4px">' + esc(L.classificacao_nome || '') + ' · <a href="#" data-verl="' + L.id + '">' + esc(L.pessoa_nome || '-') + ' #' + L.id + '</a></div><div class="fin-sub">' + esc(L.descricao || '') + '</div>' + (pode('gestor') ? '<button class="fin-bt" style="margin-top:6px" data-desf="' + l.id + '">↺ Desfazer</button>' : '') + '</div>'; }
      else if(l.conc && l.conc.transf){ var t = l.conc.transf; dir = '<div class="fin-card ok"><b>⇄ Transferência ' + moeda(t.valor) + '</b><div class="fin-sub">' + dataBR(t.data) + ' · ' + esc(t.descricao || '') + '</div>' + (pode('gestor') ? '<button class="fin-bt" style="margin-top:6px" data-desf="' + l.id + '">↺ Desfazer</button>' : '') + '</div>'; }
      else dir = '<div class="fin-card"><div class="fin-row">' + (pode('conferente') ? '<button class="fin-bt" data-busca="' + l.id + '" title="Buscar lançamento existente">🔍 Buscar</button><button class="fin-bt ok" data-criar="' + l.id + '" title="Criar lançamento a partir desta linha">+ Criar lançamento</button>' : '<span class="fin-sub">Sem conciliação</span>') + '</div><div id="cc-painel-' + l.id + '"></div></div>';
      return '<div class="fin-conc"><div class="fin-card"><div class="fin-row" style="justify-content:space-between"><b>' + diaSemana(l.data).slice(0, 3) + ', ' + dataBR(l.data).slice(0, 5) + '</b><b class="' + (n(l.valor) > 0 ? 'fin-ent' : 'fin-sai') + '">' + moeda(l.valor) + '</b></div><div class="fin-sub" style="margin-top:6px">' + esc(l.descricao) + '</div>' + (l.status && l.status !== 'pendente' ? '<div style="margin-top:4px">' + U.chipStatus(l.status) + '</div>' : '') + '</div>' + dir + '</div>';
    }).join('');
    out.innerHTML = h;
    var recarregar = function(){ T.conciliacao(el); };
    out.querySelectorAll('[data-verl]').forEach(function(a){ a.onclick = function(e){ e.preventDefault(); verLanc(Number(a.getAttribute('data-verl')), recarregar); }; });
    out.querySelectorAll('[data-desf]').forEach(function(b){ b.onclick = async function(){ var mo = await U.pedirTexto({ titulo: 'Desfazer a conciliação', ajuda: 'Se a baixa veio daqui, ela é estornada junto.', min: 10 }); if(!mo) return; try { await api('desfazer_conciliacao', { extrato_id: Number(b.getAttribute('data-desf')), motivo: mo }); toast('Desfeito'); recarregar(); } catch(e){ toast(e.message, 'erro'); } }; });
    out.querySelectorAll('[data-busca]').forEach(function(b){ b.onclick = function(){ painelBusca(Number(b.getAttribute('data-busca')), 7, '', recarregar); }; });
    out.querySelectorAll('[data-criar]').forEach(function(b){ b.onclick = function(){ criarDaLinha(j.linhas.filter(function(x){ return x.id === Number(b.getAttribute('data-criar')); })[0], recarregar); }; });
  } catch(e){ erroEm(out, e); }
};
async function painelBusca(id, dias, q, recarregar){
  var p = $('cc-painel-' + id); if(!p) return;
  p.innerHTML = '<div class="fin-vazio" style="padding:10px">Buscando...</div>';
  try {
    var j = await api('candidatos', { extrato_id: id, dias: dias, q: q });
    var h = '<div class="fin-row" style="margin-top:8px"><input class="fin-in" id="cb-q-' + id + '" placeholder="Filtro: nome, descrição ou valor" value="' + esc(q) + '" style="flex:1"><select class="fin-in" id="cb-d-' + id + '" style="width:120px">' + [3, 7, 15, 30, 60].map(function(d){ return '<option value="' + d + '"' + (d === dias ? ' selected' : '') + '>± ' + d + ' dias</option>'; }).join('') + '</select></div>';
    if(j.regra) h += '<div class="fin-aviso">Regra "' + esc(j.regra.descricao) + '" sugere criar o lançamento com a classificação dela. Use "+ Criar lançamento".</div>';
    h += j.transferencias.map(function(t){ return '<div class="fin-row" style="justify-content:space-between;font-size:12px;border-bottom:1px solid var(--border);padding:6px 0"><span>⇄ Transferência ' + dataBR(t.data) + ' ' + moeda(t.valor) + ' <span class="fin-sub">' + esc(t.descricao || '') + '</span></span><button class="fin-bt ok" data-vt="' + t.id + '">Vincular</button></div>'; }).join('');
    h += j.lancamentos.length ? '<table class="fin-tbl" style="margin-top:6px"><thead><tr><th>Data</th><th>Classificação</th><th class="fin-num">Valor</th><th></th></tr></thead><tbody>' + j.lancamentos.map(function(l){ return '<tr><td>' + dataBR(l.vencimento) + '</td><td>' + esc(l.classificacao_nome || '') + '<div class="fin-sub">' + esc(l.pessoa_nome || '') + ' · ' + esc(l.descricao || '') + '</div></td><td class="fin-num"' + (l.valor_igual ? ' style="color:#1D9E75;font-weight:800"' : '') + '>' + moeda(l.valor_final) + '</td><td><button class="fin-bt ok" data-vl="' + l.id + '">Vincular</button></td></tr>'; }).join('') + '</tbody></table>'
      : '<div class="fin-sub" style="margin-top:6px">Nenhum lançamento em aberto nessa janela. Aumente os dias ou crie o lançamento.</div>';
    p.innerHTML = h;
    var qi = $('cb-q-' + id), di = $('cb-d-' + id);
    qi.onkeydown = function(e){ if(e.key === 'Enter') painelBusca(id, Number(di.value), qi.value.trim(), recarregar); };
    di.onchange = function(){ painelBusca(id, Number(di.value), qi.value.trim(), recarregar); };
    p.querySelectorAll('[data-vl]').forEach(function(b){ b.onclick = async function(){ b.disabled = true; try { await api('conciliar_manual', { extrato_id: id, lancamento_id: Number(b.getAttribute('data-vl')) }); toast('Conciliado (e baixa registrada)'); recarregar(); } catch(e){ toast(e.message, 'erro'); b.disabled = false; } }; });
    p.querySelectorAll('[data-vt]').forEach(function(b){ b.onclick = async function(){ b.disabled = true; try { await api('conciliar_transf', { extrato_id: id, transferencia_id: Number(b.getAttribute('data-vt')) }); toast('Transferência conciliada'); recarregar(); } catch(e){ toast(e.message, 'erro'); b.disabled = false; } }; });
  } catch(e){ p.innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; }
}
async function criarDaLinha(l, recarregar){
  var sug = null; try { sug = (await api('candidatos', { extrato_id: l.id, dias: 0 })).regra; } catch(e){}
  var tipo = n(l.valor) < 0 ? 'pagar' : 'receber';
  var m = modal('<div style="font-weight:800;font-size:15px">Criar lançamento a partir do extrato</div><div class="fin-sub" style="margin:4px 0 10px">' + dataBR(l.data) + ' · ' + esc(l.descricao) + ' · <b>' + moeda(l.valor) + '</b>. Nasce ' + (tipo === 'pagar' ? 'pago' : 'recebido') + ' e conciliado com esta linha.</div>' +
    (sug ? '<div class="fin-aviso">Preenchido pela regra "' + esc(sug.descricao) + '".</div>' : '') +
    '<div class="fin-grid2"><div><div class="fin-lbl">Pessoa</div>' + campoPessoa('cl-pessoa', null, tipo) + '</div><div><div class="fin-lbl">Classificação *</div><select class="fin-in" id="cl-class">' + optsClass(sug && sug.classificacao_id, tipo) + '</select></div>' +
    '<div><div class="fin-lbl">Centro de custo</div><select class="fin-in" id="cl-cc">' + optsLista(F.base.centros, (sug && sug.centro_custo_id) || (F.base.centros[0] && F.base.centros[0].id)) + '</select></div><div><div class="fin-lbl">Unidade de negócio</div><select class="fin-in" id="cl-un">' + optsLista(F.base.unidades, sug && sug.unidade_id) + '</select></div></div>' +
    '<div style="margin-top:8px"><div class="fin-lbl">Descrição</div><input class="fin-in" id="cl-desc" value="' + esc(l.contraparte || l.descricao) + '"></div>' +
    (sug && sug.transferencia_conta_id ? '<div class="fin-aviso">Esta regra marca como TRANSFERÊNCIA. <button class="fin-bt" id="cl-tr">Registrar como transferência</button></div>' : '<div class="fin-sub" style="margin-top:6px">É transferência entre contas da Gâmi? <a href="#" id="cl-tr">Registrar como transferência</a></div>') +
    '<div id="cl-msg"></div><div class="fin-row" style="justify-content:flex-end;margin-top:12px"><button class="fin-bt" id="cl-x">Cancelar</button><button class="fin-bt ok" id="cl-ok">Criar e conciliar</button></div>');
  ligarPessoa('cl-pessoa', tipo);
  if(sug && sug.pessoa_id){ $('cl-pessoa').value = sug.pessoa_id; api('pessoa_ver', { id: sug.pessoa_id }).then(function(j){ $('cl-pessoa-txt').value = j.pessoa.nome; }).catch(function(){}); }
  $('cl-x').onclick = m.fechar;
  $('cl-tr').onclick = function(e){ e.preventDefault(); m.fechar();
    var pre = n(l.valor) < 0 ? { origem: F.conc.conta_id, destino: sug && sug.transferencia_conta_id } : { origem: sug && sug.transferencia_conta_id, destino: F.conc.conta_id };
    novaTransf(async function(r){ try { await api('conciliar_transf', { extrato_id: l.id, transferencia_id: r.id }); toast('Transferência criada e conciliada'); } catch(x){ toast(x.message, 'erro'); } recarregar(); },
      Object.assign(pre, { data: l.data, valor: Math.abs(n(l.valor)), descricao: l.descricao }));
  };
  $('cl-ok').onclick = async function(){ var b = this;
    if(!$('cl-class').value){ $('cl-msg').innerHTML = '<div class="fin-erro">Escolha a classificação.</div>'; return; }
    b.disabled = true;
    try { await api('lancar_da_linha', { extrato_id: l.id, pessoa_id: $('cl-pessoa').value, classificacao_id: $('cl-class').value, centro_custo_id: $('cl-cc').value, unidade_id: $('cl-un').value, descricao: $('cl-desc').value }); toast('Lançamento criado e conciliado'); m.fechar(); recarregar(); }
    catch(e){ $('cl-msg').innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; b.disabled = false; } };
}

/* ================= RELATÓRIOS ================= */
function filtrosRel(id, f, extra){
  return '<div class="fin-filtros">' + (extra || '') + '<select id="' + id + '-un">' + optsLista(F.base.unidades, f.unidade_id, 'Todas as unidades') + '</select><select id="' + id + '-cc">' + optsLista(F.base.centros, f.centro_custo_id, 'Todos os centros') + '</select><button class="fin-bt pri" id="' + id + '-ok">Aplicar</button><div style="flex:1"></div><button class="fin-bt" id="' + id + '-csv">⬇️ Exportar</button></div>';
}
function anosOpts(sel){ var a = new Date().getFullYear(), h = ''; for(var y = a + 1; y >= a - 5; y--) h += '<option' + (y === sel ? ' selected' : '') + '>' + y + '</option>'; return h; }
var DRE_LINHAS = [
  ['receita_bruta', 'Receita bruta', 1], ['retencoes', '(-) Retenções', -1], ['impostos_venda', '(-) Impostos sobre a venda', -1], ['descontos', 'Descontos e acréscimos', 1],
  ['outras_receitas', '(+) Outras receitas', 1], ['=receita_liquida', '(=) Receita líquida'], ['despesas_comerciais', '(-) Despesas comerciais', -1], ['despesas_operacionais', '(-) Despesas operacionais', -1],
  ['=ebitda', '(=) EBITDA'], ['impostos_renda', '(-) Impostos sobre a renda', -1], ['aportes', '(+) Aportes', 1], ['retiradas', '(-) Retiradas', -1], ['=resultado', '(=) Resultado líquido']
];
T.rel_dre = async function(el){
  css2(); carregando(el);
  try { await base(); } catch(e){ return erroEm(el, e); }
  var f = F.dre = F.dre || { ano: new Date().getFullYear(), regime: 'competencia', unidade_id: '', centro_custo_id: '' };
  el.innerHTML = filtrosRel('dr', f, '<select id="dr-ano">' + anosOpts(f.ano) + '</select><select id="dr-reg"><option value="competencia">Regime: competência</option><option value="caixa"' + (f.regime === 'caixa' ? ' selected' : '') + '>Regime: caixa</option></select>') + '<div id="dr-out"></div>';
  $('dr-ok').onclick = function(){ f.ano = Number($('dr-ano').value); f.regime = $('dr-reg').value; f.unidade_id = $('dr-un').value; f.centro_custo_id = $('dr-cc').value; T.rel_dre(el); };
  var out = $('dr-out'); carregando(out);
  try {
    var j = await api('rel_dre', f);
    var M = {}; // M[linha][sub][class][mes]
    j.linhas.forEach(function(r){ var a = M[r.dre_linha] = M[r.dre_linha] || {}, s = a[r.subgrupo || ''] = a[r.subgrupo || ''] || {}, c = s[r.classificacao] = s[r.classificacao] || {}; c[r.mes] = (c[r.mes] || 0) + n(r.valor); });
    var tot = {}; // tot[linha][mes]
    Object.keys(M).forEach(function(L){ tot[L] = {}; Object.keys(M[L]).forEach(function(s){ Object.keys(M[L][s]).forEach(function(c){ Object.keys(M[L][s][c]).forEach(function(m){ tot[L][m] = (tot[L][m] || 0) + M[L][s][c][m]; }); }); }); });
    var soma = function(lista, m){ return lista.reduce(function(a, L){ return a + ((tot[L] || {})[m] || 0); }, 0); };
    var calc = {
      '=receita_liquida': function(m){ return soma(['receita_bruta', 'retencoes', 'impostos_venda', 'descontos', 'outras_receitas'], m); },
      '=ebitda': function(m){ return soma(['receita_bruta', 'retencoes', 'impostos_venda', 'descontos', 'outras_receitas', 'despesas_comerciais', 'despesas_operacionais'], m); },
      '=resultado': function(m){ return soma(['receita_bruta', 'retencoes', 'impostos_venda', 'descontos', 'outras_receitas', 'despesas_comerciais', 'despesas_operacionais', 'impostos_renda', 'aportes', 'retiradas'], m); }
    };
    var meses = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    var cel = function(v){ return '<td class="fin-num"' + (v < 0 ? ' style="color:#C0392B"' : '') + '>' + (Math.abs(v) < 0.005 ? '0' : moedaCurta(v)) + '</td>'; };
    F.dreAbertos = F.dreAbertos || {};
    var csv = [['Linha'].concat(meses.map(function(m){ return MESES[m - 1]; }), ['Total']).join(';')];
    var h = '<div class="fin-card" style="padding:0;overflow-x:auto"><table class="fin-tbl fin-dre"><thead><tr><th>' + (f.regime === 'caixa' ? 'Regime de caixa' : 'Regime de competência') + ' · ' + f.ano + '</th>' + meses.map(function(m){ return '<th class="fin-num">' + MESES[m - 1] + '</th>'; }).join('') + '<th class="fin-num">Total</th></tr></thead><tbody>';
    DRE_LINHAS.forEach(function(d){
      var L = d[0], ehTot = L[0] === '=';
      var vals = meses.map(function(m){ return ehTot ? calc[L](m) : ((tot[L] || {})[m] || 0); }), t = vals.reduce(function(a, v){ return a + v; }, 0);
      var tem = !ehTot && M[L];
      h += '<tr class="' + (ehTot ? 'tot' : (tem ? 'exp' : '')) + '" data-l="' + L + '"><td>' + (tem ? (F.dreAbertos[L] ? '▾ ' : '▸ ') : '') + (ehTot ? '<b>' + d[1] + '</b>' : d[1]) + '</td>' + vals.map(cel).join('') + cel(t).replace('<td', '<td style="font-weight:800"') + '</tr>';
      csv.push([d[1]].concat(vals.map(function(v){ return v.toFixed(2).replace('.', ','); }), [t.toFixed(2).replace('.', ',')]).join(';'));
      if(tem && F.dreAbertos[L]) Object.keys(M[L]).sort().forEach(function(s){
        if(s) { var sv = meses.map(function(m){ var x = 0; Object.keys(M[L][s]).forEach(function(c){ x += M[L][s][c][m] || 0; }); return x; }); h += '<tr class="sub"><td>' + esc(s) + '</td>' + sv.map(cel).join('') + cel(sv.reduce(function(a, v){ return a + v; }, 0)) + '</tr>'; }
        Object.keys(M[L][s]).sort().forEach(function(c){ var cv = meses.map(function(m){ return M[L][s][c][m] || 0; }); h += '<tr class="' + (s ? 'cls' : 'sub') + '"><td>' + esc(c) + '</td>' + cv.map(cel).join('') + cel(cv.reduce(function(a, v){ return a + v; }, 0)) + '</tr>'; csv.push(['   ' + c].concat(cv.map(function(v){ return v.toFixed(2).replace('.', ','); })).join(';')); });
      });
    });
    h += '</tbody></table></div><div class="fin-sub" style="margin-top:6px">Clique nas linhas com ▸ para abrir as classificações. Valores com rateio por unidade aplicado. Transferências entre contas ficam fora do DRE.</div>';
    out.innerHTML = h;
    out.querySelectorAll('tr.exp').forEach(function(tr){ tr.onclick = function(){ var L = tr.getAttribute('data-l'); F.dreAbertos[L] = !F.dreAbertos[L]; T.rel_dre(el); }; });
    $('dr-csv').onclick = function(){ baixar('dre-' + f.ano + '-' + f.regime + '.csv', '﻿' + csv.join('\r\n'), 'text/csv;charset=utf-8'); };
  } catch(e){ erroEm(out, e); }
};

T.rel_fluxo_diario = async function(el){
  css2(); carregando(el);
  try { await base(); } catch(e){ return erroEm(el, e); }
  var f = F.fd = F.fd || { modo: 'projetado', dias: 30, unidade_id: '' };
  var ini = f.modo === 'projetado' ? hoje() : addDias(hoje(), -f.dias), fim = f.modo === 'projetado' ? addDias(hoje(), f.dias) : hoje();
  el.innerHTML = '<div class="fin-filtros"><div class="fin-subtabs" style="margin:0"><div class="fin-subtab' + (f.modo === 'projetado' ? ' on' : '') + '" data-m="projetado">Projetado</div><div class="fin-subtab' + (f.modo === 'realizado' ? ' on' : '') + '" data-m="realizado">Realizado</div></div>' +
    '<select id="fd-un">' + optsLista(F.base.unidades, f.unidade_id, 'Todas as unidades') + '</select><select id="fd-dias">' + [7, 15, 30, 60, 90].map(function(d){ return '<option value="' + d + '"' + (d === f.dias ? ' selected' : '') + '>' + d + ' dias</option>'; }).join('') + '</select><button class="fin-bt pri" id="fd-ok">Aplicar</button></div><div id="fd-out"></div>';
  el.querySelectorAll('[data-m]').forEach(function(t){ t.onclick = function(){ f.modo = t.getAttribute('data-m'); T.rel_fluxo_diario(el); }; });
  $('fd-ok').onclick = function(){ f.unidade_id = $('fd-un').value; f.dias = Number($('fd-dias').value); T.rel_fluxo_diario(el); };
  var out = $('fd-out'); carregando(out);
  try {
    var j = await api('rel_fluxo_diario', { ini: ini, fim: fim, modo: f.modo, unidade_id: f.unidade_id });
    var porDia = {}; j.dias.forEach(function(d){ porDia[String(d.dia).slice(0, 10)] = d; });
    var serie = [], saldo = f.modo === 'projetado' ? n(j.saldo_atual) : 0, minimo = saldo, d = ini;
    while(d <= fim){ var x = porDia[d] || { receitas: 0, despesas: 0 }; saldo += n(x.receitas) - n(x.despesas); minimo = Math.min(minimo, saldo); serie.push({ dia: d, r: n(x.receitas), p: n(x.despesas), s: saldo }); d = addDias(d, 1); }
    var totR = serie.reduce(function(a, x){ return a + x.r; }, 0), totP = serie.reduce(function(a, x){ return a + x.p; }, 0);
    var h = '<div class="fin-kpis">' + (f.modo === 'projetado' ? kpi('Saldo atual nas contas', moeda(j.saldo_atual), '', 'ponto de partida da projeção') + kpi('Giro necessário (' + f.dias + ' dias)', moeda(minimo < 0 ? -minimo : 0), minimo < 0 ? '#C0392B' : '#1D9E75', minimo < 0 ? 'o saldo projetado fica negativo' : 'o saldo não fica negativo') : '') +
      kpi('Entradas', moeda(totR), '#1D9E75', f.modo === 'projetado' ? 'a receber (atrasados contam hoje)' : 'recebido no período') + kpi('Saídas', moeda(totP), '#E24B4A', f.modo === 'projetado' ? 'a pagar (atrasados contam hoje)' : 'pago no período') + '</div>';
    h += '<div class="fin-card">' + graficoFluxo(serie, f.modo === 'projetado') + '</div>';
    h += '<div class="fin-card" style="margin-top:10px;padding:0;overflow-x:auto"><table class="fin-tbl"><thead><tr><th>Dia</th><th class="fin-num">Entradas</th><th class="fin-num">Saídas</th><th class="fin-num">Resultado</th>' + (f.modo === 'projetado' ? '<th class="fin-num">Saldo projetado</th>' : '') + '</tr></thead><tbody>' +
      serie.filter(function(x){ return x.r || x.p; }).map(function(x){ return '<tr><td>' + dataBR(x.dia) + ' <span class="fin-sub">' + diaSemana(x.dia).slice(0, 3) + '</span></td><td class="fin-num fin-ent">' + (x.r ? moeda(x.r) : '-') + '</td><td class="fin-num fin-sai">' + (x.p ? moeda(x.p) : '-') + '</td><td class="fin-num">' + moeda(x.r - x.p) + '</td>' + (f.modo === 'projetado' ? '<td class="fin-num"' + (x.s < 0 ? ' style="color:#C0392B;font-weight:800"' : '') + '>' + moeda(x.s) + '</td>' : '') + '</tr>'; }).join('') + '</tbody></table></div>';
    out.innerHTML = h;
  } catch(e){ erroEm(out, e); }
};
function graficoFluxo(serie, comSaldo){
  var W = 900, H = 220, pad = 40, bw = Math.max(2, (W - pad * 2) / serie.length - 2);
  var maxB = Math.max.apply(null, serie.map(function(x){ return Math.max(x.r, x.p); }).concat([1]));
  var sMin = Math.min.apply(null, serie.map(function(x){ return x.s; }).concat([0])), sMax = Math.max.apply(null, serie.map(function(x){ return x.s; }).concat([1]));
  var y0 = H / 2;
  var bars = serie.map(function(x, k){ var X = pad + k * (bw + 2); return (x.r ? '<rect x="' + X + '" y="' + (y0 - x.r / maxB * (y0 - 15)) + '" width="' + bw + '" height="' + (x.r / maxB * (y0 - 15)) + '" fill="#1D9E75"><title>' + dataBR(x.dia) + ' entradas ' + moeda(x.r) + '</title></rect>' : '') + (x.p ? '<rect x="' + X + '" y="' + y0 + '" width="' + bw + '" height="' + (x.p / maxB * (y0 - 15)) + '" fill="#E24B4A"><title>' + dataBR(x.dia) + ' saídas ' + moeda(x.p) + '</title></rect>' : ''); }).join('');
  var linha = comSaldo ? '<polyline fill="none" stroke="#0E7AB8" stroke-width="2" points="' + serie.map(function(x, k){ return (pad + k * (bw + 2) + bw / 2) + ',' + (H - 10 - (x.s - sMin) / ((sMax - sMin) || 1) * (H - 20)); }).join(' ') + '"/>' : '';
  var lbl = serie.map(function(x, k){ return k % Math.ceil(serie.length / 10) === 0 ? '<text x="' + (pad + k * (bw + 2)) + '" y="' + (H + 14) + '" font-size="10" fill="currentColor" opacity=".6">' + dataBR(x.dia).slice(0, 5) + '</text>' : ''; }).join('');
  return '<svg viewBox="0 0 ' + W + ' ' + (H + 20) + '" style="width:100%;height:auto;color:var(--text)"><line x1="' + pad + '" x2="' + (W - pad) + '" y1="' + y0 + '" y2="' + y0 + '" stroke="currentColor" opacity=".2"/>' + bars + linha + lbl + '</svg>' +
    '<div class="fin-sub"><span style="color:#1D9E75">■</span> entradas <span style="color:#E24B4A">■</span> saídas' + (comSaldo ? ' <span style="color:#0E7AB8">━</span> saldo consolidado' : '') + '</div>';
}

T.rel_fluxo_mensal = async function(el){
  css2(); carregando(el);
  try { await base(); } catch(e){ return erroEm(el, e); }
  var f = F.fm = F.fm || { ano: new Date().getFullYear(), projecao: false, unidade_id: '', centro_custo_id: '' };
  el.innerHTML = filtrosRel('fm', f, '<select id="fm-ano">' + anosOpts(f.ano) + '</select><label class="fin-sub" style="display:flex;gap:4px;align-items:center"><input type="checkbox" id="fm-proj"' + (f.projecao ? ' checked' : '') + '>Incluir projeção</label>') + '<div id="fm-out"></div>';
  $('fm-ok').onclick = function(){ f.ano = Number($('fm-ano').value); f.projecao = $('fm-proj').checked; f.unidade_id = $('fm-un').value; f.centro_custo_id = $('fm-cc').value; T.rel_fluxo_mensal(el); };
  var out = $('fm-out'); carregando(out);
  try {
    var j = await api('rel_fluxo_mensal', f);
    var G = { despesa: 'Despesas', retirada: 'Retiradas', receita: 'Receitas', aporte: 'Aportes', sem: '(Sem classificação)' }, ordem = ['despesa', 'receita', 'aporte', 'retirada', 'sem'];
    var M = {}; j.linhas.forEach(function(r){ var g = M[r.grupo] = M[r.grupo] || {}, c = g[r.classificacao] = g[r.classificacao] || {}; c[r.mes] = (c[r.mes] || 0) + n(r.valor); });
    var meses = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], res = {}, csv = [['Grupo'].concat(meses.map(function(m){ return MESES[m - 1]; }), ['Total']).join(';')];
    var cel = function(v){ return '<td class="fin-num"' + (v < 0 ? ' style="color:#C0392B"' : '') + '>' + (Math.abs(v) < 0.005 ? '0' : moedaCurta(v)) + '</td>'; };
    F.fmAbertos = F.fmAbertos || {};
    var h = '<div class="fin-card" style="padding:0;overflow-x:auto"><table class="fin-tbl fin-dre"><thead><tr><th>' + f.ano + (f.projecao ? ' (com projeção)' : ' (realizado)') + '</th>' + meses.map(function(m){ return '<th class="fin-num">' + MESES[m - 1] + '</th>'; }).join('') + '<th class="fin-num">Total</th></tr></thead><tbody>';
    ordem.filter(function(g){ return M[g]; }).forEach(function(g){
      var vals = meses.map(function(m){ var x = 0; Object.keys(M[g]).forEach(function(c){ x += M[g][c][m] || 0; }); res[m] = (res[m] || 0) + x; return x; });
      h += '<tr class="exp" data-g="' + g + '"><td>' + (F.fmAbertos[g] ? '▾ ' : '▸ ') + '<b>' + G[g] + '</b></td>' + vals.map(cel).join('') + cel(vals.reduce(function(a, v){ return a + v; }, 0)) + '</tr>';
      csv.push([G[g]].concat(vals.map(function(v){ return v.toFixed(2).replace('.', ','); })).join(';'));
      if(F.fmAbertos[g]) Object.keys(M[g]).sort().forEach(function(c){ var cv = meses.map(function(m){ return M[g][c][m] || 0; }); h += '<tr class="sub"><td>' + esc(c) + '</td>' + cv.map(cel).join('') + cel(cv.reduce(function(a, v){ return a + v; }, 0)) + '</tr>'; });
    });
    var rv = meses.map(function(m){ return res[m] || 0; }), ac = 0, av = rv.map(function(v){ ac += v; return ac; });
    h += '<tr class="tot"><td>Resultado</td>' + rv.map(cel).join('') + cel(rv.reduce(function(a, v){ return a + v; }, 0)) + '</tr><tr class="tot"><td>Acumulado</td>' + av.map(cel).join('') + '<td></td></tr></tbody></table></div>';
    csv.push(['Resultado'].concat(rv.map(function(v){ return v.toFixed(2).replace('.', ','); })).join(';'));
    out.innerHTML = h;
    out.querySelectorAll('tr.exp').forEach(function(tr){ tr.onclick = function(){ var g = tr.getAttribute('data-g'); F.fmAbertos[g] = !F.fmAbertos[g]; T.rel_fluxo_mensal(el); }; });
    $('fm-csv').onclick = function(){ baixar('fluxo-mensal-' + f.ano + '.csv', '﻿' + csv.join('\r\n'), 'text/csv;charset=utf-8'); };
  } catch(e){ erroEm(out, e); }
};

T.rel_resultado = async function(el){
  css2(); carregando(el);
  try { await base(); } catch(e){ return erroEm(el, e); }
  var mesPass = addDias(inicioMes(), -1);
  var f = F.rr = F.rr || { ini: mesPass.slice(0, 8) + '01', fim: mesPass, unidade_id: '', centro_custo_id: '' };
  el.innerHTML = filtrosRel('rr', f, '<input type="date" id="rr-ini" value="' + f.ini + '"><input type="date" id="rr-fim" value="' + f.fim + '">') + '<div id="rr-out"></div>';
  $('rr-ok').onclick = function(){ f.ini = $('rr-ini').value; f.fim = $('rr-fim').value; f.unidade_id = $('rr-un').value; f.centro_custo_id = $('rr-cc').value; T.rel_resultado(el); };
  var out = $('rr-out'); carregando(out);
  try {
    var r = (await api('rel_resultado', f)).resultado;
    var rec = n(r.receita), des = n(r.despesa), roi = des ? (rec - des) / des : 0;
    var barras = function(lista, cor){ var t = lista.reduce(function(a, x){ return a + n(x.valor); }, 0) || 1, mx = Math.max.apply(null, lista.map(function(x){ return n(x.valor); }).concat([1]));
      return lista.length ? lista.map(function(x){ return '<div class="fin-hbar"><span title="' + esc(x.nome) + '">' + esc(x.nome) + '</span><i style="width:' + (n(x.valor) / mx * 45) + '%;background:' + cor + '"></i><span class="fin-num">' + moedaCurta(x.valor) + ' <span class="fin-sub">' + (n(x.valor) / t * 100).toFixed(0) + '%</span></span></div>'; }).join('') : '<div class="fin-vazio">Sem dados.</div>'; };
    $('rr-csv').onclick = function(){ baixar('resultado-' + f.ini + '-' + f.fim + '.csv', '﻿' + ['Tipo;Nome;Valor'].concat(r.comp_receitas.map(function(x){ return 'Receita;' + x.nome + ';' + n(x.valor).toFixed(2).replace('.', ','); }), r.comp_despesas.map(function(x){ return 'Despesa;' + x.nome + ';' + n(x.valor).toFixed(2).replace('.', ','); })).join('\r\n'), 'text/csv;charset=utf-8'); };
    out.innerHTML = '<div class="fin-kpis">' + kpi('Receita total', moeda(rec), '#1D9E75') + kpi('Despesas totais', moeda(des), '#E24B4A') + kpi('Retorno (resultado ÷ despesas)', (roi * 100).toFixed(1).replace('.', ',') + '%', roi >= 0 ? '#1D9E75' : '#C0392B', moeda(rec - des) + ' é o resultado líquido') + '</div>' +
      '<div class="fin-grid2"><div class="fin-card"><b style="font-size:13px">Composição das receitas</b><div style="margin-top:8px">' + barras(r.comp_receitas, '#1D9E75') + '</div></div><div class="fin-card"><b style="font-size:13px">Composição das despesas</b><div style="margin-top:8px">' + barras(r.comp_despesas, '#E24B4A') + '</div></div></div>' +
      '<div class="fin-grid2" style="margin-top:10px"><div class="fin-card"><b style="font-size:13px">Fontes de receita (clientes)</b><div style="margin-top:8px">' + barras(r.fontes_receita, '#0E7AB8') + '</div></div><div class="fin-card"><b style="font-size:13px">Despesas e investimentos</b><div style="margin-top:8px">' + barras(r.maiores_despesas, '#D68910') + '</div></div></div>';
  } catch(e){ erroEm(out, e); }
};

/* ================= CADASTROS ================= */
T.pessoas = async function(el){
  css2();
  var f = F.pes = F.pes || { q: '', papel: '', pagina: 0 };
  el.innerHTML = '<div class="fin-filtros"><input id="pe-q" placeholder="Busque por nome, CPF ou CNPJ" value="' + esc(f.q) + '" style="min-width:240px"><select id="pe-papel"><option value="">Clientes e fornecedores</option><option value="cliente"' + (f.papel === 'cliente' ? ' selected' : '') + '>Só clientes</option><option value="fornecedor"' + (f.papel === 'fornecedor' ? ' selected' : '') + '>Só fornecedores</option></select><button class="fin-bt pri" id="pe-ok">Buscar</button><div style="flex:1"></div>' + (pode('conferente') ? '<button class="fin-bt ok" id="pe-novo">+ Nova pessoa</button>' : '') + '</div><div id="pe-out"></div>';
  var ap = function(){ f.q = $('pe-q').value.trim(); f.papel = $('pe-papel').value; f.pagina = 0; T.pessoas(el); };
  $('pe-ok').onclick = ap; $('pe-q').onkeydown = function(e){ if(e.key === 'Enter') ap(); };
  if($('pe-novo')) $('pe-novo').onclick = function(){ editarPessoa(null, function(){ T.pessoas(el); }); };
  var out = $('pe-out'); carregando(out);
  try {
    var j = await api('pessoas_listar', { q: f.q, papel: f.papel, limite: 50, pagina: f.pagina });
    var pags = Math.ceil(j.total / 50);
    out.innerHTML = '<div class="fin-sub" style="margin-bottom:6px">' + j.total + ' pessoa(s)</div><div class="fin-card" style="padding:0;overflow-x:auto"><table class="fin-tbl"><thead><tr><th>Código</th><th>Nome / CPF-CNPJ</th><th>Contato</th><th>Cidade</th><th>Tipo</th><th>Pix</th></tr></thead><tbody>' +
      (j.pessoas.length ? '' : '<tr><td colspan="6" class="fin-sub" style="text-align:center;padding:14px">Ninguém encontrado. Confira a busca ou use "+ Nova pessoa".</td></tr>') +
      j.pessoas.map(function(p){ return '<tr class="clic" data-id="' + p.id + '"><td class="fin-sub">' + p.id + '</td><td><b>' + esc(p.nome) + '</b><div class="fin-sub">' + esc(p.documento || '') + '</div></td><td class="fin-sub">' + esc(p.email || '') + '<br>' + esc(p.telefone || '') + '</td><td class="fin-sub">' + esc([p.cidade, p.uf].filter(Boolean).join(' - ')) + '</td><td class="fin-sub">' + [p.cliente ? 'cliente' : '', p.fornecedor ? 'fornecedor' : ''].filter(Boolean).join(', ') + '</td><td class="fin-sub">' + (p.pix_chave ? '✓' : '') + '</td></tr>'; }).join('') + '</tbody></table></div>' +
      (pags > 1 ? '<div class="fin-row" style="justify-content:center;margin-top:8px"><button class="fin-bt" id="pe-ant"' + (f.pagina <= 0 ? ' disabled' : '') + '>‹</button><span class="fin-sub">Página ' + (f.pagina + 1) + ' de ' + pags + '</span><button class="fin-bt" id="pe-prox"' + (f.pagina + 1 >= pags ? ' disabled' : '') + '>›</button></div>' : '');
    out.querySelectorAll('tr[data-id]').forEach(function(tr){ tr.onclick = async function(){ try { var d = await api('pessoa_ver', { id: Number(tr.getAttribute('data-id')) }); editarPessoa(d.pessoa, function(){ T.pessoas(el); }, null, null, d.lancamentos); } catch(e){ toast(e.message, 'erro'); } }; });
    if($('pe-ant')) $('pe-ant').onclick = function(){ f.pagina--; T.pessoas(el); };
    if($('pe-prox')) $('pe-prox').onclick = function(){ f.pagina++; T.pessoas(el); };
  } catch(e){ erroEm(out, e); }
};
function editarPessoa(p, aoSalvar, tipo, nomeInicial, lancs){
  p = p || { nome: nomeInicial || '', cliente: tipo === 'receber', fornecedor: tipo === 'pagar', ativo: true };
  var so = !pode('conferente');
  var c = function(id, rot, v, w){ return '<div' + (w ? ' style="grid-column:span ' + w + '"' : '') + '><div class="fin-lbl">' + rot + '</div><input class="fin-in" id="ep-' + id + '" value="' + esc(v || '') + '"' + (so ? ' disabled' : '') + '></div>'; };
  var m = modal('<div class="fin-row" style="justify-content:space-between"><b style="font-size:15px">' + (p.id ? 'Pessoa #' + p.id : 'Nova pessoa') + '</b><button class="fin-bt" id="ep-x">✕</button></div>' +
    '<div class="fin-row" style="margin:10px 0"><label class="fin-row" style="font-size:12px"><input type="checkbox" id="ep-estrangeira"' + (p.estrangeira ? ' checked' : '') + '>Estrangeira</label><label class="fin-row" style="font-size:12px"><input type="checkbox" id="ep-cliente"' + (p.cliente ? ' checked' : '') + '>Cliente</label><label class="fin-row" style="font-size:12px"><input type="checkbox" id="ep-fornecedor"' + (p.fornecedor ? ' checked' : '') + '>Fornecedor</label><label class="fin-row" style="font-size:12px"><input type="checkbox" id="ep-ativo"' + (p.ativo !== false ? ' checked' : '') + '>Ativo</label></div>' +
    '<div class="fin-g3">' + c('documento', 'CPF/CNPJ', p.documento) + c('nome', 'Nome amigável *', p.nome) + c('razao_social', 'Razão social', p.razao_social) + c('fantasia', 'Nome fantasia', p.fantasia) + c('ie', 'Inscrição estadual', p.ie) + c('im', 'Inscrição municipal', p.im) + '</div>' +
    '<div class="fin-sec"><h4>Endereço e contato</h4><div class="fin-g3">' + c('cep', 'CEP', p.cep) + c('logradouro', 'Logradouro', p.logradouro, 2) + c('numero', 'Número', p.numero) + c('complemento', 'Complemento', p.complemento) + c('bairro', 'Bairro', p.bairro) + c('cidade', 'Cidade', p.cidade) + c('uf', 'UF', p.uf) + c('telefone', 'Telefone principal', p.telefone) + c('email', 'E-mail principal', p.email, 2) + '</div></div>' +
    '<div class="fin-sec"><h4>Dados bancários</h4><div class="fin-aviso">Mudar a chave Pix ou a conta de alguém gera alerta para o gestor (golpe comum: trocam a chave do fornecedor). Confirme por telefone antes.</div><div class="fin-g3">' +
      '<div><div class="fin-lbl">Tipo de chave Pix</div><select class="fin-in" id="ep-pix_tipo"' + (so ? ' disabled' : '') + '><option value="">-</option>' + ['CPF/CNPJ', 'E-mail', 'Telefone', 'Aleatória'].map(function(x){ return '<option' + (p.pix_tipo === x ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select></div>' + c('pix_chave', 'Chave Pix', p.pix_chave, 2) + c('banco', 'Banco', p.banco) + c('agencia', 'Agência', p.agencia) + c('conta', 'Conta', p.conta) + '</div></div>' +
    '<div class="fin-sec"><h4>Observações</h4><textarea class="fin-in" id="ep-observacoes" rows="2"' + (so ? ' disabled' : '') + '>' + esc(p.observacoes || '') + '</textarea></div>' +
    (lancs && lancs.length ? '<div class="fin-sec"><h4>Lançamentos (' + lancs.length + ')</h4><div style="max-height:200px;overflow:auto"><table class="fin-tbl"><tbody>' + lancs.map(function(l){ return '<tr class="clic" data-l="' + l.id + '"><td>' + (l.tipo === 'pagar' ? '🔻' : '🔺') + '</td><td>' + esc(l.descricao || '') + '</td><td>' + dataBR(l.vencimento) + '</td><td class="fin-num">' + moeda(l.valor_final) + '</td><td>' + chipSit(l.situacao_calc, l.tipo) + '</td></tr>'; }).join('') + '</tbody></table></div></div>' : '') +
    '<div id="ep-msg"></div><div class="fin-row" style="justify-content:flex-end;margin-top:12px"><button class="fin-bt" id="ep-c">Fechar</button>' + (!so ? '<button class="fin-bt pri" id="ep-ok">Salvar</button>' : '') + '</div>');
  $('ep-x').onclick = $('ep-c').onclick = m.fechar;
  m.el.querySelectorAll('[data-l]').forEach(function(tr){ tr.onclick = function(){ m.fechar(); verLanc(Number(tr.getAttribute('data-l'))); }; });
  if($('ep-ok')) $('ep-ok').onclick = async function(){
    var b = this, d = { id: p.id || null };
    ['documento', 'nome', 'razao_social', 'fantasia', 'ie', 'im', 'cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'uf', 'telefone', 'email', 'pix_tipo', 'pix_chave', 'banco', 'agencia', 'conta', 'observacoes'].forEach(function(k){ d[k] = $('ep-' + k).value.trim(); });
    ['estrangeira', 'cliente', 'fornecedor', 'ativo'].forEach(function(k){ d[k] = $('ep-' + k).checked; });
    if(d.nome.length < 2){ $('ep-msg').innerHTML = '<div class="fin-erro">Nome obrigatório.</div>'; return; }
    b.disabled = true;
    try { var r = await api('pessoa_salvar', d); toast('Pessoa salva'); m.fechar(); aoSalvar && aoSalvar({ id: r.id || p.id, nome: d.nome }); }
    catch(e){ $('ep-msg').innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; b.disabled = false; }
  };
}

var DRE_NOMES = { receita_bruta: 'Receita bruta', retencoes: 'Retenções', impostos_venda: 'Impostos sobre a venda', descontos: 'Descontos e acréscimos', outras_receitas: 'Outras receitas', despesas_comerciais: 'Despesas comerciais', despesas_operacionais: 'Despesas operacionais', impostos_renda: 'Impostos sobre a renda', aportes: 'Aportes', retiradas: 'Retiradas', fora_dre: 'Fora do DRE' };
var GRUPOS = { receita: 'Receitas', despesa: 'Despesas', aporte: 'Aportes', retirada: 'Retiradas', transferencia: 'Transferência' };
T.plano = async function(el){
  css2(); carregando(el);
  try {
    await base(true);
    var h = '<div class="fin-row" style="justify-content:space-between;margin-bottom:10px"><span class="fin-sub">Igual ao plano de contas do Kamino. A "linha do DRE" define onde cada classificação aparece no DRE gerencial.</span>' + (pode('gestor') ? '<button class="fin-bt ok" id="pl-nova">+ Nova classificação</button>' : '') + '</div>';
    Object.keys(GRUPOS).forEach(function(g){
      var lista = F.base.classificacoes.filter(function(c){ return c.grupo === g; }); if(!lista.length) return;
      var subs = {}; lista.forEach(function(c){ (subs[c.subgrupo || ''] = subs[c.subgrupo || ''] || []).push(c); });
      h += '<div class="fin-card" style="margin-bottom:10px"><b style="font-size:14px">' + GRUPOS[g] + '</b>' + Object.keys(subs).map(function(s){ return (s ? '<div style="font-weight:700;font-size:12px;margin-top:8px">' + esc(s) + '</div>' : '') + subs[s].map(function(c){ return '<div class="fin-row" style="justify-content:space-between;font-size:12px;padding:4px 0 4px ' + (s ? 14 : 0) + 'px;border-bottom:1px solid var(--border)' + (c.ativo ? '' : ';opacity:.5') + '"><span>' + esc((c.codigo ? c.codigo + ' ' : '') + c.nome) + (c.ativo ? '' : ' (inativa)') + '</span><span class="fin-row"><span class="fin-sub">' + esc(DRE_NOMES[c.dre_linha]) + '</span>' + (pode('gestor') ? '<button class="fin-bt" data-ed="' + c.id + '">Editar</button>' : '') + '</span></div>'; }).join(''); }).join('') + '</div>';
    });
    el.innerHTML = h;
    var ed = function(c){
      c = c || { grupo: 'despesa', dre_linha: 'despesas_operacionais', ativo: true };
      var m = modal('<b style="font-size:15px">' + (c.id ? 'Editar classificação' : 'Nova classificação') + '</b><div class="fin-grid2" style="margin-top:10px"><div><div class="fin-lbl">Grupo</div><select class="fin-in" id="pc-g"' + (c.id ? ' disabled' : '') + '>' + Object.keys(GRUPOS).map(function(g){ return '<option value="' + g + '"' + (c.grupo === g ? ' selected' : '') + '>' + GRUPOS[g] + '</option>'; }).join('') + '</select></div>' +
        '<div><div class="fin-lbl">Subgrupo (ex: Despesas com Pessoas)</div><input class="fin-in" id="pc-s" value="' + esc(c.subgrupo || '') + '" list="pc-subs"><datalist id="pc-subs">' + Array.from(new Set(F.base.classificacoes.map(function(x){ return x.subgrupo; }).filter(Boolean))).map(function(s){ return '<option value="' + esc(s) + '">'; }).join('') + '</datalist></div>' +
        '<div><div class="fin-lbl">Nome *</div><input class="fin-in" id="pc-n" value="' + esc(c.nome || '') + '"></div><div><div class="fin-lbl">Código (opcional)</div><input class="fin-in" id="pc-c" value="' + esc(c.codigo || '') + '"></div>' +
        '<div><div class="fin-lbl">Linha do DRE</div><select class="fin-in" id="pc-d">' + Object.keys(DRE_NOMES).map(function(k){ return '<option value="' + k + '"' + (c.dre_linha === k ? ' selected' : '') + '>' + DRE_NOMES[k] + '</option>'; }).join('') + '</select></div>' +
        '<div><label class="fin-row" style="font-size:12px;margin-top:20px"><input type="checkbox" id="pc-a"' + (c.ativo !== false ? ' checked' : '') + '>Ativa</label></div></div><div class="fin-sub" style="margin-top:6px">Classificação não se apaga (tem histórico): desative.</div><div id="pc-msg"></div><div class="fin-row" style="justify-content:flex-end;margin-top:12px"><button class="fin-bt" id="pc-x">Cancelar</button><button class="fin-bt pri" id="pc-ok">Salvar</button></div>');
      $('pc-x').onclick = m.fechar;
      $('pc-ok').onclick = async function(){ var b = this; b.disabled = true; try { await api('cadastro_salvar', { tabela: 'classificacao', id: c.id || null, dados: { grupo: $('pc-g').value, subgrupo: $('pc-s').value, nome: $('pc-n').value, codigo: $('pc-c').value, dre_linha: $('pc-d').value, ativo: $('pc-a').checked } }); toast('Salvo'); m.fechar(); T.plano(el); } catch(e){ $('pc-msg').innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; b.disabled = false; } };
    };
    if($('pl-nova')) $('pl-nova').onclick = function(){ ed(null); };
    el.querySelectorAll('[data-ed]').forEach(function(b){ b.onclick = function(){ ed(F.base.classificacoes.filter(function(c){ return c.id === Number(b.getAttribute('data-ed')); })[0]); }; });
  } catch(e){ erroEm(el, e); }
};

T.unidades = async function(el){
  css2(); carregando(el);
  try {
    await base(true);
    var bloco = function(tab, titulo, lista, extra){ return '<div class="fin-card"><div class="fin-row" style="justify-content:space-between"><b style="font-size:14px">' + titulo + '</b>' + (pode('gestor') ? '<button class="fin-bt ok" data-novo="' + tab + '">+ Novo</button>' : '') + '</div>' +
      lista.map(function(x){ return '<div class="fin-row" style="justify-content:space-between;font-size:12px;padding:5px 0;border-bottom:1px solid var(--border)' + (x.ativo ? '' : ';opacity:.5') + '"><span>' + esc(x.nome) + (extra ? ' <span class="fin-sub">' + esc(extra(x)) + '</span>' : '') + (x.ativo ? '' : ' (inativo)') + '</span>' + (pode('gestor') ? '<button class="fin-bt" data-ed="' + tab + ':' + x.id + '">Editar</button>' : '') + '</div>'; }).join('') + '</div>'; };
    el.innerHTML = '<div class="fin-grid2">' + bloco('unidade', 'Unidades de negócio', F.base.unidades, function(u){ return [u.cidade_slug, u.cnpj].filter(Boolean).join(' · '); }) + bloco('centro', 'Centros de custo', F.base.centros) + '</div>';
    var ed = function(tab, x){
      x = x || { ativo: true };
      var m = modal('<b style="font-size:15px">' + (tab === 'unidade' ? 'Unidade de negócio' : 'Centro de custo') + '</b><div style="margin-top:10px"><div class="fin-lbl">Nome *</div><input class="fin-in" id="uc-n" value="' + esc(x.nome || '') + '"></div>' +
        (tab === 'unidade' ? '<div class="fin-grid2" style="margin-top:8px"><div><div class="fin-lbl">Cidade (slug, ex: aracaju)</div><input class="fin-in" id="uc-c" value="' + esc(x.cidade_slug || '') + '"></div><div><div class="fin-lbl">CNPJ</div><input class="fin-in" id="uc-cnpj" value="' + esc(x.cnpj || '') + '"></div></div>' : '') +
        '<label class="fin-row" style="font-size:12px;margin-top:8px"><input type="checkbox" id="uc-a"' + (x.ativo !== false ? ' checked' : '') + '>Ativo</label><div id="uc-msg"></div><div class="fin-row" style="justify-content:flex-end;margin-top:12px"><button class="fin-bt" id="uc-x">Cancelar</button><button class="fin-bt pri" id="uc-ok">Salvar</button></div>');
      $('uc-x').onclick = m.fechar;
      $('uc-ok').onclick = async function(){ var b = this; b.disabled = true; try { await api('cadastro_salvar', { tabela: tab, id: x.id || null, dados: { nome: $('uc-n').value, cidade_slug: $('uc-c') ? $('uc-c').value : '', cnpj: $('uc-cnpj') ? $('uc-cnpj').value : '', ativo: $('uc-a').checked } }); toast('Salvo'); m.fechar(); T.unidades(el); } catch(e){ $('uc-msg').innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; b.disabled = false; } };
    };
    el.querySelectorAll('[data-novo]').forEach(function(b){ b.onclick = function(){ ed(b.getAttribute('data-novo')); }; });
    el.querySelectorAll('[data-ed]').forEach(function(b){ var p = b.getAttribute('data-ed').split(':'); b.onclick = function(){ ed(p[0], (p[0] === 'unidade' ? F.base.unidades : F.base.centros).filter(function(x){ return x.id === Number(p[1]); })[0]); }; });
  } catch(e){ erroEm(el, e); }
};

T.regras = async function(el){
  css2(); carregando(el);
  try {
    await base(true);
    var nm = function(lista, id){ var x = lista.filter(function(i){ return String(i.id) === String(id); })[0]; return x ? x.nome : ''; };
    var R = F.base.regras;
    el.innerHTML = '<div class="fin-row" style="justify-content:space-between;margin-bottom:10px"><span class="fin-sub">Quando a descrição da linha do extrato contém o "texto de busca", a conciliação já sugere pessoa, classificação, centro e unidade (ou marca como transferência).</span>' + (pode('gestor') ? '<button class="fin-bt ok" id="rg-nova">+ Nova regra</button>' : '') + '</div>' +
      (R.length ? '<div class="fin-card" style="padding:0;overflow-x:auto"><table class="fin-tbl"><thead><tr><th>#</th><th>Descrição</th><th>Texto de busca</th><th>Conta</th><th>Classificação</th><th>Unidade</th><th>Transferência</th><th>Ativo</th><th></th></tr></thead><tbody>' +
        R.map(function(r){ return '<tr' + (r.ativo ? '' : ' style="opacity:.5"') + '><td class="fin-sub">' + r.id + '</td><td>' + esc(r.descricao) + '</td><td style="font-family:monospace;font-size:11px">' + esc(r.texto_busca) + '</td><td class="fin-sub">' + esc(nm(F.base.contas, r.conta_id) || 'todas') + '</td><td>' + esc(nm(F.base.classificacoes, r.classificacao_id)) + '</td><td class="fin-sub">' + esc(nm(F.base.unidades, r.unidade_id)) + '</td><td>' + (r.transferencia_conta_id ? '✓ ' + esc(nm(F.base.contas, r.transferencia_conta_id)) : '') + '</td><td>' + (r.ativo ? '✓' : '') + '</td><td>' + (pode('gestor') ? '<button class="fin-bt" data-ed="' + r.id + '">Editar</button>' : '') + '</td></tr>'; }).join('') + '</tbody></table></div>' : '<div class="fin-vazio">Nenhuma regra ainda.</div>');
    var ed = function(r){
      r = r || { ativo: true };
      var m = modal('<b style="font-size:15px">' + (r.id ? 'Editar regra' : 'Nova regra de extrato') + '</b><div class="fin-grid2" style="margin-top:10px"><div><div class="fin-lbl">Descrição *</div><input class="fin-in" id="rr-d" value="' + esc(r.descricao || '') + '"></div><div><div class="fin-lbl">Texto de busca * (trecho da descrição do banco)</div><input class="fin-in" id="rr-t" value="' + esc(r.texto_busca || '') + '"></div>' +
        '<div><div class="fin-lbl">Só nesta conta</div><select class="fin-in" id="rr-c">' + optsContas(r.conta_id, 'Todas as contas') + '</select></div><div><div class="fin-lbl">Pessoa</div>' + campoPessoa('rr-p', r.pessoa_id ? { id: r.pessoa_id, nome: '#' + r.pessoa_id } : null) + '</div>' +
        '<div><div class="fin-lbl">Classificação</div><select class="fin-in" id="rr-cl">' + optsClass(r.classificacao_id, null, '(nenhuma)') + '</select></div><div><div class="fin-lbl">Centro de custo</div><select class="fin-in" id="rr-cc">' + optsLista(F.base.centros, r.centro_custo_id, '(nenhum)') + '</select></div>' +
        '<div><div class="fin-lbl">Unidade de negócio</div><select class="fin-in" id="rr-u">' + optsLista(F.base.unidades, r.unidade_id, '(nenhuma)') + '</select></div><div><div class="fin-lbl">É transferência? Conta do outro lado</div><select class="fin-in" id="rr-tr">' + optsContas(r.transferencia_conta_id, 'Não é transferência') + '</select></div></div>' +
        '<label class="fin-row" style="font-size:12px;margin-top:8px"><input type="checkbox" id="rr-a"' + (r.ativo !== false ? ' checked' : '') + '>Ativa</label><div id="rr-msg"></div><div class="fin-row" style="justify-content:flex-end;margin-top:12px"><button class="fin-bt" id="rr-x">Cancelar</button><button class="fin-bt pri" id="rr-ok">Salvar</button></div>');
      ligarPessoa('rr-p');
      $('rr-x').onclick = m.fechar;
      $('rr-ok').onclick = async function(){ var b = this; b.disabled = true;
        try { await api('cadastro_salvar', { tabela: 'regra', id: r.id || null, dados: { descricao: $('rr-d').value, texto_busca: $('rr-t').value, conta_id: $('rr-c').value, pessoa_id: $('rr-p').value, classificacao_id: $('rr-cl').value, centro_custo_id: $('rr-cc').value, unidade_id: $('rr-u').value, transferencia_conta_id: $('rr-tr').value, ativo: $('rr-a').checked } }); toast('Regra salva'); m.fechar(); T.regras(el); }
        catch(e){ $('rr-msg').innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; b.disabled = false; } };
    };
    if($('rg-nova')) $('rg-nova').onclick = function(){ ed(null); };
    el.querySelectorAll('[data-ed]').forEach(function(b){ b.onclick = function(){ ed(R.filter(function(r){ return r.id === Number(b.getAttribute('data-ed')); })[0]); }; });
  } catch(e){ erroEm(el, e); }
};

window._FINV2 = { formLanc: formLanc, verLanc: verLanc, base: base };
})();
