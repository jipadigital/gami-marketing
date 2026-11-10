/* ============================================================
   📋 FINANCEIRO · CONTROLES (no lugar das planilhas das meninas)
   Empresas (cobrança semanal com multa) · Créditos (carteira) · Importar planilhas antigas.
   Regras (garantidas no SERVIDOR/BANCO, a tela só ajuda): nada se apaga; corrigir = cancelar com
   motivo e lançar de novo; quem lançou não confere; cancelar/estornar/isentar multa = gestor.
   ============================================================ */
(function(){
'use strict';
var U = window._FINUI; if(!U){ console.error('financeiro-ui-ctl: carregue financeiro-ui.js antes'); return; }
var api = U.api, esc = U.esc, moeda = U.moeda, dataBR = U.dataBR, dataHoraBR = U.dataHoraBR, nome = U.nome, hoje = U.hoje,
    pode = U.pode, toast = U.toast, modal = U.modal, $ = U.$;
var F = window._FIN;
var T = window._FIN_TELAS = window._FIN_TELAS || {};

function n(v){ return Number(v) || 0; }
function addDias(iso, d){ var t = new Date(iso + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); }
function segunda(iso){ var t = new Date(iso + 'T12:00:00Z'); var w = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - w); return t.toISOString().slice(0, 10); }
function inicioMes(){ return hoje().slice(0, 8) + '01'; }
function eu(){ var u = (typeof getUsuarioLogado === 'function') ? getUsuarioLogado() : null; return u && u.id; }
function kpi(l, v, cor, sub){ return '<div class="fin-card"><div class="fin-kl">' + esc(l) + '</div><div class="fin-kv"' + (cor ? ' style="color:' + cor + '"' : '') + '>' + v + '</div>' + (sub ? '<div class="fin-sub" style="margin-top:2px">' + sub + '</div>' : '') + '</div>'; }
function carregando(el){ el.innerHTML = '<div class="fin-vazio">Carregando...</div>'; }
function erroEm(el, e){ el.innerHTML = '<div class="fin-erro">' + esc(e.message || e) + '</div>'; }
function chip(t, cor){ return '<span class="fin-chip" style="color:' + cor + ';background:rgba(127,127,127,.12)">' + esc(t) + '</span>'; }
var SIT = { aberta: ['Aberta', '#B7791F'], vencida: ['Vencida', '#C0392B'], parcial: ['Parcial', '#D68910'], quitada: ['Quitada', '#1D9E75'], cancelada: ['Cancelada', '#7F8C8D'] };
function chipSit(s){ var x = SIT[s] || SIT.aberta; return chip(x[0], x[1]); }
function chipConfReg(c){ if(c && c.conf_desatualizada) return chip('🔁 Conferir de novo (mudou depois)', '#D68910'); return chipConf(c && c.conf_status, c && c.conferido_por); }
function chipConf(s, por){ if(s === 'ok') return chip('✅ Conferido' + (por ? ' · ' + nome(por) : ''), '#1D9E75'); if(s === 'divergente') return chip('⚠️ Divergente', '#C0392B'); return chip('Falta conferir', '#7F8C8D'); }
var MOTIVO = { pagamento_semanal: 'Pagamento semanal', bonus_acao: 'Bônus de ação', bonus_inicio: 'Bônus de início', cortesia: 'Cortesia', reembolso: 'Reembolso', ajuste: 'Ajuste/correção', zeragem: 'Zeragem (sem uso)', teste: 'Teste', outro: 'Outro' };

// cidades (fin_unidades) carregadas uma vez
async function base(){
  if(F.ctlBase) return F.ctlBase;
  F.ctlBase = await api('ctl_base');
  return F.ctlBase;
}
function optsCidade(sel, todas){
  var us = (F.ctlBase && F.ctlBase.unidades || []).filter(function(u){ return u.ativo; });
  return (todas ? '<option value="">Todas as cidades</option>' : '<option value="">Escolha a cidade...</option>') +
    us.map(function(u){ return '<option value="' + u.id + '"' + (String(sel) === String(u.id) ? ' selected' : '') + '>' + esc(u.nome) + '</option>'; }).join('');
}
function nomeCidade(id){ var u = (F.ctlBase && F.ctlBase.unidades || []).filter(function(x){ return String(x.id) === String(id); })[0]; return u ? u.nome : '-'; }
// botão que não deixa clicar duas vezes
async function travado(bt, fn){ if(bt.disabled) return; bt.disabled = true; var t = bt.textContent; bt.textContent = 'Salvando...'; try { await fn(); } finally { bt.disabled = false; bt.textContent = t; } }
function pedirMotivo(titulo, aoConfirmar){
  var m = modal('<div style="font-weight:700;margin-bottom:6px">' + esc(titulo) + '</div><div class="fin-sub" style="margin-bottom:6px">Isso fica registrado para sempre, com o seu nome. Escreva o motivo (mín. 10 letras).</div>' +
    '<textarea id="cm-mot" rows="3" style="width:100%" maxlength="500"></textarea><div class="fin-filtros" style="margin-top:8px"><button class="fin-bt pri" id="cm-ok">Confirmar</button><button class="fin-bt" id="cm-x">Voltar</button></div><div id="cm-err"></div>');
  $('cm-x').onclick = m.fechar;
  $('cm-ok').onclick = function(){ var mot = $('cm-mot').value.trim(); if(mot.length < 10){ $('cm-err').innerHTML = '<div class="fin-erro">Escreva o motivo (mín. 10 letras).</div>'; return; }
    travado(this, async function(){ try { await aoConfirmar(mot); m.fechar(); } catch(e){ $('cm-err').innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; } }); };
}
function selecao(el){ return Array.prototype.map.call(el.querySelectorAll('.ctl-sel:checked'), function(c){ return Number(c.value); }); }
function barraConferir(tabela, el, recarregar){
  if(!pode('conferente')) return '';
  return '<div class="fin-filtros" id="ctl-conf-bar" style="margin:6px 0"><span class="fin-sub" id="ctl-conf-n">0 selecionado(s)</span>' +
    '<button class="fin-bt ok" id="ctl-conf-ok" disabled>✅ Conferir selecionados</button><button class="fin-bt sus" id="ctl-conf-div" disabled>⚠️ Marcar divergente</button>' +
    '<span class="fin-sub">Você não confere o que você mesmo lançou.</span></div>';
}
function ligarConferir(tabela, el, recarregar){
  var bOk = $('ctl-conf-ok'), bDiv = $('ctl-conf-div'); if(!bOk) return;
  var atualizar = function(){ var k = selecao(el).length; $('ctl-conf-n').textContent = k + ' selecionado(s)'; bOk.disabled = bDiv.disabled = !k; };
  el.querySelectorAll('.ctl-sel').forEach(function(c){ c.onchange = atualizar; c.onclick = function(ev){ ev.stopPropagation(); }; });
  var todos = $('ctl-sel-todos'); if(todos){ todos.onchange = function(){ el.querySelectorAll('.ctl-sel:not(:disabled)').forEach(function(c){ c.checked = todos.checked; }); atualizar(); }; todos.onclick = function(ev){ ev.stopPropagation(); }; }
  bOk.onclick = function(){ var ids = selecao(el); travado(bOk, async function(){ try { var r = await api('ctl_conferir', { tabela: tabela, ids: ids, status: 'ok' }); toast(r.conferidos + ' conferido(s)' + (r.pulados ? ' · ' + r.pulados + ' pulado(s) (lançados por você ou cancelados)' : '')); recarregar(); } catch(e){ toast(e.message, 'erro'); } }); };
  bDiv.onclick = function(){ var ids = selecao(el); pedirMotivo('Marcar ' + ids.length + ' como divergente', async function(mot){ var r = await api('ctl_conferir', { tabela: tabela, ids: ids, status: 'divergente', observacao: mot }); toast(r.conferidos + ' marcado(s) como divergente'); recarregar(); }); };
}
function historicoHtml(hist){
  if(!hist || !hist.length) return '';
  return '<details style="margin-top:10px"><summary class="fin-sub" style="cursor:pointer">Histórico de alterações (' + hist.length + ')</summary><div style="max-height:220px;overflow:auto;margin-top:6px">' +
    hist.map(function(x){ return '<div class="fin-sub" style="padding:3px 0;border-bottom:1px solid var(--border)">' + dataHoraBR(x.ts) + ' · <b>' + esc(nome(x.ator)) + '</b> · ' + esc(x.acao === 'INSERT' ? 'criou' : 'alterou') + (x.tabela && x.tabela.indexOf('receb') >= 0 ? ' (recebimento)' : '') + '</div>'; }).join('') + '</div></details>';
}

/* ================= EMPRESAS (cobrança semanal) ================= */
T.ctl_empresas = async function(el){
  carregando(el);
  try { await base(); } catch(e){ erroEm(el, e); return; }
  var f = F.ctlCob = F.ctlCob || { unidade_id: '', ini: addDias(segunda(hoje()), -49), fim: segunda(hoje()), situacao: '', conf: '', busca: '', pagina: 0 };
  var rec = function(){ T.ctl_empresas(el); };
  el.innerHTML = '<div class="fin-filtros"><select id="cc-un">' + optsCidade(f.unidade_id, true) + '</select>' +
    '<span class="fin-sub">Semanas de</span><input type="date" id="cc-ini" value="' + f.ini + '"><span class="fin-sub">até</span><input type="date" id="cc-fim" value="' + f.fim + '">' +
    '<select id="cc-sit"><option value="">Ativas (todas as situações)</option>' + ['aberta', 'vencida', 'parcial', 'quitada', 'cancelada'].map(function(k){ return '<option value="' + k + '"' + (f.situacao === k ? ' selected' : '') + '>' + SIT[k][0] + '</option>'; }).join('') + '</select>' +
    '<select id="cc-conf"><option value="">Conferência: todas</option><option value="sem"' + (f.conf === 'sem' ? ' selected' : '') + '>Falta conferir</option><option value="ok"' + (f.conf === 'ok' ? ' selected' : '') + '>Conferidas</option><option value="divergente"' + (f.conf === 'divergente' ? ' selected' : '') + '>Divergentes</option></select>' +
    '<input id="cc-busca" placeholder="Buscar empresa" maxlength="60" value="' + esc(f.busca) + '">' +
    '<button class="fin-bt pri" id="cc-ok">Filtrar</button>' + (pode('conferente') ? '<button class="fin-bt" id="cc-novo">+ Nova cobrança</button>' : '') + '</div><div id="cc-out"></div>';
  var aplicar = function(){ f.unidade_id = $('cc-un').value; f.ini = $('cc-ini').value; f.fim = $('cc-fim').value; f.situacao = $('cc-sit').value; f.conf = $('cc-conf').value; f.busca = $('cc-busca').value.trim(); f.pagina = 0; rec(); };
  $('cc-ok').onclick = aplicar; $('cc-busca').onkeydown = function(ev){ if(ev.key === 'Enter') aplicar(); };
  if($('cc-novo')) $('cc-novo').onclick = function(){ formCobranca(null, rec); };
  var out = $('cc-out'); carregando(out);
  try {
    var arg = { unidade_id: f.unidade_id || null, ini: f.ini, fim: f.fim };
    var rs = (await api('ctl_cob_resumo', arg)).resumo || {};
    var j = await api('ctl_cob_listar', Object.assign({}, arg, { situacao: f.situacao || null, conf: f.conf || null, busca: f.busca || null, pagina: f.pagina }));
    var h = '<div class="fin-kpis">' +
      kpi('A receber (líquido)', moeda(rs.liquido), '', (rs.qtd || 0) + ' cobrança(s) no período') +
      kpi('Recebido', moeda(rs.recebido), '#1D9E75', (rs.quitadas || 0) + ' quitada(s) · ' + (rs.parciais || 0) + ' parcial(is)') +
      kpi('Em aberto', moeda(rs.saldo), n(rs.saldo) ? '#E24B4A' : '', 'inclui multa de ' + moeda(rs.multa)) +
      kpi('Vencidas', String(rs.vencidas || 0), n(rs.vencidas) ? '#C0392B' : '', moeda(rs.vencidas_valor)) +
      kpi('Falta conferir', String(rs.sem_conferencia || 0), n(rs.sem_conferencia) ? '#D68910' : '#1D9E75', (rs.divergentes || 0) + ' divergente(s)') + '</div>';
    var lst = j.linhas || [];
    h += barraConferir('cobrancas');
    h += '<div class="fin-sub" style="margin-bottom:6px">' + j.total + ' cobrança(s)' + (j.total > 200 ? ' · página ' + (j.pagina + 1) + ' de ' + Math.ceil(j.total / 200) : '') + '. Clique numa linha para ver, receber ou corrigir.</div>';
    if(!lst.length) h += '<div class="fin-vazio">Nenhuma cobrança com esse filtro.' + (pode('conferente') ? ' Use “+ Nova cobrança” ou importe a planilha antiga em “Importar planilhas”.' : '') + '</div>';
    else {
      var meu = eu();
      h += '<div class="fin-card" style="overflow-x:auto"><table class="fin-tbl"><thead><tr>' + (pode('conferente') ? '<th><input type="checkbox" id="ctl-sel-todos" title="Selecionar todas"></th>' : '') +
        '<th>Semana</th><th>Cidade</th><th>Empresa</th><th style="text-align:right">Líquido</th><th style="text-align:right">Multa</th><th style="text-align:right">Recebido</th><th style="text-align:right">Saldo</th><th>Situação</th><th>Conferência</th></tr></thead><tbody>' +
        lst.map(function(c){
          var podeConf = c.status === 'ativa' && c.criado_por !== meu;
          return '<tr class="cc-lin" data-id="' + c.id + '" style="cursor:pointer">' + (pode('conferente') ? '<td><input type="checkbox" class="ctl-sel" value="' + c.id + '"' + (podeConf ? '' : ' disabled title="Você lançou esta (ou está cancelada)"') + '></td>' : '') +
            '<td>' + dataBR(c.semana_ini) + ' a ' + dataBR(c.semana_fim).slice(0, 5) + '</td><td class="fin-sub">' + esc((c.unidade_nome || '').replace(/^Gam[iy] (Delivery )?/i, '')) + '</td>' +
            '<td><b>' + esc(c.empresa) + '</b>' + (c.nome_no_banco ? '<div class="fin-sub">no banco: ' + esc(c.nome_no_banco) + '</div>' : '') + '</td>' +
            '<td style="text-align:right">' + moeda(c.liquido) + (n(c.desconto) ? '<div class="fin-sub">desc. ' + moeda(c.desconto) + '</div>' : '') + '</td>' +
            '<td style="text-align:right">' + (n(c.multa) ? moeda(c.multa) : (c.isento_multa ? '<span class="fin-sub">isenta</span>' : '-')) + '</td>' +
            '<td class="fin-ent" style="text-align:right">' + moeda(c.recebido) + '</td><td style="text-align:right;font-weight:700' + (n(c.saldo) > 0 ? ';color:#E24B4A' : '') + '">' + moeda(Math.max(0, n(c.saldo))) + '</td>' +
            '<td>' + chipSit(c.situacao) + '</td><td>' + chipConfReg(c) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    if(j.total > 200) h += '<div class="fin-filtros" style="margin-top:8px">' + (j.pagina > 0 ? '<button class="fin-bt" id="cc-ant">← Anterior</button>' : '') + ((j.pagina + 1) * 200 < j.total ? '<button class="fin-bt" id="cc-prox">Próxima →</button>' : '') + '</div>';
    out.innerHTML = h;
    out.querySelectorAll('.cc-lin').forEach(function(tr){ tr.onclick = function(){ verCobranca(Number(tr.getAttribute('data-id')), rec); }; });
    if($('cc-ant')) $('cc-ant').onclick = function(){ f.pagina--; rec(); };
    if($('cc-prox')) $('cc-prox').onclick = function(){ f.pagina++; rec(); };
    ligarConferir('cobrancas', out, rec);
  } catch(e){ erroEm(out, e); }
};

function formCobranca(c, aoSalvar){
  var novo = !c; c = c || { semana_ini: segunda(addDias(hoje(), -7)), multa_pct: 3 };
  var g = pode('gestor');
  var m = modal('<div style="font-weight:700;font-size:15px;margin-bottom:8px">' + (novo ? 'Nova cobrança semanal' : 'Corrigir cobrança') + '</div>' +
    '<div class="fin-grid2">' +
    (novo ? '<label>Cidade<select id="fc-un">' + optsCidade(F.ctlCob && F.ctlCob.unidade_id) + '</select></label>' +
      '<label>Semana (segunda-feira)<input type="date" id="fc-sem" value="' + c.semana_ini + '"></label>' +
      '<label style="grid-column:1/-1">Empresa<input id="fc-emp" maxlength="200" placeholder="Nome da empresa"></label>' +
      '<label>CNPJ/CPF (opcional)<input id="fc-doc" maxlength="20" placeholder="só números"></label>' +
      '<label>Valor a receber (R$)<input id="fc-val" inputmode="decimal" placeholder="0,00"></label>'
    : '<div style="grid-column:1/-1" class="fin-sub">' + esc(c.empresa) + ' · ' + esc(nomeCidade(c.unidade_id)) + ' · semana ' + dataBR(c.semana_ini) + ' · valor ' + moeda(c.valor) + '<br>Empresa, semana e valor não mudam: se estiverem errados, cancele e lance de novo.</div>' +
      (c.empresa_doc ? '' : '<label>CNPJ/CPF<input id="fc-doc" maxlength="20" placeholder="só números"></label>')) +
    '<label>Desconto (R$)<input id="fc-desc" inputmode="decimal" value="' + (n(c.desconto) ? String(c.desconto).replace('.', ',') : '') + '" placeholder="0,00"></label>' +
    '<label>Motivo do desconto<input id="fc-dmot" maxlength="300" value="' + esc(c.desconto_motivo || '') + '"></label>' +
    '<label>Vencimento<input type="date" id="fc-venc" value="' + (c.vencimento || '') + '"></label>' +
    '<label>Nome no banco (quem paga)<input id="fc-banco" maxlength="200" value="' + esc(c.nome_no_banco || '') + '"></label>' +
    '<label>Multa por atraso (%)<input id="fc-mpct" inputmode="decimal" value="' + n(c.multa_pct == null ? 3 : c.multa_pct) + '"' + (g ? '' : ' disabled title="Só o gestor muda a multa"') + '></label>' +
    '<label style="display:flex;gap:6px;align-items:center;margin-top:18px"><input type="checkbox" id="fc-isento"' + (c.isento_multa ? ' checked' : '') + (g ? '' : ' disabled') + '> Isentar multa' + (g ? '' : ' (só gestor)') + '</label>' +
    '<label style="grid-column:1/-1">Motivo da isenção<input id="fc-imot" maxlength="300" value="' + esc(c.isencao_motivo || '') + '"' + (g ? '' : ' disabled') + '></label>' +
    '<label style="grid-column:1/-1">Observação<textarea id="fc-obs" rows="2" maxlength="1000">' + esc(c.observacao || '') + '</textarea></label></div>' +
    '<div class="fin-sub" style="margin-top:6px">A multa só entra se vencer sem pagar ou se pagarem depois do vencimento: ' + n(c.multa_pct == null ? 3 : c.multa_pct) + '% sobre (valor − desconto).</div>' +
    '<div class="fin-filtros" style="margin-top:10px"><button class="fin-bt pri" id="fc-ok">Salvar</button><button class="fin-bt" id="fc-x">Fechar</button></div><div id="fc-err"></div>');
  $('fc-x').onclick = m.fechar;
  if(novo && $('fc-sem')) $('fc-sem').onchange = function(){ if(this.value) this.value = segunda(this.value); };
  $('fc-ok').onclick = function(){
    var bt = this;
    travado(bt, async function(){
      var d = { id: novo ? null : c.id, desconto: $('fc-desc').value, desconto_motivo: $('fc-dmot').value, vencimento: $('fc-venc').value || null,
        nome_no_banco: $('fc-banco').value, observacao: $('fc-obs').value, multa_pct: Number(String($('fc-mpct').value).replace(',', '.')),
        isento_multa: $('fc-isento').checked, isencao_motivo: $('fc-imot').value, empresa_doc: $('fc-doc') ? $('fc-doc').value : '' };
      if(novo){ d.unidade_id = $('fc-un').value; d.semana_ini = $('fc-sem').value; d.empresa = $('fc-emp').value; d.valor = $('fc-val').value; }
      try { await api('ctl_cob_salvar', d); toast('Cobrança salva'); m.fechar(); aoSalvar && aoSalvar(); }
      catch(e){
        if(novo && /já tem cobrança/.test(e.message) && confirm(e.message + '\n\nLançar mesmo assim (é outra cobrança da mesma empresa)?')){
          try { d.permitir_repetida = true; await api('ctl_cob_salvar', d); toast('Cobrança salva'); m.fechar(); aoSalvar && aoSalvar(); return; } catch(e2){ e = e2; }
        }
        $('fc-err').innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>';   // o que foi digitado continua no formulário
      }
    });
  };
}

async function verCobranca(id, aoMudar){
  var m = modal('<div class="fin-vazio">Carregando...</div>');
  var d;
  try { d = await api('ctl_cob_ver', { id: id }); } catch(e){ m.el.innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; return; }
  var c = d.cobranca, g = pode('gestor'), conf = pode('conferente'), ativa = c.status === 'ativa';
  var h = '<div style="display:flex;justify-content:space-between;gap:8px;align-items:start"><div><div style="font-weight:700;font-size:16px">' + esc(c.empresa) + '</div>' +
    '<div class="fin-sub">' + esc(c.unidade_nome) + ' · semana ' + dataBR(c.semana_ini) + ' a ' + dataBR(c.semana_fim) + (c.empresa_doc ? ' · doc ' + esc(c.empresa_doc) : '') + ' · origem: ' + esc(c.origem) + '</div></div>' +
    '<div>' + chipSit(c.situacao) + ' ' + chipConfReg(c) + '</div></div>' +
    '<div class="fin-kpis" style="margin-top:10px">' + kpi('Valor', moeda(c.valor), '', n(c.desconto) ? 'desconto ' + moeda(c.desconto) + (c.desconto_motivo ? ' (' + esc(c.desconto_motivo) + ')' : '') : '') +
      kpi('Multa', moeda(c.multa), n(c.multa) ? '#E24B4A' : '', c.isento_multa ? 'isenta por ' + esc(nome(c.isencao_por)) + ': ' + esc(c.isencao_motivo || '') : n(c.multa_pct) + '% se atrasar') +
      kpi('Recebido', moeda(c.recebido), '#1D9E75', c.qtd_receb + ' recebimento(s)') + kpi('Saldo', moeda(Math.max(0, n(c.saldo))), n(c.saldo) > 0 ? '#E24B4A' : '#1D9E75', c.vencimento ? 'vence ' + dataBR(c.vencimento) : 'sem vencimento') + '</div>' +
    (c.status === 'cancelada' ? '<div class="fin-erro">Cancelada por ' + esc(nome(c.cancelado_por)) + ' em ' + dataHoraBR(c.cancelado_em) + ': ' + esc(c.cancelado_motivo) + '</div>' : '') +
    (c.observacao ? '<div class="fin-sub" style="margin:6px 0">Obs.: ' + esc(c.observacao) + '</div>' : '') +
    '<div style="font-weight:700;margin:10px 0 4px">Recebimentos</div>' +
    (d.recebimentos.length ? '<table class="fin-tbl"><tbody>' + d.recebimentos.map(function(r){
      return '<tr' + (r.estornado ? ' style="opacity:.55;text-decoration:line-through"' : '') + '><td>' + dataBR(r.data) + '</td><td class="fin-ent">' + moeda(r.valor) + '</td><td class="fin-sub">' + esc(r.nome_no_banco || '') + (r.forma ? ' · ' + esc(r.forma) : '') + '<br>lançado por ' + esc(nome(r.criado_por)) + (r.estornado ? '<br>estornado: ' + esc(r.estorno_motivo || '') : '') + '</td>' +
        '<td>' + (!r.estornado && g ? '<button class="fin-bt sus" data-est="' + r.id + '">Estornar</button>' : '') + '</td></tr>'; }).join('') + '</tbody></table>' : '<div class="fin-sub">Nenhum recebimento.</div>') +
    (ativa && conf && n(c.saldo) > 0 ? '<div class="fin-card" style="margin-top:8px"><div class="fin-grid2">' +
      '<label>Valor recebido (R$)<input id="vr-val" inputmode="decimal" value="' + n(c.saldo).toFixed(2).replace('.', ',') + '"></label><label>Data<input type="date" id="vr-data" value="' + hoje() + '" max="' + hoje() + '"></label>' +
      '<label>Forma<select id="vr-forma"><option>Pix</option><option>Boleto</option><option>TED</option><option>Dinheiro</option><option>Outra</option></select></label>' +
      '<label>Nome no banco<input id="vr-banco" maxlength="200" value="' + esc(c.nome_no_banco || '') + '"></label><label style="grid-column:1/-1">Observação<input id="vr-obs" maxlength="500"></label></div>' +
      '<button class="fin-bt pri" id="vr-ok" style="margin-top:6px">Registrar recebimento</button><div id="vr-err"></div></div>' : '') +
    (d.conferencias.length ? '<div style="font-weight:700;margin:10px 0 4px">Conferências</div>' + d.conferencias.map(function(x){ return '<div class="fin-sub">' + dataHoraBR(x.conferido_em) + ' · ' + esc(nome(x.conferido_por)) + ' · ' + (x.status === 'ok' ? '✅ ok' : '⚠️ divergente') + (x.observacao ? ': ' + esc(x.observacao) : '') + '</div>'; }).join('') : '') +
    historicoHtml(d.historico) +
    '<div class="fin-filtros" style="margin-top:12px">' + (ativa && conf ? '<button class="fin-bt" id="vc-edit">Corrigir</button>' : '') + (ativa && g ? '<button class="fin-bt sus" id="vc-canc">Cancelar cobrança</button>' : '') + '<button class="fin-bt" id="vc-x">Fechar</button></div>';
  m.el.innerHTML = h;
  var reabrir = function(){ m.fechar(); aoMudar && aoMudar(); verCobranca(id, aoMudar); };
  $('vc-x').onclick = m.fechar;
  if($('vc-edit')) $('vc-edit').onclick = function(){ m.fechar(); formCobranca(c, function(){ aoMudar && aoMudar(); verCobranca(id, aoMudar); }); };
  if($('vc-canc')) $('vc-canc').onclick = function(){ pedirMotivo('Cancelar a cobrança de ' + c.empresa, async function(mot){ await api('ctl_cancelar', { tabela: 'cobrancas', id: id, motivo: mot }); toast('Cobrança cancelada'); reabrir(); }); };
  m.el.querySelectorAll('[data-est]').forEach(function(b){ b.onclick = function(){ pedirMotivo('Estornar recebimento', async function(mot){ await api('ctl_estornar_receb', { id: Number(b.getAttribute('data-est')), motivo: mot }); toast('Recebimento estornado'); reabrir(); }); }; });
  if($('vr-ok')) $('vr-ok').onclick = function(){ var bt = this; travado(bt, async function(){
    try { await api('ctl_cob_receber', { cobranca_id: id, valor: $('vr-val').value, data: $('vr-data').value, forma: $('vr-forma').value, nome_no_banco: $('vr-banco').value, observacao: $('vr-obs').value }); toast('Recebimento registrado'); reabrir(); }
    catch(e){ $('vr-err').innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; } }); };
}

/* ================= CRÉDITOS ================= */
T.ctl_creditos = async function(el){
  carregando(el);
  try { await base(); } catch(e){ erroEm(el, e); return; }
  var f = F.ctlCred = F.ctlCred || { unidade_id: '', ini: inicioMes(), fim: hoje(), motivo: '', conf: '', busca: '', operador: '', status: '', pagina: 0 };
  var rec = function(){ T.ctl_creditos(el); };
  el.innerHTML = '<div class="fin-filtros"><select id="kc-un">' + optsCidade(f.unidade_id, true) + '</select>' +
    '<span class="fin-sub">De</span><input type="date" id="kc-ini" value="' + f.ini + '"><span class="fin-sub">até</span><input type="date" id="kc-fim" value="' + f.fim + '">' +
    '<select id="kc-mot"><option value="">Todos os motivos</option>' + Object.keys(MOTIVO).map(function(k){ return '<option value="' + k + '"' + (f.motivo === k ? ' selected' : '') + '>' + MOTIVO[k] + '</option>'; }).join('') + '</select>' +
    '<select id="kc-conf"><option value="">Conferência: todas</option><option value="sem"' + (f.conf === 'sem' ? ' selected' : '') + '>Falta conferir</option><option value="ok"' + (f.conf === 'ok' ? ' selected' : '') + '>Conferidos</option><option value="divergente"' + (f.conf === 'divergente' ? ' selected' : '') + '>Divergentes</option></select>' +
    '<select id="kc-st"><option value="">Ativos</option><option value="cancelado"' + (f.status === 'cancelado' ? ' selected' : '') + '>Cancelados</option></select>' +
    '<input id="kc-busca" placeholder="Quem recebeu" maxlength="60" value="' + esc(f.busca) + '"><input id="kc-op" placeholder="Operador" maxlength="60" value="' + esc(f.operador) + '" style="width:110px">' +
    '<button class="fin-bt pri" id="kc-ok">Filtrar</button>' + (pode('conferente') ? '<button class="fin-bt" id="kc-novo">+ Novo crédito</button>' : '') + '</div><div id="kc-out"></div>';
  var aplicar = function(){ f.unidade_id = $('kc-un').value; f.ini = $('kc-ini').value; f.fim = $('kc-fim').value; f.motivo = $('kc-mot').value; f.conf = $('kc-conf').value; f.status = $('kc-st').value; f.busca = $('kc-busca').value.trim(); f.operador = $('kc-op').value.trim(); f.pagina = 0; rec(); };
  $('kc-ok').onclick = aplicar; ['kc-busca', 'kc-op'].forEach(function(i){ $(i).onkeydown = function(ev){ if(ev.key === 'Enter') aplicar(); }; });
  if($('kc-novo')) $('kc-novo').onclick = function(){ formCredito(null, rec); };
  var out = $('kc-out'); carregando(out);
  try {
    var arg = { unidade_id: f.unidade_id || null, ini: f.ini, fim: f.fim };
    var rs = (await api('ctl_cred_resumo', arg)).resumo || {};
    var j = await api('ctl_cred_listar', Object.assign({}, arg, { motivo: f.motivo || null, conf: f.conf || null, busca: f.busca || null, operador: f.operador || null, status: f.status || null, pagina: f.pagina }));
    var porMot = (rs.por_motivo || []).slice(0, 4).map(function(x){ return esc(MOTIVO[x.motivo] || x.motivo) + ' ' + moeda(x.valor); }).join(' · ');
    var porOp = (rs.por_operador || []).slice(0, 3).map(function(x){ return esc(x.operador) + ' ' + moeda(x.valor); }).join(' · ');
    var h = '<div class="fin-kpis">' + kpi('Créditos no período', moeda(rs.valor), '', (rs.qtd || 0) + ' lançamento(s)') +
      kpi('Falta conferir', String(rs.sem_conferencia || 0), n(rs.sem_conferencia) ? '#D68910' : '#1D9E75', (rs.divergentes || 0) + ' divergente(s)') +
      kpi('Por motivo', '', '', porMot || '-') + kpi('Quem mais lançou', '', '', porOp || '-') + '</div>';
    var lst = j.linhas || [];
    h += (f.status === 'cancelado' ? '' : barraConferir('creditos'));
    h += '<div class="fin-sub" style="margin-bottom:6px">' + j.total + ' crédito(s)' + (j.total > 200 ? ' · página ' + (j.pagina + 1) + ' de ' + Math.ceil(j.total / 200) : '') + '. Clique numa linha para ver ou corrigir.</div>';
    if(!lst.length) h += '<div class="fin-vazio">Nenhum crédito com esse filtro.</div>';
    else {
      var meu = eu(), comSel = pode('conferente') && f.status !== 'cancelado';
      h += '<div class="fin-card" style="overflow-x:auto"><table class="fin-tbl"><thead><tr>' + (comSel ? '<th><input type="checkbox" id="ctl-sel-todos"></th>' : '') +
        '<th>Data</th><th>Cidade</th><th>Quem recebeu</th><th style="text-align:right">Valor</th><th>Motivo</th><th>Operador</th><th>Conferência</th></tr></thead><tbody>' +
        lst.map(function(c){
          var podeConf = c.status === 'ativo' && c.criado_por !== meu;
          return '<tr class="kc-lin" data-id="' + c.id + '" style="cursor:pointer">' + (comSel ? '<td><input type="checkbox" class="ctl-sel" value="' + c.id + '"' + (podeConf ? '' : ' disabled title="Você lançou este"') + '></td>' : '') +
            '<td>' + dataBR(c.data) + (c.hora ? ' <span class="fin-sub">' + esc(String(c.hora).slice(0, 5)) + '</span>' : '') + '</td><td class="fin-sub">' + esc((c.unidade_nome || '').replace(/^Gam[iy] (Delivery )?/i, '')) + '</td>' +
            '<td><b>' + esc(c.beneficiario) + '</b>' + (c.entregador_id ? ' <span class="fin-sub">#' + esc(c.entregador_id) + '</span>' : '') + (c.empresa ? '<div class="fin-sub">' + esc(c.empresa) + '</div>' : '') + '</td>' +
            '<td style="text-align:right;font-weight:700">' + moeda(c.valor) + '</td><td>' + esc(MOTIVO[c.motivo] || c.motivo) + (c.observacao ? '<div class="fin-sub">' + esc(c.observacao.slice(0, 60)) + '</div>' : '') + '</td>' +
            '<td class="fin-sub">' + esc(c.operador || '-') + '</td><td>' + (c.status === 'cancelado' ? chip('Cancelado', '#7F8C8D') : chipConfReg(c)) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    if(j.total > 200) h += '<div class="fin-filtros" style="margin-top:8px">' + (j.pagina > 0 ? '<button class="fin-bt" id="kc-ant">← Anterior</button>' : '') + ((j.pagina + 1) * 200 < j.total ? '<button class="fin-bt" id="kc-prox">Próxima →</button>' : '') + '</div>';
    out.innerHTML = h;
    out.querySelectorAll('.kc-lin').forEach(function(tr){ tr.onclick = function(){ verCredito(Number(tr.getAttribute('data-id')), rec); }; });
    if($('kc-ant')) $('kc-ant').onclick = function(){ f.pagina--; rec(); };
    if($('kc-prox')) $('kc-prox').onclick = function(){ f.pagina++; rec(); };
    ligarConferir('creditos', out, rec);
  } catch(e){ erroEm(out, e); }
};

function formCredito(c, aoSalvar){
  var novo = !c; c = c || { data: hoje(), beneficiario_tipo: 'entregador', motivo: '' };
  var m = modal('<div style="font-weight:700;font-size:15px;margin-bottom:8px">' + (novo ? 'Novo crédito na carteira' : 'Corrigir crédito') + '</div><div class="fin-grid2">' +
    (novo ? '<label>Cidade<select id="kf-un">' + optsCidade(F.ctlCred && F.ctlCred.unidade_id) + '</select></label><label>Data<input type="date" id="kf-data" value="' + c.data + '" max="' + hoje() + '"></label>' +
      '<label>Valor (R$)<input id="kf-val" inputmode="decimal" placeholder="0,00"></label>' +
      '<label>Quem recebeu<input id="kf-benef" maxlength="200" placeholder="Nome do entregador ou empresa"></label>'
    : '<div style="grid-column:1/-1" class="fin-sub">' + esc(c.beneficiario) + ' · ' + moeda(c.valor) + ' · ' + dataBR(c.data) + ' · ' + esc(nomeCidade(c.unidade_id)) + '<br>Data, valor e quem recebeu não mudam: se estiverem errados, cancele e lance de novo.</div>') +
    '<label>Hora<input type="time" id="kf-hora" value="' + esc(c.hora ? String(c.hora).slice(0, 5) : '') + '"></label>' +
    '<label>É de<select id="kf-tipo"><option value="entregador"' + (c.beneficiario_tipo === 'entregador' ? ' selected' : '') + '>Entregador</option><option value="empresa"' + (c.beneficiario_tipo === 'empresa' ? ' selected' : '') + '>Empresa</option><option value="outro"' + (c.beneficiario_tipo === 'outro' ? ' selected' : '') + '>Outro</option></select></label>' +
    '<label>ID do entregador (Machine)<input id="kf-id" maxlength="40" value="' + esc(c.entregador_id || '') + '"></label>' +
    '<label>Empresa ligada<input id="kf-emp" maxlength="200" value="' + esc(c.empresa || '') + '"></label>' +
    '<label>OS<input id="kf-os" maxlength="60" value="' + esc(c.os || '') + '"></label><label>Operador (quem creditou na Machine)<input id="kf-op" maxlength="100" value="' + esc(c.operador || '') + '"></label>' +
    '<label>Motivo<select id="kf-mot"><option value="">Escolha...</option>' + Object.keys(MOTIVO).map(function(k){ return '<option value="' + k + '"' + (c.motivo === k ? ' selected' : '') + '>' + MOTIVO[k] + '</option>'; }).join('') + '</select></label>' +
    '<label style="grid-column:1/-1">Observação<textarea id="kf-obs" rows="2" maxlength="1000">' + esc(c.observacao || '') + '</textarea></label></div>' +
    '<div class="fin-filtros" style="margin-top:10px"><button class="fin-bt pri" id="kf-ok">Salvar</button><button class="fin-bt" id="kf-x">Fechar</button></div><div id="kf-err"></div>');
  $('kf-x').onclick = m.fechar;
  $('kf-ok').onclick = function(){
    travado(this, async function(){
      var d = { id: novo ? null : c.id, hora: $('kf-hora').value || null, beneficiario_tipo: $('kf-tipo').value, entregador_id: $('kf-id').value, empresa: $('kf-emp').value,
        os: $('kf-os').value, operador: $('kf-op').value, motivo: $('kf-mot').value, observacao: $('kf-obs').value };
      if(novo){ d.unidade_id = $('kf-un').value; d.data = $('kf-data').value; d.valor = $('kf-val').value; d.beneficiario = $('kf-benef').value; }
      try { await api('ctl_cred_salvar', d); toast('Crédito salvo'); m.fechar(); aoSalvar && aoSalvar(); }
      catch(e){
        if(novo && /crédito igual/.test(e.message) && confirm(e.message + '\n\nÉ outro crédito de verdade? Lançar mesmo assim?')){
          try { d.permitir_repetido = true; await api('ctl_cred_salvar', d); toast('Crédito salvo'); m.fechar(); aoSalvar && aoSalvar(); return; } catch(e2){ e = e2; }
        }
        $('kf-err').innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>';
      }
    });
  };
}

async function verCredito(id, aoMudar){
  var m = modal('<div class="fin-vazio">Carregando...</div>');
  var d;
  try { d = await api('ctl_cred_ver', { id: id }); } catch(e){ m.el.innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; return; }
  var c = d.credito, ativo = c.status === 'ativo';
  m.el.innerHTML = '<div style="display:flex;justify-content:space-between;gap:8px"><div><div style="font-weight:700;font-size:16px">' + esc(c.beneficiario) + (c.entregador_id ? ' <span class="fin-sub">#' + esc(c.entregador_id) + '</span>' : '') + '</div>' +
    '<div class="fin-sub">' + esc(c.unidade_nome) + ' · ' + dataBR(c.data) + (c.hora ? ' ' + esc(String(c.hora).slice(0, 5)) : '') + ' · ' + esc(MOTIVO[c.motivo] || c.motivo) + ' · origem: ' + esc(c.origem) + '</div></div>' +
    '<div style="font-size:20px;font-weight:800">' + moeda(c.valor) + '</div></div>' +
    '<div class="fin-sub" style="margin-top:6px">Empresa: ' + esc(c.empresa || '-') + ' · OS: ' + esc(c.os || '-') + ' · Operador: ' + esc(c.operador || '-') + '<br>Lançado por ' + esc(nome(c.criado_por)) + ' em ' + dataHoraBR(c.criado_em) + '</div>' +
    (c.observacao ? '<div class="fin-sub" style="margin-top:4px">Obs.: ' + esc(c.observacao) + '</div>' : '') +
    (c.status === 'cancelado' ? '<div class="fin-erro">Cancelado por ' + esc(nome(c.cancelado_por)) + ' em ' + dataHoraBR(c.cancelado_em) + ': ' + esc(c.cancelado_motivo) + '</div>' : '<div style="margin-top:6px">' + chipConfReg(c) + '</div>') +
    (d.conferencias.length ? '<div style="font-weight:700;margin:10px 0 4px">Conferências</div>' + d.conferencias.map(function(x){ return '<div class="fin-sub">' + dataHoraBR(x.conferido_em) + ' · ' + esc(nome(x.conferido_por)) + ' · ' + (x.status === 'ok' ? '✅ ok' : '⚠️ divergente') + (x.observacao ? ': ' + esc(x.observacao) : '') + '</div>'; }).join('') : '') +
    historicoHtml(d.historico) +
    '<div class="fin-filtros" style="margin-top:12px">' + (ativo && pode('conferente') ? '<button class="fin-bt" id="vk-edit">Corrigir</button>' : '') + (ativo && pode('gestor') ? '<button class="fin-bt sus" id="vk-canc">Cancelar crédito</button>' : '') + '<button class="fin-bt" id="vk-x">Fechar</button></div>';
  $('vk-x').onclick = m.fechar;
  if($('vk-edit')) $('vk-edit').onclick = function(){ m.fechar(); formCredito(c, function(){ aoMudar && aoMudar(); verCredito(id, aoMudar); }); };
  if($('vk-canc')) $('vk-canc').onclick = function(){ pedirMotivo('Cancelar o crédito de ' + c.beneficiario, async function(mot){ await api('ctl_cancelar', { tabela: 'creditos', id: id, motivo: mot }); toast('Crédito cancelado'); m.fechar(); aoMudar && aoMudar(); }); };
}

/* ================= IMPORTAR PLANILHAS ANTIGAS ================= */
function lerB64(file){ return new Promise(function(ok, falha){ var r = new FileReader(); r.onload = function(){ ok(String(r.result).split(',')[1] || ''); }; r.onerror = function(){ falha(new Error('Não consegui ler o arquivo')); }; r.readAsDataURL(file); }); }
T.ctl_importar = async function(el){
  carregando(el);
  try { await base(); } catch(e){ erroEm(el, e); return; }
  el.innerHTML = '<div class="fin-card" style="max-width:820px"><div style="font-weight:700;font-size:14px;margin-bottom:6px">Importar as planilhas antigas (.xlsx)</div>' +
    '<div class="fin-sub" style="margin-bottom:8px">Traz o histórico para o sistema, sem digitar de novo. Importar a mesma planilha (ou uma versão nova dela) não duplica nada. Abas de “conferência” são cópias e ficam de fora; o que não der pra entender aparece como aviso antes de gravar.</div>' +
    '<div class="fin-filtros"><select id="ip-tipo"><option value="">Qual planilha?</option><option value="empresas">EMPRESAS (cobrança semanal)</option><option value="creditos">CRÉDITOS</option></select>' +
    '<select id="ip-un">' + optsCidade('') + '</select><input id="ip-ano" type="number" min="2020" max="2100" value="' + hoje().slice(0, 4) + '" style="width:80px" title="Ano da planilha">' +
    '<input type="file" id="ip-arq" accept=".xlsx"><button class="fin-bt pri" id="ip-ver">Conferir antes</button></div><div id="ip-out"></div></div><div id="ip-hist" style="margin-top:12px"></div>';
  var b64 = null, nomeArq = '';
  var params = function(){ return { tipo: $('ip-tipo').value, unidade_id: $('ip-un').value, ano: $('ip-ano').value, conteudo_b64: b64, arquivo_nome: nomeArq }; };
  ['ip-tipo', 'ip-un', 'ip-ano', 'ip-arq'].forEach(function(i){ $(i).onchange = function(){ b64 = null; $('ip-out').innerHTML = ''; }; });
  $('ip-ver').onclick = function(){
    var bt = this;
    travado(bt, async function(){
      var file = $('ip-arq').files[0]; var out = $('ip-out');
      if(!$('ip-tipo').value || !$('ip-un').value || !file){ toast('Escolha a planilha, a cidade e o arquivo', 'aviso'); return; }
      if(file.size > 4 * 1024 * 1024){ toast('Arquivo grande demais (máx. 4 MB)', 'erro'); return; }
      carregando(out);
      try {
        b64 = await lerB64(file); nomeArq = file.name;
        var r = (await api('ctl_importar', params())).resumo;
        out.innerHTML = '<div class="fin-kpis" style="margin-top:10px">' + kpi('Linhas para importar', String(r.linhas), '', 'cidade: ' + esc(nomeCidade($('ip-un').value))) + kpi('Soma', moeda(r.soma), '', r.recebido != null ? 'recebido ' + moeda(r.recebido) : '') + kpi('Avisos', String(r.qtd_avisos), r.qtd_avisos ? '#D68910' : '#1D9E75', r.qtd_avisos ? 'veja abaixo antes de confirmar' : 'nenhum') + '</div>' +
          '<details' + (r.qtd_avisos ? ' open' : '') + '><summary class="fin-sub" style="cursor:pointer">Abas (' + r.abas.length + ') e avisos</summary><div style="max-height:260px;overflow:auto">' +
          r.abas.map(function(a){ return '<div class="fin-sub">• ' + esc(a.aba) + ': ' + (a.linhas != null ? a.linhas + ' linha(s)' + (a.semana ? ' (' + esc(a.semana) + ')' : '') : esc(a.status || '')) + '</div>'; }).join('') +
          (r.avisos.length ? '<div style="margin-top:6px;font-weight:700">Avisos</div>' + r.avisos.map(function(a){ return '<div class="fin-sub" style="color:#B7791F">⚠️ ' + esc(a) + '</div>'; }).join('') : '') + '</div></details>' +
          (r.linhas && r.avisos.some(function(a){ return /^ATENÇÃO/.test(a); }) ? '<label class="fin-sub" style="display:flex;gap:6px;align-items:center;margin-top:8px;color:#C0392B"><input type="checkbox" id="ip-ciente"> Li os avisos de ATENÇÃO e confirmo que a cidade e o ano estão certos</label>' : '') +
          (r.linhas ? '<button class="fin-bt pri" id="ip-ok" style="margin-top:8px">Confirmar e importar ' + r.linhas + ' linha(s)</button>' : '');
        if($('ip-ok')) $('ip-ok').onclick = function(){ var b2 = this; if($('ip-ciente') && !$('ip-ciente').checked){ toast('Marque que conferiu os avisos de ATENÇÃO', 'aviso'); return; } travado(b2, async function(){
          try { var p = params(); p.confirmar = true; var k = await api('ctl_importar', p); b64 = null; $('ip-arq').value = '';
            var dif = k.valor_diferente || [];
            out.innerHTML = '<div class="fin-card" style="margin-top:10px;border-color:#1D9E75">✅ Importado: <b>' + k.novas + '</b> nova(s), ' + k.repetidas + ' já existiam' + (k.ja_lancadas_a_mao ? ', ' + k.ja_lancadas_a_mao + ' já tinham sido lançadas à mão (não duplicou)' : '') + (k.recebimentos ? ', ' + k.recebimentos + ' recebimento(s)' : '') + '.<div class="fin-sub">A planilha original ficou guardada como prova. Agora confira na aba correspondente.</div>' +
              (dif.length ? '<div class="fin-erro" style="margin-top:8px">⚠️ ' + dif.length + ' linha(s) mudaram de valor desde a última importação. O sistema manteve o valor antigo; confira e corrija (cancelar e lançar de novo):<br>' + dif.map(function(d){ return esc(d.empresa) + ' · semana ' + dataBR(d.semana) + ': no sistema ' + moeda(d.no_sistema) + ', na planilha ' + moeda(d.na_planilha); }).join('<br>') + '</div>' : '') + '</div>';
            toast('Importado'); hist(); }
          catch(e){ erroEm(out, e); } }); };
      } catch(e){ erroEm(out, e); b64 = null; }
    });
  };
  async function hist(){
    try { var j = await api('ctl_importacoes'); var l = j.importacoes || [];
      $('ip-hist').innerHTML = l.length ? '<div class="fin-card" style="overflow-x:auto"><div style="font-weight:700;font-size:13px;margin-bottom:6px">Importações feitas</div><table class="fin-tbl"><tbody>' + l.map(function(x){ return '<tr><td>' + dataHoraBR(x.importado_em) + '</td><td>' + esc(x.tipo === 'empresas' ? 'Empresas' : 'Créditos') + '</td><td>' + esc(nomeCidade(x.unidade_id)) + '</td><td class="fin-sub">' + esc(x.arquivo_nome || '') + '</td><td>' + x.qtd_novas + ' de ' + x.qtd_linhas + '</td><td class="fin-sub">' + esc(nome(x.importado_por)) + '</td></tr>'; }).join('') + '</tbody></table></div>' : '';
    } catch(e){ /* histórico é só informativo */ }
  }
  hist();
};
})();
