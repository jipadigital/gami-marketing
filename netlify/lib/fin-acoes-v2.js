// netlify/lib/fin-acoes-v2.js
// Ações da v2 do Financeiro (réplica do Kamino): Pagar, Receber, Contas/Conciliação,
// Relatórios, Cadastros, Caixa de entrada e Anexos. Mesmas regras da v1:
// toda escrita é RPC no banco (transação + ator carimbado), filtros validados.
// ============================================================
'use strict';
const crypto = require('crypto');

module.exports = function(h){
  const { rest, rpc, lerTodos, ErroUsuario, svc, txt, dataOk, uuidOk, intOk, textoBusca, P, SUPA_URL } = h;

  const PERM = {
    base: 'leitor', painel: 'leitor', lanc_listar: 'leitor', lanc_ver: 'leitor', central: 'leitor',
    pessoas_listar: 'leitor', pessoa_ver: 'leitor', receber_dash: 'leitor',
    rel_dre: 'leitor', rel_fluxo_mensal: 'leitor', rel_fluxo_diario: 'leitor', rel_resultado: 'leitor',
    conciliacao: 'leitor', candidatos: 'leitor', transf_listar: 'leitor', entradas_listar: 'leitor', anexo_baixar: 'leitor',
    lanc_exportar: 'gestor',   // exporta CPF/CNPJ: mesmo nível do export do extrato
    lanc_criar: 'conferente', lanc_editar: 'conferente', lanc_split: 'conferente', lanc_baixar: 'conferente',
    lancar_da_linha: 'conferente', transf_criar: 'conferente', conciliar_transf: 'conferente', pessoa_salvar: 'conferente',
    entrada_salvar: 'conferente', anexo_enviar: 'conferente', conciliar_auto: 'conferente',
    lanc_estornar: 'gestor', lanc_cancelar: 'gestor', transf_cancelar: 'gestor', cadastro_salvar: 'gestor',
    // recorrências: criar é do dia a dia; mudar valor/pausar/encerrar é do gestor (mexe em todas as contas futuras)
    rec_listar: 'leitor', rec_ver: 'leitor', rec_criar: 'conferente', rec_de_lanc: 'conferente', rec_confirmar_valor: 'conferente',
    rec_salvar: 'gestor', rec_status: 'gestor'
  };
  const FREQS = ['semanal', 'quinzenal', 'mensal', 'bimestral', 'trimestral', 'semestral', 'anual'];
  const FREQ_PASSO = { semanal: [0, 7], quinzenal: [0, 14], mensal: [1, 0], bimestral: [2, 0], trimestral: [3, 0], semestral: [6, 0], anual: [12, 0] };
  function proxFreq(iso, freq){ const [m, d] = FREQ_PASSO[freq]; if(m) return addMes(iso, m); const t = new Date(iso + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); }
  // o lançamento vira o modelo da recorrência (sem vencimento, valor e acréscimos do mês)
  function modeloDe(it){ const m = Object.assign({}, it); ['tipo', 'valor', 'vencimento', 'competencia', 'juros', 'multa', 'desconto', 'codigo_barras', 'pix_copia_cola', 'nf_numero'].forEach(k => delete m[k]); return m; }
  // leitor não precisa de CPF/CNPJ, Pix e dados bancários (exportar já é só do gestor)
  const SENSIVEIS = ['pessoa_doc', 'documento', 'pix_copia_cola', 'codigo_barras', 'pix_chave', 'pix_tipo', 'banco', 'agencia', 'conta'];
  function mascarar(ctx, o){ if(!o || !ctx || ctx.papel !== 'leitor') return o; SENSIVEIS.forEach(k => { if(o[k] != null && o[k] !== '') o[k] = '•••'; }); return o; }
  // ligar o documento da Caixa de entrada ao lançamento: se falhar, o lançamento JÁ existe (não pode pedir pra salvar de novo)
  async function ligarEntrada(b, ctx, idLanc){
    if(!(b.entrada_id && intOk(b.entrada_id) && idLanc)) return null;
    try { await rpc('fin_salvar_entrada', { p_ator: ctx.pessoaId, p_id: intOk(b.entrada_id), d: { status: 'lancado', lancamento_id: idLanc } }); return null; }
    catch(e){ return 'O lançamento #' + idLanc + ' foi criado, mas não consegui marcar o documento da Caixa de entrada como lançado. NÃO lance de novo: marque o documento à mão.'; }
  }
  function recOpcoes(r){
    r = r || {};
    const frequencia = FREQS.indexOf(r.frequencia) >= 0 ? r.frequencia : null;
    if(!frequencia) throw new ErroUsuario('Escolha a frequência da recorrência');
    const fim = r.fim ? dataOk(r.fim) : null; if(r.fim && !fim) throw new ErroUsuario('Data final inválida');
    return { frequencia, fim, variavel: r.variavel === true };
  }

  const num = (v, nome) => { if(v === '' || v == null) return 0; const n = typeof v === 'number' ? v : P.parseValor(String(v)); if(n == null || !isFinite(n) || n < 0 || n > 1e9) throw new ErroUsuario((nome || 'Valor') + ' inválido'); return Math.round(n * 100) / 100; };
  const idOuNull = v => (v === '' || v == null) ? null : (intOk(v) || (() => { throw new ErroUsuario('Cadastro inválido'); })());
  const uuidOuNull = v => (v === '' || v == null) ? null : (uuidOk(v) || (() => { throw new ErroUsuario('Conta inválida'); })());
  const FORMAS = ['boleto', 'ted', 'pix', 'outros', 'manual', 'pix_conta'];

  function limparItem(b, tipo){
    const it = {
      tipo, pessoa_id: idOuNull(b.pessoa_id), descricao: txt(b.descricao, 300), classificacao_id: idOuNull(b.classificacao_id),
      centro_custo_id: idOuNull(b.centro_custo_id), unidade_id: idOuNull(b.unidade_id), conta_id: uuidOuNull(b.conta_id),
      forma: FORMAS.indexOf(b.forma) >= 0 ? b.forma : null, valor: num(b.valor, 'Valor'), juros: num(b.juros, 'Juros'), multa: num(b.multa, 'Multa'),
      desconto: num(b.desconto, 'Desconto'), retencao: num(b.retencao, 'Retenção'), retencao_tipo: txt(b.retencao_tipo, 40) || null,
      vencimento: dataOk(b.vencimento), competencia: dataOk(b.competencia), nf_numero: txt(b.nf_numero, 40) || null,
      codigo_barras: txt(b.codigo_barras, 120).replace(/[^\d. ]/g, '') || null, pix_copia_cola: txt(b.pix_copia_cola, 600) || null,
      observacao: txt(b.observacao, 1000) || null, rateio: null
    };
    if(!it.vencimento) throw new ErroUsuario('Vencimento obrigatório');
    if(it.valor <= 0) throw new ErroUsuario('Valor obrigatório');
    if(it.desconto + it.retencao >= it.valor + it.juros + it.multa) throw new ErroUsuario('Desconto/retenção maior que o valor');
    if(Array.isArray(b.rateio) && b.rateio.length){
      it.rateio = b.rateio.slice(0, 30).map(r => ({ unidade_id: intOk(r.unidade_id), pct: Math.round(Number(r.pct) * 100) / 100 }));
      if(it.rateio.some(r => !r.unidade_id || !(r.pct > 0))) throw new ErroUsuario('Rateio inválido');
      const s = it.rateio.reduce((a, r) => a + r.pct, 0);
      if(Math.abs(s - 100) > 0.01) throw new ErroUsuario('Rateio precisa somar 100% (está ' + s.toFixed(2) + '%)');
    }
    return it;
  }
  function addMes(iso, n){ const [y, m, d] = iso.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1 + n, 1)); const ult = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate(); return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(Math.min(d, ult)).padStart(2, '0'); }

  // filtros da lista (Pagar/Receber), equivalente à "Lista de Pagamentos" do Kamino
  function filtroLanc(b){
    const f = [];
    if(b.tipo === 'pagar' || b.tipo === 'receber') f.push('tipo=eq.' + b.tipo);
    const sit = (Array.isArray(b.situacao) ? b.situacao : []).filter(s => ['pendente', 'atrasado', 'pago', 'cancelado'].indexOf(s) >= 0);
    if(sit.length) f.push('situacao_calc=in.(' + sit.join(',') + ')');
    else f.push('status=neq.cancelado');
    const pares = [['venc_de', 'vencimento=gte.'], ['venc_ate', 'vencimento=lte.'], ['pag_de', 'data_pagamento=gte.'], ['pag_ate', 'data_pagamento=lte.'],
                   ['comp_de', 'competencia=gte.'], ['comp_ate', 'competencia=lte.']];
    pares.forEach(([k, op]) => { const d = dataOk(b[k]); if(d) f.push(op + d); });
    [['pessoa_id', 'pessoa_id'], ['classificacao_id', 'classificacao_id'], ['centro_custo_id', 'centro_custo_id'], ['unidade_id', 'unidade_id'], ['codigo', 'id']]
      .forEach(([k, col]) => { const v = intOk(b[k]); if(v) f.push(col + '=eq.' + v); });
    const conta = uuidOk(b.conta_id); if(conta) f.push('conta_id=eq.' + conta);
    if(FORMAS.indexOf(b.forma) >= 0) f.push('forma=eq.' + b.forma);
    const v = b.valor ? P.parseValor(String(b.valor)) : null; if(v) f.push('valor_final=eq.' + Math.abs(v));
    const d = textoBusca(b.descricao); if(d) f.push('descricao=ilike.*' + d + '*');
    const o = textoBusca(b.observacao); if(o) f.push('observacao=ilike.*' + o + '*');
    const nf = textoBusca(b.nf); if(nf) f.push('nf_numero=ilike.*' + nf + '*');
    const q = textoBusca(b.q); if(q) f.push('or=(pessoa_nome.ilike.*' + q + '*,descricao.ilike.*' + q + '*,classificacao_nome.ilike.*' + q + '*)');
    if(b.conciliado === 'sim') f.push('extrato_id=not.is.null');
    if(b.conciliado === 'nao') f.push('extrato_id=is.null');
    if(b.anexo === 'sim') f.push('anexos=gt.0');
    if(b.anexo === 'nao') f.push('anexos=eq.0');
    return f.join('&');
  }

  const A = {
    // Tudo que os formulários precisam: unidades, centros, classificações, contas
    async base(){
      const [unidades, centros, classificacoes, contas, regras] = await Promise.all([
        lerTodos('fin_unidades?select=*&order=nome.asc'), lerTodos('fin_centros_custo?select=*&order=nome.asc'),
        lerTodos('fin_classificacoes?select=*&order=ordem.asc,nome.asc'), lerTodos('fin_contas?select=*&order=nome.asc'),
        lerTodos('fin_regras_extrato?select=*&order=id.asc')
      ]);
      return { unidades, centros, classificacoes, contas, regras };
    },

    async painel(){ return { painel: await rpc('fin_painel', {}) }; },

    async lanc_listar(b, ctx){
      const pagina = Math.max(0, Math.min(2000, Number(b.pagina) || 0)), tam = Math.min(200, Number(b.tam) || 100);
      const ord = b.ordem === 'pagamento' ? 'data_pagamento.desc.nullslast,id.desc' : (b.ordem === 'recente' ? 'id.desc' : 'vencimento.asc,id.asc');
      const { data, headers } = await rest('fin_v_lanc?select=*&' + filtroLanc(b) + '&order=' + ord, {
        headers: svc({ 'Range-Unit': 'items', 'Range': (pagina * tam) + '-' + (pagina * tam + tam - 1), 'Prefer': 'count=exact' })
      });
      const total = Number(String(headers.get('content-range') || '').split('/')[1]) || 0;
      return { itens: (data || []).map(o => mascarar(ctx, o)), total, pagina, tam };
    },

    async lanc_exportar(b){
      const itens = await lerTodos('fin_v_lanc?select=*&' + filtroLanc(b) + '&order=vencimento.asc,id.asc', 30000);
      const cel = v => { const s = v == null ? '' : String(v); return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const br = n => n == null ? '' : Number(n).toFixed(2).replace('.', ',');
      const cab = ['Código', 'Tipo', 'Pessoa', 'CPF/CNPJ', 'Descrição', 'Classificação', 'Centro de custo', 'Unidade', 'Conta', 'Forma', 'Vencimento', 'Competência', 'Pagamento', 'Valor bruto', 'Juros', 'Multa', 'Desconto', 'Retenção', 'Valor final', 'Situação', 'Conciliado', 'NF', 'Parcela'];
      const out = [cab.join(';')].concat(itens.map(l => [l.id, l.tipo, l.pessoa_nome, l.pessoa_doc, l.descricao, l.classificacao_nome, l.centro_custo_nome, l.unidade_nome, l.conta_nome, l.forma,
        l.vencimento, l.competencia, l.data_pagamento, br(l.valor), br(l.juros), br(l.multa), br(l.desconto), br(l.retencao), br(l.valor_final), l.situacao_calc,
        l.extrato_id ? 'sim' : 'não', l.nf_numero, l.parcela_num ? l.parcela_num + '/' + l.parcela_total : ''].map(cel).join(';')));
      return { csv: '﻿' + out.join('\r\n'), qtd: itens.length };
    },

    async lanc_ver(b, ctx){
      const id = intOk(b.id); if(!id) throw new ErroUsuario('Código inválido');
      const [l] = (await rest('fin_v_lanc?id=eq.' + id + '&select=*')).data || [];
      if(!l) throw new ErroUsuario('Lançamento não encontrado', 404);
      const [baixas, anexos, historico, parcelas, alertas] = await Promise.all([
        lerTodos('fin_baixas?lancamento_id=eq.' + id + '&select=*&order=id.asc'),
        lerTodos('fin_anexos?lancamento_id=eq.' + id + '&select=id,nome,mime,bytes,por,em&order=id.asc'),
        lerTodos('fin_auditoria?select=seq,ts,ator,acao,tabela,antes,depois&or=(and(tabela.eq.fin_lancamentos,registro_id.eq.' + id + '),and(tabela.eq.fin_baixas,depois->>lancamento_id.eq.' + id + '))&order=seq.asc', 500),
        l.grupo_parcela ? lerTodos('fin_v_lanc?grupo_parcela=eq.' + l.grupo_parcela + '&select=id,parcela_num,parcela_total,vencimento,valor_final,situacao_calc&order=parcela_num.asc') : Promise.resolve([]),
        lerTodos('fin_alertas?lancamento_id=eq.' + id + '&select=*&order=id.desc')
      ]);
      let extrato = null;
      if(l.extrato_id) extrato = ((await rest('fin_v_extrato?id=eq.' + l.extrato_id + '&select=id,data,valor,descricao,conta_nome,status')).data || [])[0] || null;
      mascarar(ctx, l);
      return { lanc: l, baixas, anexos, historico: historico.map(x => ({ seq: x.seq, ts: x.ts, ator: x.ator, acao: x.acao, tabela: x.tabela, antes: x.antes, depois: x.depois })), parcelas, alertas, extrato };
    },

    // Cria 1 ou várias (parcelamento): modo unico | compra (competência fixa, "1/N") | mensal (competência varia) | avancado (lista livre)
    async lanc_criar(b, ctx){
      const tipo = b.tipo === 'receber' ? 'receber' : 'pagar';
      const base = limparItem(b, tipo);
      let itens = [base];
      const modo = b.parcelamento && b.parcelamento.modo;
      if(modo === 'recorrente'){
        // vira um modelo: o banco gera este vencimento e os próximos sozinho, todo período
        const o = recOpcoes(b.parcelamento);
        const r = await rpc('fin_rec_criar', { p_ator: ctx.pessoaId, p_tipo: tipo, p_modelo: modeloDe(base), p_valor: base.valor, p_variavel: o.variavel,
          p_freq: o.frequencia, p_inicio: base.vencimento, p_comp: base.competencia, p_fim: o.fim });
        const ids = Array.isArray(r.ids) ? r.ids : [];
        let aviso = null;
        if(ids[0] && (base.codigo_barras || base.pix_copia_cola || base.nf_numero || base.juros || base.multa || base.desconto)){
          try { await rpc('fin_editar_lancamento', { p_ator: ctx.pessoaId, p_id: ids[0], i: base }); }
          catch(e){ aviso = 'A recorrência foi criada, mas o boleto/Pix/NF ou juros e desconto do 1º mês não entraram: abra a conta #' + ids[0] + ' e complete.'; }
        }
        aviso = (await ligarEntrada(b, ctx, ids[0])) || aviso;
        return { ok: true, ids, recorrencia_id: r.id, aviso };
      }
      if(modo === 'compra' || modo === 'mensal'){
        const n = Math.round(Number(b.parcelamento.parcelas));
        if(!(n >= 2 && n <= 120)) throw new ErroUsuario('Parcelas: de 2 a 120');
        const cents = Math.round(base.valor * 100), parte = Math.floor(cents / n), resto = cents - parte * n;
        const rc = Math.round(base.retencao * 100), rparte = Math.floor(rc / n), rresto = rc - rparte * n;
        itens = [];
        for(let k = 0; k < n; k++){
          const it = Object.assign({}, base);
          it.valor = modo === 'compra' ? (parte + (k === n - 1 ? resto : 0)) / 100 : base.valor;   // compra: divide o total; mensal: repete o valor
          if(modo === 'compra') it.retencao = (rparte + (k === n - 1 ? rresto : 0)) / 100;          // a retenção da NF também é dividida
          it.vencimento = addMes(base.vencimento, k);
          it.competencia = modo === 'compra' ? (base.competencia || base.vencimento) : addMes(base.competencia || base.vencimento, k);
          it.descricao = (base.descricao || '') + ' ' + (k + 1) + '/' + n;
          if(k > 0){ it.juros = 0; it.multa = 0; it.desconto = 0; }
          itens.push(it);
        }
      } else if(modo === 'avancado'){
        const lista = Array.isArray(b.parcelamento.lista) ? b.parcelamento.lista : [];
        if(lista.length < 2 || lista.length > 120) throw new ErroUsuario('Parcelamento avançado: de 2 a 120 parcelas');
        itens = lista.map((p, k) => Object.assign({}, base, { valor: num(p.valor, 'Valor da parcela ' + (k + 1)), vencimento: dataOk(p.vencimento),
          competencia: dataOk(p.competencia) || base.competencia, descricao: (base.descricao || '') + ' ' + (k + 1) + '/' + lista.length,
          juros: k === 0 ? base.juros : 0, multa: k === 0 ? base.multa : 0, desconto: k === 0 ? base.desconto : 0 }));
        if(itens.some(i => !i.vencimento || !(i.valor > 0))) throw new ErroUsuario('Toda parcela precisa de valor e vencimento');
      }
      itens.forEach((i, k) => { if(i.desconto + i.retencao >= i.valor + i.juros + i.multa) throw new ErroUsuario('Na parcela ' + (k + 1) + ' o desconto/retenção fica maior que o valor. Diminua o desconto ou lance sem parcelar.'); });
      const r = await rpc('fin_criar_lancamentos', { p_ator: ctx.pessoaId, p_itens: itens });
      const aviso = await ligarEntrada(b, ctx, r.ids && r.ids[0]);
      return Object.assign({}, r, { aviso });
    },

    async lanc_editar(b, ctx){
      const id = intOk(b.id); if(!id) throw new ErroUsuario('Código inválido');
      const [l] = (await rest('fin_lancamentos?id=eq.' + id + '&select=tipo')).data || [];
      if(!l) throw new ErroUsuario('Lançamento não encontrado', 404);
      const it = limparItem(b, l.tipo);
      const r = await rpc('fin_editar_lancamento', { p_ator: ctx.pessoaId, p_id: id, i: it });
      // conta recorrente de valor variável: salvar a edição = "o valor deste mês confere"
      if(b.confirmar_valor === true) await rpc('fin_rec_confirmar_valor', { p_ator: ctx.pessoaId, p_id: id, p_valor: it.valor });
      return r;
    },

    // ---------- RECORRÊNCIAS ----------
    async rec_listar(b){
      const f = [];
      if(b.tipo === 'pagar' || b.tipo === 'receber') f.push('tipo=eq.' + b.tipo);
      if(['ativa', 'pausada', 'encerrada'].indexOf(b.status) >= 0) f.push('status=eq.' + b.status);
      const q = textoBusca(b.q); if(q) f.push('or=(pessoa_nome.ilike.*' + q + '*,descricao.ilike.*' + q + '*,classificacao_nome.ilike.*' + q + '*)');
      const itens = await lerTodos('fin_v_recorrencias?select=*' + (f.length ? '&' + f.join('&') : '') + '&order=status.asc,id.desc', 5000);
      return { itens };
    },
    async rec_ver(b){
      const id = intOk(b.id); if(!id) throw new ErroUsuario('Código inválido');
      const [r] = (await rest('fin_v_recorrencias?id=eq.' + id + '&select=*')).data || [];
      if(!r) throw new ErroUsuario('Recorrência não encontrada', 404);
      const [lancs, historico] = await Promise.all([
        lerTodos('fin_v_lanc?recorrencia_id=eq.' + id + '&select=id,vencimento,valor_final,situacao_calc,status,valor_a_confirmar,data_pagamento,motivo_cancelamento&order=recorrencia_seq.desc', 500),
        lerTodos('fin_auditoria?select=seq,ts,ator,acao,antes,depois&tabela=eq.fin_recorrencias&registro_id=eq.' + id + '&order=seq.asc', 300)
      ]);
      return { rec: r, lancs, historico };
    },
    async rec_criar(b, ctx){
      const tipo = b.tipo === 'receber' ? 'receber' : 'pagar';
      const base = limparItem(b, tipo), o = recOpcoes(b);
      return rpc('fin_rec_criar', { p_ator: ctx.pessoaId, p_tipo: tipo, p_modelo: modeloDe(base), p_valor: base.valor, p_variavel: o.variavel,
        p_freq: o.frequencia, p_inicio: base.vencimento, p_comp: base.competencia, p_fim: o.fim });
    },
    // "Tornar recorrente": usa um lançamento que já existe como modelo; a próxima conta nasce no período seguinte
    async rec_de_lanc(b, ctx){
      const id = intOk(b.id); if(!id) throw new ErroUsuario('Código inválido');
      const [l] = (await rest('fin_v_lanc?id=eq.' + id + '&select=*')).data || [];
      if(!l) throw new ErroUsuario('Lançamento não encontrado', 404);
      if(l.recorrencia_id) throw new ErroUsuario('Esse lançamento já faz parte da recorrência #' + l.recorrencia_id);
      if(l.status === 'cancelado') throw new ErroUsuario('Lançamento cancelado não vira recorrência');
      const o = recOpcoes(b);
      const base = limparItem(Object.assign({}, l, { juros: 0, multa: 0, desconto: 0 }), l.tipo);
      const inicio = proxFreq(base.vencimento, o.frequencia), comp = base.competencia ? proxFreq(base.competencia, o.frequencia) : null;
      return rpc('fin_rec_criar', { p_ator: ctx.pessoaId, p_tipo: l.tipo, p_modelo: modeloDe(base), p_valor: base.valor, p_variavel: o.variavel,
        p_freq: o.frequencia, p_inicio: inicio, p_comp: comp, p_fim: o.fim });
    },
    async rec_salvar(b, ctx){
      const id = intOk(b.id); if(!id) throw new ErroUsuario('Código inválido');
      const [r] = (await rest('fin_recorrencias?id=eq.' + id + '&select=tipo,inicio')).data || [];
      if(!r) throw new ErroUsuario('Recorrência não encontrada', 404);
      const base = limparItem(Object.assign({}, b, { vencimento: r.inicio }), r.tipo);
      const fim = b.fim ? dataOk(b.fim) : null; if(b.fim && !fim) throw new ErroUsuario('Data final inválida');
      return rpc('fin_rec_salvar', { p_ator: ctx.pessoaId, p_id: id, p_modelo: modeloDe(base), p_valor: base.valor, p_variavel: b.variavel === true,
        p_fim: fim, p_aplicar: b.aplicar === true });
    },
    async rec_status(b, ctx){
      const id = intOk(b.id); if(!id) throw new ErroUsuario('Código inválido');
      // "operacao" (não "acao": esse campo é o nome da ação na API)
      if(['pausar', 'retomar', 'encerrar'].indexOf(b.operacao) < 0) throw new ErroUsuario('Ação inválida');
      const motivo = txt(b.motivo, 500); if(motivo.length < 10) throw new ErroUsuario('Diga o motivo (mínimo 10 letras)');
      return rpc('fin_rec_status', { p_ator: ctx.pessoaId, p_id: id, p_acao: b.operacao, p_motivo: motivo, p_cancelar_futuros: b.cancelar_futuros === true });
    },
    async rec_confirmar_valor(b, ctx){
      const id = intOk(b.id); if(!id) throw new ErroUsuario('Código inválido');
      return rpc('fin_rec_confirmar_valor', { p_ator: ctx.pessoaId, p_id: id, p_valor: num(b.valor, 'Valor') });
    },
    async lanc_cancelar(b, ctx){
      const id = intOk(b.id), motivo = txt(b.motivo, 500);
      if(!id) throw new ErroUsuario('Código inválido'); if(motivo.length < 10) throw new ErroUsuario('Diga o motivo (mínimo 10 letras)');
      return rpc('fin_cancelar_lancamento', { p_ator: ctx.pessoaId, p_id: id, p_motivo: motivo });
    },
    async lanc_split(b, ctx){
      const id = intOk(b.id); if(!id) throw new ErroUsuario('Código inválido');
      return rpc('fin_split_lancamento', { p_ator: ctx.pessoaId, p_id: id, p_valor2: num(b.valor2, 'Valor'), p_venc2: dataOk(b.vencimento2) });
    },
    async lanc_baixar(b, ctx){
      const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).map(intOk).filter(Boolean).slice(0, 200);
      if(!ids.length) throw new ErroUsuario('Nada selecionado');
      const conta = uuidOk(b.conta_id); if(!conta) throw new ErroUsuario('Escolha a conta');
      const data = dataOk(b.data); if(!data) throw new ErroUsuario('Data inválida');
      const ok = [], erros = [];
      for(const id of ids){   // um por um: se um falhar, os outros não são afetados (cada um é transação própria)
        try {
          await rpc('fin_baixar', { p_ator: ctx.pessoaId, p_id: id, p_data: data, p_conta: conta,
            p_juros: ids.length === 1 && b.juros !== undefined ? num(b.juros, 'Juros') : null, p_multa: ids.length === 1 && b.multa !== undefined ? num(b.multa, 'Multa') : null,
            p_desconto: ids.length === 1 && b.desconto !== undefined ? num(b.desconto, 'Desconto') : null, p_obs: txt(b.observacao, 500) || null, p_extrato: null });
          ok.push(id);
        } catch(e){ erros.push('#' + id + ': ' + e.message); }
      }
      return { baixados: ok.length, erros };
    },
    async lanc_estornar(b, ctx){
      const id = intOk(b.id), motivo = txt(b.motivo, 500);
      if(!id) throw new ErroUsuario('Código inválido'); if(motivo.length < 10) throw new ErroUsuario('Diga o motivo (mínimo 10 letras)');
      return rpc('fin_estornar_baixa', { p_ator: ctx.pessoaId, p_id: id, p_motivo: motivo });
    },

    // Central de pagamentos/recebimentos: cards por dia
    async central(b){
      const tipo = b.tipo === 'receber' ? 'receber' : 'pagar';
      const ini = dataOk(b.ini), fim = dataOk(b.fim); if(!ini || !fim) throw new ErroUsuario('Período inválido');
      const f = ['tipo=eq.' + tipo, 'status=neq.cancelado', 'vencimento=gte.' + ini, 'vencimento=lte.' + fim];
      if(b.situacao === 'pendentes') f.push('status=eq.pendente');
      if(b.situacao === 'pagos') f.push('status=eq.pago');
      const q = textoBusca(b.q); if(q) f.push('or=(pessoa_nome.ilike.*' + q + '*,descricao.ilike.*' + q + '*)');
      const itens = await lerTodos('fin_v_lanc?select=id,tipo,pessoa_nome,descricao,classificacao_nome,valor,valor_final,juros,multa,desconto,vencimento,status,situacao_calc,conta_id,conta_nome,forma,extrato_id,recorrencia_id,valor_a_confirmar&' + f.join('&') + '&order=vencimento.asc,id.asc', 20000);
      const dias = {};
      itens.forEach(l => {
        const d = dias[l.vencimento] = dias[l.vencimento] || { dia: l.vencimento, total: 0, qtd: 0, pagos: 0, pendentes: 0, atrasados: 0, por_class: {}, itens: [] };
        d.total += Number(l.valor_final); d.qtd++;
        if(l.status === 'pago') d.pagos++; else if(l.situacao_calc === 'atrasado') d.atrasados++; else d.pendentes++;
        const c = l.classificacao_nome || '(Sem classificação)'; d.por_class[c] = (d.por_class[c] || 0) + Number(l.valor_final);
        d.itens.push(l);
      });
      // atrasados de antes do período aparecem como um card próprio (como os "Erro em pagamento" do Kamino ficam no topo)
      const atrasados = await lerTodos('fin_v_lanc?select=id,pessoa_nome,descricao,valor_final,vencimento&tipo=eq.' + tipo + '&status=eq.pendente&vencimento=lt.' + ini + '&order=vencimento.asc', 5000);
      return { dias: Object.values(dias), atrasados_antes: { qtd: atrasados.length, total: atrasados.reduce((a, l) => a + Number(l.valor_final), 0), itens: atrasados.slice(0, 200) } };
    },

    async receber_dash(b){ return { dash: await rpc('fin_receber_dash', { p_unidade: intOk(b.unidade_id) }) }; },

    async rel_dre(b){
      const ano = Number(b.ano) || new Date().getFullYear();
      return { linhas: await rpc('fin_rel_dre', { p_ano: ano, p_regime: b.regime === 'caixa' ? 'caixa' : 'competencia', p_unidade: intOk(b.unidade_id), p_centro: intOk(b.centro_custo_id) }) };
    },
    async rel_fluxo_mensal(b){
      const ano = Number(b.ano) || new Date().getFullYear();
      return { linhas: await rpc('fin_rel_fluxo_mensal', { p_ano: ano, p_unidade: intOk(b.unidade_id), p_centro: intOk(b.centro_custo_id), p_projecao: b.projecao === true }) };
    },
    async rel_fluxo_diario(b){
      const ini = dataOk(b.ini), fim = dataOk(b.fim); if(!ini || !fim) throw new ErroUsuario('Período inválido');
      const [dias, saldos] = await Promise.all([
        rpc('fin_rel_fluxo_diario', { p_ini: ini, p_fim: fim, p_modo: b.modo === 'realizado' ? 'realizado' : 'projetado', p_unidade: intOk(b.unidade_id) }),
        rpc('fin_saldos_contas', {})
      ]);
      return { dias, saldo_atual: (saldos || []).filter(s => s.ativo).reduce((a, s) => a + Number(s.saldo || 0), 0) };
    },
    async rel_resultado(b){
      const ini = dataOk(b.ini), fim = dataOk(b.fim); if(!ini || !fim) throw new ErroUsuario('Período inválido');
      return { resultado: await rpc('fin_rel_resultado', { p_ini: ini, p_fim: fim, p_unidade: intOk(b.unidade_id), p_centro: intOk(b.centro_custo_id) }) };
    },

    // ---------- Pessoas
    async pessoas_listar(b, ctx){
      const f = [];
      const q = textoBusca(b.q);
      if(q){ const dig = q.replace(/\D/g, ''); f.push('or=(nome.ilike.*' + q + '*,razao_social.ilike.*' + q + '*' + (dig.length >= 3 ? ',documento.like.*' + dig + '*' : '') + ')'); }
      if(b.papel === 'cliente') f.push('cliente=eq.true');
      if(b.papel === 'fornecedor') f.push('fornecedor=eq.true');
      if(b.ativos !== false) f.push('ativo=eq.true');
      const lim = Math.min(Number(b.limite) || 50, 500), pagina = Math.max(0, Number(b.pagina) || 0);
      const { data, headers } = await rest('fin_pessoas?select=id,nome,documento,razao_social,cliente,fornecedor,email,telefone,cidade,uf,ativo,pix_chave' + (f.length ? '&' + f.join('&') : '') + '&order=nome.asc', {
        headers: svc({ 'Range-Unit': 'items', 'Range': (pagina * lim) + '-' + (pagina * lim + lim - 1), 'Prefer': 'count=exact' })
      });
      return { pessoas: (data || []).map(o => mascarar(ctx, o)), total: Number(String(headers.get('content-range') || '').split('/')[1]) || 0 };
    },
    async pessoa_ver(b, ctx){
      const id = intOk(b.id); if(!id) throw new ErroUsuario('Pessoa inválida');
      const [p] = (await rest('fin_pessoas?id=eq.' + id + '&select=*')).data || [];
      if(!p) throw new ErroUsuario('Pessoa não encontrada', 404);
      const lanc = await lerTodos('fin_v_lanc?pessoa_id=eq.' + id + '&select=id,tipo,descricao,valor_final,vencimento,data_pagamento,situacao_calc&order=vencimento.desc', 300);
      return { pessoa: mascarar(ctx, p), lancamentos: lanc };
    },
    async pessoa_salvar(b, ctx){
      const id = b.id ? intOk(b.id) : null; if(b.id && !id) throw new ErroUsuario('Pessoa inválida');
      const campos = ['nome', 'documento', 'razao_social', 'fantasia', 'ie', 'im', 'cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'uf', 'telefone', 'email', 'pix_tipo', 'pix_chave', 'banco', 'agencia', 'conta', 'observacoes'];
      const d = {}; campos.forEach(c => { d[c] = txt(b[c], c === 'observacoes' ? 2000 : 200) || null; });
      ['estrangeira', 'cliente', 'fornecedor'].forEach(c => { d[c] = b[c] === true; });
      d.ativo = b.ativo !== false;
      if(d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) throw new ErroUsuario('E-mail inválido');
      const r = await rpc('fin_salvar_pessoa', { p_ator: ctx.pessoaId, p_id: id, d });
      if(r && r.ok === false) throw new ErroUsuario(r.erro);
      return r;
    },

    async cadastro_salvar(b, ctx){
      const tabela = ['unidade', 'centro', 'classificacao', 'regra'].indexOf(b.tabela) >= 0 ? b.tabela : null;
      if(!tabela) throw new ErroUsuario('Cadastro inválido');
      const d = Object.assign({}, b.dados || {});
      Object.keys(d).forEach(k => { if(typeof d[k] === 'string') d[k] = txt(d[k], 200); });
      if(tabela !== 'regra' && (!d.nome || d.nome.length < 2)) throw new ErroUsuario('Nome obrigatório');
      if(tabela === 'regra'){ if(!d.texto_busca || String(d.texto_busca).trim().length < 2) throw new ErroUsuario('Diga o texto a procurar no extrato'); if(!d.descricao) d.descricao = d.texto_busca; }
      if(tabela === 'classificacao'){
        if(['receita', 'despesa', 'aporte', 'retirada', 'transferencia'].indexOf(d.grupo) < 0 && !b.id) throw new ErroUsuario('Grupo inválido');
        if(['receita_bruta', 'retencoes', 'impostos_venda', 'descontos', 'outras_receitas', 'despesas_comerciais', 'despesas_operacionais', 'impostos_renda', 'aportes', 'retiradas', 'fora_dre'].indexOf(d.dre_linha) < 0) throw new ErroUsuario('Linha do DRE inválida');
      }
      const r = await rpc('fin_salvar_cadastro', { p_ator: ctx.pessoaId, p_tabela: tabela, p_id: b.id ? intOk(b.id) : null, d });
      if(r && r.ok === false) throw new ErroUsuario(r.erro);
      return r;
    },

    // ---------- Conciliação (tela do Kamino: banco à esquerda, lançamento à direita)
    async conciliacao(b){
      const conta = uuidOk(b.conta_id), ini = dataOk(b.ini), fim = dataOk(b.fim);
      if(!conta || !ini || !fim) throw new ErroUsuario('Escolha conta e período');
      const linhas = await lerTodos('fin_v_extrato?conta_id=eq.' + conta + '&data=gte.' + ini + '&data=lte.' + fim + '&select=id,data,valor,descricao,contraparte,status,categoria&order=data.asc,id.asc', 5000);
      const ids = linhas.map(l => l.id);
      let concs = [];
      for(let i = 0; i < ids.length; i += 150) concs = concs.concat(await lerTodos('fin_conciliacoes?ativo=eq.true&extrato_id=in.(' + ids.slice(i, i + 150).join(',') + ')&select=extrato_id,lancamento_id,transferencia_id,metodo,criado_por'));
      const lids = [...new Set(concs.map(c => c.lancamento_id).filter(Boolean))], tids = [...new Set(concs.map(c => c.transferencia_id).filter(Boolean))];
      let lancs = [], transfs = [];
      for(let i = 0; i < lids.length; i += 150) lancs = lancs.concat(await lerTodos('fin_v_lanc?id=in.(' + lids.slice(i, i + 150).join(',') + ')&select=id,tipo,pessoa_nome,descricao,classificacao_nome,centro_custo_nome,valor_final,vencimento,situacao_calc'));
      if(tids.length) transfs = await lerTodos('fin_transferencias?id=in.(' + tids.join(',') + ')&select=*');
      const mL = {}, mT = {}, mC = {}; lancs.forEach(l => { mL[l.id] = l; }); transfs.forEach(t => { mT[t.id] = t; }); concs.forEach(c => { mC[c.extrato_id] = c; });
      let cred = 0, deb = 0, credSem = 0, debSem = 0, nCred = 0, nDeb = 0, nCredSem = 0, nDebSem = 0;
      linhas.forEach(l => {
        const c = mC[l.id]; l.conc = c ? { metodo: c.metodo, por: c.criado_por, lanc: c.lancamento_id ? mL[c.lancamento_id] : null, transf: c.transferencia_id ? mT[c.transferencia_id] : null } : null;
        const v = Number(l.valor);
        if(v > 0){ cred += v; nCred++; if(!c){ credSem += v; nCredSem++; } } else { deb += v; nDeb++; if(!c){ debSem += v; nDebSem++; } }
      });
      return { linhas, cards: { cred, deb, credSem, debSem, nCred, nDeb, nCredSem, nDebSem } };
    },
    async candidatos(b){
      const id = intOk(b.extrato_id); if(!id) throw new ErroUsuario('Linha inválida');
      const [e] = (await rest('fin_extrato?id=eq.' + id + '&select=*')).data || [];
      if(!e) throw new ErroUsuario('Linha não encontrada', 404);
      const dias = Math.max(0, Math.min(60, Number(b.dias) || 7));
      const d0 = new Date(e.data + 'T12:00:00Z'), di = new Date(+d0 - dias * 864e5).toISOString().slice(0, 10), df = new Date(+d0 + dias * 864e5).toISOString().slice(0, 10);
      const tipo = Number(e.valor) < 0 ? 'pagar' : 'receber';
      const f = ['tipo=eq.' + tipo, 'status=neq.cancelado', 'extrato_id=is.null', 'vencimento=gte.' + di, 'vencimento=lte.' + df];
      const q = textoBusca(b.q);
      if(q){ const vq = P.parseValor(q); f.push('or=(pessoa_nome.ilike.*' + q + '*,descricao.ilike.*' + q + '*' + (vq ? ',valor_final.eq.' + Math.abs(vq) : '') + ')'); }
      const lancs = await lerTodos('fin_v_lanc?select=id,tipo,pessoa_nome,descricao,classificacao_nome,valor_final,vencimento,situacao_calc&' + f.join('&') + '&limit=300', 300);
      const alvo = Math.abs(Number(e.valor)), nome = P.norm(e.contraparte || e.descricao || '');
      lancs.forEach(l => {
        const dv = Math.abs(Number(l.valor_final) - alvo), dd = Math.abs((new Date(l.vencimento + 'T12:00:00Z') - d0) / 864e5);
        const nm = l.pessoa_nome && nome.indexOf(P.norm(l.pessoa_nome).split(' ')[0]) >= 0 ? 1 : 0;
        l.score = (dv < 0.005 ? 100 : Math.max(0, 50 - dv)) + (nm ? 20 : 0) - dd;
        l.valor_igual = dv < 0.005;
      });
      lancs.sort((a, c) => c.score - a.score);
      const transfs = await lerTodos('fin_transferencias?cancelada=eq.false&valor=eq.' + alvo + '&data=gte.' + di + '&data=lte.' + df + '&' +
        (Number(e.valor) < 0 ? 'conta_origem_id=eq.' : 'conta_destino_id=eq.') + e.conta_id + '&select=*', 50);
      const regra = await rpc('fin_sugestao_regra', { p_extrato: id });
      return { linha: e, lancamentos: lancs.slice(0, 40), transferencias: transfs, regra };
    },
    async lancar_da_linha(b, ctx){
      const id = intOk(b.extrato_id); if(!id) throw new ErroUsuario('Linha inválida');
      const i = { pessoa_id: idOuNull(b.pessoa_id), classificacao_id: idOuNull(b.classificacao_id), centro_custo_id: idOuNull(b.centro_custo_id),
                  unidade_id: idOuNull(b.unidade_id), descricao: txt(b.descricao, 300), observacao: txt(b.observacao, 1000) || null, forma: FORMAS.indexOf(b.forma) >= 0 ? b.forma : null };
      if(!i.classificacao_id) throw new ErroUsuario('Escolha a classificação');
      const r = await rpc('fin_lancar_da_linha', { p_ator: ctx.pessoaId, p_extrato: id, i });
      if(r && r.ok === false) throw new ErroUsuario(r.erro);
      return r;
    },
    async conciliar_auto(b, ctx){ return { conciliadas: await rpc('fin_conciliar_auto', { p_ator: ctx.pessoaId }) }; },

    async transf_listar(b){
      const ini = dataOk(b.ini), fim = dataOk(b.fim);
      return { transferencias: await lerTodos('fin_transferencias?select=*' + (ini ? '&data=gte.' + ini : '') + (fim ? '&data=lte.' + fim : '') + '&order=data.desc,id.desc', 2000) };
    },
    async transf_criar(b, ctx){
      const o = uuidOk(b.conta_origem_id), d = uuidOk(b.conta_destino_id), data = dataOk(b.data);
      if(!o || !d || o === d) throw new ErroUsuario('Escolha duas contas diferentes'); if(!data) throw new ErroUsuario('Data inválida');
      return rpc('fin_criar_transferencia', { p_ator: ctx.pessoaId, p_data: data, p_origem: o, p_destino: d, p_valor: num(b.valor, 'Valor') || (() => { throw new ErroUsuario('Valor obrigatório'); })(), p_desc: txt(b.descricao, 300) });
    },
    async transf_cancelar(b, ctx){
      const id = intOk(b.id), motivo = txt(b.motivo, 500);
      if(!id || motivo.length < 10) throw new ErroUsuario('Diga o motivo (mínimo 10 letras)');
      return rpc('fin_cancelar_transferencia', { p_ator: ctx.pessoaId, p_id: id, p_motivo: motivo });
    },
    async conciliar_transf(b, ctx){
      const e = intOk(b.extrato_id), t = intOk(b.transferencia_id); if(!e || !t) throw new ErroUsuario('Dados inválidos');
      const r = await rpc('fin_conciliar_transferencia', { p_ator: ctx.pessoaId, p_extrato: e, p_transf: t });
      if(r && r.ok === false) throw new ErroUsuario(r.erro);
      return r;
    },

    // ---------- Caixa de entrada (boleto/NF que chegou e ainda não virou conta a pagar)
    async entradas_listar(b){
      const st = ['pendente', 'nao_identificado', 'lancado', 'arquivado'].indexOf(b.status) >= 0 ? b.status : 'pendente';
      const lista = await lerTodos('fin_entradas?status=eq.' + st + '&select=*&order=vencimento.asc.nullslast,id.desc', 2000);
      const ids = lista.map(e => e.id);
      let anexos = [];
      for(let i = 0; i < ids.length; i += 150) anexos = anexos.concat(await lerTodos('fin_anexos?entrada_id=in.(' + ids.slice(i, i + 150).join(',') + ')&select=id,entrada_id,nome,mime'));
      lista.forEach(e => { e.anexos = anexos.filter(a => a.entrada_id === e.id); });
      return { entradas: lista };
    },
    async entrada_salvar(b, ctx){
      const id = b.id ? intOk(b.id) : null;
      const st = ['pendente', 'nao_identificado', 'arquivado'].indexOf(b.status) >= 0 ? b.status : null;
      if(st === 'arquivado' && txt(b.motivo_arquivo, 300).length < 10) throw new ErroUsuario('Diga por que está arquivando (mínimo 10 letras)');
      const v = b.valor === '' || b.valor == null ? null : num(b.valor, 'Valor');
      const r = await rpc('fin_salvar_entrada', { p_ator: ctx.pessoaId, p_id: id, d: {
        beneficiario: txt(b.beneficiario, 200), documento: txt(b.documento, 30).replace(/\D/g, ''), vencimento: dataOk(b.vencimento) || '',
        valor: v == null ? '' : v, linha_digitavel: txt(b.linha_digitavel, 120).replace(/[^\d. ]/g, ''), observacao: txt(b.observacao, 1000),
        status: st || '', motivo_arquivo: txt(b.motivo_arquivo, 300) } });
      return r;
    },

    // ---------- Anexos (bucket PRIVADO fin-anexos; download só por link assinado de 60s)
    async anexo_enviar(b, ctx){
      const lanc = b.lancamento_id ? intOk(b.lancamento_id) : null, ent = b.entrada_id ? intOk(b.entrada_id) : null;
      if(!lanc && !ent) throw new ErroUsuario('Anexo sem destino');
      const mime = String(b.mime || '');
      const ext = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[mime];
      if(!ext) throw new ErroUsuario('Só PDF ou imagem (PNG, JPG, WEBP)');
      const buf = Buffer.from(String(b.base64 || ''), 'base64');
      if(!buf.length) throw new ErroUsuario('Arquivo vazio');
      if(buf.length > 4 * 1024 * 1024) throw new ErroUsuario('Arquivo grande demais (máx. 4 MB)');
      // confere a "assinatura" do arquivo (não confia na extensão que o navegador mandou)
      const magic = buf.slice(0, 12).toString('hex');
      const okMagic = (ext === 'pdf' && magic.startsWith('25504446')) || (ext === 'png' && magic.startsWith('89504e47')) ||
                      (ext === 'jpg' && magic.startsWith('ffd8ff')) || (ext === 'webp' && magic.startsWith('52494646') && buf.slice(8, 12).toString() === 'WEBP');
      if(!okMagic) throw new ErroUsuario('O conteúdo do arquivo não bate com o tipo informado');
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      const agora = new Date().toISOString();
      const caminho = agora.slice(0, 4) + '/' + agora.slice(5, 7) + '/' + crypto.randomUUID() + '.' + ext;
      const up = await fetch(SUPA_URL + '/storage/v1/object/fin-anexos/' + caminho, { method: 'POST', headers: svc({ 'Content-Type': mime, 'x-upsert': 'false' }), body: buf });
      if(!up.ok) throw new ErroUsuario('Falha ao guardar o arquivo (' + up.status + ')', 502);
      return rpc('fin_registrar_anexo', { p_ator: ctx.pessoaId, d: { lancamento_id: lanc || '', entrada_id: ent || '', nome: txt(b.nome, 150) || ('anexo.' + ext), caminho, mime, bytes: buf.length, sha256: sha } });
    },
    async anexo_baixar(b){
      const id = intOk(b.id); if(!id) throw new ErroUsuario('Anexo inválido');
      const [a] = (await rest('fin_anexos?id=eq.' + id + '&select=caminho,nome')).data || [];
      if(!a) throw new ErroUsuario('Anexo não encontrado', 404);
      const r = await fetch(SUPA_URL + '/storage/v1/object/sign/fin-anexos/' + a.caminho, { method: 'POST', headers: svc(), body: JSON.stringify({ expiresIn: 60 }) });
      const j = await r.json().catch(() => ({}));
      if(!r.ok || !j.signedURL) throw new ErroUsuario('Não consegui gerar o link do anexo', 502);
      return { url: SUPA_URL + '/storage/v1' + j.signedURL, nome: a.nome };
    }
  };

  return { acoes: A, perm: PERM };
};
