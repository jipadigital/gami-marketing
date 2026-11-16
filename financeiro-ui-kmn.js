/* ============================================================
   🔎 FINANCEIRO · CONFERÊNCIA DO KAMINO (v9, 16/11/2026)
   O servidor puxa o Kamino sozinho a cada 10 min (kamino-sync). Aqui as meninas do financeiro,
   a Leomara e a diretoria conferem cada pagamento/recebimento.
   Regras (garantidas no BANCO, a tela só ajuda): conferência é da VERSÃO do lançamento (mudou no
   Kamino = conferir de novo); quem lançou no Kamino não confere; acima do limite precisa de
   2 pessoas; nada se apaga.
   ============================================================ */
(function(){
'use strict';
var U = window._FINUI; if(!U){ console.error('financeiro-ui-kmn: carregue financeiro-ui.js antes'); return; }
var api = U.api, esc = U.esc, moeda = U.moeda, dataBR = U.dataBR, dataHoraBR = U.dataHoraBR, nome = U.nome, hoje = U.hoje,
    pode = U.pode, toast = U.toast, modal = U.modal, $ = U.$;
var F = window._FIN;
var T = window._FIN_TELAS = window._FIN_TELAS || {};

function addDias(iso, d){ var t = new Date(iso + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); }
function kpi(l, v, cor, sub){ return '<div class="fin-card"><div class="fin-kl">' + esc(l) + '</div><div class="fin-kv"' + (cor ? ' style="color:' + cor + '"' : '') + '>' + v + '</div>' + (sub ? '<div class="fin-sub" style="margin-top:2px">' + sub + '</div>' : '') + '</div>'; }
function chip(t, cor){ return '<span class="fin-chip" style="color:' + cor + ';background:rgba(127,127,127,.12)">' + esc(t) + '</span>'; }
async function travado(bt, fn){ if(bt.disabled) return; bt.disabled = true; var t = bt.textContent; bt.textContent = 'Salvando...'; try { await fn(); } finally { bt.disabled = false; bt.textContent = t; } }

var CONF = {
  pendente: ['Falta conferir', '#7F8C8D'], mudou: ['🔁 Mudou no Kamino: conferir de novo', '#D68910'], aguardando_2a: ['Falta a 2ª pessoa', '#B7791F'],
  ok: ['✅ Conferido', '#1D9E75'], divergente: ['⚠️ Divergente', '#D68910'], suspeito: ['🚩 Suspeito', '#C0392B']
};
function chipConf(l){
  var x = CONF[l.conf_status] || CONF.pendente;
  var por = (l.conf_status === 'ok' || l.conf_status === 'aguardando_2a' || l.conf_status === 'divergente' || l.conf_status === 'suspeito') && l.ult_por ? ' · ' + nome(l.ult_por) : '';
  return chip(x[0] + por, x[1]);
}
var CAMPO = { valor: 'Valor', valor_pago: 'Valor pago', valor_bruto: 'Valor bruto', pessoa: 'Favorecido', pessoa_kmn_id: 'Cadastro (ID)', pessoa_doc: 'CPF/CNPJ',
  destino_hash: 'Pix/conta de destino', destino_desc: 'Destino', conta: 'Conta', forma: 'Forma', data_pagamento: 'Data do pagamento', vencimento: 'Vencimento',
  competencia: 'Competência', situacao: 'Situação', situacao_cod: 'Código da situação', classificacao: 'Classificação', centro_custo: 'Centro de custo', unidade: 'Cidade',
  descricao: 'Descrição', obs: 'Observação', nf: 'Nota fiscal', boleto: 'Boleto', anexos: 'Tem anexo', conciliado: 'Conciliado com o banco', enviado_banco: 'Enviado ao banco',
  juros: 'Juros', desconto: 'Desconto', taxa: 'Taxa', agendado: 'Agendado para', incluido_por: 'Lançado por', incluido_em: 'Lançado em', situacao_em: 'Situação mudou em', codigo_externo: 'Código externo' };
var SEM_IMPORTANCIA = { situacao_em: 1, situacao_cod: 1, destino_hash: 1 };
function fmt(k, v){
  if(v == null || v === '') return '<span class="fin-sub">vazio</span>';
  if(/^(valor|valor_pago|valor_bruto|juros|desconto|taxa)$/.test(k)) return moeda(v);
  if(/^(vencimento|data_pagamento|competencia|agendado)$/.test(k)) return dataBR(v);
  if(/_em$/.test(k)) return dataHoraBR(v);
  if(v === true) return 'sim'; if(v === false) return 'não';
  return esc(v);
}
function diffHtml(m){
  var campos = (m.mudou || []).filter(function(k){ return !SEM_IMPORTANCIA[k]; });
  if(!campos.length) return '<span class="fin-sub">(só detalhes internos)</span>';
  return campos.map(function(k){ return '<div><b>' + esc(CAMPO[k] || k) + ':</b> ' + fmt(k, m.antes && m.antes[k]) + ' → ' + fmt(k, m.depois && m.depois[k]) + '</div>'; }).join('');
}

/* ================= CONFERIR ================= */
T.kmn_conferir = async function(el){
  var f = F.kmnF = F.kmnF || { tipo: 'pagar', campo: 'data_pagamento', ini: addDias(hoje(), -29), fim: hoje(), conf: 'falta', situacao: 'pagos', unidade: '', busca: '', pagina: 0 };
  el.innerHTML = '<div class="fin-filtros">' +
    '<select id="kf-tipo"><option value="pagar"' + (f.tipo === 'pagar' ? ' selected' : '') + '>💸 Pagamentos</option><option value="receber"' + (f.tipo === 'receber' ? ' selected' : '') + '>💰 Recebimentos</option></select>' +
    '<select id="kf-campo"><option value="data_pagamento"' + (f.campo === 'data_pagamento' ? ' selected' : '') + '>Data em que foi pago/recebido</option><option value="vencimento"' + (f.campo === 'vencimento' ? ' selected' : '') + '>Data de vencimento</option></select>' +
    '<input type="date" id="kf-ini" value="' + f.ini + '"><input type="date" id="kf-fim" value="' + f.fim + '">' +
    '<select id="kf-conf">' + [['falta', 'Falta conferir'], ['', 'Todos'], ['ok', 'Conferidos'], ['problema', 'Divergentes e suspeitos'], ['mudou', 'Mudou depois de conferido']].map(function(o){ return '<option value="' + o[0] + '"' + (f.conf === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
    '<select id="kf-sit">' + [['pagos', 'Só pagos/recebidos'], ['pendentes', 'Só pendentes'], ['', 'Pagos e pendentes']].map(function(o){ return '<option value="' + o[0] + '"' + (f.situacao === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
    '<select id="kf-un"><option value="">Todas as cidades</option></select>' +
    '<input id="kf-busca" placeholder="Favorecido, descrição, classificação" value="' + esc(f.busca) + '" style="min-width:200px">' +
    '<button class="fin-bt pri" id="kf-ok">Filtrar</button></div>' +
    '<div class="fin-filtros" style="margin-top:-4px"><span class="fin-sub">Período rápido:</span>' +
    [['7', 'Últimos 7 dias'], ['30', 'Últimos 30 dias'], ['mes', 'Este mês'], ['ant', 'Mês passado'], ['tudo', 'Tudo (desde jun/2026)']].map(function(o){ return '<button class="fin-bt" data-per="' + o[0] + '">' + o[1] + '</button>'; }).join('') + '</div>' +
    '<div id="kf-kpis"></div><div id="kf-bar"></div><div id="kf-out"><div class="fin-vazio">Carregando...</div></div>';
  var ler = function(){ f.tipo = $('kf-tipo').value; f.campo = $('kf-campo').value; f.ini = $('kf-ini').value; f.fim = $('kf-fim').value; f.conf = $('kf-conf').value; f.situacao = $('kf-sit').value; f.unidade = $('kf-un').value; f.busca = $('kf-busca').value.trim(); f.pagina = 0; };
  var rec = function(){ T.kmn_conferir(el); };
  $('kf-ok').onclick = function(){ ler(); rec(); };
  el.querySelectorAll('[data-per]').forEach(function(b){ b.onclick = function(){
    ler(); var p = b.getAttribute('data-per'), h = hoje();
    if(p === '7'){ f.ini = addDias(h, -6); f.fim = h; }
    else if(p === '30'){ f.ini = addDias(h, -29); f.fim = h; }
    else if(p === 'mes'){ f.ini = h.slice(0, 8) + '01'; f.fim = h; }
    else if(p === 'ant'){ var i = addDias(h.slice(0, 8) + '01', -1); f.ini = i.slice(0, 8) + '01'; f.fim = i; }
    else { f.ini = '2026-01-01'; f.fim = addDias(h, 90); }
    rec(); }; });
  $('kf-busca').onkeydown = function(e){ if(e.key === 'Enter'){ ler(); rec(); } };
  ['kf-tipo', 'kf-campo', 'kf-conf', 'kf-sit', 'kf-un'].forEach(function(id){ $(id).onchange = function(){ ler(); rec(); }; });

  var meu = F.kmnReq = (F.kmnReq || 0) + 1; // se a tela recarregar no meio, só a última resposta desenha
  try {
    var res = await Promise.all([
      api('kmn_resumo', { tipo: f.tipo, campo: f.campo, ini: f.ini, fim: f.fim }),
      api('kmn_listar', { tipo: f.tipo, campo: f.campo, ini: f.ini, fim: f.fim, conf: f.conf, situacao: f.situacao, unidade: f.unidade, busca: f.busca, pagina: f.pagina })
    ]);
    if(meu !== F.kmnReq) return;
    var r = res[0].resumo || {}, j = res[1];
    // cidades
    var un = $('kf-un'); while(un.options.length > 1) un.remove(1); (r.unidades || []).forEach(function(u){ var o = document.createElement('option'); o.value = u; o.textContent = u; if(u === f.unidade) o.selected = true; un.appendChild(o); });
    // KPIs do período (todas as conferências, não só o filtro de status)
    var ps = r.por_status || {}; var g = function(k){ return ps[k] || { qtd: 0, valor: 0 }; };
    var falta = g('pendente').qtd + g('mudou').qtd + g('aguardando_2a').qtd;
    var okq = g('ok').qtd, tot = r.qtd || 0, pct = tot ? Math.round(okq / tot * 100) : 0;
    $('kf-kpis').innerHTML = '<div class="fin-kpis">' +
      kpi(f.tipo === 'pagar' ? 'Pagamentos no período' : 'Recebimentos no período', String(tot), '', moeda(r.valor)) +
      kpi('Falta conferir', String(falta), falta ? '#B7791F' : '#1D9E75', moeda(g('pendente').valor + g('mudou').valor + g('aguardando_2a').valor)) +
      kpi('Conferido', pct + '%', pct >= 95 ? '#1D9E75' : pct >= 70 ? '#D68910' : '#C0392B', okq + ' de ' + tot) +
      kpi('Divergentes e suspeitos', String(g('divergente').qtd + g('suspeito').qtd), (g('divergente').qtd + g('suspeito').qtd) ? '#C0392B' : '', moeda(g('divergente').valor + g('suspeito').valor)) +
      kpi('Mudou depois de conferido', String(g('mudou').qtd), g('mudou').qtd ? '#D68910' : '', 'precisa conferir de novo') +
      kpi('Excluídos no Kamino', String(r.sumidos || 0), r.sumidos ? '#C0392B' : '', (r.total_espelho || 0) + ' no espelho') +
      '</div><div class="fin-sub" style="margin:-6px 0 8px">Mostrando ' + (f.campo === 'vencimento' ? 'vencimentos' : (f.tipo === 'pagar' ? 'pagamentos feitos' : 'recebimentos')) + ' de ' + dataBR(f.ini) + ' a ' + dataBR(f.fim) +
      '. O espelho tem <b>' + (r.total_espelho || 0) + '</b> ' + (f.tipo === 'pagar' ? 'pagamentos' : 'recebimentos') + ' no total: use o período rápido ou "Todos" na conferência para ver mais.</div>';
    if(!r.total_espelho){ $('kf-out').innerHTML = '<div class="fin-vazio">O espelho do Kamino ainda está carregando (a primeira carga leva algumas horas e corre sozinha a cada 10 minutos). Veja o andamento em Sincronização.</div>'; return; }

    var linhas = j.linhas || [];
    if(pode('conferente')){
      $('kf-bar').innerHTML = '<div class="fin-filtros" style="margin:6px 0"><span class="fin-sub" id="kf-n">0 selecionado(s)</span>' +
        '<button class="fin-bt ok" id="kf-bok" disabled>✅ Confere</button><button class="fin-bt div" id="kf-bdiv" disabled>⚠️ Divergente</button><button class="fin-bt sus" id="kf-bsus" disabled>🚩 Suspeito</button>' +
        '<span class="fin-sub">Confira valor, favorecido e destino com o comprovante. Você não confere o que você mesma lançou no Kamino.</span></div>';
    }
    var h = '<div class="fin-card" style="overflow-x:auto"><table class="fin-tbl"><thead><tr>' + (pode('conferente') ? '<th><input type="checkbox" id="kf-todos"></th>' : '') +
      '<th>' + (f.campo === 'vencimento' ? 'Vencimento' : (f.tipo === 'pagar' ? 'Pago em' : 'Recebido em')) + '</th><th>' + (f.tipo === 'pagar' ? 'Favorecido' : 'Cliente') + '</th><th>Descrição / classificação</th><th>Cidade</th><th style="text-align:right">Valor</th><th>Situação</th><th>Conferência</th></tr></thead><tbody>';
    if(!linhas.length) h += '<tr><td colspan="8" class="fin-vazio">Nada neste filtro.</td></tr>';
    linhas.forEach(function(l){
      var d = l.dados || {};
      var vl = l.valor_pago != null ? l.valor_pago : l.valor;
      h += '<tr class="clic" data-id="' + l.id + '">' + (pode('conferente') ? '<td><input type="checkbox" class="kf-sel" value="' + l.id + '"></td>' : '') +
        '<td>' + dataBR(f.campo === 'vencimento' ? l.vencimento : l.data_pagamento) + '</td>' +
        '<td><b>' + esc(l.pessoa || '-') + '</b>' + (d.destino_desc ? '<div class="fin-sub">' + esc(d.destino_desc) + '</div>' : (d.forma ? '<div class="fin-sub">' + esc(d.forma) + '</div>' : '')) + '</td>' +
        '<td>' + esc(d.descricao || '') + '<div class="fin-sub">' + esc(l.classificacao || 'sem classificação') + '</div></td>' +
        '<td>' + esc(l.unidade || '-') + '</td>' +
        '<td style="text-align:right;font-weight:700">' + moeda(vl) + (l.valor_pago != null && l.valor != null && Number(l.valor_pago) !== Number(l.valor) ? '<div class="fin-sub">venc. ' + moeda(l.valor) + '</div>' : '') + '</td>' +
        '<td>' + esc(l.situacao || '') + (l.versao > 1 ? ' <span class="fin-chip" style="background:#FFF3CD;color:#8A6D00" title="Este lançamento foi alterado no Kamino">✏️ alterado ' + (l.versao - 1) + 'x</span>' : '') + (d.conciliado ? '' : (l.data_pagamento && f.tipo === 'pagar' ? ' <span class="fin-sub" title="O Kamino ainda não achou esta saída no extrato do banco">· sem conciliação</span>' : '')) + '</td>' +
        '<td>' + chipConf(l) + '</td></tr>';
    });
    h += '</tbody></table>';
    if(j.total > j.tamanho){
      var pags = Math.ceil(j.total / j.tamanho);
      h += '<div class="fin-filtros" style="margin-top:8px"><span class="fin-sub">Página ' + (j.pagina + 1) + ' de ' + pags + ' · ' + j.total + ' lançamentos</span>' +
        (j.pagina > 0 ? '<button class="fin-bt" id="kf-ant">‹ Anterior</button>' : '') + (j.pagina + 1 < pags ? '<button class="fin-bt" id="kf-prox">Próxima ›</button>' : '') + '</div>';
    }
    h += '</div>';
    $('kf-out').innerHTML = h;
    if($('kf-ant')) $('kf-ant').onclick = function(){ f.pagina--; rec(); };
    if($('kf-prox')) $('kf-prox').onclick = function(){ f.pagina++; rec(); };
    $('kf-out').querySelectorAll('tr.clic').forEach(function(tr){ tr.onclick = function(){ abrir(Number(tr.getAttribute('data-id')), rec); }; });
    if(pode('conferente')){
      var sel = function(){ return Array.prototype.map.call($('kf-out').querySelectorAll('.kf-sel:checked'), function(c){ return Number(c.value); }); };
      var atual = function(){ var k = sel().length; $('kf-n').textContent = k + ' selecionado(s)'; $('kf-bok').disabled = $('kf-bdiv').disabled = $('kf-bsus').disabled = !k; };
      $('kf-out').querySelectorAll('.kf-sel').forEach(function(c){ c.onclick = function(ev){ ev.stopPropagation(); }; c.onchange = atual; });
      if($('kf-todos')){ $('kf-todos').onclick = function(ev){ ev.stopPropagation(); }; $('kf-todos').onchange = function(){ var v = this.checked; $('kf-out').querySelectorAll('.kf-sel').forEach(function(c){ c.checked = v; }); atual(); }; }
      $('kf-bok').onclick = function(){ conferir(sel(), 'ok', this, rec); };
      $('kf-bdiv').onclick = function(){ conferir(sel(), 'divergente', this, rec); };
      $('kf-bsus').onclick = function(){ conferir(sel(), 'suspeito', this, rec); };
    }
  } catch(e){ $('kf-out').innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; }
};

async function conferir(ids, resultado, bt, depois){
  if(!ids.length) return;
  var obs = null;
  if(resultado !== 'ok'){
    obs = await U.pedirTexto({ titulo: (resultado === 'suspeito' ? '🚩 Marcar como suspeito' : '⚠️ Marcar como divergente') + ' (' + ids.length + ')',
      ajuda: 'Escreva o que está errado (mín. 10 letras). Fica registrado para sempre, com o seu nome, e a diretoria é avisada.', min: 10, botao: 'Registrar' });
    if(!obs) return;
  }
  await travado(bt, async function(){
    try {
      var r = await api('kmn_conferir', { ids: ids, resultado: resultado, observacao: obs });
      var msg = r.conferidos + ' registrado(s)';
      if(r.pulados) msg += ' · ' + r.pulados + ' pulado(s)' + (r.motivos && r.motivos.length ? ': ' + r.motivos.join('; ') : ' (já conferidos por você)');
      toast(msg, r.pulados && !r.conferidos ? 'aviso' : null);
      depois && depois();
    } catch(e){ toast(e.message, 'erro'); }
  });
}

async function abrir(id, depois){
  var m = modal('<div class="fin-vazio">Carregando...</div>');
  try {
    var j = await api('kmn_ver', { id: id });
    var l = j.lanc, d = l.dados || {};
    var linha = function(k){ return d[k] == null || d[k] === '' ? '' : '<tr><td class="fin-sub" style="white-space:nowrap">' + esc(CAMPO[k] || k) + '</td><td>' + fmt(k, d[k]) + '</td></tr>'; };
    var h = '<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><div><div style="font-weight:800;font-size:15px">' + (l.tipo === 'pagar' ? '💸 Pagamento' : '💰 Recebimento') + ' Kamino #' + l.kamino_id + '</div>' +
      '<div style="margin-top:4px">' + chipConf(l) + (l.sumiu_em ? ' ' + chip('🗑️ Excluído no Kamino em ' + dataHoraBR(l.sumiu_em), '#C0392B') : '') + '</div></div><button class="fin-bt" id="kv-x">✕</button></div>' +
      '<table class="fin-tbl" style="margin-top:10px"><tbody>' + ['pessoa', 'pessoa_doc', 'destino_desc', 'valor', 'valor_pago', 'juros', 'desconto', 'vencimento', 'data_pagamento', 'situacao', 'forma', 'conta', 'classificacao', 'centro_custo', 'unidade', 'descricao', 'obs', 'nf', 'anexos', 'conciliado', 'incluido_por', 'incluido_em'].map(linha).join('') + '</tbody></table>';
    if(pode('conferente') && !l.sumiu_em){
      h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin:12px 0"><button class="fin-bt ok" data-r="ok">✅ Confere</button><button class="fin-bt div" data-r="divergente">⚠️ Divergente</button><button class="fin-bt sus" data-r="suspeito">🚩 Suspeito</button></div>';
    }
    h += '<div style="font-weight:700;margin-top:12px">Conferências</div>' + (j.confs.length ? j.confs.map(function(c){
      return '<div class="fin-sub" style="padding:3px 0;border-bottom:1px solid var(--border)">' + dataHoraBR(c.em) + ' · <b>' + esc(nome(c.por)) + '</b> · ' + esc((CONF[c.resultado] || [c.resultado])[0]) + ' (versão ' + c.versao + (c.versao !== l.versao ? ', antiga' : '') + ')' + (c.observacao ? ' · ' + esc(c.observacao) : '') + '</div>'; }).join('') : '<div class="fin-sub">Ninguém conferiu ainda.</div>');
    var muds = j.versoes.filter(function(v){ return v.versao > 1; });
    h += '<div style="font-weight:700;margin-top:12px">O que mudou no Kamino</div>' + (muds.length ? muds.map(function(v){
      return '<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:12px"><div class="fin-sub">Visto em ' + dataHoraBR(v.visto_em) + ' (versão ' + v.versao + ')</div>' + diffHtml(v) + '</div>'; }).join('') : '<div class="fin-sub">Nada mudou desde que o espelho começou a acompanhar.</div>');
    if(j.alertas.length){
      h += '<div style="font-weight:700;margin-top:12px">Alertas</div>' + j.alertas.map(function(a){ return '<div class="fin-sub" style="padding:3px 0">' + U.chipSev(a.severidade) + ' ' + esc(a.titulo) + ' · ' + esc(a.status) + '</div>'; }).join('');
    }
    m.fechar(); m = modal(h);
    $('kv-x').onclick = m.fechar;
    m.el.querySelectorAll('[data-r]').forEach(function(b){ b.onclick = function(){ var bt = this; conferir([l.id], bt.getAttribute('data-r'), bt, function(){ m.fechar(); depois && depois(); }); }; });
  } catch(e){ m.fechar(); toast(e.message, 'erro'); }
}

window._FIN_KMN_ABRIR = abrir;

/* ================= O QUE MUDOU NO KAMINO ================= */
T.kmn_mudancas = async function(el){
  var f = F.kmnM = F.kmnM || { tipo: '', ini: addDias(hoje(), -6), fim: hoje(), pagina: 0, importantes: true };
  el.innerHTML = '<div class="fin-filtros"><select id="km-tipo"><option value="">Pagamentos e recebimentos</option><option value="pagar"' + (f.tipo === 'pagar' ? ' selected' : '') + '>Só pagamentos</option><option value="receber"' + (f.tipo === 'receber' ? ' selected' : '') + '>Só recebimentos</option></select>' +
    '<input type="date" id="km-ini" value="' + f.ini + '"><input type="date" id="km-fim" value="' + f.fim + '">' +
    '<label class="fin-sub" style="display:flex;gap:4px;align-items:center"><input type="checkbox" id="km-imp"' + (f.importantes ? ' checked' : '') + '> só valor, favorecido, destino, datas e situação</label>' +
    '<button class="fin-bt pri" id="km-ok">Filtrar</button></div>' +
    '<div class="fin-sub" style="margin-bottom:8px">Tudo o que alguém alterou no Kamino depois que o espelho já tinha visto o lançamento. Nada aqui pode ser apagado.</div><div id="km-out"><div class="fin-vazio">Carregando...</div></div>';
  var rec = function(){ T.kmn_mudancas(el); };
  $('km-ok').onclick = function(){ f.tipo = $('km-tipo').value; f.ini = $('km-ini').value; f.fim = $('km-fim').value; f.importantes = $('km-imp').checked; f.pagina = 0; rec(); };
  try {
    var j = await api('kmn_mudancas', { tipo: f.tipo, ini: f.ini, fim: f.fim, pagina: f.pagina });
    var IMP = ['valor', 'valor_pago', 'pessoa', 'pessoa_doc', 'destino_desc', 'conta', 'forma', 'data_pagamento', 'vencimento', 'situacao'];
    var ls = (j.linhas || []).filter(function(m){ return !f.importantes || (m.mudou || []).some(function(k){ return IMP.indexOf(k) >= 0; }); });
    var h = '<div class="fin-card" style="overflow-x:auto"><table class="fin-tbl"><thead><tr><th>Visto em</th><th>Lançamento</th><th>Cidade</th><th>O que mudou</th></tr></thead><tbody>';
    if(!ls.length) h += '<tr><td colspan="4" class="fin-vazio">Nenhuma alteração no período.</td></tr>';
    ls.forEach(function(m){
      h += '<tr class="clic" data-id="' + m.lanc_id + '"><td style="white-space:nowrap">' + dataHoraBR(m.visto_em) + '</td><td><b>' + esc(m.pessoa || '-') + '</b><div class="fin-sub">' + (m.tipo === 'pagar' ? 'Pagamento' : 'Recebimento') + ' #' + m.kamino_id + (m.sumiu_em ? ' · 🗑️ excluído' : '') + '</div></td><td>' + esc(m.unidade || '-') + '</td><td style="font-size:12px">' + diffHtml(m) + '</td></tr>';
    });
    h += '</tbody></table>';
    if(j.total > j.tamanho){
      var pags = Math.ceil(j.total / j.tamanho);
      h += '<div class="fin-filtros" style="margin-top:8px"><span class="fin-sub">Página ' + (j.pagina + 1) + ' de ' + pags + '</span>' + (j.pagina > 0 ? '<button class="fin-bt" id="km-ant">‹ Anterior</button>' : '') + (j.pagina + 1 < pags ? '<button class="fin-bt" id="km-prox">Próxima ›</button>' : '') + '</div>';
    }
    $('km-out').innerHTML = h + '</div>';
    if($('km-ant')) $('km-ant').onclick = function(){ f.pagina--; rec(); };
    if($('km-prox')) $('km-prox').onclick = function(){ f.pagina++; rec(); };
    $('km-out').querySelectorAll('tr.clic').forEach(function(tr){ tr.onclick = function(){ abrir(Number(tr.getAttribute('data-id')), rec); }; });
  } catch(e){ $('km-out').innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; }
};

/* ================= RECORRÊNCIAS DO KAMINO (só leitura) ================= */
// pagar: contas que o Kamino lança em série (SequenciaParcelas): aluguel, salário, sistemas...
// receber: o Kamino não usa contrato; a recorrência é a cobrança semanal de cada empresa.
var MOD_COR = { faturado: ['#0E5A8A', '#DCEBF5'], carteira: ['#137A5A', '#DDF3EA'], fat_cart: ['#5B3E9E', '#ECE5F8'], todas: ['#3D4A57', '#E7EBEE'], outras: ['#7A5200', '#FFF1D6'], nao_achada: ['#8A8F96', '#F1F3F5'], sem: ['#8A8F96', '#F1F3F5'] };
function chipMod(m){
  if(!m) return '<span class="fin-sub">-</span>';
  var c = MOD_COR[m.cod] || MOD_COR.outras;
  return '<span class="fin-chip" title="' + esc((m.codigos || []).join(', ')) + '" style="color:' + c[0] + ';background:' + c[1] + '">' + esc(m.nome) + '</span>';
}
function telaRec(el, tipo){
  var receber = tipo === 'receber';
  var f = F['kmnRec' + tipo] = F['kmnRec' + tipo] || { so: receber ? '' : 'ativas', busca: '', unidade: '', modalidade: '', pagina: 0 };
  el.innerHTML = '<div class="fin-sub" style="margin-bottom:8px">' + (receber
      ? 'Cobranças recorrentes vindas do Kamino: cada empresa cobrada semana a semana, por cidade. Só leitura: qualquer mudança é feita no Kamino.'
      : 'Contas recorrentes vindas do Kamino (aluguel, salários, sistemas...), agrupadas pela série que o Kamino cria. Só leitura: qualquer mudança é feita no Kamino.') + '</div>' +
    '<div class="fin-filtros"><select id="kr-so">' + (receber
      ? [['', 'Todas as empresas'], ['atraso', 'Só com cobrança atrasada']]
      : [['ativas', 'Com parcelas a vencer'], ['', 'Todas'], ['varia', 'Valor mudou entre parcelas']]).map(function(o){ return '<option value="' + o[0] + '"' + (f.so === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
    '<select id="kr-un"><option value="">Todas as cidades</option></select>' +
    (receber ? '<select id="kr-mod">' + [['', 'Todas as modalidades'], ['faturado', 'Faturado'], ['carteira', 'Carteira de créditos'], ['fat_cart', 'Faturado + Carteira'], ['todas', 'Aceita todas as formas'], ['outras', 'Outras (dinheiro, Pix...)'], ['nao_achada', 'Não achada na Machine']].map(function(o){ return '<option value="' + o[0] + '"' + ((f.modalidade || '') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' : '') +
    '<input id="kr-busca" placeholder="' + (receber ? 'Empresa' : 'Favorecido') + '" value="' + esc(f.busca) + '"><button class="fin-bt pri" id="kr-ok">Filtrar</button></div><div id="kr-out"><div class="fin-vazio">Carregando...</div></div>';
  var rec = function(){ telaRec(el, tipo); };
  $('kr-ok').onclick = function(){ f.so = $('kr-so').value; f.unidade = $('kr-un').value; f.busca = $('kr-busca').value.trim(); f.pagina = 0; if($('kr-mod')) f.modalidade = $('kr-mod').value;
    if(receber && window._FIN_CIDADE_RECEBER_NOME) window._FIN_CIDADE_RECEBER_NOME(f.unidade); // a mesma cidade vale em Central e Cobranças
    rec(); };
  $('kr-so').onchange = $('kr-ok').onclick; $('kr-un').onchange = $('kr-ok').onclick; if($('kr-mod')) $('kr-mod').onchange = $('kr-ok').onclick;
  $('kr-busca').onkeydown = function(e){ if(e.key === 'Enter') $('kr-ok').onclick(); };
  (async function(){
    try {
      // cidades (as mesmas unidades do Kamino), carregadas uma vez
      if(!F.kmnUnidades){ try { F.kmnUnidades = ((await api('base')).unidades || []).map(function(u){ return u.nome; }); } catch(e){ F.kmnUnidades = []; } }
      var sel = $('kr-un'); if(sel) F.kmnUnidades.forEach(function(nm){ var o = document.createElement('option'); o.value = nm; o.textContent = nm; if(nm === f.unidade) o.selected = true; sel.appendChild(o); });
      var j = await api('kmn_recorrencias', { tipo: tipo, so: f.so, busca: f.busca, unidade: f.unidade, modalidade: f.modalidade || '', pagina: f.pagina });
      var ls = j.linhas || [];
      var somaAtr = ls.reduce(function(a, r){ return a + (Number(r.total_atrasado) || 0); }, 0);
      var NOMES_MOD = { faturado: 'faturado', carteira: 'carteira', fat_cart: 'faturado + carteira', todas: 'todas as formas', outras: 'outras', nao_achada: 'não achadas na Machine', sem: 'sem modalidade' };
      var resumoMod = receber && j.contagem ? Object.keys(j.contagem).sort(function(a, b){ return j.contagem[b] - j.contagem[a]; }).map(function(k){ return j.contagem[k] + ' ' + (NOMES_MOD[k] || k); }).join(' · ') : '';
      var h = '<div class="fin-sub" style="margin:6px 0">' + j.total + (receber ? ' empresa(s)' + (f.unidade ? ' em ' + esc(f.unidade) : '') + (somaAtr ? ' · em atraso nesta página: <b style="color:#C0392B">' + moeda(somaAtr) + '</b>' : '') : ' conta(s) recorrente(s)') + (resumoMod ? '<div>' + resumoMod + '</div>' : '') + '</div><div class="fin-card" style="overflow-x:auto"><table class="fin-tbl"><thead><tr>';
      if(receber){
        h += '<th>Empresa</th><th>Cidade</th><th>Modalidade</th><th style="text-align:right">Cobranças</th><th style="text-align:right">Recebidas</th><th style="text-align:right">Atrasadas</th><th style="text-align:right">Valor médio</th><th style="text-align:right">Em atraso</th><th>Última</th></tr></thead><tbody>';
        if(!ls.length) h += '<tr><td colspan="9" class="fin-vazio">Nada neste filtro.</td></tr>';
        ls.forEach(function(r){ h += '<tr><td><b>' + esc(r.pessoa) + '</b>' + (r.modalidade && r.modalidade.ativa_machine === false ? ' <span class="fin-chip" style="background:#E7EBEE;color:#3D4A57">inativa na Machine</span>' : '') + '</td><td>' + esc(r.unidade || '-') + '</td><td>' + chipMod(r.modalidade) + '</td><td style="text-align:right">' + r.cobrancas + '</td><td style="text-align:right">' + r.recebidas + '</td><td style="text-align:right' + (r.atrasadas ? ';color:#C0392B;font-weight:700' : '') + '">' + r.atrasadas + '</td><td style="text-align:right">' + moeda(r.valor_medio) + '</td><td style="text-align:right;font-weight:700">' + moeda(r.total_atrasado || 0) + '</td><td>' + dataBR(r.ultima) + '</td></tr>'; });
      } else {
        h += '<th>Favorecido</th><th>Conta / classificação</th><th>Frequência</th><th style="text-align:right">Valor</th><th style="text-align:right">Parcelas</th><th>Próximo vencimento</th><th style="text-align:right">Em aberto</th></tr></thead><tbody>';
        if(!ls.length) h += '<tr><td colspan="7" class="fin-vazio">Nada neste filtro.</td></tr>';
        ls.forEach(function(r){
          var val = Number(r.valor_min) === Number(r.valor_max) ? moeda(r.valor_tipico) : moeda(r.valor_min) + ' a ' + moeda(r.valor_max);
          h += '<tr class="clic" data-serie="' + esc(r.serie) + '"><td><b>' + esc(r.pessoa || '-') + '</b>' + (Number(r.qtd_pessoas) > 1 ? ' <span class="fin-chip" style="background:#FDECEA;color:#C0392B">' + r.qtd_pessoas + ' favorecidos</span>' : '') + '</td>' +
            '<td>' + esc(r.descricao || '') + '<div class="fin-sub">' + esc(r.classificacao || 'sem classificação') + ' · ' + esc(r.unidade || '') + '</div></td>' +
            '<td>' + esc(r.frequencia) + '</td><td style="text-align:right;font-weight:700">' + val + (r.valor_varia ? '<div><span class="fin-chip" style="background:#FFF3CD;color:#8A6D00">valor mudou</span></div>' : '') + '</td>' +
            '<td style="text-align:right">' + r.pagas + ' pagas de ' + r.parcelas + (Number(r.atrasadas) ? '<div style="color:#C0392B;font-size:12px">' + r.atrasadas + ' atrasada(s)</div>' : '') + '</td>' +
            '<td>' + (r.proximo_venc ? dataBR(r.proximo_venc) : '<span class="fin-sub">nenhum</span>') + '</td><td style="text-align:right">' + moeda(r.total_aberto || 0) + '</td></tr>';
        });
      }
      h += '</tbody></table>';
      if(j.total > j.tamanho){ var pags = Math.ceil(j.total / j.tamanho); h += '<div class="fin-filtros" style="margin-top:8px"><span class="fin-sub">Página ' + (j.pagina + 1) + ' de ' + pags + '</span>' + (j.pagina > 0 ? '<button class="fin-bt" id="kr-ant">‹ Anterior</button>' : '') + (j.pagina + 1 < pags ? '<button class="fin-bt" id="kr-prox">Próxima ›</button>' : '') + '</div>'; }
      $('kr-out').innerHTML = h + '</div>';
      if($('kr-ant')) $('kr-ant').onclick = function(){ f.pagina--; rec(); };
      if($('kr-prox')) $('kr-prox').onclick = function(){ f.pagina++; rec(); };
      $('kr-out').querySelectorAll('tr[data-serie]').forEach(function(tr){ tr.onclick = function(){ parcelas(tr.getAttribute('data-serie'), rec); }; });
    } catch(e){ $('kr-out').innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; }
  })();
}
async function parcelas(serie, depois){
  var m = modal('<div class="fin-vazio">Carregando...</div>');
  try {
    var j = await api('kmn_listar', { tipo: 'pagar', campo: 'vencimento', ini: '2025-01-01', fim: addDias(hoje(), 700), conf: '', situacao: '', serie: serie });
    var h = '<div style="display:flex;justify-content:space-between"><div style="font-weight:800;font-size:15px">🔁 Parcelas da conta recorrente</div><button class="fin-bt" id="kp-x">✕</button></div>' +
      '<table class="fin-tbl" style="margin-top:10px"><thead><tr><th>Vencimento</th><th>Pago em</th><th style="text-align:right">Valor</th><th>Situação</th><th>Conferência</th></tr></thead><tbody>';
    (j.linhas || []).slice().sort(function(a, b){ return String(a.vencimento).localeCompare(String(b.vencimento)); }).forEach(function(l){
      h += '<tr class="clic" data-id="' + l.id + '"><td>' + dataBR(l.vencimento) + '</td><td>' + dataBR(l.data_pagamento) + '</td><td style="text-align:right;font-weight:700">' + moeda(l.valor_pago != null ? l.valor_pago : l.valor) + '</td><td>' + esc(l.situacao || '') + '</td><td>' + chipConf(l) + '</td></tr>';
    });
    m.fechar(); m = modal(h + '</tbody></table><div class="fin-sub" style="margin-top:8px">Clique numa parcela para ver os detalhes e conferir.</div>');
    $('kp-x').onclick = m.fechar;
    m.el.querySelectorAll('tr[data-id]').forEach(function(tr){ tr.onclick = function(){ m.fechar(); abrir(Number(tr.getAttribute('data-id')), depois); }; });
  } catch(e){ m.fechar(); toast(e.message, 'erro'); }
}
T.kmn_rec_pagar = function(el){ telaRec(el, 'pagar'); };
T.kmn_rec_receber = function(el){ telaRec(el, 'receber'); };

/* ================= SINCRONIZAÇÃO ================= */
T.kmn_sync = async function(el){
  el.innerHTML = '<div class="fin-vazio">Carregando...</div>';
  try {
    var j = await api('kmn_sync_status');
    var NOME = { pagar: '💸 Pagamentos', receber: '💰 Recebimentos', pessoas: '👤 Cadastros (chave Pix)' };
    var h = '<div class="fin-sub" style="margin-bottom:10px">O servidor lê o Kamino sozinho a cada 10 minutos (só leitura: não lança, não paga, não apaga nada lá). A primeira carga corre aos poucos e leva algumas horas; enquanto ela não termina, não sai alerta.</div>';
    if(!j.sync.length) h += '<div class="fin-vazio">A sincronização ainda não rodou nenhuma vez.</div>';
    else {
      h += '<div class="fin-card" style="overflow-x:auto"><table class="fin-tbl"><thead><tr><th>O quê</th><th>Situação</th><th>Última leitura ok</th><th>Andamento</th></tr></thead><tbody>';
      j.sync.forEach(function(s){
        var carga = s.volta === 1 || s.volta == null;
        var atrasado = !s.ultimo_ok || (Date.now() - new Date(s.ultimo_ok)) > 40 * 60e3;
        h += '<tr><td><b>' + esc(NOME[s.chave] || s.chave) + '</b></td><td>' +
          (s.ultimo_erro && (!s.ultimo_ok || new Date(s.ultimo_erro_em) > new Date(s.ultimo_ok)) ? chip('⛔ Erro: ' + s.ultimo_erro, '#C0392B') : atrasado ? chip('⚠️ Parado há mais de 40 min', '#D68910') : chip(carga ? '⏳ Primeira carga' : '✅ Em dia', carga ? '#B7791F' : '#1D9E75')) + '</td>' +
          '<td>' + dataHoraBR(s.ultimo_ok) + '</td><td class="fin-sub">' +
          (s.chave === 'pessoas' ? (carga ? 'lendo o cadastro pela 1ª vez' : 'cadastro relido em ' + dataHoraBR(s.ultima_volta)) :
            (carga ? 'carregando: já chegou ao vencimento de ' + dataBR(s.janela_ate) : 'revisão completa em ' + dataHoraBR(s.ultima_volta)) + (s.confirmar ? ' · ' + s.confirmar + ' a confirmar se foram excluídos' : '')) + '</td></tr>';
      });
      h += '</tbody></table></div>';
    }
    el.innerHTML = h;
  } catch(e){ el.innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; }
};
})();
