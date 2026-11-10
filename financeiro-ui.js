/* ============================================================
   🛡️ FINANCEIRO / CONFERÊNCIA ANTIFRAUDE (UI)
   Toda autorização é no SERVIDOR (netlify/functions/financeiro.js).
   Esta tela só mostra o que o servidor devolver. Nenhum dado fica no navegador
   além do rascunho da conferência (pra não perder o que a pessoa digitou).
   ============================================================ */
(function(){
'use strict';

var F = window._FIN = window._FIN || { papel: null, nomes: {}, categorias: [], contas: [], aba: 'painel', filtros: {}, pagina: 0 };
var NIVEL = { leitor: 1, conferente: 2, gestor: 3, super: 4 };
function pode(p){ return F.papel && NIVEL[F.papel] >= NIVEL[p]; }

function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function moeda(v){ var n = Number(v) || 0; return (n < 0 ? '-' : '') + 'R$ ' + Math.abs(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function dataBR(d){ if(!d) return '-'; var s = String(d).slice(0, 10).split('-'); return s.length === 3 ? s[2] + '/' + s[1] + '/' + s[0] : d; }
function dataHoraBR(d){ if(!d) return '-'; try { return new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch(e){ return d; } }
function nome(id){ if(!id) return '-'; if(String(id).indexOf('sistema') === 0) return '🤖 Sistema'; return F.nomes[id] || id; }
function hoje(){ var d = new Date(Date.now() - 3 * 3600e3); return d.toISOString().slice(0, 10); }
function inicioMes(){ return hoje().slice(0, 8) + '01'; }
function uid(){ try { return crypto.randomUUID(); } catch(e){ return Date.now().toString(36) + Math.random().toString(36).slice(2); } }
function $(id){ return document.getElementById(id); }

async function api(acao, dados){
  var u = (typeof getUsuarioLogado === 'function') ? getUsuarioLogado() : null;
  var token = ''; try { token = localStorage.getItem('gami_sessao_token') || ''; } catch(e){}
  var corpo = Object.assign({ acao: acao }, dados || {});
  var r, j;
  try {
    r = await fetch('/.netlify/functions/financeiro', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gami-User': (u && u.id) || '', 'X-Gami-Token': token }, body: JSON.stringify(corpo) });
  } catch(e){ throw new Error('Sem conexão com o servidor. Nada foi gravado; tente de novo.'); }
  try { j = await r.json(); } catch(e){ throw new Error('Resposta inválida do servidor (HTTP ' + r.status + ')'); }
  if(!r.ok || !j.ok){ var er = new Error((j && j.erro) || ('Erro HTTP ' + r.status)); er.semAcesso = j && j.sem_acesso; er.status = r.status; throw er; }
  return j;
}

function toast(msg, tipo){
  var d = document.createElement('div');
  d.style.cssText = 'position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:100000;padding:11px 18px;border-radius:9px;font-size:13px;font-weight:600;box-shadow:0 6px 24px rgba(0,0,0,.25);max-width:90vw;color:#fff;background:' + (tipo === 'erro' ? '#C0392B' : tipo === 'aviso' ? '#B7791F' : '#1D9E75');
  d.textContent = msg; document.body.appendChild(d);
  setTimeout(function(){ d.remove(); }, tipo === 'erro' ? 7000 : 3500);
}

/* ---------- menu: só aparece se o servidor disser que a pessoa tem papel ---------- */
var _checando = false;
window._finChecarMenu = async function(){
  var el = $('nav-financeiro'); if(!el || _checando) return;
  var u = (typeof getUsuarioLogado === 'function') ? getUsuarioLogado() : null;
  if(!u){ el.style.display = 'none'; return; }
  var chave = 'fin_papel_' + u.id;
  try { var c = JSON.parse(sessionStorage.getItem(chave) || 'null'); if(c && c.t && Date.now() - c.t < 5 * 60e3){ el.style.display = c.p ? '' : 'none'; return; } } catch(e){}
  _checando = true;
  try {
    var j = await api('me');
    F.papel = j.papel; F.nomes = j.nomes || {}; F.categorias = j.categorias || [];
    el.style.display = '';
    try { sessionStorage.setItem(chave, JSON.stringify({ p: j.papel || '', t: Date.now() })); } catch(e){}
  } catch(e){
    el.style.display = 'none';
    if(e.semAcesso || e.status === 403){ try { sessionStorage.setItem(chave, JSON.stringify({ p: '', t: Date.now() })); } catch(x){} }
  } finally { _checando = false; }
};
document.addEventListener('DOMContentLoaded', function(){ setTimeout(window._finChecarMenu, 1500); });
document.addEventListener('click', function(e){
  if(e.detail < 2) return;
  var t = e.target; if(!t || !t.closest) return;
  if(!t.closest('#fin-root, .fin-modal-bg')) return;
  if(/^(INPUT|TEXTAREA|SELECT|OPTION|LABEL)$/.test(t.tagName)) return;
  e.stopImmediatePropagation(); e.preventDefault();   // 2º clique de um clique duplo: ignora (abria 2 modais / gravava 2x)
}, true);
// sair da conta: some tudo do financeiro (tela, modais, cache, rascunhos)
function limparFinanceiro(){
  try { var r = document.getElementById('fin-root'); if(r) r.innerHTML = ''; } catch(e){}
  try { document.querySelectorAll('.fin-modal-bg').forEach(function(x){ x.remove(); }); } catch(e){}
  try { Object.keys(sessionStorage).forEach(function(k){ if(k.indexOf('fin_') === 0) sessionStorage.removeItem(k); }); } catch(e){}
  try { var f = window._FIN; Object.keys(f).forEach(function(k){ delete f[k]; }); f.papel = null; f.nomes = {}; f.categorias = []; f.contas = []; f.aba = 'painel'; f.filtros = {}; f.pagina = 0; } catch(e){}
}
document.addEventListener('DOMContentLoaded', function(){
  if(typeof window.fazerLogout === 'function' && !window.fazerLogout._fin){
    var orig = window.fazerLogout;
    window.fazerLogout = function(){ limparFinanceiro(); return orig.apply(this, arguments); };
    window.fazerLogout._fin = true;
  }
});

/* ---------- estilos ---------- */
function css(){
  if($('fin-css')) return;
  var s = document.createElement('style'); s.id = 'fin-css';
  s.textContent = [
    '.fin-tabs{display:flex;gap:4px;flex-wrap:wrap;margin:0 0 14px;border-bottom:1px solid var(--border);padding-bottom:8px}',
    '.fin-tab{padding:7px 12px;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;color:var(--text2);background:transparent;border:1px solid transparent}',
    '.fin-tab.on{background:var(--surface2);border-color:var(--border);color:var(--text)}',
    '.fin-subtabs{display:flex;gap:2px;flex-wrap:wrap;margin:-6px 0 14px}',
    '.fin-subtab{padding:6px 11px;font-size:12px;cursor:pointer;color:var(--text3);border-bottom:2px solid transparent}',
    '.fin-subtab.on{color:var(--text);border-bottom-color:#0E7AB8;font-weight:700}',
    '.fin-card{background:var(--surface2);border:1px solid var(--border);border-radius:11px;padding:13px}',
    '.fin-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:14px}',
    '.fin-kl{font-size:10px;color:var(--text3);text-transform:uppercase;font-weight:700;letter-spacing:.4px}',
    '.fin-kv{font-size:20px;font-weight:800;margin-top:3px}',
    '.fin-tbl{width:100%;border-collapse:collapse;font-size:12px}',
    '.fin-tbl th{text-align:left;color:var(--text3);font-weight:600;padding:7px 8px;border-bottom:1px solid var(--border);white-space:nowrap}',
    '.fin-tbl td{padding:8px;border-bottom:1px solid var(--border);vertical-align:top}',
    '.fin-tbl tr.clic{cursor:pointer}.fin-tbl tr.clic:hover td{background:var(--surface2)}',
    '.fin-ent{color:#1D9E75;font-weight:700;white-space:nowrap}.fin-sai{color:#E24B4A;font-weight:700;white-space:nowrap}',
    '.fin-chip{display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;white-space:nowrap}',
    '.fin-filtros{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;align-items:center}',
    '.fin-filtros select,.fin-filtros input,.fin-in{padding:7px 9px;border-radius:7px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:12px;font-family:inherit}',
    '.fin-in{width:100%;box-sizing:border-box}',
    '.fin-modal{overflow-x:auto}',
    '.fin-modal-bg{position:fixed;inset:0;background:rgba(11,37,66,.72);z-index:99990;display:flex;align-items:flex-start;justify-content:center;padding:24px 12px;overflow:auto}',
    '.fin-modal{background:var(--surface);color:var(--text);border-radius:14px;max-width:720px;width:100%;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.35)}',
    '.fin-bt{padding:9px 14px;border-radius:8px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:12px;font-weight:700;cursor:pointer;font-family:inherit}',
    '.fin-bt:disabled{opacity:.5;cursor:wait}',
    '.fin-bt.ok{background:#1D9E75;color:#fff;border-color:#1D9E75}.fin-bt.div{background:#D68910;color:#fff;border-color:#D68910}.fin-bt.sus{background:#C0392B;color:#fff;border-color:#C0392B}',
    '.fin-bt.pri{background:#0E7AB8;color:#fff;border-color:#0E7AB8}',
    '.fin-bt.sel{outline:3px solid var(--text);outline-offset:1px}',
    '.fin-vazio{padding:36px;text-align:center;color:var(--text3);font-size:13px}',
    '.fin-aviso{background:rgba(214,137,16,.12);border:1px solid rgba(214,137,16,.4);border-radius:9px;padding:10px 12px;font-size:12px;margin:8px 0}',
    '.fin-erro{background:rgba(192,57,43,.1);border:1px solid rgba(192,57,43,.4);border-radius:9px;padding:10px 12px;font-size:12px;margin:8px 0;color:#C0392B}',
    '.fin-sub{font-size:11px;color:var(--text3)}',
    '.fin-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}@media(max-width:640px){.fin-grid2{grid-template-columns:1fr}}',
    '.fin-bar{height:8px;border-radius:4px;background:var(--border);overflow:hidden}.fin-bar>i{display:block;height:100%;background:#1D9E75}'
  ].join('\n');
  document.head.appendChild(s);
}

var STATUS = {
  pendente:      { t: 'Pendente', c: '#7F8C8D', bg: 'rgba(127,140,141,.15)' },
  aguardando_2a: { t: 'Falta 2ª conferência', c: '#2E86C1', bg: 'rgba(46,134,193,.15)' },
  ok:            { t: 'Conferido', c: '#1D9E75', bg: 'rgba(29,158,117,.15)' },
  divergente:    { t: 'Divergente', c: '#D68910', bg: 'rgba(214,137,16,.15)' },
  suspeito:      { t: 'Suspeito', c: '#C0392B', bg: 'rgba(192,57,43,.15)' },
  fraude:        { t: 'FRAUDE', c: '#fff', bg: '#C0392B' }
};
function chipStatus(s){ var x = STATUS[s] || STATUS.pendente; return '<span class="fin-chip" style="color:' + x.c + ';background:' + x.bg + '">' + x.t + '</span>'; }
var SEV = { critico: { t: 'CRÍTICO', c: '#fff', bg: '#922B21' }, alto: { t: 'Alto', c: '#fff', bg: '#C0392B' }, medio: { t: 'Médio', c: '#fff', bg: '#D68910' }, baixo: { t: 'Baixo', c: '#34495E', bg: 'rgba(52,73,94,.15)' } };
function chipSev(s){ var x = SEV[s] || SEV.baixo; return '<span class="fin-chip" style="color:' + x.c + ';background:' + x.bg + '">' + x.t + '</span>'; }
var REGRA = {
  DUPLICIDADE: 'Pagamento em duplicidade', FRACIONAMENTO: 'Pagamento fracionado', FAVORECIDO_NOVO: 'Favorecido novo',
  FAVORECIDO_EQUIPE: 'Favorecido é da equipe', ACIMA_DA_MEDIA: 'Acima da média', FIM_DE_SEMANA: 'Fim de semana',
  IDA_E_VOLTA: 'Entrou e saiu', LACUNA_SALDO: 'Saldo não fecha', CONTA_SEM_EXTRATO: 'Conta sem extrato',
  SEM_CONFERENCIA: 'Sem conferência', SAIDA_SEM_LANCAMENTO: 'Saída sem lançamento', PAGO_SEM_SAIDA: 'Pago sem saída',
  CONF_SUSPEITO: 'Marcado suspeito', CONF_DIVERGENTE: 'Marcado divergente'
};

/* ---------- entrada da aba ---------- */
window.initFinanceiro = async function(){
  css();
  var root = $('fin-root'); if(!root) return;
  root.innerHTML = '<div class="fin-vazio">Carregando...</div>';
  try {
    var j = await api('me');
    F.papel = j.papel; F.nomes = j.nomes || {}; F.categorias = j.categorias || [];
    var c = await api('contas'); F.contas = c.contas || [];
    F.flypPode = false;
    try { F.flypPode = (await api('flyp_pode')).pode === true; } catch(e){ F.flypPode = false; }  // trava própria (servidor)
  } catch(e){
    root.innerHTML = '<div class="fin-vazio" style="color:#C0392B">🔒 ' + esc(e.semAcesso ? 'Acesso restrito. Peça liberação ao administrador.' : e.message) + '</div>';
    return;
  }
  render();
};

/* Menu igual ao do Kamino (abas + sub-abas). A v2 (financeiro-ui-v2.js) registra as telas novas
   em window._FIN_TELAS; se a v2 não carregar, as telas da v1 continuam funcionando. */
var TELAS_V1 = { geral: telaGeral, extrato: telaExtrato, alertas: telaAlertas, importar: telaImportar, lancamentos: telaLancamentos, config: telaConfig, auditoria: telaAuditoria };
function menu(){
  var T = window._FIN_TELAS || {};
  var t = function(id){ return T[id] || TELAS_V1[id]; };
  var M = [
    { id: 'painel', t: '📊 Painel', p: 'leitor', subs: [['painel', 'Painel'], ['geral', 'Conferência do mês']] },
    { id: 'pagar', t: '💸 Pagar', p: 'leitor', subs: [['pagar_central', 'Central de pagamentos'], ['pagar_lista', 'Lista de pagamentos'], ['entradas', 'Caixa de entrada']] },
    { id: 'receber', t: '💰 Receber', p: 'leitor', subs: [['receber_dash', 'Central de recebimentos'], ['receber_lista', 'Cobranças']] },
    { id: 'contas', t: '🏦 Contas', p: 'leitor', subs: [['contas_saldos', 'Contas e saldos'], ['conciliacao', 'Conciliação'], ['extrato', 'Conferência do extrato'], ['importar', 'Importar extrato / Kamino', 'conferente']] },
    { id: 'relatorios', t: '📈 Relatórios', p: 'leitor', subs: [['rel_dre', 'DRE gerencial'], ['rel_fluxo_diario', 'Fluxo diário'], ['rel_fluxo_mensal', 'Fluxo mensal'], ['rel_resultado', 'Resultado da operação']] },
    { id: 'controles', t: '📋 Controles', p: 'leitor', subs: [['ctl_empresas', 'Empresas (semanal)'], ['ctl_creditos', 'Créditos'], ['ctl_importar', 'Importar planilhas', 'conferente']] },
    { id: 'flyp', t: '🛵 FLYP', p: 'leitor', flyp: true, subs: [['flyp_resumo', 'Saques e recargas por dia'], ['flyp_lista', 'Transações'], ['flyp_importar', 'Importar da FLYP', 'conferente'], ['flyp_acessos', 'Quem vê e quem consultou', 'super']] },
    { id: 'alertas', t: '🚨 Alertas', p: 'leitor', subs: [['alertas', 'Alertas']] },
    { id: 'cadastros', t: '🗂️ Cadastros', p: 'leitor', subs: [['pessoas', 'Pessoas e empresas'], ['plano', 'Plano de contas'], ['unidades', 'Unidades e centros de custo'], ['regras', 'Regras de extrato'], ['config', 'Contas, regras antifraude e acessos', 'gestor']] },
    { id: 'auditoria', t: '🔏 Auditoria', p: 'gestor', subs: [['auditoria', 'Registro permanente']] }
  ];
  return M.map(function(a){
    a.subs = a.subs.filter(function(s){ return t(s[0]) && pode(s[2] || a.p); }).map(function(s){ return { id: s[0], t: s[1], fn: t(s[0]) }; });
    return a;
  }).filter(function(a){ return pode(a.p) && a.subs.length && (!a.flyp || F.flypPode === true); });
}
function render(){
  var root = $('fin-root');
  var M = menu();
  // compatibilidade: F.aba antigo (ex.: 'alertas', 'extrato') vira a sub-aba
  var achar = function(sub){ for(var i = 0; i < M.length; i++) for(var k = 0; k < M[i].subs.length; k++) if(M[i].subs[k].id === sub) return [M[i], M[i].subs[k]]; return null; };
  var atual = achar(F.sub || F.aba) || achar('painel') || [M[0], M[0].subs[0]];
  F.aba = atual[0].id; F.sub = atual[1].id;
  root.innerHTML = '<div class="fin-tabs">' + M.map(function(a){ return '<div class="fin-tab' + (a.id === F.aba ? ' on' : '') + '" data-aba="' + a.id + '">' + a.t + '</div>'; }).join('') +
    '<div style="flex:1"></div><span class="fin-sub" style="align-self:center">Você: <b>' + esc(nome(((typeof getUsuarioLogado === 'function') && getUsuarioLogado() || {}).id)) + '</b> · ' + esc({ super: 'Super admin', gestor: 'Gestor', conferente: 'Conferente', leitor: 'Leitura' }[F.papel] || F.papel) + '</span></div>' +
    (atual[0].subs.length > 1 ? '<div class="fin-subtabs">' + atual[0].subs.map(function(s){ return '<div class="fin-subtab' + (s.id === F.sub ? ' on' : '') + '" data-sub="' + s.id + '">' + esc(s.t) + '</div>'; }).join('') + '</div>' : '') +
    '<div id="fin-corpo"></div>';
  root.querySelectorAll('.fin-tab').forEach(function(t){ t.onclick = function(){ var a = M.filter(function(x){ return x.id === t.getAttribute('data-aba'); })[0]; F.sub = a.subs[0].id; F.pagina = 0; render(); }; });
  root.querySelectorAll('.fin-subtab').forEach(function(t){ t.onclick = function(){ F.sub = t.getAttribute('data-sub'); F.pagina = 0; render(); }; });
  try { atual[1].fn($('fin-corpo')); } catch(e){ $('fin-corpo').innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; console.error(e); }
}
// a v2 usa os mesmos utilitários (um lugar só pra regra de tela, escape e chamada ao servidor)
window._FINUI = { api: api, esc: esc, moeda: moeda, dataBR: dataBR, dataHoraBR: dataHoraBR, nome: nome, hoje: hoje, inicioMes: inicioMes, uid: uid,
  pode: pode, toast: toast, modal: modal, baixar: baixar, abrirLinha: abrirLinha, chipStatus: chipStatus, chipSev: chipSev, render: render, $: $,
  irPara: function(sub){ F.sub = sub; render(); }, pedirTexto: pedirTexto, lerArquivo: lerArquivo };
function carregando(el){ el.innerHTML = '<div class="fin-vazio">Carregando...</div>'; }
function erroEm(el, e){ el.innerHTML = '<div class="fin-erro">' + esc(e.message || e) + '</div>'; }
function optsContas(sel, todas){
  return (todas ? '<option value="">Todas as contas</option>' : '<option value="">Escolha a conta...</option>') +
    F.contas.filter(function(c){ return c.ativo || todas; }).map(function(c){ return '<option value="' + c.id + '"' + (sel === c.id ? ' selected' : '') + '>' + esc(c.nome) + (c.ativo ? '' : ' (inativa)') + '</option>'; }).join('');
}

/* ================= VISÃO GERAL ================= */
async function telaGeral(el){
  var f = F.filtrosGeral = F.filtrosGeral || { ini: inicioMes(), fim: hoje() };
  el.innerHTML = '<div class="fin-filtros"><span class="fin-sub">Período</span><input type="date" id="fg-ini" value="' + f.ini + '"><input type="date" id="fg-fim" value="' + f.fim + '"><button class="fin-bt" id="fg-ok">Aplicar</button></div><div id="fg-out"><div class="fin-vazio">Carregando...</div></div>';
  $('fg-ok').onclick = function(){ f.ini = $('fg-ini').value; f.fim = $('fg-fim').value; telaGeral(el); };
  var out = $('fg-out');
  try {
    var j = await api('resumo', { ini: f.ini, fim: f.fim }); var r = j.resumo || {};
    var integ = null; if(pode('gestor')){ try { integ = (await api('verificar_integridade')).integridade; } catch(e){ integ = { ok: false, motivo: e.message }; } }
    var contas = r.contas || [];
    var saldo = contas.reduce(function(a, c){ return a + (Number(c.saldo_banco) || 0); }, 0);
    var ent = contas.reduce(function(a, c){ return a + (Number(c.entradas) || 0); }, 0);
    var sai = contas.reduce(function(a, c){ return a + (Number(c.saidas) || 0); }, 0);
    var st = r.status || {}; var tot = 0, okq = 0; Object.keys(st).forEach(function(k){ tot += st[k].qtd; if(k === 'ok') okq = st[k].qtd; });
    var pct = tot ? Math.round(okq / tot * 100) : 0;
    var al = r.alertas || {}; var nAl = (al.critico || 0) + (al.alto || 0) + (al.medio || 0) + (al.baixo || 0);
    var h = '<div class="fin-kpis">' +
      kpi('Saldo nos bancos', moeda(saldo), saldo < 0 ? '#E24B4A' : '', 'Último saldo informado em cada extrato') +
      kpi('Entradas', moeda(ent), '#1D9E75', dataBR(f.ini) + ' a ' + dataBR(f.fim)) +
      kpi('Saídas', moeda(sai), '#E24B4A', 'Resultado: ' + moeda(ent + sai)) +
      kpi('Conferido', pct + '%', pct >= 95 ? '#1D9E75' : pct >= 70 ? '#D68910' : '#E24B4A', okq + ' de ' + tot + ' linhas', '<div class="fin-bar" style="margin-top:6px"><i style="width:' + pct + '%"></i></div>') +
      kpi('Alertas abertos', String(nAl), (al.critico || al.alto) ? '#C0392B' : '', (al.critico ? al.critico + ' crítico · ' : '') + (al.alto || 0) + ' alto · ' + (al.medio || 0) + ' médio · ' + (al.baixo || 0) + ' baixo') +
      (integ ? kpi('Registro permanente', integ.ok ? '✅ Íntegro' : '⛔ QUEBRADO', integ.ok ? '#1D9E75' : '#C0392B', integ.ok ? (integ.total + ' registros encadeados') : esc(integ.motivo || '') + (integ.quebra_seq ? ' (registro ' + integ.quebra_seq + ')' : '')) : '') +
      '</div>';
    if(al.critico) h += '<div class="fin-erro" style="cursor:pointer" onclick="window._FIN.filtroAlerta={severidade:\'critico\'};window._FINUI.irPara(\'alertas\')">⛔ Há ' + al.critico + ' alerta(s) CRÍTICO(s). Clique para ver.</div>';
    // pendências de conferência
    var pend = ['pendente', 'aguardando_2a', 'divergente', 'suspeito'].filter(function(k){ return st[k]; });
    if(pend.length){
      h += '<div class="fin-card" style="margin-bottom:12px"><div style="font-weight:700;font-size:13px;margin-bottom:8px">Falta conferir no período</div><div style="display:flex;gap:8px;flex-wrap:wrap">' +
        pend.map(function(k){ return '<div class="fin-bt" data-st="' + k + '" style="display:flex;gap:6px;align-items:center">' + chipStatus(k) + '<b>' + st[k].qtd + '</b><span class="fin-sub">' + moeda(st[k].valor) + '</span></div>'; }).join('') + '</div></div>';
    }
    h += '<div class="fin-card" style="margin-bottom:12px;overflow-x:auto"><div style="font-weight:700;font-size:13px;margin-bottom:8px">Contas bancárias</div>';
    if(!contas.length) h += '<div class="fin-vazio">Nenhuma conta cadastrada. ' + (pode('gestor') ? 'Cadastre em 🗂️ Cadastros › Contas, regras antifraude e acessos.' : 'Peça ao gestor para cadastrar.') + '</div>';
    else {
      h += '<table class="fin-tbl"><thead><tr><th>Conta</th><th style="text-align:right">Saldo banco</th><th>Saldo em</th><th>Último extrato</th><th style="text-align:right">Entradas</th><th style="text-align:right">Saídas</th></tr></thead><tbody>';
      contas.forEach(function(c){
        var dias = c.ultimo_import ? Math.floor((Date.now() - new Date(c.ultimo_import)) / 864e5) : null;
        h += '<tr><td><b>' + esc(c.nome) + '</b>' + (c.ativo ? '' : ' <span class="fin-sub">(inativa)</span>') + '<div class="fin-sub">' + esc(c.banco || '') + (c.formato ? ' · ' + c.formato.toUpperCase() : '') + '</div></td>' +
          '<td style="text-align:right;font-weight:700">' + (c.saldo_banco == null ? '-' : moeda(c.saldo_banco)) + '</td><td>' + dataBR(c.saldo_data) + '</td>' +
          '<td>' + (c.ultimo_import ? dataHoraBR(c.ultimo_import) + (dias > 7 ? ' <span class="fin-chip" style="background:#D68910;color:#fff">' + dias + 'd</span>' : '') : '<span class="fin-sub">nunca</span>') + '</td>' +
          '<td class="fin-ent" style="text-align:right">' + moeda(c.entradas) + '</td><td class="fin-sai" style="text-align:right">' + moeda(c.saidas) + '</td></tr>';
      });
      h += '</tbody></table>';
    }
    h += '</div>';
    var cats = (r.categorias || []);
    if(cats.length){
      h += '<div class="fin-card" style="overflow-x:auto"><div style="font-weight:700;font-size:13px;margin-bottom:8px">Por categoria (classificação das conferentes)</div><table class="fin-tbl"><thead><tr><th>Categoria</th><th style="text-align:right">Entradas</th><th style="text-align:right">Saídas</th></tr></thead><tbody>' +
        cats.map(function(c){ return '<tr><td>' + esc(c.categoria) + '</td><td class="fin-ent" style="text-align:right">' + (c.entradas ? moeda(c.entradas) : '-') + '</td><td class="fin-sai" style="text-align:right">' + (c.saidas ? moeda(c.saidas) : '-') + '</td></tr>'; }).join('') + '</tbody></table></div>';
    }
    out.innerHTML = h;
    out.querySelectorAll('[data-st]').forEach(function(b){ b.onclick = function(){ F.filtros = { ini: f.ini, fim: f.fim, status: b.getAttribute('data-st') }; F.sub = 'extrato'; render(); }; });
  } catch(e){ erroEm(out, e); }
}
function kpi(l, v, cor, sub, extra){ return '<div class="fin-card"><div class="fin-kl">' + l + '</div><div class="fin-kv"' + (cor ? ' style="color:' + cor + '"' : '') + '>' + v + '</div>' + (sub ? '<div class="fin-sub" style="margin-top:2px">' + sub + '</div>' : '') + (extra || '') + '</div>'; }

/* ================= EXTRATO ================= */
async function telaExtrato(el){
  var f = F.filtros = Object.assign({ ini: inicioMes(), fim: hoje(), status: 'abertos' }, F.filtros || {});
  el.innerHTML = '<div class="fin-filtros">' +
    '<select id="fe-conta">' + optsContas(f.conta_id, true) + '</select>' +
    '<input type="date" id="fe-ini" value="' + (f.ini || '') + '"><input type="date" id="fe-fim" value="' + (f.fim || '') + '">' +
    '<select id="fe-tipo"><option value="">Entradas e saídas</option><option value="entrada"' + (f.tipo === 'entrada' ? ' selected' : '') + '>Só entradas</option><option value="saida"' + (f.tipo === 'saida' ? ' selected' : '') + '>Só saídas</option></select>' +
    '<select id="fe-st"><option value="">Todos os status</option><option value="abertos"' + (f.status === 'abertos' ? ' selected' : '') + '>A conferir / com problema</option>' +
      Object.keys(STATUS).map(function(k){ return '<option value="' + k + '"' + (f.status === k ? ' selected' : '') + '>' + STATUS[k].t + '</option>'; }).join('') + '</select>' +
    '<input id="fe-q" placeholder="Buscar nome, descrição ou valor" value="' + esc(f.q || '') + '" style="min-width:180px">' +
    '<label class="fin-sub" style="display:flex;gap:4px;align-items:center"><input type="checkbox" id="fe-al"' + (f.com_alerta ? ' checked' : '') + '>com alerta</label>' +
    '<button class="fin-bt pri" id="fe-ok">Filtrar</button>' + (pode('gestor') ? '<button class="fin-bt" id="fe-csv">⬇️ Exportar</button>' : '') + '</div><div id="fe-out"></div>';
  var aplicar = function(){ F.filtros = { conta_id: $('fe-conta').value, ini: $('fe-ini').value, fim: $('fe-fim').value, tipo: $('fe-tipo').value, status: $('fe-st').value, q: $('fe-q').value.trim(), com_alerta: $('fe-al').checked }; F.pagina = 0; telaExtrato(el); };
  $('fe-ok').onclick = aplicar; $('fe-q').onkeydown = function(e){ if(e.key === 'Enter') aplicar(); };
  if($('fe-csv')) $('fe-csv').onclick = async function(){
    var b = this; b.disabled = true;
    try { var j = await api('exportar_csv', F.filtros); baixar('extrato-' + (F.filtros.ini || '') + '-a-' + (F.filtros.fim || '') + '.csv', j.csv, 'text/csv;charset=utf-8'); toast(j.qtd + ' linhas exportadas'); }
    catch(e){ toast(e.message, 'erro'); } finally { b.disabled = false; }
  };
  var out = $('fe-out'); carregando(out);
  try {
    var j = await api('extrato', Object.assign({ pagina: F.pagina }, f));
    if(!j.linhas.length){ out.innerHTML = '<div class="fin-vazio">Nada encontrado com esses filtros.' + (f.status === 'abertos' ? ' 🎉 Tudo conferido no período.' : '') + '</div>'; return; }
    var soma = j.linhas.reduce(function(a, l){ return a + Number(l.valor); }, 0);
    var h = '<div class="fin-sub" style="margin-bottom:6px">' + j.total + ' linha(s) · nesta página: ' + moeda(soma) + '</div><div class="fin-card" style="padding:0;overflow-x:auto"><table class="fin-tbl"><thead><tr><th>Data</th><th>Conta</th><th>Descrição</th><th style="text-align:right">Valor</th><th>Status</th><th>Categoria</th></tr></thead><tbody>';
    j.linhas.forEach(function(l){
      h += '<tr class="clic" data-id="' + l.id + '"><td style="white-space:nowrap">' + dataBR(l.data) + '</td><td class="fin-sub">' + esc(l.conta_nome) + '</td>' +
        '<td><div style="font-weight:600">' + esc(l.contraparte || l.descricao) + '</div>' + (l.contraparte ? '<div class="fin-sub">' + esc(l.descricao) + '</div>' : '') + '</td>' +
        '<td style="text-align:right" class="' + (l.valor > 0 ? 'fin-ent' : 'fin-sai') + '">' + moeda(l.valor) + '</td>' +
        '<td>' + chipStatus(l.status) + (l.alertas_abertos ? ' <span title="alertas abertos">🚨' + l.alertas_abertos + '</span>' : '') + (l.lancamento_id ? ' <span title="Conciliado com lançamento">🔗</span>' : '') + '</td>' +
        '<td class="fin-sub">' + esc(l.categoria || '') + '</td></tr>';
    });
    h += '</tbody></table></div>';
    var pags = Math.ceil(j.total / j.tam);
    if(pags > 1) h += '<div style="display:flex;gap:6px;justify-content:center;margin-top:10px;align-items:center"><button class="fin-bt" id="fe-ant"' + (F.pagina <= 0 ? ' disabled' : '') + '>‹ Anterior</button><span class="fin-sub">Página ' + (F.pagina + 1) + ' de ' + pags + '</span><button class="fin-bt" id="fe-prox"' + (F.pagina + 1 >= pags ? ' disabled' : '') + '>Próxima ›</button></div>';
    out.innerHTML = h;
    out.querySelectorAll('tr[data-id]').forEach(function(tr){ tr.onclick = function(){ abrirLinha(Number(tr.getAttribute('data-id')), function(){ telaExtrato(el); }); }; });
    if($('fe-ant')) $('fe-ant').onclick = function(){ F.pagina--; telaExtrato(el); };
    if($('fe-prox')) $('fe-prox').onclick = function(){ F.pagina++; telaExtrato(el); };
  } catch(e){ erroEm(out, e); }
}

function baixar(nomeArq, conteudo, tipo){
  var blob = new Blob([conteudo], { type: tipo || 'text/plain' }); var a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = nomeArq; document.body.appendChild(a); a.click(); setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function modal(html){
  var bg = document.createElement('div'); bg.className = 'fin-modal-bg';
  bg.innerHTML = '<div class="fin-modal">' + html + '</div>';
  document.body.appendChild(bg);
  var sujo = false;   // alguém digitou? então fechar sem querer pede confirmação
  bg.addEventListener('input', function(){ sujo = true; });
  bg.addEventListener('click', function(e){ if(e.target === bg) tentarFechar(); });
  function tecla(e){ if(e.key === 'Escape' && document.body.lastElementChild === bg) tentarFechar(); }
  document.addEventListener('keydown', tecla);
  function tentarFechar(){ if(!sujo || confirm('Fechar sem salvar? O que você digitou será perdido.')) fechar(); }
  function fechar(){ document.removeEventListener('keydown', tecla); bg.remove(); }
  return { el: bg.firstChild, fechar: fechar };
}
// caixa para pedir motivo/valor/data (no lugar do prompt(), que algumas telas de celular bloqueiam)
function pedirTexto(o){
  o = o || {};
  return new Promise(function(ok){
    var tipo = o.tipo || 'textarea', min = o.min || 0;
    var campo = tipo === 'textarea' ? '<textarea id="pt-v" rows="3" maxlength="' + (o.max || 500) + '" style="width:100%">' + esc(o.valor || '') + '</textarea>'
      : '<input id="pt-v" class="fin-in" type="' + (tipo === 'date' ? 'date' : 'text') + '"' + (tipo === 'valor' ? ' inputmode="decimal" placeholder="0,00"' : '') + ' value="' + esc(o.valor || '') + '" style="width:100%">';
    var m = modal('<div style="font-weight:700;margin-bottom:6px">' + esc(o.titulo || '') + '</div>' + (o.ajuda ? '<div class="fin-sub" style="margin-bottom:6px">' + esc(o.ajuda) + '</div>' : '') + campo +
      (min ? '<div class="fin-sub" data-pt="cont" style="margin-top:2px"></div>' : '') +
      '<div style="margin-top:10px;gap:8px;display:flex"><button class="fin-bt pri" data-pt="ok">' + esc(o.botao || 'Confirmar') + '</button><button class="fin-bt" data-pt="x">Voltar</button></div><div data-pt="err"></div>');
    var inp = m.el.querySelector('#pt-v'), cont = m.el.querySelector('[data-pt=cont]');
    var conta = function(){ if(cont) cont.textContent = inp.value.trim().length + ' de no mínimo ' + min + ' letras'; };
    if(cont){ inp.addEventListener('input', conta); conta(); }
    setTimeout(function(){ try { inp.focus(); } catch(e){} }, 30);
    m.el.querySelector('[data-pt=x]').onclick = function(){ m.fechar(); ok(null); };
    m.el.querySelector('[data-pt=ok]').onclick = function(){
      var v = inp.value.trim();
      if(min && v.length < min){ m.el.querySelector('[data-pt=err]').innerHTML = '<div class="fin-erro">Escreva pelo menos ' + min + ' letras.</div>'; return; }
      if(o.obrigatorio && !v){ m.el.querySelector('[data-pt=err]').innerHTML = '<div class="fin-erro">Preencha o campo.</div>'; return; }
      m.fechar(); ok(v);
    };
  });
}

/* ---------- detalhe + conferência de uma linha ---------- */
async function abrirLinha(id, aoMudar){
  var m = modal('<div class="fin-vazio">Carregando...</div>');
  var d;
  try { d = await api('linha', { id: id }); } catch(e){ m.el.innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div><button class="fin-bt" onclick="this.closest(\'.fin-modal-bg\').remove()">Fechar</button>'; return; }
  var l = d.linha;
  var chaveRasc = 'fin_rasc_' + ((((typeof getUsuarioLogado === 'function') && getUsuarioLogado()) || {}).id || '') + '_' + id;
  var rasc = {}; try { rasc = JSON.parse(sessionStorage.getItem(chaveRasc) || '{}'); } catch(e){}
  var idem = rasc.idem || uid();
  var escolhido = rasc.status || null;
  var h = '<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start"><div><div class="fin-sub">' + esc(l.conta_nome) + ' · ' + dataBR(l.data) + ' · linha #' + l.id + '</div>' +
    '<div style="font-size:17px;font-weight:800;margin-top:2px">' + esc(l.contraparte || l.descricao) + '</div><div class="fin-sub">' + esc(l.descricao) + (l.documento ? ' · doc ' + esc(l.documento) : '') + (l.contraparte_doc ? ' · ' + esc(l.contraparte_doc) : '') + '</div></div>' +
    '<div style="text-align:right"><div class="' + (l.valor > 0 ? 'fin-ent' : 'fin-sai') + '" style="font-size:20px">' + moeda(l.valor) + '</div>' + chipStatus(l.status) + '</div></div>';
  if(l.conf_necessarias > 1) h += '<div class="fin-aviso">Valor alto: precisa de <b>2 pessoas diferentes</b> conferindo (' + l.n_ok + ' de 2).</div>';
  if(d.alertas.length){
    h += '<div style="margin-top:12px;font-weight:700;font-size:12px">🚨 Alertas desta linha</div>';
    d.alertas.forEach(function(a){
      h += '<div class="fin-card" style="margin-top:6px;padding:9px">' + chipSev(a.severidade) + ' <b>' + esc(a.titulo) + '</b> <span class="fin-sub">' + (a.status === 'aberto' ? 'aberto' : esc(a.status) + ' por ' + esc(nome(a.resolvido_por))) + '</span>' +
        (a.detalhe && a.detalhe.explicacao ? '<div class="fin-sub" style="margin-top:3px">' + esc(a.detalhe.explicacao) + '</div>' : '') +
        (a.justificativa ? '<div class="fin-sub" style="margin-top:3px">Justificativa: ' + esc(a.justificativa) + '</div>' : '') + '</div>';
    });
  }
  // lançamento
  h += '<div style="margin-top:12px;font-weight:700;font-size:12px">🔗 Lançamento (Kamino)</div>';
  if(d.lancamento){
    var L = d.lancamento;
    h += '<div class="fin-card" style="margin-top:6px;padding:9px;font-size:12px"><b>' + esc(L.pessoa || '-') + '</b> · ' + moeda(L.valor) + ' · venc ' + dataBR(L.vencimento) + (L.data_pagamento ? ' · pago ' + dataBR(L.data_pagamento) : '') + '<div class="fin-sub">' + esc([L.descricao, L.categoria, L.situacao].filter(Boolean).join(' · ')) + '</div>' +
      (pode('gestor') ? '<button class="fin-bt" id="fl-desf" style="margin-top:6px">Desfazer vínculo</button>' : '') + '</div>';
  } else if(d.candidatos.length){
    h += '<div class="fin-sub" style="margin:4px 0">Lançamentos com o mesmo valor perto dessa data:</div>' + d.candidatos.map(function(L){
      return '<div class="fin-card" style="margin-top:4px;padding:8px;font-size:12px;display:flex;justify-content:space-between;gap:8px;align-items:center"><div><b>' + esc(L.pessoa || '-') + '</b> · venc ' + dataBR(L.vencimento) + (L.data_pagamento ? ' · pago ' + dataBR(L.data_pagamento) : '') + '<div class="fin-sub">' + esc([L.descricao, L.categoria].filter(Boolean).join(' · ')) + '</div></div>' +
        (pode('conferente') ? '<button class="fin-bt" data-vinc="' + L.id + '">Vincular</button>' : '') + '</div>';
    }).join('');
  } else h += '<div class="fin-sub" style="margin-top:4px">Nenhum lançamento com esse valor por perto.</div>';

  // histórico
  if(d.historico.length){
    h += '<div style="margin-top:12px;font-weight:700;font-size:12px">📜 Histórico de conferência (permanente)</div>';
    d.historico.slice().reverse().forEach(function(c){
      h += '<div style="font-size:12px;padding:6px 0;border-bottom:1px solid var(--border)">' + chipStatus(c.status) + ' <b>' + esc(nome(c.conferido_por)) + '</b> <span class="fin-sub">' + dataHoraBR(c.conferido_em) + '</span>' +
        (c.categoria ? ' · ' + esc(c.categoria) : '') + (c.observacao ? '<div class="fin-sub">' + esc(c.observacao) + '</div>' : '') + (c.referencia ? '<div class="fin-sub">Ref: ' + esc(c.referencia) + '</div>' : '') + '</div>';
    });
  }
  if(d.importacao) h += '<div class="fin-sub" style="margin-top:8px">Veio do arquivo <b>' + esc(d.importacao.arquivo_nome || '-') + '</b>, importado por ' + esc(nome(d.importacao.importado_por)) + ' em ' + dataHoraBR(d.importacao.importado_em) + '</div>';

  if(pode('conferente')){
    h += '<div class="fin-card" style="margin-top:14px"><div style="font-weight:800;font-size:13px;margin-bottom:8px">✍️ Sua conferência</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px"><button class="fin-bt ok" data-s="ok">✅ Confere</button><button class="fin-bt div" data-s="divergente">⚠️ Divergente</button><button class="fin-bt sus" data-s="suspeito">🚩 Suspeito</button></div>' +
      '<div class="fin-grid2"><div><div class="fin-sub">Categoria</div><select class="fin-in" id="fc-cat"><option value="">(não classificar)</option>' + F.categorias.map(function(c){ return '<option' + ((rasc.categoria || l.categoria) === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select></div>' +
      '<div><div class="fin-sub">Referência (nº NF, boleto, Kamino...)</div><input class="fin-in" id="fc-ref" maxlength="200" value="' + esc(rasc.referencia || '') + '"></div></div>' +
      '<div class="fin-sub" style="margin-top:8px">Observação <span id="fc-obr"></span></div><textarea class="fin-in" id="fc-obs" rows="3" maxlength="1000" placeholder="O que você conferiu? (obrigatório se divergente ou suspeito)">' + esc(rasc.observacao || '') + '</textarea>' +
      '<div id="fc-msg"></div><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px"><button class="fin-bt" id="fc-x">Fechar</button><button class="fin-bt pri" id="fc-salvar">Registrar conferência</button></div>' +
      '<div class="fin-sub" style="margin-top:6px">Toda conferência fica registrada para sempre com seu nome e horário. Para corrigir, registre uma nova.</div></div>';
  } else h += '<div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="fin-bt" id="fc-x">Fechar</button></div>';
  m.el.innerHTML = h;

  var salvarRasc = function(){ try { sessionStorage.setItem(chaveRasc, JSON.stringify({ idem: idem, status: escolhido, categoria: $('fc-cat') && $('fc-cat').value, referencia: $('fc-ref') && $('fc-ref').value, observacao: $('fc-obs') && $('fc-obs').value })); } catch(e){} };
  var marcar = function(){ m.el.querySelectorAll('[data-s]').forEach(function(b){ b.classList.toggle('sel', b.getAttribute('data-s') === escolhido); }); if($('fc-obr')) $('fc-obr').textContent = escolhido && escolhido !== 'ok' ? '(obrigatório, mínimo 10 letras)' : ''; };
  m.el.querySelectorAll('[data-s]').forEach(function(b){ b.onclick = function(){ escolhido = b.getAttribute('data-s'); marcar(); salvarRasc(); }; });
  ['fc-cat', 'fc-ref', 'fc-obs'].forEach(function(i){ if($(i)) $(i).oninput = salvarRasc; });
  marcar();
  $('fc-x').onclick = m.fechar;
  if($('fc-salvar')) $('fc-salvar').onclick = async function(){
    var b = this, msg = $('fc-msg');
    if(!escolhido){ msg.innerHTML = '<div class="fin-erro">Escolha Confere, Divergente ou Suspeito.</div>'; return; }
    var obs = $('fc-obs').value.trim();
    if(escolhido !== 'ok' && obs.length < 10){ msg.innerHTML = '<div class="fin-erro">Explique o problema na observação (mínimo 10 letras).</div>'; return; }
    b.disabled = true; b.textContent = 'Gravando...';
    try {
      await api('conferir', { extrato_id: id, status: escolhido, categoria: $('fc-cat').value || null, referencia: $('fc-ref').value.trim(), observacao: obs, idem: idem });
      try { sessionStorage.removeItem(chaveRasc); } catch(e){}
      toast('Conferência registrada'); m.fechar(); if(aoMudar) aoMudar();
    } catch(e){
      // mantém o rascunho e o MESMO idem: se a 1ª tentativa chegou a gravar, reenviar não duplica
      msg.innerHTML = '<div class="fin-erro">' + esc(e.message) + '<br>Seu texto continua salvo aqui. Tente de novo.</div>';
      b.disabled = false; b.textContent = 'Registrar conferência';
    }
  };
  m.el.querySelectorAll('[data-vinc]').forEach(function(b){ b.onclick = async function(){
    b.disabled = true;
    try { await api('conciliar_manual', { extrato_id: id, lancamento_id: Number(b.getAttribute('data-vinc')) }); toast('Vinculado'); m.fechar(); abrirLinha(id, aoMudar); if(aoMudar) aoMudar(); }
    catch(e){ toast(e.message, 'erro'); b.disabled = false; }
  }; });
  if($('fl-desf')) $('fl-desf').onclick = async function(){
    var motivo = await pedirTexto({ titulo: 'Desfazer o vínculo com o lançamento', ajuda: 'Fica registrado para sempre, com o seu nome.', min: 10 }); if(!motivo) return;
    try { await api('desfazer_conciliacao', { extrato_id: id, motivo: motivo }); toast('Vínculo desfeito'); m.fechar(); abrirLinha(id, aoMudar); } catch(e){ toast(e.message, 'erro'); }
  };
}

/* ================= ALERTAS ================= */
async function telaAlertas(el){
  var f = F.filtroAlerta = Object.assign({ status: 'aberto' }, F.filtroAlerta || {});
  el.innerHTML = '<div class="fin-filtros"><select id="fa-st"><option value="aberto">Abertos</option><option value="fechados"' + (f.status === 'fechados' ? ' selected' : '') + '>Resolvidos</option><option value="fraude_confirmada"' + (f.status === 'fraude_confirmada' ? ' selected' : '') + '>Fraudes confirmadas</option></select>' +
    '<select id="fa-sev"><option value="">Todas as severidades</option>' + Object.keys(SEV).map(function(k){ return '<option value="' + k + '"' + (f.severidade === k ? ' selected' : '') + '>' + SEV[k].t + '</option>'; }).join('') + '</select>' +
    '<select id="fa-conta">' + optsContas(f.conta_id, true) + '</select><button class="fin-bt pri" id="fa-ok">Filtrar</button>' +
    (pode('gestor') ? '<button class="fin-bt" id="fa-rodar" title="Roda todas as regras agora">🔍 Rodar regras agora</button>' : '') + '</div><div id="fa-out"></div>';
  $('fa-ok').onclick = function(){ F.filtroAlerta = { status: $('fa-st').value, severidade: $('fa-sev').value, conta_id: $('fa-conta').value }; telaAlertas(el); };
  if($('fa-rodar')) $('fa-rodar').onclick = async function(){
    var b = this; b.disabled = true; b.textContent = 'Rodando...';
    try { var j = await api('rodar_regras'); var tot = 0; Object.keys(j.novos || {}).forEach(function(k){ tot += j.novos[k]; }); toast(tot + ' alerta(s) novo(s)'); telaAlertas(el); }
    catch(e){ toast(e.message, 'erro'); b.disabled = false; }
  };
  var out = $('fa-out'); carregando(out);
  try {
    var j = await api('alertas', f);
    if(!j.alertas.length){ out.innerHTML = '<div class="fin-vazio">' + (f.status === 'aberto' ? '✅ Nenhum alerta aberto.' : 'Nada por aqui.') + '</div>'; return; }
    var h = '<div class="fin-sub" style="margin-bottom:6px">' + j.alertas.length + ' alerta(s)</div>';
    j.alertas.forEach(function(a){
      var ln = a.linha;
      h += '<div class="fin-card" style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><div>' + chipSev(a.severidade) + ' <span class="fin-chip" style="background:var(--border);color:var(--text2)">' + esc(REGRA[a.regra] || a.regra) + '</span> <b style="font-size:13px">' + esc(a.titulo) + '</b></div>' +
        '<div class="fin-sub">' + dataHoraBR(a.criado_em) + '</div></div>' +
        (a.detalhe && a.detalhe.explicacao ? '<div class="fin-sub" style="margin-top:4px">' + esc(a.detalhe.explicacao) + '</div>' : '') +
        detalheAlerta(a) +
        (ln ? '<div style="margin-top:6px;font-size:12px;cursor:pointer;text-decoration:underline dotted" data-linha="' + ln.id + '">' + dataBR(ln.data) + ' · ' + esc(ln.conta_nome) + ' · ' + esc(ln.contraparte || ln.descricao) + ' · <span class="' + (ln.valor > 0 ? 'fin-ent' : 'fin-sai') + '">' + moeda(ln.valor) + '</span> ' + chipStatus(ln.status) + '</div>' : '') +
        (a.status !== 'aberto' ? '<div class="fin-sub" style="margin-top:6px">✔️ ' + esc({ resolvido: 'Resolvido', falso_positivo: 'Falso positivo', fraude_confirmada: 'FRAUDE CONFIRMADA' }[a.status] || a.status) + ' por <b>' + esc(nome(a.resolvido_por)) + '</b> em ' + dataHoraBR(a.resolvido_em) + ': ' + esc(a.justificativa) + '</div>' :
          (pode('gestor') && (a.severidade !== 'critico' || F.papel === 'super') ? '<div style="margin-top:8px"><button class="fin-bt" data-res="' + a.id + '">Resolver</button></div>' : (a.severidade === 'critico' ? '<div class="fin-sub" style="margin-top:6px">Crítico: só o super admin resolve.</div>' : ''))) +
        '</div>';
    });
    out.innerHTML = h;
    out.querySelectorAll('[data-linha]').forEach(function(x){ x.onclick = function(){ abrirLinha(Number(x.getAttribute('data-linha')), function(){ telaAlertas(el); }); }; });
    out.querySelectorAll('[data-res]').forEach(function(b){ b.onclick = function(){ resolverAlerta(Number(b.getAttribute('data-res')), function(){ telaAlertas(el); }); }; });
  } catch(e){ erroEm(out, e); }
}
function detalheAlerta(a){
  var d = a.detalhe || {}, p = [];
  if(a.regra === 'LACUNA_SALDO') p.push('Saldo anterior ' + moeda(d.saldo_anterior) + ' (' + dataBR(d.data_anterior) + ') + movimentos ' + moeda(d.movimento) + ' = esperado <b>' + moeda(d.saldo_esperado) + '</b>, mas o banco diz <b>' + moeda(d.saldo_banco) + '</b> (' + dataBR(d.data) + '). Diferença <b style="color:#C0392B">' + moeda(d.diferenca) + '</b>.');
  if(a.regra === 'DUPLICIDADE') p.push('Pagamento igual em ' + dataBR(d.outra_data) + ' (' + esc(d.outra_conta) + ', linha #' + d.outro_extrato_id + ').');
  if(a.regra === 'FRACIONAMENTO') p.push('Soma no dia: <b>' + moeda(d.soma) + '</b> em ' + (d.ids || []).length + ' pagamentos.');
  if(a.regra === 'ACIMA_DA_MEDIA') p.push('Média anterior: ' + moeda(d.media_anterior) + ' em ' + d.qtd_anteriores + ' pagamentos.');
  if(a.regra === 'CONF_SUSPEITO' || a.regra === 'CONF_DIVERGENTE') p.push('Marcado por <b>' + esc(nome(d.conferido_por)) + '</b>: "' + esc(d.observacao) + '"');
  return p.length ? '<div style="font-size:12px;margin-top:4px">' + p.join('<br>') + '</div>' : '';
}
function resolverAlerta(id, aoMudar){
  var m = modal('<div style="font-weight:800;font-size:15px;margin-bottom:10px">Resolver alerta #' + id + '</div>' +
    '<div class="fin-sub">Desfecho</div><select class="fin-in" id="fr-st"><option value="resolvido">Resolvido (era legítimo, verificado)</option><option value="falso_positivo">Falso positivo (regra errou)</option><option value="fraude_confirmada">🚩 FRAUDE CONFIRMADA</option></select>' +
    '<div class="fin-sub" style="margin-top:8px">Justificativa (o que você verificou? mínimo 15 letras)</div><textarea class="fin-in" id="fr-j" rows="4" maxlength="1000" placeholder="Ex: conferi a NF 1234 do fornecedor e o contrato assinado em 10/10"></textarea>' +
    '<div class="fin-aviso">A resolução é permanente, fica com seu nome e não pode ser desfeita.</div><div id="fr-msg"></div>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px"><button class="fin-bt" id="fr-x">Cancelar</button><button class="fin-bt pri" id="fr-ok">Registrar</button></div>');
  $('fr-x').onclick = m.fechar;
  $('fr-ok').onclick = async function(){
    var b = this, j = $('fr-j').value.trim();
    if(j.length < 15){ $('fr-msg').innerHTML = '<div class="fin-erro">Justificativa muito curta (mínimo 15 letras).</div>'; return; }
    if($('fr-st').value === 'fraude_confirmada' && !confirm('Confirmar que é FRAUDE? Isso fica registrado para sempre.')) return;
    b.disabled = true;
    try { await api('resolver_alerta', { id: id, status: $('fr-st').value, justificativa: j }); toast('Alerta resolvido'); m.fechar(); aoMudar && aoMudar(); }
    catch(e){ $('fr-msg').innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; b.disabled = false; }
  };
}

/* ================= IMPORTAR ================= */
async function lerArquivo(file){
  if(/\.xlsx?$/i.test(file.name)) throw new Error('Envie o extrato em OFX (melhor) ou CSV. No Excel: Arquivo › Salvar como › CSV.');
  var bytes = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch(e){ return new TextDecoder('windows-1252').decode(bytes); }   // OFX de banco BR costuma vir em Latin-1
}

function telaImportar(el){
  el.innerHTML = '<div class="fin-grid2">' +
    '<div class="fin-card"><div style="font-weight:800;font-size:14px">🏦 Extrato bancário</div><div class="fin-sub" style="margin:4px 0 10px">OFX (recomendado) ou CSV, direto do banco (Cora). Pode mandar período que já foi importado: linhas repetidas são ignoradas sozinhas.</div>' +
      '<div class="fin-sub">Conta</div><select class="fin-in" id="fi-conta">' + optsContas('', false) + '</select>' +
      '<div class="fin-sub" style="margin-top:8px">Arquivo</div><input type="file" class="fin-in" id="fi-arq" accept=".ofx,.csv,.txt,.xlsx,.xls">' +
      '<div style="margin-top:10px"><button class="fin-bt pri" id="fi-prev">Conferir arquivo</button></div><div id="fi-out"></div></div>' +
    (pode('gestor') ? '<div class="fin-card"><div style="font-weight:800;font-size:14px">🧾 Lançamentos do Kamino</div><div class="fin-sub" style="margin:4px 0 10px">Kamino › Exportação (CSV/Excel) de contas a pagar ou receber. Serve pra cruzar: toda saída do banco precisa ter um lançamento. Quando a API do Kamino liberar, isso entra sozinho.</div>' +
      '<div class="fin-sub">Tipo</div><select class="fin-in" id="fk-tipo"><option value="pagar">Contas a pagar</option><option value="receber">Contas a receber</option><option value="">Misto (coluna Tipo no arquivo)</option></select>' +
      '<div class="fin-sub" style="margin-top:8px">Arquivo</div><input type="file" class="fin-in" id="fk-arq" accept=".csv,.txt,.xlsx,.xls">' +
      '<div style="margin-top:10px"><button class="fin-bt pri" id="fk-prev">Conferir arquivo</button></div><div id="fk-out"></div></div>' : '') +
    '</div><div class="fin-card" style="margin-top:12px"><div style="font-weight:700;font-size:13px;margin-bottom:6px">Histórico de importações</div><div id="fi-hist"><div class="fin-vazio">Carregando...</div></div></div>';

  $('fi-prev').onclick = async function(){
    var out = $('fi-out'), b = this, conta = $('fi-conta').value, file = $('fi-arq').files[0];
    if(!conta){ out.innerHTML = '<div class="fin-erro">Escolha a conta.</div>'; return; }
    if(!file){ out.innerHTML = '<div class="fin-erro">Escolha o arquivo.</div>'; return; }
    b.disabled = true; out.innerHTML = '<div class="fin-vazio">Lendo...</div>';
    try {
      var conteudo = await lerArquivo(file);
      var dados = { conta_id: conta, arquivo_nome: file.name, conteudo: conteudo };
      var j = await api('importar_preview', dados), r = j.resumo;
      var h = '<div style="margin-top:12px;font-size:12px;line-height:1.7"><b>' + r.linhas + '</b> movimentações · <b style="color:#1D9E75">' + r.novas + ' novas</b> · ' + r.duplicadas + ' já existiam<br>Período ' + dataBR(r.periodo_ini) + ' a ' + dataBR(r.periodo_fim) +
        '<br>Entradas <span class="fin-ent">' + moeda(r.soma_creditos) + '</span> · Saídas <span class="fin-sai">' + moeda(r.soma_debitos) + '</span>' + (r.saldo_final != null ? '<br>Saldo do banco em ' + dataBR(r.saldo_data) + ': <b>' + moeda(r.saldo_final) + '</b>' : '') + '</div>';
      (r.avisos || []).forEach(function(a){ h += '<div class="fin-aviso">' + esc(a) + '</div>'; });
      if(r.ja_importado) h += '<div class="fin-erro">Este arquivo já foi importado por ' + esc(nome(r.ja_importado.importado_por)) + ' em ' + dataHoraBR(r.ja_importado.importado_em) + '.</div>';
      h += '<table class="fin-tbl" style="margin-top:6px"><tbody>' + r.amostra.map(function(l){ return '<tr><td>' + dataBR(l.data) + '</td><td>' + esc(l.contraparte || l.descricao) + '</td><td style="text-align:right" class="' + (l.valor > 0 ? 'fin-ent' : 'fin-sai') + '">' + moeda(l.valor) + '</td></tr>'; }).join('') + '</tbody></table><div class="fin-sub">Primeiras ' + r.amostra.length + ' linhas</div>';
      var temAtencao = (r.avisos || []).some(function(a){ return /^ATENÇÃO/.test(a); });
      if(!r.ja_importado && r.novas > 0) h += (temAtencao ? '<label class="fin-sub" style="display:flex;gap:6px;align-items:center;margin-top:8px;color:#C0392B"><input type="checkbox" id="fi-ciente"> Conferi: este arquivo é mesmo da conta escolhida</label>' : '') +
        '<div style="margin-top:10px"><button class="fin-bt ok" id="fi-ok">Importar ' + r.novas + ' linha(s) nova(s)</button></div>';
      else if(!r.ja_importado) h += '<div class="fin-aviso">Nada novo neste arquivo.</div>';
      out.innerHTML = h;
      if($('fi-ok')) $('fi-ok').onclick = async function(){
        if($('fi-ciente') && !$('fi-ciente').checked){ toast('O arquivo parece ser de outra conta: confira e marque a caixa', 'aviso'); return; }
        var b2 = this; b2.disabled = true; b2.textContent = 'Importando...';
        try {
          var k = await api('importar_extrato', dados);
          var tot = 0; Object.keys(k.alertas_novos || {}).forEach(function(x){ tot += k.alertas_novos[x]; });
          out.innerHTML = '<div class="fin-card" style="margin-top:10px;border-color:#1D9E75">✅ <b>' + k.novas + '</b> linha(s) importada(s), ' + k.duplicadas + ' ignorada(s) por já existirem.' + (tot ? '<br>🚨 <b>' + tot + '</b> alerta(s) novo(s) gerado(s). Veja em Alertas.' : '') + '</div>';
          $('fi-arq').value = ''; historico();
        } catch(e){ out.insertAdjacentHTML('beforeend', '<div class="fin-erro">' + esc(e.message) + '</div>'); b2.disabled = false; b2.textContent = 'Tentar de novo'; }
      };
    } catch(e){ out.innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; }
    finally { b.disabled = false; }
  };

  if($('fk-prev')) $('fk-prev').onclick = async function(){
    var out = $('fk-out'), b = this, file = $('fk-arq').files[0];
    if(!file){ out.innerHTML = '<div class="fin-erro">Escolha o arquivo.</div>'; return; }
    b.disabled = true; out.innerHTML = '<div class="fin-vazio">Lendo...</div>';
    try {
      var conteudo = await lerArquivo(file);
      var dados = { tipo_lanc: $('fk-tipo').value, arquivo_nome: file.name, conteudo: conteudo };
      var j = await api('importar_lancamentos', dados), r = j.resumo;
      var h = '<div style="margin-top:12px;font-size:12px;line-height:1.7"><b>' + r.linhas + '</b> lançamentos · ' + dataBR(r.periodo_ini) + ' a ' + dataBR(r.periodo_fim) + '<br>A pagar ' + moeda(r.total_pagar) + ' · A receber ' + moeda(r.total_receber) + '</div>' +
        '<table class="fin-tbl"><tbody>' + r.amostra.map(function(l){ return '<tr><td>' + (l.tipo === 'pagar' ? '🔻' : '🔺') + '</td><td>' + esc(l.pessoa || '-') + '</td><td>' + dataBR(l.vencimento) + '</td><td style="text-align:right">' + moeda(l.valor) + '</td><td class="fin-sub">' + esc(l.situacao || '') + '</td></tr>'; }).join('') + '</tbody></table>' +
        '<div style="margin-top:10px"><button class="fin-bt ok" id="fk-ok">Importar</button></div>';
      out.innerHTML = h;
      $('fk-ok').onclick = async function(){
        var b2 = this; b2.disabled = true; b2.textContent = 'Importando...';
        try { var k = await api('importar_lancamentos', Object.assign({ confirmar: true }, dados)); out.innerHTML = '<div class="fin-card" style="margin-top:10px;border-color:#1D9E75">✅ ' + k.linhas + ' lançamento(s), ' + k.novas + ' novo(s), ' + k.conciliadas + ' vinculado(s) automaticamente ao extrato.' + (k.pessoas_novas ? ' ' + k.pessoas_novas + ' pessoa(s) cadastrada(s) automaticamente.' : '') + (k.sem_classificacao ? ' <b>' + k.sem_classificacao + ' sem classificação reconhecida</b>: confira em Pagar › Lista.' : '') + '</div>'; historico(); }
        catch(e){ out.insertAdjacentHTML('beforeend', '<div class="fin-erro">' + esc(e.message) + '</div>'); b2.disabled = false; b2.textContent = 'Tentar de novo'; }
      };
    } catch(e){ out.innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; }
    finally { b.disabled = false; }
  };

  async function historico(){
    var hd = $('fi-hist'); if(!hd) return;
    try {
      var j = await api('importacoes');
      if(!j.importacoes.length){ hd.innerHTML = '<div class="fin-vazio">Nenhuma importação ainda.</div>'; return; }
      var nomeConta = {}; F.contas.forEach(function(c){ nomeConta[c.id] = c.nome; });
      hd.innerHTML = '<div style="overflow-x:auto"><table class="fin-tbl"><thead><tr><th>Quando</th><th>Quem</th><th>Conta</th><th>Arquivo</th><th>Período</th><th style="text-align:right">Novas / repetidas</th><th style="text-align:right">Saldo banco</th>' + (pode('gestor') ? '<th></th>' : '') + '</tr></thead><tbody>' +
        j.importacoes.slice(0, 60).map(function(i){ return '<tr><td>' + dataHoraBR(i.importado_em) + '</td><td>' + esc(nome(i.importado_por)) + '</td><td>' + esc(i.tipo === 'extrato' ? (nomeConta[i.conta_id] || '-') : '🧾 Lançamentos') + '</td><td class="fin-sub">' + esc(i.arquivo_nome || '') + '</td><td>' + dataBR(i.periodo_ini) + ' a ' + dataBR(i.periodo_fim) + '</td><td style="text-align:right">' + i.qtd_novas + ' / ' + i.qtd_duplicadas + '</td><td style="text-align:right">' + (i.saldo_final != null ? moeda(i.saldo_final) : '-') + '</td>' +
          (pode('gestor') ? '<td><button class="fin-bt" data-arq="' + i.id + '" title="Baixar o arquivo original guardado">⬇️</button></td>' : '') + '</tr>'; }).join('') + '</tbody></table></div>';
      hd.querySelectorAll('[data-arq]').forEach(function(b){ b.onclick = async function(){ try { var a = await api('baixar_arquivo', { id: b.getAttribute('data-arq') }); baixar(a.arquivo_nome || 'arquivo.txt', a.conteudo || ''); } catch(e){ toast(e.message, 'erro'); } }; });
    } catch(e){ erroEm(hd, e); }
  }
  historico();
}

/* ================= LANÇAMENTOS ================= */
async function telaLancamentos(el){
  var f = F.filtroLanc = F.filtroLanc || { tipo: 'pagar', ini: '', fim: '' };
  el.innerHTML = '<div class="fin-filtros"><select id="fl-tipo"><option value="pagar">A pagar</option><option value="receber"' + (f.tipo === 'receber' ? ' selected' : '') + '>A receber</option><option value=""' + (f.tipo === '' ? ' selected' : '') + '>Todos</option></select><span class="fin-sub">Vencimento</span><input type="date" id="fl-ini" value="' + f.ini + '"><input type="date" id="fl-fim" value="' + f.fim + '"><select id="fl-vinc"><option value="">Todos</option><option value="sem"' + (f.vinc === 'sem' ? ' selected' : '') + '>Sem saída no extrato</option><option value="com"' + (f.vinc === 'com' ? ' selected' : '') + '>Batidos com o extrato</option></select><button class="fin-bt pri" id="fl-ok">Filtrar</button></div><div id="fl-out"></div>';
  $('fl-ok').onclick = function(){ F.filtroLanc = { tipo: $('fl-tipo').value, ini: $('fl-ini').value, fim: $('fl-fim').value, vinc: $('fl-vinc').value }; telaLancamentos(el); };
  var out = $('fl-out'); carregando(out);
  try {
    var j = await api('lancamentos', f), lista = j.lancamentos;
    if(f.vinc === 'sem') lista = lista.filter(function(l){ return !l.extrato_id; });
    if(f.vinc === 'com') lista = lista.filter(function(l){ return l.extrato_id; });
    if(!lista.length){ out.innerHTML = '<div class="fin-vazio">Nenhum lançamento. ' + (pode('gestor') ? 'Importe a exportação do Kamino em 🏦 Contas › Importar extrato / Kamino.' : '') + '</div>'; return; }
    var tot = lista.reduce(function(a, l){ return a + Number(l.valor); }, 0);
    out.innerHTML = '<div class="fin-sub" style="margin-bottom:6px">' + lista.length + ' lançamento(s) · ' + moeda(tot) + '</div><div class="fin-card" style="padding:0;overflow-x:auto"><table class="fin-tbl"><thead><tr><th></th><th>Pessoa</th><th>Vencimento</th><th>Pago em</th><th style="text-align:right">Valor</th><th>Situação</th><th>Categoria</th><th>Extrato</th></tr></thead><tbody>' +
      lista.slice(0, 1500).map(function(l){ return '<tr' + (l.extrato_id ? ' class="clic" data-ext="' + l.extrato_id + '"' : '') + '><td>' + (l.tipo === 'pagar' ? '🔻' : '🔺') + '</td><td><b>' + esc(l.pessoa || '-') + '</b><div class="fin-sub">' + esc(l.descricao || '') + '</div></td><td>' + dataBR(l.vencimento) + '</td><td>' + dataBR(l.data_pagamento) + '</td><td style="text-align:right;font-weight:700">' + moeda(l.valor) + '</td><td class="fin-sub">' + esc(l.situacao || '') + '</td><td class="fin-sub">' + esc(l.categoria || '') + '</td><td>' + (l.extrato_id ? '🔗 #' + l.extrato_id : (l.data_pagamento ? '<span class="fin-chip" style="background:#D68910;color:#fff">sem saída</span>' : '-')) + '</td></tr>'; }).join('') + '</tbody></table></div>';
    out.querySelectorAll('[data-ext]').forEach(function(tr){ tr.onclick = function(){ abrirLinha(Number(tr.getAttribute('data-ext'))); }; });
  } catch(e){ erroEm(out, e); }
}

/* ================= CONFIGURAÇÕES ================= */
async function telaConfig(el){
  el.innerHTML = '<div class="fin-grid2"><div class="fin-card"><div style="font-weight:800;font-size:14px;margin-bottom:8px">🏦 Contas bancárias</div><div id="fc-contas"></div></div>' +
    '<div class="fin-card"><div style="font-weight:800;font-size:14px;margin-bottom:8px">🎚️ Regras antifraude</div><div id="fc-cfg"></div></div></div>' +
    '<div class="fin-card" style="margin-top:12px"><div style="font-weight:800;font-size:14px;margin-bottom:4px">✅ Favorecidos confiáveis</div><div class="fin-sub" style="margin-bottom:8px">Silencia só os alertas de "favorecido novo" e "é da equipe" (ex.: salário, fornecedor fixo). Duplicidade, fracionamento e valor fora da média continuam valendo.</div><div id="fc-benef"></div></div>' +
    (F.papel === 'super' ? '<div class="fin-card" style="margin-top:12px"><div style="font-weight:800;font-size:14px;margin-bottom:4px">👥 Quem acessa o financeiro</div><div class="fin-sub" style="margin-bottom:8px"><b>Conferente</b>: confere linhas e importa extrato. <b>Gestor</b>: tudo isso + resolve alertas, contas, regras, auditoria. <b>Leitura</b>: só vê. Você (super admin) sempre tem acesso total.</div><div id="fc-acesso"></div></div>' : '');

  // contas
  (function contas(){
    var d = $('fc-contas');
    d.innerHTML = (F.contas.length ? '<table class="fin-tbl"><tbody>' + F.contas.map(function(c){ return '<tr><td><b>' + esc(c.nome) + '</b><div class="fin-sub">' + esc([c.banco, c.agencia, c.numero, c.cidade_slug].filter(Boolean).join(' · ')) + (c.formato ? ' · ' + c.formato.toUpperCase() : '') + '</div></td><td>' + (c.ativo ? '' : '<span class="fin-sub">inativa</span>') + '</td><td style="text-align:right"><button class="fin-bt" data-ec="' + c.id + '">Editar</button></td></tr>'; }).join('') + '</tbody></table>' : '<div class="fin-sub">Nenhuma conta.</div>') +
      '<button class="fin-bt pri" id="fc-nova" style="margin-top:8px">+ Nova conta</button>';
    $('fc-nova').onclick = function(){ editarConta(null, recarregar); };
    d.querySelectorAll('[data-ec]').forEach(function(b){ b.onclick = function(){ editarConta(F.contas.find(function(c){ return c.id === b.getAttribute('data-ec'); }), recarregar); }; });
  })();
  async function recarregar(){ try { F.contas = (await api('contas')).contas || []; } catch(e){} telaConfig(el); }

  // parâmetros
  (async function(){
    var d = $('fc-cfg'); carregando(d);
    try {
      var j = await api('config');
      d.innerHTML = j.config.map(function(c){ var v = c.valor; return '<div style="margin-bottom:9px"><div class="fin-sub">' + esc(c.descricao || c.chave) + '</div><div style="display:flex;gap:6px">' +
        (c.chave === 'exigir_lastro' ? '<select class="fin-in" data-cfg="' + c.chave + '"><option value="false"' + (v ? '' : ' selected') + '>Desligado</option><option value="true"' + (v ? ' selected' : '') + '>Ligado</option></select>' : '<input class="fin-in" type="number" step="any" min="0" data-cfg="' + c.chave + '" value="' + esc(v) + '">') +
        '<button class="fin-bt" data-sc="' + c.chave + '">Salvar</button></div>' + (c.atualizado_por ? '<div class="fin-sub">alterado por ' + esc(nome(c.atualizado_por)) + ' em ' + dataHoraBR(c.atualizado_em) + '</div>' : '') + '</div>'; }).join('');
      d.querySelectorAll('[data-sc]').forEach(function(b){ b.onclick = async function(){
        var k = b.getAttribute('data-sc'), inp = d.querySelector('[data-cfg="' + k + '"]');
        b.disabled = true; try { await api('salvar_config', { chave: k, valor: inp.value }); toast('Salvo'); } catch(e){ toast(e.message, 'erro'); } b.disabled = false;
      }; });
    } catch(e){ erroEm(d, e); }
  })();

  // favorecidos
  (async function benef(){
    var d = $('fc-benef'); carregando(d);
    try {
      var j = await api('benef_listar');
      var ativos = j.benef.filter(function(b){ return b.ativo; });
      d.innerHTML = '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"><input class="fin-in" id="fb-nome" placeholder="Nome como aparece no extrato" style="flex:1;min-width:180px"><input class="fin-in" id="fb-mot" placeholder="Motivo (ex: salário CLT, contrato)" style="flex:1;min-width:180px"><button class="fin-bt pri" id="fb-add">Adicionar</button></div>' +
        (ativos.length ? '<table class="fin-tbl"><tbody>' + ativos.map(function(b){ return '<tr><td><b>' + esc(b.nome_exibicao || b.contraparte_norm) + '</b><div class="fin-sub">' + esc(b.motivo) + ' · ' + esc(nome(b.aprovado_por)) + ' em ' + dataBR(b.aprovado_em) + '</div></td><td style="text-align:right"><button class="fin-bt" data-rb="' + b.id + '">Remover</button></td></tr>'; }).join('') + '</tbody></table>' : '<div class="fin-sub">Nenhum.</div>');
      $('fb-add').onclick = async function(){ try { await api('benef_confiar', { nome: $('fb-nome').value, motivo: $('fb-mot').value }); toast('Adicionado'); benef(); } catch(e){ toast(e.message, 'erro'); } };
      d.querySelectorAll('[data-rb]').forEach(function(b){ b.onclick = async function(){ if(!confirm('Remover da lista de confiáveis?')) return; try { await api('benef_revogar', { id: Number(b.getAttribute('data-rb')) }); benef(); } catch(e){ toast(e.message, 'erro'); } }; });
    } catch(e){ erroEm(d, e); }
  })();

  // acessos (super)
  if(F.papel === 'super') (async function acesso(){
    var d = $('fc-acesso'); carregando(d);
    try {
      var j = await api('acesso_listar');
      var pNome = {}; j.pessoas.forEach(function(p){ pNome[p.id] = p.nome; F.nomes[p.id] = p.nome; });
      d.innerHTML = '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"><select class="fin-in" id="fac-p" style="flex:2;min-width:200px"><option value="">Escolha a pessoa...</option>' + j.pessoas.map(function(p){ return '<option value="' + esc(p.id) + '">' + esc(p.nome) + (p.cargo ? ' · ' + esc(p.cargo) : '') + '</option>'; }).join('') + '</select>' +
        '<select class="fin-in" id="fac-r" style="flex:1;min-width:120px"><option value="conferente">Conferente</option><option value="gestor">Gestor</option><option value="leitor">Leitura</option></select><button class="fin-bt pri" id="fac-add">Liberar</button></div>' +
        (j.acessos.length ? '<table class="fin-tbl"><tbody>' + j.acessos.map(function(a){ return '<tr><td><b>' + esc(pNome[a.pessoa_id] || a.pessoa_id) + '</b><div class="fin-sub">' + esc(a.papel) + (a.ativo ? '' : ' · REVOGADO') + ' · liberado por ' + esc(nome(a.criado_por)) + ' em ' + dataBR(a.criado_em) + '</div></td><td style="text-align:right">' + (a.ativo ? '<button class="fin-bt" data-rev="' + esc(a.pessoa_id) + '" data-pp="' + a.papel + '">Revogar</button>' : '<button class="fin-bt" data-reat="' + esc(a.pessoa_id) + '" data-pp="' + a.papel + '">Reativar</button>') + '</td></tr>'; }).join('') + '</tbody></table>' : '<div class="fin-sub">Só você tem acesso por enquanto.</div>');
      $('fac-add').onclick = async function(){ var p = $('fac-p').value; if(!p) return toast('Escolha a pessoa', 'aviso'); try { await api('acesso_salvar', { pessoa_id: p, papel: $('fac-r').value, ativo: true }); toast('Acesso liberado'); acesso(); } catch(e){ toast(e.message, 'erro'); } };
      d.querySelectorAll('[data-rev],[data-reat]').forEach(function(b){ b.onclick = async function(){ var rev = b.hasAttribute('data-rev'); var p = b.getAttribute(rev ? 'data-rev' : 'data-reat'); if(rev && !confirm('Revogar o acesso de ' + (pNome[p] || p) + '?')) return; try { await api('acesso_salvar', { pessoa_id: p, papel: b.getAttribute('data-pp'), ativo: !rev }); acesso(); } catch(e){ toast(e.message, 'erro'); } }; });
    } catch(e){ erroEm(d, e); }
  })();
}
function editarConta(c, aoSalvar){
  c = c || {};
  var m = modal('<div style="font-weight:800;font-size:15px;margin-bottom:10px">' + (c.id ? 'Editar conta' : 'Nova conta bancária') + '</div><div class="fin-grid2">' +
    campo('Nome (ex: Cora Aracaju)', 'ec-nome', c.nome) + campo('Banco', 'ec-banco', c.banco || 'Cora') + campo('Agência', 'ec-ag', c.agencia) + campo('Número da conta', 'ec-num', c.numero) + campo('Cidade (slug, ex: aracaju)', 'ec-cid', c.cidade_slug) + campo('Unidade de negócio', 'ec-uni', c.unidade) + '</div>' +
    (c.id ? '<label style="display:flex;gap:6px;align-items:center;margin-top:8px;font-size:12px"><input type="checkbox" id="ec-at"' + (c.ativo ? ' checked' : '') + '> Conta ativa</label>' : '') +
    '<div class="fin-sub" style="margin-top:8px">O número da conta é usado pra avisar se alguém importar o arquivo na conta errada.</div><div id="ec-msg"></div><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px"><button class="fin-bt" id="ec-x">Cancelar</button><button class="fin-bt pri" id="ec-ok">Salvar</button></div>');
  $('ec-x').onclick = m.fechar;
  $('ec-ok').onclick = async function(){
    var b = this; b.disabled = true;
    try { await api('salvar_conta', { id: c.id || null, nome: $('ec-nome').value, banco: $('ec-banco').value, agencia: $('ec-ag').value, numero: $('ec-num').value, cidade_slug: $('ec-cid').value, unidade: $('ec-uni').value, ativo: c.id ? $('ec-at').checked : true }); toast('Conta salva'); m.fechar(); aoSalvar && aoSalvar(); }
    catch(e){ $('ec-msg').innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; b.disabled = false; }
  };
}
function campo(l, id, v){ return '<div><div class="fin-sub">' + l + '</div><input class="fin-in" id="' + id + '" value="' + esc(v || '') + '"></div>'; }

/* ================= AUDITORIA ================= */
async function telaAuditoria(el){
  F.audPag = F.audPag || 0;
  el.innerHTML = '<div class="fin-card" style="margin-bottom:10px"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><div style="flex:1;min-width:220px"><b>🔏 Registro permanente</b><div class="fin-sub">Cada ação (importar, conferir, resolver, mudar regra ou acesso) vira um registro encadeado ao anterior por uma impressão digital (hash). Se alguém alterar ou apagar qualquer coisa direto no banco, a verificação acusa exatamente onde. Backup automático todo dia às 7h em cofre separado.</div></div><button class="fin-bt pri" id="fa-ver">Verificar integridade agora</button></div><div id="fa-res"></div></div><div id="fa-lista"></div>';
  $('fa-ver').onclick = async function(){
    var b = this; b.disabled = true; var r = $('fa-res');
    try { var i = (await api('verificar_integridade')).integridade; r.innerHTML = i.ok ? '<div class="fin-card" style="margin-top:8px;border-color:#1D9E75">✅ Íntegro: ' + i.total + ' registros conferidos, nenhum alterado ou faltando.</div>' : '<div class="fin-erro">⛔ QUEBRA NA CADEIA no registro ' + esc(i.quebra_seq) + ': ' + esc(i.motivo) + '. Avise o super admin e não mexa em nada.</div>'; }
    catch(e){ r.innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; } b.disabled = false;
  };
  var out = $('fa-lista'); carregando(out);
  try {
    var j = await api('auditoria', { pagina: F.audPag });
    var ACAO = { fin_conferencias: 'Conferência', fin_extrato: 'Linha de extrato', fin_importacoes: 'Importação', fin_alertas: 'Alerta', fin_config: 'Regra', fin_acesso: 'Acesso', fin_contas: 'Conta', fin_lancamentos: 'Lançamento', fin_conciliacoes: 'Vínculo', fin_benef_confiaveis: 'Favorecido confiável' };
    out.innerHTML = '<div class="fin-card" style="padding:0;overflow-x:auto"><table class="fin-tbl"><thead><tr><th>#</th><th>Quando</th><th>Quem</th><th>O quê</th><th>Detalhe</th></tr></thead><tbody>' + j.registros.map(function(r){
      var d = r.depois || {}, det = '';
      if(r.tabela === 'fin_conferencias') det = (d.status || '') + ' na linha #' + d.extrato_id + (d.observacao ? ': ' + d.observacao : '');
      else if(r.tabela === 'fin_extrato') det = dataBR(d.data) + ' ' + moeda(d.valor) + ' ' + (d.contraparte || d.descricao || '');
      else if(r.tabela === 'fin_alertas') det = r.acao === 'UPDATE' ? (d.status + ': ' + (d.justificativa || '')) : (d.titulo || '');
      else if(r.tabela === 'fin_importacoes') det = (d.arquivo_nome || '') + ' · ' + d.qtd_novas + ' novas';
      else if(r.tabela === 'fin_config') det = d.chave + ' = ' + JSON.stringify(d.valor) + (r.antes ? ' (antes ' + JSON.stringify(r.antes.valor) + ')' : '');
      else if(r.tabela === 'fin_acesso') det = nome(d.pessoa_id) + ' → ' + d.papel + (d.ativo ? '' : ' (revogado)');
      else det = r.registro_id || '';
      return '<tr><td class="fin-sub">' + r.seq + '</td><td style="white-space:nowrap">' + dataHoraBR(r.ts) + '</td><td>' + esc(nome(r.ator)) + '</td><td>' + esc((ACAO[r.tabela] || r.tabela) + (r.acao === 'UPDATE' ? ' (alteração)' : '')) + '</td><td class="fin-sub" style="max-width:380px">' + esc(String(det).slice(0, 200)) + '<div style="font-family:monospace;font-size:9px;opacity:.6">' + esc(r.hash.slice(0, 16)) + '…</div></td></tr>';
    }).join('') + '</tbody></table></div>' +
    '<div style="display:flex;gap:6px;justify-content:center;margin-top:10px;align-items:center"><button class="fin-bt" id="fa-ant"' + (F.audPag <= 0 ? ' disabled' : '') + '>‹ Mais novos</button><span class="fin-sub">' + j.total + ' registros</span><button class="fin-bt" id="fa-prox"' + ((F.audPag + 1) * 100 >= j.total ? ' disabled' : '') + '>Mais antigos ›</button></div>';
    $('fa-ant').onclick = function(){ F.audPag--; telaAuditoria(el); };
    $('fa-prox').onclick = function(){ F.audPag++; telaAuditoria(el); };
  } catch(e){ erroEm(out, e); }
}

})();
