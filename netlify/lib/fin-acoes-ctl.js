// netlify/lib/fin-acoes-ctl.js
// CONTROLES do financeiro (no lugar das planilhas das meninas): EMPRESAS (cobrança semanal) e CRÉDITOS.
// Toda escrita é RPC no banco (transação + ator carimbado + auditoria). Filtros validados antes de virar URL.
// Quem lançou não confere (regra no banco). Cancelar/estornar/isentar multa: gestor.
// ============================================================
'use strict';
const crypto = require('crypto');
const X = require('./xlsx-mini');
const PL = require('./fin-planilhas');
const MQ = require('./machine-api');

module.exports = function(h){
  const { rest, rpc, ErroUsuario, txt, dataOk, intOk, textoBusca, svc, NIVEL } = h;

  const PERM = {
    ctl_base: 'leitor', ctl_cob_resumo: 'leitor', ctl_cob_listar: 'leitor', ctl_cob_ver: 'leitor',
    ctl_cred_resumo: 'leitor', ctl_cred_listar: 'leitor', ctl_cred_ver: 'leitor', ctl_importacoes: 'leitor',
    ctl_cob_salvar: 'conferente', ctl_cob_receber: 'conferente', ctl_cred_salvar: 'conferente', ctl_conferir: 'conferente', ctl_importar: 'conferente',
    ctl_estornar_receb: 'gestor', ctl_cancelar: 'gestor',
    // v5: as outras planilhas (bags, camisetas, motoboys novos, motoboys semanal, descontos)
    ctl_reg_abas: 'leitor', ctl_reg_listar: 'leitor', ctl_reg_ver: 'leitor',
    ctl_reg_salvar: 'conferente', ctl_reg_pagar: 'conferente', ctl_reg_estornar_pag: 'gestor',
    // v6: Motoboys semanal calculado pelas corridas da Machine
    ctl_moto_previa: 'leitor', ctl_moto_buscar_dia: 'conferente', ctl_moto_gerar: 'conferente'
  };
  const MOTIVOS = ['pagamento_semanal', 'bonus_acao', 'bonus_inicio', 'cortesia', 'reembolso', 'ajuste', 'zeragem', 'teste', 'outro'];
  const SIT = ['aberta', 'vencida', 'parcial', 'quitada', 'cancelada'];
  const TABELAS = { cobrancas: 'fin_ctl_cobrancas', creditos: 'fin_ctl_creditos', registros: 'fin_ctl_registros' };
  // cada planilha = um ou mais tipos de linha (DESCONTOS tem as abas "banco" e "fora do banco")
  const PLANILHAS = { bag: ['bag'], camiseta: ['camiseta'], moto_novo: ['moto_novo'], motoboy_semanal: ['motoboy_semanal'], descontos: ['desconto_banco', 'desconto_fora'] };
  const TIPOS_LINHA = ['bag', 'camiseta', 'moto_novo', 'motoboy_semanal', 'desconto_banco', 'desconto_fora'];
  const FORMAS = ['pix', 'dinheiro', 'cartao', 'boleto', 'cortesia', 'desconto_semanal', 'outro'];

  // valor DIGITADO por gente do Brasil: "1.500" = mil e quinhentos, "1,5" / "1,500" = um e meio
  // (o parseValor do extrato recusa esses casos porque arquivo de banco pode vir no formato americano)
  const valorBR = s => {
    let t = String(s == null ? '' : s).trim().replace(/\s|R\$/gi, '');
    if(/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
    else if(/^\d+,\d+$/.test(t)) t = t.replace(',', '.');
    else return h.P.parseValor(t);
    const x = Number(t); return isFinite(x) ? x : null;
  };
  const valor = (v, nome, zeroOk) => {
    const n = typeof v === 'number' ? v : valorBR(v);
    if(n == null || !isFinite(n) || n < 0 || (!zeroOk && n === 0) || n > 10000000) throw new ErroUsuario((nome || 'Valor') + ' inválido');
    return Math.round(n * 100) / 100;
  };
  const unidade = v => { const u = intOk(v); if(!u) throw new ErroUsuario('Escolha a cidade'); return u; };
  const unidadeOpc = v => (v === '' || v == null) ? null : unidade(v);
  function periodo(b, max){
    const ini = dataOk(b.ini), fim = dataOk(b.fim);
    if(!ini || !fim || fim < ini) throw new ErroUsuario('Período inválido');
    if((Date.parse(fim) - Date.parse(ini)) / 864e5 > (max || 400)) throw new ErroUsuario('Período grande demais');
    return { ini, fim };
  }
  async function pagina(path, pag){
    const p = Math.min(Math.max(0, parseInt(pag, 10) || 0), 1000);
    const { data, headers } = await rest(path, { headers: svc({ 'Range-Unit': 'items', Range: (p * 200) + '-' + (p * 200 + 199), Prefer: 'count=exact' }) });
    return { linhas: data || [], total: Number(String(headers.get('content-range') || '').split('/')[1]) || 0, pagina: p };
  }

  const acoes = {
    async ctl_base(){
      const { data } = await rest('fin_unidades?select=id,nome,cidade_slug,ativo&order=nome.asc');
      return { unidades: data || [], motivos: MOTIVOS };
    },

    // ---------------- EMPRESAS ----------------
    async ctl_cob_resumo(b){
      const { ini, fim } = periodo(b, 400);
      return { resumo: await rpc('fin_ctl_resumo_cob', { p_unidade: unidadeOpc(b.unidade_id), p_ini: ini, p_fim: fim }) };
    },
    async ctl_cob_listar(b){
      const { ini, fim } = periodo(b, 400);
      const f = ['semana_ini=gte.' + ini, 'semana_ini=lte.' + fim];
      const u = unidadeOpc(b.unidade_id); if(u) f.push('unidade_id=eq.' + u);
      if(SIT.indexOf(b.situacao) >= 0) f.push('situacao=eq.' + b.situacao); else f.push('status=eq.ativa');
      if(b.conf === 'sem') f.push('conf_status=is.null'); else if(b.conf === 'ok' || b.conf === 'divergente') f.push('conf_status=eq.' + b.conf);
      const busca = textoBusca(b.busca);
      if(busca) f.push('empresa_norm=ilike.*' + encodeURIComponent(h.P.norm(busca)) + '*');
      return pagina('fin_ctl_v_cobrancas?select=*&' + f.join('&') + '&order=semana_ini.desc,empresa_norm.asc,id.asc', b.pagina);
    },
    async ctl_cob_ver(b){
      const id = intOk(b.id); if(!id) throw new ErroUsuario('Cobrança inválida');
      const [c] = (await rest('fin_ctl_v_cobrancas?id=eq.' + id + '&select=*')).data || [];
      if(!c) throw new ErroUsuario('Cobrança não encontrada');
      const receb = (await rest('fin_ctl_cob_receb?cobranca_id=eq.' + id + '&select=*&order=id.asc')).data || [];
      const conf = (await rest('fin_ctl_conferencias?tabela=eq.fin_ctl_cobrancas&registro_id=eq.' + id + '&select=*&order=id.desc')).data || [];
      // histórico SÓ desta cobrança e dos recebimentos dela (sem misturar ids de outras tabelas)
      const hist = (await rest('fin_auditoria?or=(and(tabela.eq.fin_ctl_cobrancas,registro_id.eq.' + id + '),and(tabela.eq.fin_ctl_cob_receb,depois->>cobranca_id.eq.' + id + '))&select=seq,ts,ator,acao,tabela,antes,depois&order=seq.asc')).data || [];
      return { cobranca: c, recebimentos: receb, conferencias: conf, historico: hist };
    },
    async ctl_cob_salvar(b, ctx){
      const id = b.id ? intOk(b.id) : null;
      const d = {
        desconto: b.desconto === '' || b.desconto == null ? 0 : valor(b.desconto, 'Desconto', true),
        desconto_motivo: txt(b.desconto_motivo, 300), vencimento: dataOk(b.vencimento), nome_no_banco: txt(b.nome_no_banco, 200),
        observacao: txt(b.observacao, 1000), multa_pct: b.multa_pct === '' || b.multa_pct == null ? 3 : Number(b.multa_pct),
        isento_multa: b.isento_multa === true, isencao_motivo: txt(b.isencao_motivo, 300), empresa_doc: txt(b.empresa_doc, 20)
      };
      if(!(d.multa_pct >= 0 && d.multa_pct <= 20)) throw new ErroUsuario('Multa inválida (0 a 20%)');
      if(d.empresa_doc && !/^(\d{11}|\d{14})$/.test(d.empresa_doc.replace(/\D/g, ''))) throw new ErroUsuario('CNPJ/CPF inválido');
      // isentar multa ou mudar o % da multa: só gestor
      if((d.isento_multa || d.multa_pct !== 3) && NIVEL[ctx.papel] < NIVEL.gestor){
        if(!id) throw new ErroUsuario('Isentar ou mudar a multa é com o gestor');
        const [atual] = (await rest('fin_ctl_cobrancas?id=eq.' + id + '&select=isento_multa,multa_pct')).data || [];
        if(!atual || atual.isento_multa !== d.isento_multa || Number(atual.multa_pct) !== d.multa_pct) throw new ErroUsuario('Isentar ou mudar a multa é com o gestor');
      }
      if(!id){
        d.unidade_id = unidade(b.unidade_id); d.semana_ini = dataOk(b.semana_ini); d.semana_fim = dataOk(b.semana_fim) || null;
        if(!d.semana_ini) throw new ErroUsuario('Semana obrigatória');
        d.empresa = txt(b.empresa, 200); if(d.empresa.length < 2) throw new ErroUsuario('Empresa obrigatória');
        d.valor = valor(b.valor, 'Valor a receber', true);
        d.permitir_repetida = b.permitir_repetida === true;
      }
      if(d.desconto > 0 && d.desconto_motivo.length < 5) throw new ErroUsuario('Desconto precisa de motivo (mín. 5 letras)');
      // a regra de verdade é no banco (p_gestor): desconto/vencimento/multa de cobrança já lançada só o gestor muda
      return rpc('fin_ctl_cob_salvar', { p_ator: ctx.pessoaId, p_id: id, p_d: d, p_gestor: NIVEL[ctx.papel] >= NIVEL.gestor });
    },
    async ctl_cob_receber(b, ctx){
      const id = intOk(b.cobranca_id); if(!id) throw new ErroUsuario('Cobrança inválida');
      const d = { valor: valor(b.valor, 'Valor recebido'), data: dataOk(b.data), forma: txt(b.forma, 30), nome_no_banco: txt(b.nome_no_banco, 200),
                  observacao: txt(b.observacao, 500), extrato_id: b.extrato_id ? intOk(b.extrato_id) : null };
      if(!d.data) throw new ErroUsuario('Data do recebimento obrigatória');
      return rpc('fin_ctl_cob_receber', { p_ator: ctx.pessoaId, p_cobranca: id, p_d: d });
    },
    async ctl_estornar_receb(b, ctx){
      const id = intOk(b.id); if(!id) throw new ErroUsuario('Recebimento inválido');
      return rpc('fin_ctl_estornar_receb', { p_ator: ctx.pessoaId, p_id: id, p_motivo: txt(b.motivo, 500) });
    },

    // ---------------- CRÉDITOS ----------------
    async ctl_cred_resumo(b){
      const { ini, fim } = periodo(b, 400);
      return { resumo: await rpc('fin_ctl_resumo_cred', { p_unidade: unidadeOpc(b.unidade_id), p_ini: ini, p_fim: fim }) };
    },
    async ctl_cred_listar(b){
      const { ini, fim } = periodo(b, 400);
      const f = ['data=gte.' + ini, 'data=lte.' + fim];
      const u = unidadeOpc(b.unidade_id); if(u) f.push('unidade_id=eq.' + u);
      f.push(b.status === 'cancelado' ? 'status=eq.cancelado' : 'status=eq.ativo');
      if(MOTIVOS.indexOf(b.motivo) >= 0) f.push('motivo=eq.' + b.motivo);
      if(b.conf === 'sem') f.push('conf_status=is.null'); else if(b.conf === 'ok' || b.conf === 'divergente') f.push('conf_status=eq.' + b.conf);
      const busca = textoBusca(b.busca);
      if(busca) f.push('beneficiario_norm=ilike.*' + encodeURIComponent(h.P.norm(busca)) + '*');
      const op = textoBusca(b.operador); if(op) f.push('operador=ilike.*' + encodeURIComponent(op) + '*');
      return pagina('fin_ctl_v_creditos?select=*&' + f.join('&') + '&order=data.desc,hora.desc.nullslast,id.desc', b.pagina);
    },
    async ctl_cred_ver(b){
      const id = intOk(b.id); if(!id) throw new ErroUsuario('Crédito inválido');
      const [c] = (await rest('fin_ctl_v_creditos?id=eq.' + id + '&select=*')).data || [];
      if(!c) throw new ErroUsuario('Crédito não encontrado');
      const conf = (await rest('fin_ctl_conferencias?tabela=eq.fin_ctl_creditos&registro_id=eq.' + id + '&select=*&order=id.desc')).data || [];
      const hist = (await rest('fin_auditoria?tabela=eq.fin_ctl_creditos&registro_id=eq.' + id + '&select=seq,ts,ator,acao,antes,depois&order=seq.asc')).data || [];
      return { credito: c, conferencias: conf, historico: hist };
    },
    async ctl_cred_salvar(b, ctx){
      const id = b.id ? intOk(b.id) : null;
      const d = { beneficiario_tipo: ['entregador', 'empresa', 'outro'].indexOf(b.beneficiario_tipo) >= 0 ? b.beneficiario_tipo : 'entregador',
        entregador_id: txt(b.entregador_id, 40).replace(/[^0-9A-Za-z_-]/g, ''), empresa: txt(b.empresa, 200), os: txt(b.os, 60), operador: txt(b.operador, 100),
        motivo: MOTIVOS.indexOf(b.motivo) >= 0 ? b.motivo : null, observacao: txt(b.observacao, 1000),
        hora: /^\d{2}:\d{2}(:\d{2})?$/.test(b.hora || '') ? b.hora : null };
      if(!d.motivo) throw new ErroUsuario('Escolha o motivo do crédito');
      if(!id){
        d.unidade_id = unidade(b.unidade_id); d.data = dataOk(b.data); if(!d.data) throw new ErroUsuario('Data obrigatória');
        d.valor = valor(b.valor, 'Valor'); d.beneficiario = txt(b.beneficiario, 200);
        if(d.beneficiario.length < 2) throw new ErroUsuario('Quem recebeu o crédito é obrigatório');
        d.permitir_repetido = b.permitir_repetido === true;
      }
      return rpc('fin_ctl_cred_salvar', { p_ator: ctx.pessoaId, p_id: id, p_d: d });
    },

    // ---------------- comuns ----------------
    async ctl_cancelar(b, ctx){
      const t = TABELAS[b.tabela]; const id = intOk(b.id);
      if(!t || !id) throw new ErroUsuario('Registro inválido');
      return rpc('fin_ctl_cancelar', { p_ator: ctx.pessoaId, p_tabela: t, p_id: id, p_motivo: txt(b.motivo, 500) });
    },
    async ctl_conferir(b, ctx){
      const t = TABELAS[b.tabela]; if(!t) throw new ErroUsuario('Tabela inválida');
      const ids = (Array.isArray(b.ids) ? b.ids : []).map(intOk).filter(Boolean).slice(0, 500);
      if(!ids.length) throw new ErroUsuario('Selecione o que conferir');
      if(b.status !== 'ok' && b.status !== 'divergente') throw new ErroUsuario('Status inválido');
      return rpc('fin_ctl_conferir', { p_ator: ctx.pessoaId, p_tabela: t, p_ids: ids, p_status: b.status, p_obs: txt(b.observacao, 1000) });
    },
    // ---------------- v5: AS OUTRAS PLANILHAS ----------------
    async ctl_reg_abas(b){
      const tipos = PLANILHAS[b.planilha]; if(!tipos) throw new ErroUsuario('Planilha inválida');
      return { abas: await rpc('fin_ctl_reg_abas', { p_tipos: tipos, p_unidade: unidadeOpc(b.unidade_id) }) };
    },
    async ctl_reg_listar(b){
      const tipos = PLANILHAS[b.planilha]; if(!tipos) throw new ErroUsuario('Planilha inválida');
      const { ini, fim } = periodo(b, 400);
      const semanal = b.planilha === 'motoboy_semanal';
      const f = ['tipo=in.(' + tipos.join(',') + ')', (semanal ? 'semana_ini' : 'data') + '=gte.' + ini, (semanal ? 'semana_ini' : 'data') + '=lte.' + fim];
      const u = unidadeOpc(b.unidade_id); if(u) f.push('unidade_id=eq.' + u);
      f.push(b.status === 'cancelado' ? 'status=eq.cancelado' : 'status=eq.ativo');
      if(TIPOS_LINHA.indexOf(b.tipo) >= 0 && tipos.indexOf(b.tipo) >= 0) f.push('tipo=eq.' + b.tipo);
      if(['pendente', 'parcial', 'pago', 'cortesia'].indexOf(b.situacao) >= 0) f.push('situacao=eq.' + b.situacao);
      if(b.conf === 'sem') f.push('conf_status=is.null'); else if(b.conf === 'ok' || b.conf === 'divergente') f.push('conf_status=eq.' + b.conf);
      const busca = textoBusca(b.busca);
      if(busca) f.push('nome_norm=ilike.*' + encodeURIComponent(h.P.norm(busca)) + '*');
      const res = await pagina('fin_ctl_v_registros?select=*&' + f.join('&') + '&order=data.asc,id.asc', b.pagina);
      // linha de TOTAL da aba (como na planilha), calculada no servidor sobre a aba inteira
      const tot = (await rest('fin_ctl_v_registros?select=valor,pago,saldo,valor_gami,valor_entregador,quantidade&' + f.join('&'))).data || [];
      const soma = k => Math.round(tot.reduce((a, x) => a + (Number(x[k]) || 0), 0) * 100) / 100;
      res.totais = { valor: soma('valor'), pago: soma('pago'), saldo: soma('saldo'), valor_gami: soma('valor_gami'), valor_entregador: soma('valor_entregador'), quantidade: soma('quantidade'), linhas: tot.length };
      return res;
    },
    async ctl_reg_ver(b){
      const id = intOk(b.id); if(!id) throw new ErroUsuario('Registro inválido');
      const [r] = (await rest('fin_ctl_v_registros?id=eq.' + id + '&select=*')).data || [];
      if(!r) throw new ErroUsuario('Registro não encontrado');
      const pags = (await rest('fin_ctl_reg_pag?registro_id=eq.' + id + '&select=*&order=id.asc')).data || [];
      const conf = (await rest('fin_ctl_conferencias?tabela=eq.fin_ctl_registros&registro_id=eq.' + id + '&select=*&order=id.desc')).data || [];
      const hist = (await rest('fin_auditoria?or=(and(tabela.eq.fin_ctl_registros,registro_id.eq.' + id + '),and(tabela.eq.fin_ctl_reg_pag,depois->>registro_id.eq.' + id + '))&select=seq,ts,ator,acao,tabela&order=seq.asc')).data || [];
      return { registro: r, pagamentos: pags, conferencias: conf, historico: hist };
    },
    async ctl_reg_salvar(b, ctx){
      const id = b.id ? intOk(b.id) : null;
      const d = { forma: FORMAS.indexOf(b.forma) >= 0 ? b.forma : '', tamanho: txt(b.tamanho, 40), pago_por: txt(b.pago_por, 200),
        motivo: txt(b.motivo, 300), responsavel: txt(b.responsavel, 100), observacao: txt(b.observacao, 1000) };
      if(!id){
        if(TIPOS_LINHA.indexOf(b.tipo) < 0) throw new ErroUsuario('Planilha inválida');
        d.tipo = b.tipo; d.unidade_id = unidade(b.unidade_id); d.nome = txt(b.nome, 200);
        if(d.nome.length < 2) throw new ErroUsuario('Nome obrigatório');
        if(b.tipo === 'motoboy_semanal'){
          d.semana_ini = dataOk(b.semana_ini); if(!d.semana_ini) throw new ErroUsuario('Semana obrigatória');
          d.valor = valor(b.valor, 'Faturamento', true);
          if(b.percentual !== '' && b.percentual != null){ const pc = Number(String(b.percentual).replace(',', '.')); if(!(pc >= 0 && pc <= 100)) throw new ErroUsuario('Percentual inválido'); d.percentual = pc; }
        } else {
          d.data = dataOk(b.data); if(!d.data) throw new ErroUsuario('Data obrigatória');
          if(b.tipo === 'bag' || b.tipo === 'camiseta'){
            const q = parseInt(b.quantidade, 10); if(!(q >= 1 && q <= 1000)) throw new ErroUsuario('Quantidade inválida'); d.quantidade = q;
            d.valor_unitario = d.forma === 'cortesia' ? 0 : valor(b.valor_unitario, 'Valor unitário', true);
          } else d.valor = valor(b.valor, 'Valor');
          if(b.valor_pago !== '' && b.valor_pago != null && (b.tipo === 'bag' || b.tipo === 'camiseta' || b.tipo === 'moto_novo')){
            d.valor_pago = valor(b.valor_pago, 'Valor pago', true); d.data_pagamento = dataOk(b.data_pagamento) || d.data;
          }
        }
        d.permitir_repetido = b.permitir_repetido === true;
      }
      return rpc('fin_ctl_reg_salvar', { p_ator: ctx.pessoaId, p_id: id, p_d: d });
    },
    async ctl_reg_pagar(b, ctx){
      const id = intOk(b.registro_id); if(!id) throw new ErroUsuario('Registro inválido');
      const d = { valor: valor(b.valor, 'Valor'), data: dataOk(b.data), forma: FORMAS.indexOf(b.forma) >= 0 ? b.forma : '', pago_por: txt(b.pago_por, 200), observacao: txt(b.observacao, 500) };
      if(!d.data) throw new ErroUsuario('Data obrigatória');
      return rpc('fin_ctl_reg_pagar', { p_ator: ctx.pessoaId, p_registro: id, p_d: d });
    },
    async ctl_reg_estornar_pag(b, ctx){
      const id = intOk(b.id); if(!id) throw new ErroUsuario('Pagamento inválido');
      return rpc('fin_ctl_reg_estornar_pag', { p_ator: ctx.pessoaId, p_id: id, p_motivo: txt(b.motivo, 500) });
    },

    // ---------------- v6: MOTOBOYS PELA MACHINE ----------------
    async ctl_moto_buscar_dia(b, ctx){
      const un = unidade(b.unidade_id), dia = dataOk(b.dia);
      if(!dia) throw new ErroUsuario('Dia inválido');
      const hojeBR = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
      if(dia >= hojeBR) throw new ErroUsuario('Só dá pra buscar dias que já terminaram');
      const [u] = (await rest('fin_unidades?id=eq.' + un + '&select=cidade_slug')).data || [];
      if(!u || !u.cidade_slug) throw new ErroUsuario('Essa unidade não tem cidade da Machine');
      let res;
      try { res = await MQ.corridasDoDia(u.cidade_slug, dia, 20000); } catch(e){ throw new ErroUsuario(e.message); }
      const r = await rpc('fin_ctl_machine_salvar_dia', { p_ator: ctx.pessoaId, p_unidade: un, p_dia: dia, p_completo: res.completo, p_corridas: res.corridas });
      return Object.assign({ completo: res.completo }, r);
    },
    async ctl_moto_previa(b){
      const un = unidade(b.unidade_id), ini = dataOk(b.semana_ini); if(!ini) throw new ErroUsuario('Semana inválida');
      const pct = b.percentual === '' || b.percentual == null ? 21 : Number(String(b.percentual).replace(',', '.'));
      if(!(pct >= 0 && pct <= 100)) throw new ErroUsuario('Percentual inválido');
      return { previa: await rpc('fin_ctl_moto_previa', { p_unidade: un, p_ini: ini, p_pct: pct }) };
    },
    async ctl_moto_gerar(b, ctx){
      const un = unidade(b.unidade_id), ini = dataOk(b.semana_ini); if(!ini) throw new ErroUsuario('Semana inválida');
      const pct = b.percentual === '' || b.percentual == null ? 21 : Number(String(b.percentual).replace(',', '.'));
      if(!(pct >= 0 && pct <= 100)) throw new ErroUsuario('Percentual inválido');
      return rpc('fin_ctl_moto_gerar', { p_ator: ctx.pessoaId, p_unidade: un, p_ini: ini, p_pct: pct });
    },

    async ctl_importacoes(){
      const { data } = await rest('fin_ctl_importacoes?select=id,tipo,unidade_id,arquivo_nome,arquivo_bytes,qtd_linhas,qtd_novas,importado_por,importado_em&order=importado_em.desc&limit=100');
      return { importacoes: data || [] };
    },
    // Importa a planilha antiga (.xlsx) inteira: lê no servidor, mostra a prévia e só grava no "confirmar".
    async ctl_importar(b, ctx){
      const tipo = ['empresas', 'creditos', 'bag', 'camiseta', 'moto_novo', 'motoboy_semanal', 'descontos'].indexOf(b.tipo) >= 0 ? b.tipo : null;
      if(!tipo) throw new ErroUsuario('Escolha o tipo da planilha');
      const un = unidade(b.unidade_id);
      const ano = parseInt(b.ano, 10); if(!(ano >= 2020 && ano <= 2100)) throw new ErroUsuario('Ano inválido');
      const b64 = typeof b.conteudo_b64 === 'string' ? b.conteudo_b64 : '';
      if(!b64 || b64.length > 5.5 * 1024 * 1024) throw new ErroUsuario('Arquivo vazio ou grande demais (máx. 4 MB)');
      const buf = Buffer.from(b64, 'base64');
      if(buf.length < 100 || buf.readUInt32LE(0) !== 0x04034b50) throw new ErroUsuario('Envie a planilha em .xlsx (Excel)');
      let abas; try { abas = X.lerXlsx(buf); } catch(e){ throw new ErroUsuario(e.message || 'Não consegui ler a planilha'); }
      const res = tipo === 'empresas' ? PL.parseEmpresas(abas, ano) : tipo === 'creditos' ? PL.parseCreditos(abas, ano)
        : (tipo === 'bag' || tipo === 'camiseta') ? PL.parseVendas(abas, ano, tipo) : tipo === 'moto_novo' ? PL.parseMotoNovos(abas, ano)
        : tipo === 'motoboy_semanal' ? PL.parseMotoboys(abas, ano) : PL.parseDescontos(abas, ano);
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      const soma = Math.round(res.linhas.reduce((a, l) => a + l.valor, 0) * 100) / 100;
      const resumo = { linhas: res.linhas.length, soma, avisos: res.avisos.slice(0, 200), qtd_avisos: res.avisos.length, abas: res.abas };
      if(PLANILHAS[tipo] && tipo !== 'motoboy_semanal' && tipo !== 'descontos') resumo.recebido = Math.round(res.linhas.reduce((a, l) => a + (l.valor_pago || 0), 0) * 100) / 100;
      if(tipo === 'empresas') resumo.recebido = Math.round(res.linhas.reduce((a, l) => a + (l.recebido || 0), 0) * 100) / 100;
      if(!b.confirmar) return { preview: true, resumo };
      if(!res.linhas.length) throw new ErroUsuario('Nada para importar');
      const r = await rpc(PLANILHAS[tipo] ? 'fin_ctl_reg_importar' : 'fin_ctl_importar', { p_ator: ctx.pessoaId, p_tipo: tipo,
        p_meta: { unidade_id: un, arquivo_nome: txt(b.arquivo_nome, 200), sha256: sha, bytes: buf.length, conteudo_b64: b64, abas: res.abas },
        p_linhas: res.linhas });
      if(r && r.ok === false) throw new ErroUsuario(r.erro);
      return Object.assign({ resumo }, r);
    }
  };

  return { acoes, perm: PERM };
};
