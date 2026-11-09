/* ============================================================
   🛵 FINANCEIRO · FLYP (ZL Hub, franquia Machine) (UI)
   Saques Pix dos condutores, recargas das empresas e boletos, vindos do CSV de
   "Transações Financeiras" do ZL Hub. A trava é TODA no servidor (fin_flyp_acesso);
   aqui só tela. Sensível: nada é guardado no navegador (sem localStorage, sem export).
   ============================================================ */
(function(){
'use strict';
var U = window._FINUI; if(!U){ console.error('financeiro-ui-flyp: carregue financeiro-ui.js antes'); return; }
var api = U.api, esc = U.esc, moeda = U.moeda, dataBR = U.dataBR, dataHoraBR = U.dataHoraBR, nome = U.nome, hoje = U.hoje,
    pode = U.pode, toast = U.toast, $ = U.$;
var F = window._FIN;
var T = window._FIN_TELAS = window._FIN_TELAS || {};

function n(v){ return Number(v) || 0; }
function addDias(iso, d){ var t = new Date(iso + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); }
function diaSemana(iso){ return ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][new Date(iso + 'T12:00:00Z').getUTCDay()]; }
function kpi(l, v, cor, sub){ return '<div class="fin-card"><div class="fin-kl">' + esc(l) + '</div><div class="fin-kv"' + (cor ? ' style="color:' + cor + '"' : '') + '>' + v + '</div>' + (sub ? '<div class="fin-sub" style="margin-top:2px">' + sub + '</div>' : '') + '</div>'; }
function carregando(el){ el.innerHTML = '<div class="fin-vazio">Carregando...</div>'; }
function erroEm(el, e){ el.innerHTML = '<div class="fin-erro">' + esc(e.message || e) + '</div>'; }
var ST = {
  concluido: ['Concluído', '#1D9E75'], efetivado: ['Efetivado', '#1D9E75'], quitado: ['Quitado', '#1D9E75'],
  aberto: ['Aberto', '#B7791F'], em_analise: ['Em análise', '#B7791F'], aguardando_aprovacao: ['Aguardando aprovação', '#B7791F'],
  expirado: ['Expirado', '#7F8C8D'], rejeitado: ['Rejeitado', '#C0392B'], vencido: ['Vencido', '#C0392B'], cancelado: ['Cancelado', '#7F8C8D'], outro: ['Outro', '#7F8C8D']
};
function chip(s, orig){ var x = ST[s] || ST.outro; return '<span class="fin-chip" style="color:' + x[1] + ';background:rgba(127,127,127,.12)">' + esc(orig || x[0]) + '</span>'; }
var CAT = { saque: '💸 Saque', recarga: '💰 Recarga', boleto: '🧾 Boleto', a_receber: '🧾 A receber', outro: 'Outro' };
var AVISO = '<div class="fin-sub" style="margin:4px 0 10px">🔒 Dado restrito. Toda consulta fica registrada (quem, quando, qual período).</div>';

function filtroPeriodo(f, idp){
  return '<div class="fin-filtros"><span class="fin-sub">Período</span><input type="date" id="' + idp + '-ini" value="' + f.ini + '"><input type="date" id="' + idp + '-fim" value="' + f.fim + '">' +
    '<button class="fin-bt" data-r="7">7 dias</button><button class="fin-bt" data-r="30">30 dias</button><button class="fin-bt" data-r="90">90 dias</button>' +
    '<button class="fin-bt pri" id="' + idp + '-ok">Aplicar</button></div>';
}
function ligarPeriodo(el, f, idp, recarregar){
  $(idp + '-ok').onclick = function(){ f.ini = $(idp + '-ini').value; f.fim = $(idp + '-fim').value; recarregar(); };
  el.querySelectorAll('[data-r]').forEach(function(b){ b.onclick = function(){ f.fim = hoje(); f.ini = addDias(f.fim, -(Number(b.getAttribute('data-r')) - 1)); recarregar(); }; });
}

/* ================= RESUMO POR DIA ================= */
T.flyp_resumo = async function(el){
  var f = F.flypResumo = F.flypResumo || { ini: addDias(hoje(), -29), fim: hoje() };
  el.innerHTML = AVISO + filtroPeriodo(f, 'fr') + '<div id="fr-out"></div>';
  ligarPeriodo(el, f, 'fr', function(){ T.flyp_resumo(el); });
  var out = $('fr-out'); carregando(out);
  try {
    var r = (await api('flyp_resumo', { ini: f.ini, fim: f.fim })).resumo || {};
    var t = r.totais || {}, cob = r.cobertura || {};
    var h = '';
    if(!cob.total) h += '<div class="fin-erro" style="background:rgba(214,137,16,.12);color:#B7791F">Ainda não há dados da FLYP. Importe o CSV em “Importar da FLYP”.</div>';
    else if(cob.fim < f.fim) h += '<div class="fin-sub" style="margin-bottom:8px">⚠️ Os dados importados vão até <b>' + dataBR(cob.fim) + '</b>. Importe o período mais recente para ficar em dia.</div>';
    h += '<div class="fin-kpis">' +
      kpi('Saques concluídos', String(t.saques || 0), '', 'média de ' + String(t.media_saques_dia || 0).replace('.', ',') + ' por dia com saque · ' + (t.condutores || 0) + ' condutores') +
      kpi('Valor sacado', moeda(t.saques_valor), '#E24B4A', 'líquido pago aos condutores ' + moeda(t.saques_liquido)) +
      kpi('Taxa de saque (Gâmi)', moeda(t.saques_taxa), '#1D9E75', 'mais ' + moeda(t.recargas_taxa) + ' de taxa nas recargas') +
      kpi('Recargas das empresas', moeda(t.recargas_valor), '#1D9E75', (t.recargas || 0) + ' recargas efetivadas') +
      kpi('Saques que não saíram', String(n(t.saques_rejeitados) + n(t.saques_expirados)), (n(t.saques_rejeitados) ? '#C0392B' : ''), (t.saques_rejeitados || 0) + ' rejeitados · ' + (t.saques_expirados || 0) + ' expirados · ' + (t.saques_pendentes || 0) + ' pendentes') +
      kpi('Boletos / a receber', moeda(t.boletos_valor), '', (t.boletos || 0) + ' no período · em aberto ' + moeda(t.boletos_em_aberto)) +
      '</div>';
    var dias = r.dias || [];
    h += '<div class="fin-card" style="margin-bottom:12px;overflow-x:auto"><div style="font-weight:700;font-size:13px;margin-bottom:8px">Dia a dia</div>';
    if(!dias.length) h += '<div class="fin-vazio">Nenhuma movimentação no período.</div>';
    else {
      var maxQ = Math.max.apply(null, dias.map(function(d){ return n(d.saques); }).concat([1]));
      h += '<table class="fin-tbl"><thead><tr><th>Dia</th><th style="text-align:right">Saques</th><th style="min-width:110px"></th><th style="text-align:right">Valor sacado</th><th style="text-align:right">Taxa Gâmi</th><th style="text-align:right">Condutores</th><th style="text-align:right">Rejeit./expir.</th><th style="text-align:right">Recargas</th><th style="text-align:right">Boletos</th></tr></thead><tbody>';
      dias.forEach(function(d){
        var nao = n(d.saques_rejeitados) + n(d.saques_expirados);
        h += '<tr class="fr-dia" data-d="' + esc(d.data) + '" style="cursor:pointer"><td><b>' + dataBR(d.data) + '</b> <span class="fin-sub">' + diaSemana(d.data) + '</span></td>' +
          '<td style="text-align:right;font-weight:700">' + n(d.saques) + '</td>' +
          '<td><div class="fin-bar"><i style="width:' + Math.round(n(d.saques) / maxQ * 100) + '%"></i></div></td>' +
          '<td class="fin-sai" style="text-align:right">' + moeda(d.saques_valor) + '</td><td class="fin-ent" style="text-align:right">' + moeda(n(d.saques_taxa) + n(d.recargas_taxa)) + '</td>' +
          '<td style="text-align:right">' + n(d.condutores) + '</td><td style="text-align:right' + (n(d.saques_rejeitados) ? ';color:#C0392B;font-weight:700' : '') + '">' + (nao || '') + '</td>' +
          '<td class="fin-ent" style="text-align:right">' + (n(d.recargas) ? moeda(d.recargas_valor) + ' <span class="fin-sub">(' + n(d.recargas) + ')</span>' : '') + '</td>' +
          '<td style="text-align:right">' + (n(d.boletos) ? moeda(d.boletos_valor) : '') + '</td></tr>';
      });
      h += '</tbody></table><div class="fin-sub" style="margin-top:6px">Clique num dia para ver as transações.</div>';
    }
    h += '</div>';
    var top = r.top_condutores || [];
    if(top.length){
      h += '<div class="fin-card" style="overflow-x:auto"><div style="font-weight:700;font-size:13px;margin-bottom:8px">Quem mais sacou no período</div><table class="fin-tbl"><thead><tr><th>Condutor</th><th style="text-align:right">Saques</th><th style="text-align:right">Valor</th><th style="text-align:right">Taxa</th></tr></thead><tbody>' +
        top.map(function(x){ return '<tr><td>' + esc(x.nome) + '</td><td style="text-align:right">' + n(x.saques) + '</td><td style="text-align:right">' + moeda(x.valor) + '</td><td class="fin-ent" style="text-align:right">' + moeda(x.taxa) + '</td></tr>'; }).join('') + '</tbody></table></div>';
    }
    if(r.ultima_importacao) h += '<div class="fin-sub" style="margin-top:8px">Última importação: ' + dataHoraBR(r.ultima_importacao.em) + ' por ' + esc(nome(r.ultima_importacao.por)) + ' (' + dataBR(r.ultima_importacao.periodo_ini) + ' a ' + dataBR(r.ultima_importacao.periodo_fim) + ').</div>';
    out.innerHTML = h;
    out.querySelectorAll('.fr-dia').forEach(function(tr){ tr.onclick = function(){ var d = tr.getAttribute('data-d'); F.flypLista = { ini: d, fim: d, categoria: '', status: '', busca: '', pagina: 0 }; U.irPara('flyp_lista'); }; });
  } catch(e){ erroEm(out, e); }
};

/* ================= LISTA DE TRANSAÇÕES ================= */
T.flyp_lista = async function(el){
  var f = F.flypLista = F.flypLista || { ini: addDias(hoje(), -6), fim: hoje(), categoria: 'saque', status: '', busca: '', pagina: 0 };
  el.innerHTML = AVISO + '<div class="fin-filtros"><span class="fin-sub">Período (máx. 62 dias)</span><input type="date" id="fl-ini" value="' + f.ini + '"><input type="date" id="fl-fim" value="' + f.fim + '">' +
    '<select id="fl-cat"><option value="">Tudo</option>' + ['saque', 'recarga', 'boleto', 'a_receber'].map(function(k){ return '<option value="' + k + '"' + (f.categoria === k ? ' selected' : '') + '>' + CAT[k] + '</option>'; }).join('') + '</select>' +
    '<select id="fl-st"><option value="">Qualquer status</option>' + ['concluido', 'efetivado', 'em_analise', 'aguardando_aprovacao', 'aberto', 'rejeitado', 'expirado', 'vencido', 'quitado'].map(function(k){ return '<option value="' + k + '"' + (f.status === k ? ' selected' : '') + '>' + ST[k][0] + '</option>'; }).join('') + '</select>' +
    '<input id="fl-busca" placeholder="Nome do condutor / empresa" value="' + esc(f.busca) + '" maxlength="60" style="min-width:180px">' +
    '<button class="fin-bt pri" id="fl-ok">Filtrar</button></div><div id="fl-out"></div>';
  var aplicar = function(){ f.ini = $('fl-ini').value; f.fim = $('fl-fim').value; f.categoria = $('fl-cat').value; f.status = $('fl-st').value; f.busca = $('fl-busca').value.trim(); f.pagina = 0; T.flyp_lista(el); };
  $('fl-ok').onclick = aplicar; $('fl-busca').onkeydown = function(ev){ if(ev.key === 'Enter') aplicar(); };
  var out = $('fl-out'); carregando(out);
  try {
    var j = await api('flyp_listar', { ini: f.ini, fim: f.fim, categoria: f.categoria || null, status: f.status || null, busca: f.busca || null, pagina: f.pagina });
    var lst = j.transacoes || [];
    var tot = lst.reduce(function(a, x){ return a + n(x.valor); }, 0), taxa = lst.reduce(function(a, x){ return a + n(x.taxa); }, 0);
    var h = '<div class="fin-sub" style="margin-bottom:6px">' + j.total + ' transação(ões)' + (j.total > 200 ? ' · página ' + (j.pagina + 1) + ' de ' + Math.ceil(j.total / 200) : '') + ' · nesta página: ' + moeda(tot) + ' · taxa ' + moeda(taxa) + '</div>';
    if(!lst.length) h += '<div class="fin-vazio">Nada encontrado com esse filtro.</div>';
    else {
      h += '<div class="fin-card" style="overflow-x:auto"><table class="fin-tbl"><thead><tr><th>Data</th><th>Tipo</th><th>Contraparte</th><th style="text-align:right">Valor</th><th style="text-align:right">Líquido</th><th style="text-align:right">Taxa</th><th>Status</th></tr></thead><tbody>' +
        lst.map(function(x){
          return '<tr><td>' + dataBR(x.data) + (x.hora ? ' <span class="fin-sub">' + esc(String(x.hora).slice(0, 5)) + '</span>' : '') + '</td><td>' + (CAT[x.categoria] || esc(x.tipo)) + '</td><td>' + esc(x.contraparte) + '</td>' +
            '<td style="text-align:right" class="' + (x.direcao === 'saida' ? 'fin-sai' : 'fin-ent') + '">' + (x.direcao === 'saida' ? '-' : '') + moeda(x.valor) + '</td>' +
            '<td style="text-align:right">' + moeda(x.valor_liquido) + '</td><td style="text-align:right">' + moeda(x.taxa) + '</td><td>' + chip(x.status, x.status_original) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    if(j.total > 200){
      h += '<div class="fin-filtros" style="margin-top:8px">' + (j.pagina > 0 ? '<button class="fin-bt" id="fl-ant">← Anterior</button>' : '') + ((j.pagina + 1) * 200 < j.total ? '<button class="fin-bt" id="fl-prox">Próxima →</button>' : '') + '</div>';
    }
    out.innerHTML = h;
    if($('fl-ant')) $('fl-ant').onclick = function(){ f.pagina--; T.flyp_lista(el); };
    if($('fl-prox')) $('fl-prox').onclick = function(){ f.pagina++; T.flyp_lista(el); };
  } catch(e){ erroEm(out, e); }
};

/* ================= IMPORTAR ================= */
function lerTexto(file){ return new Promise(function(ok, falha){ var r = new FileReader(); r.onload = function(){ ok(String(r.result || '')); }; r.onerror = function(){ falha(new Error('Não consegui ler o arquivo')); }; r.readAsText(file, 'utf-8'); }); }
T.flyp_importar = function(el){
  el.innerHTML = AVISO + '<div class="fin-card" style="max-width:760px">' +
    '<div style="font-weight:700;font-size:14px;margin-bottom:6px">Importar “Transações Financeiras” da FLYP</div>' +
    '<ol class="fin-sub" style="margin:0 0 10px 18px;line-height:1.7">' +
      '<li>No ZL Hub (app.flyp.com.br), abra <b>Financeiro › Transações Financeiras</b>.</li>' +
      '<li>Em <b>Período</b>, escolha os dias (pode repetir dias já importados: nada duplica, e status que mudou é atualizado).</li>' +
      '<li>Clique em <b>Filtrar</b> e depois no botão <b>CSV</b>.</li>' +
      '<li>Escolha o arquivo baixado aqui embaixo. Depois de importar, <b>apague o arquivo do computador</b>.</li></ol>' +
    '<div class="fin-filtros"><input type="file" id="fi-arq" accept=".csv,.txt,text/csv">' +
    '<select id="fi-dir"><option value="">Direção: automática</option><option value="saida">Exportei filtrando só Saída</option><option value="entrada">Exportei filtrando só Entrada</option></select>' +
    '<button class="fin-bt pri" id="fi-ver">Conferir antes</button></div><div id="fi-out"></div></div>';
  var conteudo = null, nomeArq = '';
  $('fi-arq').onchange = function(){ conteudo = null; $('fi-out').innerHTML = ''; };
  $('fi-ver').onclick = async function(){
    var file = $('fi-arq').files[0]; if(!file){ toast('Escolha o arquivo CSV', 'aviso'); return; }
    if(file.size > 4 * 1024 * 1024){ toast('Arquivo grande demais (máx. 4 MB). Exporte um período menor.', 'erro'); return; }
    var out = $('fi-out'); carregando(out);
    try {
      conteudo = await lerTexto(file); nomeArq = file.name;
      var j = await api('flyp_importar', { conteudo: conteudo, arquivo_nome: nomeArq, direcao: $('fi-dir').value || null });
      var r = j.resumo;
      out.innerHTML = '<div class="fin-kpis" style="margin-top:10px">' +
        kpi('Linhas', String(r.linhas), '', dataBR(r.periodo_ini) + ' a ' + dataBR(r.periodo_fim)) +
        kpi('Saques concluídos', String(r.saques), '#E24B4A', moeda(r.saques_valor)) +
        kpi('Recargas efetivadas', String(r.recargas), '#1D9E75', moeda(r.recargas_valor)) +
        kpi('Boletos / a receber', String(r.boletos), '', '') + '</div>' +
        '<button class="fin-bt pri" id="fi-ok" style="margin-top:8px">Confirmar importação</button>';
      $('fi-ok').onclick = async function(){
        this.disabled = true;
        try {
          var k = await api('flyp_importar', { conteudo: conteudo, arquivo_nome: nomeArq, direcao: $('fi-dir').value || null, confirmar: true });
          conteudo = null; $('fi-arq').value = '';
          out.innerHTML = '<div class="fin-card" style="margin-top:10px;border-color:#1D9E75">✅ Importado: <b>' + k.novas + '</b> novas, <b>' + k.status_mudou + '</b> com status atualizado, ' + k.repetidas + ' já existiam.<div class="fin-sub" style="margin-top:4px">Lembre de apagar o arquivo CSV do computador.</div></div>';
          toast('Importado');
        } catch(e){ this.disabled = false; erroEm(out, e); conteudo = null; }
      };
    } catch(e){ erroEm(out, e); conteudo = null; }
  };
};

/* ================= QUEM VÊ (só super) ================= */
T.flyp_acessos = async function(el){
  el.innerHTML = '<div id="fa-out"></div>'; var out = $('fa-out'); carregando(out);
  try {
    var j = await api('flyp_acessos'), l = await api('flyp_leituras');
    var nomeEq = {}; (j.equipe || []).forEach(function(p){ nomeEq[p.pessoa_id] = p.nome; });
    var nm = function(id){ return nomeEq[id] || nome(id) || id; };
    var h = '<div class="fin-card" style="margin-bottom:12px;max-width:760px"><div style="font-weight:700;font-size:13px;margin-bottom:4px">Quem pode ver os dados da FLYP</div>' +
      '<div class="fin-sub" style="margin-bottom:8px">Ter acesso ao financeiro <b>não</b> dá acesso à FLYP. Você (super) sempre vê. Libere só quem precisa.</div>';
    var ativos = (j.acessos || []).filter(function(a){ return a.ativo; });
    h += ativos.length ? '<table class="fin-tbl"><tbody>' + ativos.map(function(a){ return '<tr><td>' + esc(nm(a.pessoa_id)) + '</td><td class="fin-sub">liberado por ' + esc(nm(a.liberado_por)) + ' em ' + dataHoraBR(a.liberado_em) + '</td><td><button class="fin-bt" data-rev="' + esc(a.pessoa_id) + '">Revogar</button></td></tr>'; }).join('') + '</tbody></table>'
      : '<div class="fin-vazio">Só você vê.</div>';
    h += '<div class="fin-filtros" style="margin-top:8px"><select id="fa-p"><option value="">Liberar para...</option>' + (j.equipe || []).filter(function(p){ return !ativos.some(function(a){ return a.pessoa_id === p.pessoa_id; }); }).map(function(p){ return '<option value="' + esc(p.pessoa_id) + '">' + esc(p.nome) + '</option>'; }).join('') + '</select><button class="fin-bt" id="fa-lib">Liberar</button></div></div>';
    var lei = l.leituras || [];
    h += '<div class="fin-card" style="overflow-x:auto"><div style="font-weight:700;font-size:13px;margin-bottom:8px">Quem consultou (últimas 200)</div>' +
      (lei.length ? '<table class="fin-tbl"><thead><tr><th>Quando</th><th>Quem</th><th>O quê</th><th>Filtro</th></tr></thead><tbody>' + lei.map(function(x){
        var fl = x.filtro || {};
        return '<tr><td>' + dataHoraBR(x.em) + '</td><td>' + esc(nm(x.ator)) + '</td><td>' + esc(x.acao === 'listar' ? 'Lista de transações' : 'Resumo por dia') + '</td><td class="fin-sub">' + dataBR(fl.ini) + ' a ' + dataBR(fl.fim) + (fl.busca ? ' · busca "' + esc(fl.busca) + '"' : '') + (fl.categoria ? ' · ' + esc(fl.categoria) : '') + '</td></tr>';
      }).join('') + '</tbody></table>' : '<div class="fin-vazio">Ninguém consultou ainda.</div>') + '</div>';
    out.innerHTML = h;
    $('fa-lib').onclick = async function(){ var p = $('fa-p').value; if(!p) return; try { await api('flyp_liberar', { pessoa_id: p, ativo: true }); toast('Liberado'); T.flyp_acessos(el); } catch(e){ toast(e.message, 'erro'); } };
    out.querySelectorAll('[data-rev]').forEach(function(b){ b.onclick = async function(){ try { await api('flyp_liberar', { pessoa_id: b.getAttribute('data-rev'), ativo: false }); toast('Revogado'); T.flyp_acessos(el); } catch(e){ toast(e.message, 'erro'); } }; });
  } catch(e){ erroEm(out, e); }
};
})();
