/* ============================================================
   📋 FINANCEIRO · PLANILHAS (Bags, Camisetas, Motoboys novos, Motoboys semanal, Descontos)
   Cada uma com a CARA da planilha: abas de mês (ou semana), as mesmas colunas, linha pra digitar
   no topo e linha de TOTAL embaixo. Por trás: nada se apaga, valor/nome não mudam depois de lançados,
   quem lança não confere ("CONFIRMAÇÃO"), tudo auditado. As regras de verdade estão no servidor/banco.
   ============================================================ */
(function(){
'use strict';
var U = window._FINUI; if(!U){ console.error('financeiro-ui-planilhas: carregue financeiro-ui.js antes'); return; }
var api = U.api, esc = U.esc, moeda = U.moeda, dataBR = U.dataBR, dataHoraBR = U.dataHoraBR, nome = U.nome, hoje = U.hoje,
    pode = U.pode, toast = U.toast, modal = U.modal, $ = U.$;
var F = window._FIN;
var T = window._FIN_TELAS = window._FIN_TELAS || {};

function n(v){ return Number(v) || 0; }
function eu(){ var u = (typeof getUsuarioLogado === 'function') ? getUsuarioLogado() : null; return u && u.id; }
function addDias(iso, d){ var t = new Date(iso + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); }
function segunda(iso){ var t = new Date(iso + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() - (t.getUTCDay() + 6) % 7); return t.toISOString().slice(0, 10); }
function inicioMes(iso){ return (iso || hoje()).slice(0, 8) + '01'; }
function fimMes(iso){ var p = iso.split('-').map(Number); return new Date(Date.UTC(p[0], p[1], 0)).toISOString().slice(0, 10); }
var MESES = ['JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];
function nomeAba(ini, fim, semanal){ return semanal ? dataBR(ini).slice(0, 5) + ' a ' + dataBR(fim).slice(0, 5) : MESES[+ini.slice(5, 7) - 1] + ' ' + ini.slice(0, 4); }
function chip(t, cor){ return '<span class="fin-chip" style="color:' + cor + ';background:rgba(127,127,127,.12)">' + esc(t) + '</span>'; }
function conf(r){
  if(r.status === 'cancelado') return chip('Cancelado', '#7F8C8D');
  if(r.conf_desatualizada) return chip('🔁 conferir de novo', '#D68910');
  if(r.conf_status === 'ok') return chip('✅ ok · ' + nome(r.conferido_por), '#1D9E75');
  if(r.conf_status === 'divergente') return chip('⚠️ divergente', '#C0392B');
  return '<span class="fin-sub">falta conferir</span>';
}
var SIT = { pendente: ['A pagar', '#C0392B'], parcial: ['Parcial', '#D68910'], pago: ['Pago', '#1D9E75'], cortesia: ['Cortesia', '#7F8C8D'] };
var FORMAS = { pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão', boleto: 'Boleto', cortesia: 'Cortesia / doação', desconto_semanal: 'Desconto no semanal', outro: 'Outro' };
function optsForma(sel){ return Object.keys(FORMAS).map(function(k){ return '<option value="' + k + '"' + (sel === k ? ' selected' : '') + '>' + FORMAS[k] + '</option>'; }).join(''); }
async function travado(bt, fn){ if(bt.disabled) return; bt.disabled = true; var t = bt.textContent; bt.textContent = '...'; try { await fn(); } finally { bt.disabled = false; bt.textContent = t; } }

// ---------- definição de cada planilha (colunas iguais às da planilha) ----------
// c = coluna: { t: título, v: valor da linha, num: alinhar à direita, tot: chave do total, inp: campo de digitação }
var PL = {
  bag: { titulo: '🎒 Bags', semanal: false, tipo: 'bag', pagavel: true, cols: [
    { t: 'NOME', v: function(r){ return '<b>' + esc(r.nome) + '</b>'; }, inp: '<input data-k="nome" maxlength="200" placeholder="Nome">' },
    { t: 'QUANT', num: true, v: function(r){ return r.quantidade; }, tot: 'quantidade', inp: '<input data-k="quantidade" type="number" min="1" value="1" style="width:60px">' },
    { t: 'FORMA DE PAGAMENTO', v: function(r){ return esc(FORMAS[r.forma] || r.forma || '-'); }, inp: '<select data-k="forma">' + optsForma('pix') + '</select>' },
    { t: 'VALOR UNITÁRIO', num: true, v: function(r){ return moeda(r.valor_unitario); }, inp: '<input data-k="valor_unitario" inputmode="decimal" placeholder="0,00" style="width:80px">' },
    { t: 'VALOR TOTAL', num: true, v: function(r){ return '<b>' + moeda(r.valor) + '</b>'; }, tot: 'valor' },
    { t: 'PAGO', num: true, v: function(r){ return moeda(r.pago); }, tot: 'pago', inp: '<input data-k="valor_pago" inputmode="decimal" placeholder="pago agora" style="width:85px">' },
    { t: 'FALTA', num: true, v: function(r){ return n(r.saldo) > 0 ? '<b style="color:#C0392B">' + moeda(r.saldo) + '</b>' : '-'; }, tot: 'saldo' },
    { t: 'DATA', v: function(r){ return dataBR(r.data); }, inp: '<input data-k="data" type="date">' },
    { t: 'PAGAMENTO EM NOME DE QUEM', v: function(r){ return esc(r.pago_por || ''); }, inp: '<input data-k="pago_por" maxlength="200" placeholder="Quem pagou">' },
    { t: 'SITUAÇÃO', v: function(r){ var s = SIT[r.situacao]; return s ? chip(s[0], s[1]) : ''; } }
  ]},
  moto_novo: { titulo: '🆕 Motoboys novos', semanal: false, tipo: 'moto_novo', pagavel: true, cols: [
    { t: 'NOME', v: function(r){ return '<b>' + esc(r.nome) + '</b>'; }, inp: '<input data-k="nome" maxlength="200" placeholder="Nome do motoboy">' },
    { t: 'VALOR', num: true, v: function(r){ return moeda(r.valor); }, tot: 'valor', inp: '<input data-k="valor" inputmode="decimal" value="10,00" style="width:80px">' },
    { t: 'PAGO', num: true, v: function(r){ return moeda(r.pago); }, tot: 'pago', inp: '<input data-k="valor_pago" inputmode="decimal" value="10,00" style="width:80px" title="Quanto já pagou">' },
    { t: 'DATA', v: function(r){ return dataBR(r.data); }, inp: '<input data-k="data" type="date">' },
    { t: 'PAGAMENTO EM NOME DE QUEM', v: function(r){ return esc(r.pago_por || ''); }, inp: '<input data-k="pago_por" maxlength="200" placeholder="Quem pagou">' },
    { t: 'SITUAÇÃO', v: function(r){ var s = SIT[r.situacao]; return s ? chip(s[0], s[1]) : ''; } }
  ]},
  motoboy_semanal: { titulo: '🛵 Motoboys (semanal)', semanal: true, tipo: 'motoboy_semanal', cols: [
    { t: 'NOME', v: function(r){ return '<b>' + esc(r.nome) + '</b>' + (r.observacao ? '<div class="fin-sub">' + esc(r.observacao) + '</div>' : ''); }, inp: '<input data-k="nome" maxlength="200" placeholder="Nome do motoboy">' },
    { t: 'FATURAMENTO', num: true, v: function(r){ return moeda(r.valor); }, tot: 'valor', inp: '<input data-k="valor" inputmode="decimal" placeholder="0,00" style="width:95px">' },
    { t: 'VALOR A PAGAR (%)', num: true, v: function(r){ return moeda(r.valor_gami) + ' <span class="fin-sub">' + String(n(r.percentual)).replace('.', ',') + '%</span>'; }, tot: 'valor_gami', inp: '<input data-k="percentual" inputmode="decimal" value="21" style="width:50px" title="% da Gâmi">' },
    { t: 'TOTAL DO ENTREGADOR', num: true, v: function(r){ return '<b>' + moeda(r.valor_entregador) + '</b>'; }, tot: 'valor_entregador' }
  ]},
  descontos: { titulo: '💸 Descontos', semanal: false, tipos: ['desconto_banco', 'desconto_fora'], cols: [
    { t: 'NOME DA EMPRESA / MOTOBOY / FAVORECIDO', v: function(r){ return '<b>' + esc(r.nome) + '</b>'; }, inp: '<input data-k="nome" maxlength="200" placeholder="Nome">' },
    { t: 'VALOR', num: true, v: function(r){ return moeda(r.valor); }, tot: 'valor', inp: '<input data-k="valor" inputmode="decimal" placeholder="0,00" style="width:90px">' },
    { t: 'MOTIVO', v: function(r){ return esc(r.motivo || ''); }, inp: '<input data-k="motivo" maxlength="300" placeholder="Motivo">' },
    { t: 'DATA', v: function(r){ return dataBR(r.data); }, inp: '<input data-k="data" type="date">' },
    { t: 'RESPONSÁVEL', fora: true, v: function(r){ return esc(r.responsavel || ''); }, inp: '<input data-k="responsavel" maxlength="100" placeholder="Responsável">' }
  ]}
};
// CAMISETAS = BAGS + data e tamanho na frente (igual à planilha)
PL.camiseta = { titulo: '👕 Camisetas', semanal: false, tipo: 'camiseta', pagavel: true, cols: [PL.bag.cols[0],
  { t: 'TAM', v: function(r){ return esc(r.tamanho || ''); }, inp: '<select data-k="tamanho"><option>P</option><option selected>M</option><option>G</option><option>GG</option><option>XG</option></select>' }]
  .concat(PL.bag.cols.slice(1)) };

function css(){
  if($('fin-css-pl')) return;
  var s = document.createElement('style'); s.id = 'fin-css-pl';
  s.textContent = [
    '.pl-abas{display:flex;gap:2px;overflow-x:auto;border-bottom:2px solid var(--border);margin:8px 0 0}',
    '.pl-aba{padding:7px 12px;border:1px solid var(--border);border-bottom:none;border-radius:8px 8px 0 0;background:var(--surface2);cursor:pointer;font-size:12px;white-space:nowrap}',
    '.pl-aba.on{background:#1D9E75;color:#fff;font-weight:700;border-color:#1D9E75}',
    '.pl-aba .q{opacity:.7;font-size:11px;margin-left:4px}',
    '.pl-grade{width:100%;border-collapse:collapse;font-size:12.5px}',
    '.pl-grade th{position:sticky;top:0;background:#0B2542;color:#fff;text-align:left;padding:7px 8px;font-size:11px;letter-spacing:.3px;border:1px solid #1d3a5c;white-space:nowrap}',
    '.pl-grade td{padding:6px 8px;border:1px solid var(--border);vertical-align:top}',
    '.pl-grade tbody tr:nth-child(even){background:var(--surface2)}',
    '.pl-grade tbody tr.pl-l:hover{background:rgba(29,158,117,.08);cursor:pointer}',
    '.pl-grade td.num,.pl-grade th.num{text-align:right;white-space:nowrap}',
    '.pl-grade tr.pl-nova td{background:rgba(29,158,117,.07)}',
    '.pl-grade tr.pl-nova input,.pl-grade tr.pl-nova select{width:100%;min-width:60px;padding:5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font:inherit}',
    '.pl-grade tfoot td{background:#E8F5EF;font-weight:800;border-top:2px solid #1D9E75}',
    '.pl-sub{display:flex;gap:6px;margin:6px 0}'
  ].join('');
  document.head.appendChild(s);
}

async function base(){ if(!F.ctlBase) F.ctlBase = await api('ctl_base'); return F.ctlBase; }
function optsCidade(sel){
  return (F.ctlBase.unidades || []).filter(function(u){ return u.ativo; }).map(function(u){ return '<option value="' + u.id + '"' + (String(sel) === String(u.id) ? ' selected' : '') + '>' + esc(u.nome) + '</option>'; }).join('');
}

function tela(chaveP){
  return async function(el){
    css();
    el.innerHTML = '<div class="fin-vazio">Carregando...</div>';
    try { await base(); } catch(e){ el.innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; return; }
    var def = PL[chaveP];
    var st = F['pl_' + chaveP] = F['pl_' + chaveP] || { unidade_id: (F.ctlBase.unidades.filter(function(u){ return u.cidade_slug === 'joao-pessoa'; })[0] || F.ctlBase.unidades[0] || {}).id, ini: null, fim: null, sub: 'desconto_banco', busca: '', conf: '' };
    var rec = function(){ T['pl_' + chaveP](el); };
    var digitando = function(){ var nv = el.querySelector('.pl-nova'); if(!nv) return false; return [].some.call(nv.querySelectorAll('[data-k]'), function(i){ return i.type !== 'date' && i.getAttribute('data-k') !== 'percentual' && i.getAttribute('data-k') !== 'forma' && i.getAttribute('data-k') !== 'tamanho' && i.getAttribute('data-k') !== 'quantidade' && String(i.value || '').trim() !== '' && i.value !== i.defaultValue; }); };
    var podeSair = function(){ return !digitando() || confirm('Você está digitando uma linha que ainda não foi salva. Descartar?'); };
    var podeLancar = pode('conferente');
    el.innerHTML = '<div class="fin-filtros"><b style="font-size:15px">' + def.titulo + '</b><select id="pl-un">' + optsCidade(st.unidade_id) + '</select>' +
      '<input id="pl-busca" placeholder="Buscar nome" maxlength="60" value="' + esc(st.busca) + '" style="width:150px">' +
      '<select id="pl-conf"><option value="">Confirmação: todas</option><option value="sem"' + (st.conf === 'sem' ? ' selected' : '') + '>Falta conferir</option><option value="ok"' + (st.conf === 'ok' ? ' selected' : '') + '>Conferidas</option><option value="divergente"' + (st.conf === 'divergente' ? ' selected' : '') + '>Divergentes</option></select>' +
      '<button class="fin-bt pri" id="pl-ok">Filtrar</button>' + (chaveP === 'motoboy_semanal' && podeLancar ? '<button class="fin-bt ok" id="pl-maq" title="Soma as corridas finalizadas de cada motoboy na semana desta aba">⚡ Calcular da Machine</button>' : '') + '</div>' +
      (chaveP === 'descontos' ? '<div class="pl-sub"><button class="fin-bt' + (st.sub === 'desconto_banco' ? ' pri' : '') + '" data-sub="desconto_banco">🏦 Dentro do banco</button><button class="fin-bt' + (st.sub === 'desconto_fora' ? ' pri' : '') + '" data-sub="desconto_fora">📒 Fora do banco</button></div>' : '') +
      '<div class="pl-abas" id="pl-abas"></div><div id="pl-out"><div class="fin-vazio">Carregando...</div></div>';
    $('pl-ok').onclick = function(){ if(!podeSair()) return; st.unidade_id = $('pl-un').value; st.busca = $('pl-busca').value.trim(); st.conf = $('pl-conf').value; rec(); };
    $('pl-un').onchange = function(){ if(!podeSair()){ this.value = st.unidade_id; return; } st.unidade_id = this.value; st.ini = null; rec(); };
    $('pl-busca').onkeydown = function(ev){ if(ev.key === 'Enter') $('pl-ok').click(); };
    el.querySelectorAll('[data-sub]').forEach(function(b){ b.onclick = function(){ if(!podeSair()) return; st.sub = b.getAttribute('data-sub'); rec(); }; });
    try {
      // abas (meses/semanas que têm dados + a atual)
      var abas = (await api('ctl_reg_abas', { planilha: chaveP, unidade_id: st.unidade_id })).abas || [];
      var atualIni = def.semanal ? segunda(hoje()) : inicioMes();
      if(!abas.some(function(a){ return a.ini === atualIni; })) abas.unshift({ ini: atualIni, fim: def.semanal ? addDias(atualIni, 6) : fimMes(atualIni), qtd: 0 });
      abas.sort(function(a, b){ return a.ini < b.ini ? -1 : 1; });
      if(!st.ini || !abas.some(function(a){ return a.ini === st.ini; })){ st.ini = atualIni; }
      var aba = abas.filter(function(a){ return a.ini === st.ini; })[0];
      st.fim = def.semanal ? aba.ini : aba.fim;
      $('pl-abas').innerHTML = abas.map(function(a){ return '<div class="pl-aba' + (a.ini === st.ini ? ' on' : '') + '" data-ini="' + a.ini + '">' + esc(nomeAba(a.ini, a.fim, def.semanal)) + '<span class="q">' + (n(a.qtd) || '') + '</span>' + (n(a.sem_conferencia) ? ' <span title="falta conferir">•</span>' : '') + '</div>'; }).join('');
      $('pl-abas').querySelectorAll('.pl-aba').forEach(function(t){ t.onclick = function(){ if(!podeSair()) return; st.ini = t.getAttribute('data-ini'); rec(); }; });
      var ativa = $('pl-abas').querySelector('.pl-aba.on'); if(ativa) ativa.scrollIntoView({ block: 'nearest', inline: 'end' });
      if($('pl-maq')) $('pl-maq').onclick = function(){ calcularMachine(st, rec); };
      var arg = { planilha: chaveP, unidade_id: st.unidade_id, ini: st.ini, fim: st.fim, busca: st.busca || null, conf: st.conf || null };
      if(chaveP === 'descontos') arg.tipo = st.sub;
      var j = await api('ctl_reg_listar', arg);
      var cols = def.cols.filter(function(c){ return !c.fora || (chaveP === 'descontos' && st.sub === 'desconto_fora'); });
      var meu = eu();
      var h = (podeLancar ? '<div class="fin-filtros" style="margin:8px 0"><span class="fin-sub" id="pl-n">0 marcada(s)</span><button class="fin-bt ok" id="pl-c-ok" disabled>✅ Confirmar marcadas</button><button class="fin-bt sus" id="pl-c-div" disabled>⚠️ Divergente</button><span class="fin-sub">Quem lançou a linha não confirma a própria linha.</span></div>' : '') +
        '<div class="fin-card" style="padding:0;overflow:auto;max-height:70vh"><table class="pl-grade"><thead><tr>' + (podeLancar ? '<th style="width:26px"><input type="checkbox" id="pl-todas"></th>' : '') +
        cols.map(function(c){ return '<th' + (c.num ? ' class="num"' : '') + '>' + c.t + '</th>'; }).join('') + '<th>CONFIRMAÇÃO</th></tr></thead><tbody>';
      if(podeLancar){
        h += '<tr class="pl-nova">' + '<td>➕</td>' + cols.map(function(c){ return '<td>' + (c.inp || '') + '</td>'; }).join('') + '<td><button class="fin-bt pri" id="pl-salvar">Salvar linha</button></td></tr>';
      }
      var lin = j.linhas || [];
      h += lin.map(function(r){
        var podeConf = r.status === 'ativo' && r.criado_por !== meu;
        return '<tr class="pl-l" data-id="' + r.id + '">' + (podeLancar ? '<td><input type="checkbox" class="pl-sel" value="' + r.id + '"' + (podeConf ? '' : ' disabled title="Você lançou esta linha"') + '></td>' : '') +
          cols.map(function(c){ return '<td' + (c.num ? ' class="num"' : '') + '>' + c.v(r) + '</td>'; }).join('') + '<td>' + conf(r) + '</td></tr>';
      }).join('');
      if(!lin.length) h += '<tr><td colspan="' + (cols.length + 2) + '" class="fin-sub" style="text-align:center;padding:16px">Aba vazia. ' + (podeLancar ? 'Digite na linha verde acima ou importe a planilha antiga em “Importar planilhas”.' : '') + '</td></tr>';
      var t = j.totais || {};
      h += '</tbody><tfoot><tr>' + (podeLancar ? '<td></td>' : '') + cols.map(function(c, i){ return '<td' + (c.num ? ' class="num"' : '') + '>' + (i === 0 ? 'TOTAL (' + (t.linhas || 0) + ')' : c.tot ? (c.tot === 'quantidade' ? n(t.quantidade) : moeda(t[c.tot])) : '') + '</td>'; }).join('') + '<td></td></tr></tfoot></table></div>';
      if(j.total > 200) h += '<div class="fin-sub" style="margin-top:6px">Mostrando 200 de ' + j.total + ' (o total acima é da aba inteira).</div>';
      $('pl-out').innerHTML = h;
      // linha nova: Enter salva; o que foi digitado só some depois de salvar
      var nova = $('pl-out').querySelector('.pl-nova');
      if(nova){
        var dt = nova.querySelector('[data-k=data]'); if(dt){ dt.value = (st.ini <= hoje() && hoje() <= (def.semanal ? addDias(st.ini, 6) : st.fim)) ? hoje() : st.ini; dt.max = hoje(); }
        var salvar = function(){
          travado($('pl-salvar'), async function(){
            var d = { tipo: def.tipo || st.sub, unidade_id: st.unidade_id };
            nova.querySelectorAll('[data-k]').forEach(function(i){ d[i.getAttribute('data-k')] = i.value; });
            if(def.semanal) d.semana_ini = st.ini;
            if(d.forma === 'cortesia' && !(d.observacao)){
              var ob = await U.pedirTexto({ titulo: 'Cortesia / doação', ajuda: 'Para quem e por quê? Fica registrado.', min: 10 }); if(!ob) return; d.observacao = ob;
            }
            try { await api('ctl_reg_salvar', d); }
            catch(e){
              if(/igual/.test(e.message) && confirm(e.message + '\n\nÉ outro lançamento de verdade? Salvar mesmo assim?')){
                d.permitir_repetido = true;
                try { await api('ctl_reg_salvar', d); } catch(e2){ toast(e2.message, 'erro'); return; }
              }
              else { toast(e.message, 'erro'); return; }
            }
            var fimAba = def.semanal ? addDias(st.ini, 6) : st.fim;
            if(!def.semanal && d.data && (d.data < st.ini || d.data > fimAba)){ toast('Linha salva na aba de ' + nomeAba(d.data.slice(0, 8) + '01', fimMes(d.data), false) + ' (pela data que você colocou)', 'aviso'); }
            else toast('Linha salva');
            rec();
          });
        };
        $('pl-salvar').onclick = salvar;
        nova.querySelectorAll('input').forEach(function(i){ i.onkeydown = function(ev){ if(ev.key === 'Enter') salvar(); }; });
        var primeiro = nova.querySelector('[data-k=nome]'); if(primeiro) setTimeout(function(){ try { primeiro.focus(); } catch(e){} }, 50);
      }
      $('pl-out').querySelectorAll('tr.pl-l').forEach(function(tr){ tr.onclick = function(ev){ if(ev.target.type === 'checkbox') return; verRegistro(Number(tr.getAttribute('data-id')), def, rec); }; });
      // confirmação (= conferência por OUTRA pessoa)
      if(podeLancar){
        var bOk = $('pl-c-ok'), bDiv = $('pl-c-div');
        var marcadas = function(){ return [].map.call($('pl-out').querySelectorAll('.pl-sel:checked'), function(c){ return Number(c.value); }); };
        var atu = function(){ var k = marcadas().length; $('pl-n').textContent = k + ' marcada(s)'; bOk.disabled = bDiv.disabled = !k; };
        $('pl-out').querySelectorAll('.pl-sel').forEach(function(c){ c.onchange = atu; });
        $('pl-todas').onchange = function(){ var v = this.checked; $('pl-out').querySelectorAll('.pl-sel:not(:disabled)').forEach(function(c){ c.checked = v; }); atu(); };
        bOk.onclick = function(){ var ids = marcadas(); travado(bOk, async function(){ try { var r = await api('ctl_conferir', { tabela: 'registros', ids: ids, status: 'ok' }); toast(r.conferidos + ' confirmada(s)' + (r.pulados ? ' · ' + r.pulados + ' pulada(s)' : '')); rec(); } catch(e){ toast(e.message, 'erro'); } }); };
        bDiv.onclick = async function(){ var ids = marcadas(); var ob = await U.pedirTexto({ titulo: 'Marcar ' + ids.length + ' como divergente', ajuda: 'O que está errado?', min: 10 }); if(!ob) return;
          try { await api('ctl_conferir', { tabela: 'registros', ids: ids, status: 'divergente', observacao: ob }); toast('Marcada(s) como divergente'); rec(); } catch(e){ toast(e.message, 'erro'); } };
      }
    } catch(e){ $('pl-out').innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; }
  };
}

// ⚡ Motoboys pela Machine: busca os 7 dias (um por vez, pra caber no tempo do servidor), mostra a prévia e gera
function calcularMachine(st, aoMudar){
  var ini = st.ini, fim = addDias(ini, 6), fechada = fim < hoje();
  var nomeCid = ((F.ctlBase.unidades || []).filter(function(u){ return String(u.id) === String(st.unidade_id); })[0] || {}).nome || '';
  var m = modal('<div style="font-weight:800;font-size:16px">⚡ Motoboys da semana pela Machine</div>' +
    '<div class="fin-sub" style="margin:4px 0 10px">' + esc(nomeCid) + ' · semana ' + dataBR(ini) + ' a ' + dataBR(fim) + '. Soma as corridas FINALIZADAS de cada motoboy (é a mesma conta da planilha).' +
    (fechada ? '' : '<br><b style="color:#C0392B">Esta semana ainda não terminou: dá pra ver a prévia, mas só gera depois de domingo.</b>') + '</div>' +
    '<div class="fin-filtros"><label class="fin-sub">% da Gâmi <input id="mq-pct" value="21" inputmode="decimal" style="width:60px"></label>' +
    '<button class="fin-bt pri" id="mq-buscar">1. Buscar os 7 dias na Machine</button><button class="fin-bt" id="mq-ver">Só ver a prévia</button></div>' +
    '<div id="mq-dias" style="margin-top:8px"></div><div id="mq-prev"></div>');
  var de = function(sel){ return m.el.querySelector(sel); };
  var pct = function(){ return de('#mq-pct').value; };
  async function previa(){
    var out = de('#mq-prev'); out.innerHTML = '<div class="fin-vazio">Calculando...</div>';
    try {
      var p = (await api('ctl_moto_previa', { unidade_id: st.unidade_id, semana_ini: ini, percentual: pct() })).previa;
      var pode = p.semana_fechada && n(p.dias_ok) === 7;
      var h = '<div class="fin-kpis" style="margin-top:10px">' +
        '<div class="fin-card"><div class="fin-kl">Dias buscados</div><div class="fin-kv" style="color:' + (n(p.dias_ok) === 7 ? '#1D9E75' : '#D68910') + '">' + n(p.dias_ok) + ' de 7</div></div>' +
        '<div class="fin-card"><div class="fin-kl">Motoboys</div><div class="fin-kv">' + n(p.motoboys) + '</div></div>' +
        '<div class="fin-card"><div class="fin-kl">Faturamento</div><div class="fin-kv">' + moeda(p.faturamento) + '</div></div>' +
        '<div class="fin-card"><div class="fin-kl">Gâmi (' + esc(pct()) + '%)</div><div class="fin-kv" style="color:#1D9E75">' + moeda(p.gami) + '</div><div class="fin-sub">entregadores ' + moeda(n(p.faturamento) - n(p.gami)) + '</div></div></div>';
      if(n(p.ja_na_aba)) h += '<div class="fin-sub" style="margin:6px 0">Já existem ' + n(p.ja_na_aba) + ' linha(s) nesta aba (' + moeda(p.ja_na_aba_valor) + '), ' + n(p.ja_da_machine) + ' delas já geradas pela Machine. Nada é duplicado: o que já existe fica como está.</div>';
      if((p.divergencias || []).length) h += '<div class="fin-erro" style="margin:6px 0">⚠️ ' + p.divergencias.length + ' motoboy(s) lançados à mão com valor diferente da Machine:<br>' + p.divergencias.map(function(d){ return esc(d.nome) + ': na aba ' + moeda(d.na_aba) + ', Machine ' + moeda(d.machine); }).join('<br>') + '</div>';
      h += '<details style="margin:6px 0"><summary class="fin-sub" style="cursor:pointer">Ver os ' + n(p.motoboys) + ' motoboys</summary><div style="max-height:240px;overflow:auto"><table class="fin-tbl"><tbody>' +
        (p.linhas || []).map(function(l){ return '<tr><td>' + esc(l.nome || '-') + '</td><td class="fin-sub">' + n(l.corridas) + ' corridas</td><td style="text-align:right">' + moeda(l.valor) + '</td></tr>'; }).join('') + '</tbody></table></div></details>';
      h += '<button class="fin-bt ok" id="mq-gerar"' + (pode ? '' : ' disabled') + '>2. Gerar a semana na planilha</button>' +
        (pode ? '' : '<span class="fin-sub" style="margin-left:8px">' + (!p.semana_fechada ? 'a semana ainda não terminou' : 'faltam dias completos da Machine') + '</span>');
      out.innerHTML = h;
      if(de('#mq-gerar')) de('#mq-gerar').onclick = function(){ var bt = this; travado(bt, async function(){
        try { var g = await api('ctl_moto_gerar', { unidade_id: st.unidade_id, semana_ini: ini, percentual: pct() });
          toast(g.novos + ' motoboy(s) lançados'); out.innerHTML = '<div class="fin-card" style="border-color:#1D9E75;margin-top:10px">✅ ' + g.novos + ' motoboy(s) lançados na aba' + (g.ja_gerados ? ', ' + g.ja_gerados + ' já tinham sido gerados antes' : '') + (g.ja_lancados_a_mao ? ', ' + g.ja_lancados_a_mao + ' já estavam lançados à mão (não duplicou)' : '') + '. Agora outra pessoa confere na coluna CONFIRMAÇÃO.</div>';
          aoMudar && aoMudar(); }
        catch(e){ toast(e.message, 'erro'); } }); };
    } catch(e){ out.innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div>'; }
  }
  de('#mq-ver').onclick = previa;
  de('#mq-buscar').onclick = function(){ var bt = this; travado(bt, async function(){
    var box = de('#mq-dias'); box.innerHTML = '';
    for(var i = 0; i < 7; i++){
      var dia = addDias(ini, i);
      var linha = document.createElement('div'); linha.className = 'fin-sub'; box.appendChild(linha);
      if(dia >= hoje()){ linha.textContent = dataBR(dia) + ': ainda não terminou, pulado'; continue; }
      linha.textContent = dataBR(dia) + ': buscando...';
      try { var r = await api('ctl_moto_buscar_dia', { unidade_id: st.unidade_id, dia: dia });
        linha.innerHTML = (r.completo ? '✅ ' : '⚠️ ') + dataBR(dia) + ': ' + n(r.finalizadas) + ' corridas finalizadas · ' + moeda(r.valor) + (r.completo ? '' : ' <b style="color:#C0392B">(a Machine cortou: busque de novo)</b>'); }
      catch(e){ linha.innerHTML = '❌ ' + dataBR(dia) + ': ' + esc(e.message); }
    }
    await previa();
  }); };
}

async function verRegistro(id, def, aoMudar){
  var m = modal('<div class="fin-vazio">Carregando...</div>');
  var d; try { d = await api('ctl_reg_ver', { id: id }); } catch(e){ m.el.innerHTML = '<div class="fin-erro">' + esc(e.message) + '</div><button class="fin-bt" style="margin-top:8px">Fechar</button>'; m.el.querySelector('button').onclick = m.fechar; return; }
  var r = d.registro, ativo = r.status === 'ativo', g = pode('gestor'), cf = pode('conferente');
  var pagavel = r.tipo === 'bag' || r.tipo === 'camiseta' || r.tipo === 'moto_novo';
  var h = '<div style="display:flex;justify-content:space-between;gap:8px"><div><div style="font-weight:800;font-size:16px">' + esc(r.nome) + '</div><div class="fin-sub">' + esc(r.unidade_nome) + ' · ' + (r.tipo === 'motoboy_semanal' ? 'semana ' + dataBR(r.semana_ini) + ' a ' + dataBR(r.semana_fim) : dataBR(r.data)) + ' · ' + esc({ manual: 'digitado', planilha: 'veio da planilha antiga', machine: 'calculado da Machine' }[r.origem] || r.origem) + '</div></div>' +
    '<div style="text-align:right;font-size:20px;font-weight:800">' + moeda(r.valor) + '</div></div>' +
    '<div class="fin-sub" style="margin-top:6px">' + [r.quantidade ? 'Quant.: ' + r.quantidade : '', r.tamanho ? 'Tam.: ' + esc(r.tamanho) : '', r.forma ? 'Forma: ' + esc(FORMAS[r.forma] || r.forma) : '', r.motivo ? 'Motivo: ' + esc(r.motivo) : '', r.responsavel ? 'Responsável: ' + esc(r.responsavel) : '', r.pago_por ? 'Em nome de: ' + esc(r.pago_por) : '', r.tipo === 'motoboy_semanal' ? 'Gâmi ' + moeda(r.valor_gami) + ' (' + n(r.percentual) + '%) · entregador ' + moeda(r.valor_entregador) : ''].filter(Boolean).join(' · ') +
    '<br>Lançado por ' + esc(nome(r.criado_por)) + ' em ' + dataHoraBR(r.criado_em) + (r.observacao ? '<br>Obs.: ' + esc(r.observacao) : '') + '</div>' +
    (r.status === 'cancelado' ? '<div class="fin-erro">Cancelado por ' + esc(nome(r.cancelado_por)) + ': ' + esc(r.cancelado_motivo) + '</div>' : '<div style="margin-top:6px">' + conf(r) + '</div>');
  if(pagavel){
    h += '<div style="font-weight:700;margin:10px 0 4px">Pagamentos <span class="fin-sub">(pago ' + moeda(r.pago) + ' · falta ' + moeda(Math.max(0, n(r.saldo))) + ')</span></div>' +
      (d.pagamentos.length ? '<table class="fin-tbl"><tbody>' + d.pagamentos.map(function(p){ return '<tr' + (p.estornado ? ' style="opacity:.5;text-decoration:line-through"' : '') + '><td>' + dataBR(p.data) + '</td><td>' + moeda(p.valor) + '</td><td class="fin-sub">' + esc(p.pago_por || '') + ' · ' + esc(nome(p.criado_por)) + (p.estornado ? ' · estornado: ' + esc(p.estorno_motivo) : '') + '</td><td>' + (!p.estornado && g ? '<button class="fin-bt sus" data-est="' + p.id + '">Estornar</button>' : '') + '</td></tr>'; }).join('') + '</tbody></table>' : '<div class="fin-sub">Nenhum pagamento.</div>');
    if(ativo && cf && n(r.saldo) > 0) h += '<div class="fin-card" style="margin-top:6px"><div class="fin-grid2"><label>Valor<input id="rp-val" inputmode="decimal" value="' + n(r.saldo).toFixed(2).replace('.', ',') + '"></label><label>Data<input type="date" id="rp-data" value="' + hoje() + '" max="' + hoje() + '"></label>' +
      '<label>Forma<select id="rp-forma">' + optsForma(r.forma || 'pix') + '</select></label><label>Em nome de quem<input id="rp-quem" maxlength="200" value="' + esc(r.pago_por || '') + '"></label></div><button class="fin-bt pri" id="rp-ok" style="margin-top:6px">Registrar pagamento</button></div>';
  }
  h += (d.conferencias.length ? '<div style="font-weight:700;margin:10px 0 4px">Confirmações</div>' + d.conferencias.map(function(x){ return '<div class="fin-sub">' + dataHoraBR(x.conferido_em) + ' · ' + esc(nome(x.conferido_por)) + ' · ' + (x.status === 'ok' ? '✅ ok' : '⚠️ divergente: ' + esc(x.observacao || '')) + '</div>'; }).join('') : '') +
    (d.historico.length ? '<details style="margin-top:8px"><summary class="fin-sub" style="cursor:pointer">Histórico (' + d.historico.length + ')</summary>' + d.historico.map(function(x){ return '<div class="fin-sub">' + dataHoraBR(x.ts) + ' · ' + esc(nome(x.ator)) + ' · ' + (x.acao === 'INSERT' ? 'criou' : 'alterou') + (x.tabela === 'fin_ctl_reg_pag' ? ' (pagamento)' : '') + '</div>'; }).join('') + '</details>' : '') +
    '<div class="fin-filtros" style="margin-top:12px">' + (ativo && cf ? '<button class="fin-bt" id="rv-edit">Corrigir observação / quem pagou</button>' : '') + (ativo && g ? '<button class="fin-bt sus" id="rv-canc">Cancelar linha</button>' : '') + '<button class="fin-bt" id="rv-x">Fechar</button></div>';
  m.el.innerHTML = h;
  var de = function(sel){ return m.el.querySelector(sel); };
  var reabrir = function(){ m.fechar(); aoMudar && aoMudar(); verRegistro(id, def, aoMudar); };
  de('#rv-x').onclick = m.fechar;
  if(de('#rp-ok')) de('#rp-ok').onclick = function(){ var bt = this; travado(bt, async function(){ try { await api('ctl_reg_pagar', { registro_id: id, valor: de('#rp-val').value, data: de('#rp-data').value, forma: de('#rp-forma').value, pago_por: de('#rp-quem').value }); toast('Pagamento registrado'); reabrir(); } catch(e){ toast(e.message, 'erro'); } }); };
  m.el.querySelectorAll('[data-est]').forEach(function(b){ b.onclick = async function(){ var mo = await U.pedirTexto({ titulo: 'Estornar pagamento', min: 10 }); if(!mo) return; try { await api('ctl_reg_estornar_pag', { id: Number(b.getAttribute('data-est')), motivo: mo }); toast('Estornado'); reabrir(); } catch(e){ toast(e.message, 'erro'); } }; });
  if(de('#rv-canc')) de('#rv-canc').onclick = async function(){ var mo = await U.pedirTexto({ titulo: 'Cancelar a linha de ' + r.nome, ajuda: 'Ela não some: fica registrada como cancelada.', min: 10 }); if(!mo) return; try { await api('ctl_cancelar', { tabela: 'registros', id: id, motivo: mo }); toast('Cancelada'); m.fechar(); aoMudar && aoMudar(); } catch(e){ toast(e.message, 'erro'); } };
  if(de('#rv-edit')) de('#rv-edit').onclick = async function(){
    var quem = await U.pedirTexto({ titulo: 'Em nome de quem / observação', ajuda: 'Nome, valor e data não mudam (se estiverem errados, cancele e lance de novo).', tipo: 'text', valor: r.pago_por || '' }); if(quem === null) return;
    var ob = await U.pedirTexto({ titulo: 'Observação', valor: r.observacao || '' }); if(ob === null) return;
    try { await api('ctl_reg_salvar', { id: id, pago_por: quem, observacao: ob, forma: r.forma, tamanho: r.tamanho, motivo: r.motivo, responsavel: r.responsavel }); toast('Salvo'); reabrir(); } catch(e){ toast(e.message, 'erro'); }
  };
}

['bag', 'camiseta', 'moto_novo', 'motoboy_semanal', 'descontos'].forEach(function(k){ T['pl_' + k] = tela(k); });
})();
