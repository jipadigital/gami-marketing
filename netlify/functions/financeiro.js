// netlify/functions/financeiro.js
// 🛡️ MÓDULO FINANCEIRO / CONFERÊNCIA ANTIFRAUDE. Dado mais sensível do sistema.
//
// SEGURANÇA (servidor é a única fronteira de confiança):
//  1) valida a sessão (X-Gami-User/Token contra usuarios_login, token ativo e não expirado);
//  2) descobre o PAPEL: super_admin (jipadigital@gmail.com) ou linha ativa em fin_acesso;
//  3) cada ação exige um papel mínimo (tabela PERM abaixo);
//  4) lê/escreve com a service key; as tabelas fin_* não existem pra chave pública (RLS + REVOKE);
//  5) TODA escrita é RPC no banco, numa transação, carimbando QUEM fez (auditoria encadeada);
//  6) o banco recusa DELETE/UPDATE indevido mesmo que este código tenha bug.
// ============================================================
'use strict';
const P = require('../lib/fin-parser');

// DOIS BANCOS:
//  - MAIN (dashboard): só pra validar a sessão (usuarios_login) e ler nomes da equipe (pessoas).
//  - FIN (exclusivo do financeiro): TODO dado financeiro. Projeto Supabase separado, com chave própria.
//    Liga quando existe FIN_SUPA_SERVICE_KEY (a URL não é segredo e fica aqui: as env vars das
//    funções têm limite de 4 KB na AWS). Sem a chave, usa o MAIN (como antes).
const MAIN_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';
const FIN_URL = process.env.FIN_SUPA_URL || 'https://vyjjdirlgvysbalrmmih.supabase.co';
const MAIN_KEY = process.env.SUPA_SERVICE_KEY;
const BANCO_EXCLUSIVO = !!process.env.FIN_SUPA_SERVICE_KEY;
const SUPA_URL = BANCO_EXCLUSIVO ? FIN_URL : MAIN_URL;
const SUPA_SERVICE_KEY = BANCO_EXCLUSIVO ? process.env.FIN_SUPA_SERVICE_KEY : MAIN_KEY;
const SUPER_ADMIN_EMAIL = 'jipadigital@gmail.com';
const SUPER_ADMIN_PESSOA = 'pe016';   // super = e-mail E pessoa_id certos (trocar o e-mail no dashboard não basta)
const MAX_ARQUIVO = 4 * 1024 * 1024; // 4 MB de texto (limite do Netlify é 6 MB no corpo)

const ORIGENS_PERMITIDAS = ['https://gami-marketing.netlify.app', 'http://localhost:8888', 'http://localhost:3000'];
function corsHeaders(origin){
  const permitido = ORIGENS_PERMITIDAS.indexOf(origin) >= 0 ? origin : ORIGENS_PERMITIDAS[0];
  return {
    'Access-Control-Allow-Origin': permitido,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Gami-User, X-Gami-Token',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  };
}
function svc(extra){ return Object.assign({ 'apikey': SUPA_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPA_SERVICE_KEY, 'Content-Type': 'application/json' }, extra || {}); }
function svcMain(extra){ return Object.assign({ 'apikey': MAIN_KEY, 'Authorization': 'Bearer ' + MAIN_KEY, 'Content-Type': 'application/json' }, extra || {}); }

// Hierarquia: super > gestor > conferente > leitor
const NIVEL = { leitor: 1, conferente: 2, gestor: 3, super: 4 };
const PERM = {
  me: 'leitor', resumo: 'leitor', extrato: 'leitor', linha: 'leitor', alertas: 'leitor', contas: 'leitor',
  lancamentos: 'leitor', categorias: 'leitor', importacoes: 'leitor',
  conferir: 'conferente', importar_preview: 'conferente', importar_extrato: 'conferente', conciliar_manual: 'conferente',
  resolver_alerta: 'gestor', salvar_conta: 'gestor', config: 'gestor', salvar_config: 'gestor',
  benef_listar: 'gestor', benef_confiar: 'gestor', benef_revogar: 'gestor', auditoria: 'gestor',
  verificar_integridade: 'gestor', rodar_regras: 'gestor', importar_lancamentos: 'gestor',
  desfazer_conciliacao: 'gestor', exportar_csv: 'gestor', baixar_arquivo: 'gestor',
  acesso_listar: 'super', acesso_salvar: 'super'
};

// Categorias = plano de contas do Kamino (pra conferente classificar a linha)
const CATEGORIAS = [
  'Receita: cobrança semanal (restaurante)', 'Receita: outras', 'Receita: financeira (rendimento)',
  'Despesa: administrativa', 'Despesa: comercial / marketing', 'Despesa: operacional (motoboy/frota)',
  'Despesa: infraestrutura / sistemas', 'Despesa: pessoas (salário)', 'Despesa: pessoas (benefícios/encargos)',
  'Despesa: impostos', 'Despesa: tarifa bancária', 'Transferência entre contas Gâmi', 'Aporte de sócio',
  'Retirada / distribuição de lucro', 'Empréstimo / consórcio', 'Estorno / devolução', 'Não identificado'
];

class ErroUsuario extends Error { constructor(msg, status){ super(msg); this.status = status || 400; } }

async function rest(path, opts){ return restEm(SUPA_URL, svc, path, opts); }
async function restMain(path, opts){ return restEm(MAIN_URL, svcMain, path, opts); }
async function restEm(base, hdr, path, opts){
  const r = await fetch(base + '/rest/v1/' + path, Object.assign({ headers: hdr() }, opts || {}));
  const txt = await r.text();
  let j = null; try { j = txt ? JSON.parse(txt) : null; } catch(e){}
  if(!r.ok){
    let msg = (j && (j.message || j.hint)) || txt.slice(0, 200) || ('HTTP ' + r.status);
    if(/violates|syntax|constraint|relation |column |function |permission denied|duplicate key|out of range|null value|invalid input/i.test(msg)){
      console.error('[financeiro] erro do banco:', String(msg).slice(0, 300));
      msg = 'Dado inválido ou repetido: nada foi gravado. Confira os campos e tente de novo.';
    }
    throw new ErroUsuario(String(msg).replace(/^FINANCEIRO:\s*/, ''), r.status >= 500 ? 502 : 400);
  }
  return { data: j, headers: r.headers };
}
async function rpc(fn, args){ return (await rest('rpc/' + fn, { method: 'POST', body: JSON.stringify(args || {}) })).data; }
async function lerTodos(path, max){ return lerTodosEm(rest, svc, path, max); }
async function lerTodosMain(path, max){ return lerTodosEm(restMain, svcMain, path, max); }
async function lerTodosEm(fn, hdr, path, max){
  let out = [];
  for(let off = 0; off < (max || 20000); off += 1000){
    const { data } = await fn(path, { headers: hdr({ 'Range-Unit': 'items', 'Range': off + '-' + (off + 999) }) });
    if(!Array.isArray(data) || !data.length) break;
    out = out.concat(data);
    if(data.length < 1000) break;
  }
  return out;
}

// Filtros que vão pra URL do PostgREST: só o formato esperado passa
const reData = /^\d{4}-\d{2}-\d{2}$/;
const reUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function dataOk(v){ return typeof v === 'string' && reData.test(v) ? v : null; }
function uuidOk(v){ return typeof v === 'string' && reUuid.test(v) ? v : null; }
function intOk(v){ const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; }
function textoBusca(v){ return String(v || '').replace(/[^\p{L}\p{N} .\-\/]/gu, ' ').trim().slice(0, 60); }
function txt(v, max){ return String(v == null ? '' : v).trim().slice(0, max || 500); }
function hojeISO(){ return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); }

function csvCel(v){ const s = v == null ? '' : String(v); return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function moedaBR(n){ return n == null ? '' : Number(n).toFixed(2).replace('.', ','); }

// Monta o filtro do extrato (usado na lista e no export)
function filtroExtrato(b){
  const f = [];
  const conta = uuidOk(b.conta_id); if(conta) f.push('conta_id=eq.' + conta);
  const ini = dataOk(b.ini), fim = dataOk(b.fim);
  if(ini) f.push('data=gte.' + ini);
  if(fim) f.push('data=lte.' + fim);
  if(b.tipo === 'entrada') f.push('valor=gt.0');
  if(b.tipo === 'saida') f.push('valor=lt.0');
  const st = ['pendente', 'aguardando_2a', 'ok', 'divergente', 'suspeito', 'fraude'];
  if(b.status === 'abertos') f.push('status=in.(pendente,aguardando_2a,divergente,suspeito)');
  else if(st.indexOf(b.status) >= 0) f.push('status=eq.' + b.status);
  const q = textoBusca(b.q);
  if(q){
    const valorBusca = P.parseValor(q);
    const termos = ['descricao.ilike.*' + q + '*', 'contraparte.ilike.*' + q + '*'];
    if(valorBusca != null) termos.push('valor.eq.' + valorBusca, 'valor.eq.' + (-valorBusca));
    f.push('or=(' + termos.join(',') + ')');
  }
  if(b.com_alerta) f.push('alertas_abertos=gt.0');
  return f.join('&');
}

const ACOES = {
  async me(b, ctx){
    const acessos = await lerTodos('fin_acesso?ativo=eq.true&select=pessoa_id');
    const ids = acessos.map(a => a.pessoa_id).concat([ctx.pessoaId]);
    const nomes = await nomesPessoas(ids);
    return { papel: ctx.papel, pessoa_id: ctx.pessoaId, nomes, categorias: await categoriasDisponiveis() };
  },

  async resumo(b){
    const fim = dataOk(b.fim) || hojeISO();
    const ini = dataOk(b.ini) || (fim.slice(0, 8) + '01');
    const r = await rpc('fin_resumo', { p_ini: ini, p_fim: fim });
    return { ini, fim, resumo: r };
  },

  async contas(){ return { contas: await lerTodos('fin_contas?select=*&order=nome.asc') }; },

  async extrato(b){
    const pagina = Math.max(0, Math.min(500, Number(b.pagina) || 0)), tam = 100;
    const filtro = filtroExtrato(b);
    const { data, headers } = await rest('fin_v_extrato?select=*' + (filtro ? '&' + filtro : '') + '&order=data.desc,id.desc', {
      headers: svc({ 'Range-Unit': 'items', 'Range': (pagina * tam) + '-' + (pagina * tam + tam - 1), 'Prefer': 'count=exact' })
    });
    const total = Number(String(headers.get('content-range') || '').split('/')[1]) || 0;
    return { linhas: data || [], total, pagina, tam };
  },

  async linha(b){
    const id = intOk(b.id); if(!id) throw new ErroUsuario('id inválido');
    const [l] = (await rest('fin_v_extrato?id=eq.' + id + '&select=*')).data || [];
    if(!l) throw new ErroUsuario('Linha não encontrada', 404);
    const historico = (await rest('fin_conferencias?extrato_id=eq.' + id + '&select=*&order=id.asc')).data || [];
    const alertas = (await rest('fin_alertas?extrato_id=eq.' + id + '&select=*&order=id.desc')).data || [];
    let lancamento = null, candidatos = [];
    if(l.lancamento_id) lancamento = ((await rest('fin_lancamentos?id=eq.' + l.lancamento_id + '&select=*')).data || [])[0] || null;
    else {
      const tipo = l.valor < 0 ? 'pagar' : 'receber';
      const d0 = new Date(l.data + 'T12:00:00Z'), di = new Date(d0 - 10 * 864e5).toISOString().slice(0, 10), df = new Date(+d0 + 10 * 864e5).toISOString().slice(0, 10);
      candidatos = (await rest('fin_lancamentos?tipo=eq.' + tipo + '&valor=eq.' + Math.abs(l.valor) +
        '&and=(or(vencimento.gte.' + di + ',data_pagamento.gte.' + di + '),or(vencimento.lte.' + df + ',data_pagamento.lte.' + df + '))&select=*&limit=10')).data || [];
    }
    const imp = ((await rest('fin_importacoes?id=eq.' + l.importacao_id + '&select=id,arquivo_nome,formato,importado_por,importado_em')).data || [])[0] || null;
    return { linha: l, historico, alertas, lancamento, candidatos, importacao: imp };
  },

  async conferir(b, ctx){
    const id = intOk(b.extrato_id); if(!id) throw new ErroUsuario('Linha inválida');
    const status = ['ok', 'divergente', 'suspeito'].indexOf(b.status) >= 0 ? b.status : null;
    if(!status) throw new ErroUsuario('Escolha OK, Divergente ou Suspeito');
    const obs = txt(b.observacao, 1000);
    if(status !== 'ok' && obs.length < 10) throw new ErroUsuario('Explique o problema (mínimo 10 letras)');
    const categoria = b.categoria ? txt(b.categoria, 120) : null;
    if(categoria && (await categoriasDisponiveis()).indexOf(categoria) < 0) throw new ErroUsuario('Categoria inválida');
    const idem = txt(b.idem, 80) || null;
    const r = await rpc('fin_conferir', { p_ator: ctx.pessoaId, p_extrato: id, p_status: status, p_categoria: categoria,
      p_obs: obs || null, p_ref: txt(b.referencia, 200) || null, p_idem: idem });
    return r;
  },

  async alertas(b){
    const f = [];
    const st = ['aberto', 'resolvido', 'falso_positivo', 'fraude_confirmada'];
    if(b.status === 'fechados') f.push('status=neq.aberto');
    else f.push('status=eq.' + (st.indexOf(b.status) >= 0 ? b.status : 'aberto'));
    if(['critico', 'alto', 'medio', 'baixo'].indexOf(b.severidade) >= 0) f.push('severidade=eq.' + b.severidade);
    const conta = uuidOk(b.conta_id); if(conta) f.push('conta_id=eq.' + conta);
    const lista = await lerTodos('fin_alertas?select=*&' + f.join('&') + '&order=criado_em.desc', 3000);
    const ordem = { critico: 0, alto: 1, medio: 2, baixo: 3 };
    lista.sort((a, c) => (ordem[a.severidade] - ordem[c.severidade]) || (c.id - a.id));
    // anexa a linha do extrato pra mostrar sem 2ª chamada
    const ids = [...new Set(lista.map(a => a.extrato_id).filter(Boolean))].slice(0, 1500);
    let mapa = {};
    for(let i = 0; i < ids.length; i += 150){
      const pg = (await rest('fin_v_extrato?id=in.(' + ids.slice(i, i + 150).join(',') + ')&select=id,data,valor,descricao,contraparte,conta_nome,status')).data || [];
      pg.forEach(x => { mapa[x.id] = x; });
    }
    lista.forEach(a => { if(a.extrato_id) a.linha = mapa[a.extrato_id] || null; });
    return { alertas: lista };
  },

  async resolver_alerta(b, ctx){
    const id = intOk(b.id); if(!id) throw new ErroUsuario('Alerta inválido');
    if(['resolvido', 'falso_positivo', 'fraude_confirmada'].indexOf(b.status) < 0) throw new ErroUsuario('Escolha o desfecho');
    const just = txt(b.justificativa, 1000);
    if(just.length < 15) throw new ErroUsuario('Justificativa obrigatória (mínimo 15 letras): diga o que foi verificado');
    return rpc('fin_resolver_alerta', { p_ator: ctx.pessoaId, p_id: id, p_status: b.status, p_just: just, p_eh_super: ctx.papel === 'super' });
  },

  async importar_preview(b, ctx){ return importar(b, ctx, true); },
  async importar_extrato(b, ctx){ await sincronizarEquipe(); return importar(b, ctx, false); },

  async importar_lancamentos(b, ctx){
    const conteudo = validarArquivo(b);
    const tipo = b.tipo_lanc === 'receber' ? 'receber' : (b.tipo_lanc === 'pagar' ? 'pagar' : null);
    const res = P.parseLancamentos(conteudo, tipo);
    if(!res.ok) throw new ErroUsuario(res.erro);
    const resumo = { linhas: res.linhas.length, periodo_ini: res.periodo_ini, periodo_fim: res.periodo_fim,
      total_pagar: res.linhas.filter(l => l.tipo === 'pagar').reduce((a, l) => a + l.valor, 0),
      total_receber: res.linhas.filter(l => l.tipo === 'receber').reduce((a, l) => a + l.valor, 0),
      amostra: res.linhas.slice(0, 8).map(l => ({ tipo: l.tipo, pessoa: l.pessoa, valor: l.valor, vencimento: l.vencimento, data_pagamento: l.data_pagamento, situacao: l.situacao })) };
    if(!b.confirmar) return { preview: true, resumo };
    const r = await rpc('fin_importar_lancamentos', { p_ator: ctx.pessoaId,
      p_meta: { origem: 'kamino_csv', formato: 'csv', arquivo_nome: txt(b.arquivo_nome, 200), sha256: res.sha256, bytes: Buffer.byteLength(conteudo), conteudo,
                periodo_ini: res.periodo_ini, periodo_fim: res.periodo_fim },
      p_linhas: res.linhas });
    if(r && r.ok === false) throw new ErroUsuario(r.erro);
    return Object.assign({ resumo }, r);
  },

  async importacoes(b){
    const conta = uuidOk(b.conta_id);
    return { importacoes: await lerTodos('fin_importacoes?select=id,conta_id,tipo,formato,arquivo_nome,arquivo_sha256,periodo_ini,periodo_fim,saldo_final,saldo_data,qtd_linhas,qtd_novas,qtd_duplicadas,soma_creditos,soma_debitos,importado_por,importado_em' +
      (conta ? '&conta_id=eq.' + conta : '') + '&order=importado_em.desc', 2000) };
  },

  async baixar_arquivo(b){
    const id = uuidOk(b.id); if(!id) throw new ErroUsuario('Importação inválida');
    const [i] = (await rest('fin_importacoes?id=eq.' + id + '&select=arquivo_nome,conteudo,arquivo_sha256')).data || [];
    if(!i) throw new ErroUsuario('Não encontrada', 404);
    return i;
  },

  async lancamentos(b){
    const f = [];
    if(b.tipo === 'pagar' || b.tipo === 'receber') f.push('tipo=eq.' + b.tipo);
    const ini = dataOk(b.ini), fim = dataOk(b.fim);
    if(ini) f.push('vencimento=gte.' + ini);
    if(fim) f.push('vencimento=lte.' + fim);
    const lista = await lerTodos('fin_lancamentos?select=id,origem,tipo,pessoa,descricao,categoria,unidade,conta_nome,valor,vencimento,data_pagamento,situacao' + (f.length ? '&' + f.join('&') : '') + '&order=vencimento.desc', 5000);
    const conc = await lerTodos('fin_conciliacoes?ativo=eq.true&select=lancamento_id,extrato_id', 20000);
    const m = {}; conc.forEach(c => { m[c.lancamento_id] = c.extrato_id; });
    lista.forEach(l => { l.extrato_id = m[l.id] || null; });
    return { lancamentos: lista };
  },

  async conciliar_manual(b, ctx){
    const e = intOk(b.extrato_id), l = intOk(b.lancamento_id);
    if(!e || !l) throw new ErroUsuario('Dados inválidos');
    const r = await rpc('fin_conciliar_manual', { p_ator: ctx.pessoaId, p_extrato: e, p_lanc: l });
    if(r && r.ok === false) throw new ErroUsuario(r.erro);
    return r;
  },
  async desfazer_conciliacao(b, ctx){
    const e = intOk(b.extrato_id); if(!e) throw new ErroUsuario('Linha inválida');
    const motivo = txt(b.motivo, 500); if(motivo.length < 10) throw new ErroUsuario('Diga o motivo (mínimo 10 letras)');
    return rpc('fin_desfazer_conciliacao', { p_ator: ctx.pessoaId, p_extrato: e, p_motivo: motivo });
  },

  async categorias(){ return { categorias: await categoriasDisponiveis() }; },

  async salvar_conta(b, ctx){
    const nome = txt(b.nome, 80); if(nome.length < 3) throw new ErroUsuario('Nome da conta obrigatório');
    const id = b.id ? uuidOk(b.id) : null; if(b.id && !id) throw new ErroUsuario('Conta inválida');
    return rpc('fin_salvar_conta', { p_ator: ctx.pessoaId, p_id: id, p_dados: {
      nome, banco: txt(b.banco, 60), agencia: txt(b.agencia, 20), numero: txt(b.numero, 30),
      cidade_slug: txt(b.cidade_slug, 60), unidade: txt(b.unidade, 80), ativo: b.ativo === false ? false : true } });
  },

  async config(){ return { config: await lerTodos('fin_config?select=*&order=chave.asc') }; },
  async salvar_config(b, ctx){
    const chave = txt(b.chave, 60);
    let valor = b.valor;
    if(chave === 'exigir_lastro') valor = valor === true || valor === 'true';
    else {
      if(valor === '' || valor == null) throw new ErroUsuario('Preencha o valor');
      valor = typeof valor === 'number' ? valor : Number(String(valor).trim().replace(/\./g, '').replace(',', '.'));
      if(!isFinite(valor) || valor < 0 || valor > 1e7) throw new ErroUsuario('Valor inválido');
    }
    return rpc('fin_salvar_config', { p_ator: ctx.pessoaId, p_chave: chave, p_valor: valor });
  },

  async benef_listar(){ return { benef: await lerTodos('fin_benef_confiaveis?select=*&order=aprovado_em.desc') }; },
  async benef_confiar(b, ctx){
    const nome = txt(b.nome, 120), motivo = txt(b.motivo, 500);
    if(motivo.length < 10) throw new ErroUsuario('Motivo obrigatório (mínimo 10 letras): por que é confiável?');
    const r = await rpc('fin_benef_confiar', { p_ator: ctx.pessoaId, p_nome: nome, p_motivo: motivo });
    if(r && r.ok === false) throw new ErroUsuario(r.erro);
    return r;
  },
  async benef_revogar(b, ctx){
    const id = intOk(b.id); if(!id) throw new ErroUsuario('Inválido');
    return rpc('fin_benef_revogar', { p_ator: ctx.pessoaId, p_id: id });
  },

  async auditoria(b){
    const pagina = Math.max(0, Number(b.pagina) || 0);
    const f = [];
    if(b.ator) f.push('ator=eq.' + encodeURIComponent(txt(b.ator, 60)));
    if(b.tabela && /^fin_[a-z_]+$/.test(b.tabela) && b.tabela.indexOf('fin_flyp') !== 0) f.push('tabela=eq.' + b.tabela);
    f.push('tabela=not.like.fin_flyp*');   // FLYP tem trava própria: nunca aparece na auditoria geral
    const { data, headers } = await rest('fin_auditoria?select=seq,ts,ator,acao,tabela,registro_id,antes,depois,hash' + (f.length ? '&' + f.join('&') : '') + '&order=seq.desc', {
      headers: svc({ 'Range-Unit': 'items', 'Range': (pagina * 100) + '-' + (pagina * 100 + 99), 'Prefer': 'count=exact' })
    });
    return { registros: data || [], total: Number(String(headers.get('content-range') || '').split('/')[1]) || 0, pagina };
  },
  async verificar_integridade(){ return { integridade: await rpc('fin_verificar_cadeia', {}) }; },
  async rodar_regras(b, ctx){
    await sincronizarEquipe();
    try { return { novos: await rpc('fin_rodar_regras_todas', { p_ator: ctx.pessoaId }) }; }
    catch(e){ return { novos: await rpc('fin_rodar_regras', { p_ator: ctx.pessoaId }) }; }   // banco ainda sem a v2
  },

  async exportar_csv(b){
    const filtro = filtroExtrato(b);
    const linhas = await lerTodos('fin_v_extrato?select=*' + (filtro ? '&' + filtro : '') + '&order=data.asc,id.asc', 50000);
    const cab = ['ID', 'Conta', 'Data', 'Tipo', 'Valor', 'Descrição', 'Favorecido/Pagador', 'Documento', 'Status', 'Conferências', 'Categoria', 'Alertas abertos'];
    const out = [cab.join(';')];
    linhas.forEach(l => out.push([l.id, l.conta_nome, l.data, l.tipo, moedaBR(l.valor), l.descricao, l.contraparte, l.documento, l.status,
      (l.confs || []).map(c => c.por + ':' + c.status).join(' | '), l.categoria, l.alertas_abertos].map(csvCel).join(';')));
    return { csv: '﻿' + out.join('\r\n'), qtd: linhas.length };
  },

  async acesso_listar(){
    const acessos = await lerTodos('fin_acesso?select=*&order=criado_em.asc');
    const pessoas = await lerTodosMain('pessoas?select=id,nome,cargo,email&order=nome.asc', 3000);
    return { acessos, pessoas: pessoas.map(p => ({ id: p.id, nome: p.nome, cargo: p.cargo })) };
  },
  async acesso_salvar(b, ctx){
    const pid = txt(b.pessoa_id, 80); if(!/^[A-Za-z0-9_\-]{2,80}$/.test(pid)) throw new ErroUsuario('Pessoa inválida');
    if(['gestor', 'conferente', 'leitor'].indexOf(b.papel) < 0) throw new ErroUsuario('Papel inválido');
    const existe = (await restMain('pessoas?id=eq.' + encodeURIComponent(pid) + '&select=id&limit=1')).data || [];
    if(!existe.length) throw new ErroUsuario('Pessoa não encontrada');
    return rpc('fin_salvar_acesso', { p_ator: ctx.pessoaId, p_pessoa: pid, p_papel: b.papel, p_ativo: b.ativo !== false });
  }
};

// Copia só os NOMES da equipe (pessoas do dashboard) pro banco do financeiro, pra regra
// "pagamento pra alguém da equipe". Falha aqui não impede a importação (a regra só fica desatualizada).
async function sincronizarEquipe(){
  try {
    const p = await lerTodosMain('pessoas?select=id,nome', 5000);
    if(p.length) await rpc('fin_sincronizar_equipe', { p_lista: p.filter(x => x.id && x.nome).map(x => ({ id: String(x.id), nome: String(x.nome) })) });
  } catch(e){ console.error('[financeiro] sincronizarEquipe', e.message); }
}

// Categorias da conferência = plano de contas (fin_classificacoes, v2). Sem a v2 rodada, cai na lista fixa.
async function categoriasDisponiveis(){
  try {
    const cl = await lerTodos('fin_classificacoes?ativo=eq.true&select=nome,grupo&order=ordem.asc,nome.asc');
    if(cl.length) return [...new Set(cl.map(c => c.nome))].concat(['Não identificado']);
  } catch(e){}
  return CATEGORIAS;
}

// ---------- v2: réplica do Kamino (Pagar, Receber, Contas, Relatórios, Cadastros)
// (se o arquivo da v2 não estiver no deploy, a v1 continua funcionando sozinha)
let V2 = null;
try { V2 = require('../lib/fin-acoes-v2')({ rest, rpc, lerTodos, ErroUsuario, svc, txt, dataOk, uuidOk, intOk, textoBusca, P, SUPA_URL }); }
catch(e){ console.error('[financeiro] v2 indisponível:', e.message); }
if(V2){
  Object.keys(V2.acoes).forEach(k => { if(ACOES[k]) throw new Error('Ação duplicada: ' + k); ACOES[k] = V2.acoes[k]; PERM[k] = V2.perm[k]; });
  Object.keys(V2.acoes).forEach(k => { if(!PERM[k]) throw new Error('Ação sem permissão definida: ' + k); });
}

// ---------- v4: CONTROLES (planilhas das meninas: Empresas semanal, Créditos)
let CTL = null;
try { CTL = require('../lib/fin-acoes-ctl')({ rest, rpc, ErroUsuario, txt, dataOk, intOk, textoBusca, svc, NIVEL, P }); }
catch(e){ console.error('[financeiro] controles indisponível:', e.message); }
if(CTL){
  Object.keys(CTL.acoes).forEach(k => { if(ACOES[k]) throw new Error('Ação duplicada: ' + k); if(!CTL.perm[k]) throw new Error('Ação sem permissão: ' + k); ACOES[k] = CTL.acoes[k]; PERM[k] = CTL.perm[k]; });
}

// ---------- v3: dados da FLYP (ZL Hub). Trava própria dentro do módulo (fin_flyp_acesso).
let FLYP = null;
try { FLYP = require('../lib/fin-acoes-flyp')({ rpc, lerTodos, ErroUsuario, txt, dataOk, P }); }
catch(e){ console.error('[financeiro] flyp indisponível:', e.message); }
if(FLYP){
  Object.keys(FLYP.acoes).forEach(k => { if(ACOES[k]) throw new Error('Ação duplicada: ' + k); if(!FLYP.perm[k]) throw new Error('Ação sem permissão: ' + k); ACOES[k] = FLYP.acoes[k]; PERM[k] = FLYP.perm[k]; });
}

async function nomesPessoas(ids){
  const uniq = [...new Set(ids.filter(x => x && /^[A-Za-z0-9_\-]+$/.test(x)))];
  if(!uniq.length) return {};
  const lista = (await restMain('pessoas?id=in.(' + uniq.map(encodeURIComponent).join(',') + ')&select=id,nome')).data || [];
  const m = {}; lista.forEach(p => { m[p.id] = p.nome; });
  return m;
}

function validarArquivo(b){
  const conteudo = typeof b.conteudo === 'string' ? b.conteudo : '';
  if(!conteudo) throw new ErroUsuario('Arquivo vazio');
  if(Buffer.byteLength(conteudo) > MAX_ARQUIVO) throw new ErroUsuario('Arquivo grande demais (máx. 4 MB). Exporte um período menor.');
  return conteudo;
}

async function importar(b, ctx, soPreview){
  const conta = uuidOk(b.conta_id); if(!conta) throw new ErroUsuario('Escolha a conta bancária');
  const conteudo = validarArquivo(b);
  const [c] = (await rest('fin_contas?id=eq.' + conta + '&select=*')).data || [];
  if(!c || !c.ativo) throw new ErroUsuario('Conta inválida ou inativa');
  const res = P.parseExtrato(conteudo, b.arquivo_nome);
  if(!res.ok) throw new ErroUsuario(res.erro);

  const avisos = [];
  if(c.formato && c.formato !== res.formato) avisos.push('Esta conta sempre foi importada em ' + c.formato.toUpperCase() + ' e este arquivo é ' + res.formato.toUpperCase() + '. Use o mesmo formato pra não duplicar linhas.');
  if(res.conta_banco && res.conta_banco.numero && c.numero){
    const a = String(res.conta_banco.numero).replace(/\D/g, ''), z = String(c.numero).replace(/\D/g, '');
    if(a && z && a.indexOf(z) < 0 && z.indexOf(a) < 0) avisos.push('ATENÇÃO: o arquivo é da conta ' + res.conta_banco.numero + ', mas você escolheu ' + c.nome + ' (' + c.numero + ').');
  }
  if(res.saldo_final == null) avisos.push('O arquivo não traz o saldo final: a checagem de "saldo que não fecha" não roda pra este período. Prefira OFX.');
  if(res.periodo_fim > hojeISO()) avisos.push('Período termina no futuro: confira o arquivo.');

  // quantas linhas já existem (dedup) — checagem real é no banco, isto é só pra mostrar antes
  const hashes = res.linhas.map(l => l.hash);
  let existentes = 0;
  for(let i = 0; i < hashes.length; i += 100){
    const pg = (await rest('fin_extrato?conta_id=eq.' + conta + '&hash=in.(' + hashes.slice(i, i + 100).join(',') + ')&select=hash')).data || [];
    existentes += pg.length;
  }
  const jaImportado = ((await rest('fin_importacoes?conta_id=eq.' + conta + '&tipo=eq.extrato&arquivo_sha256=eq.' + res.sha256 + '&select=id,importado_por,importado_em')).data || [])[0] || null;
  const resumo = {
    formato: res.formato, linhas: res.linhas.length, novas: res.linhas.length - existentes, duplicadas: existentes,
    periodo_ini: res.periodo_ini, periodo_fim: res.periodo_fim, saldo_final: res.saldo_final, saldo_data: res.saldo_data,
    soma_creditos: res.soma_creditos, soma_debitos: res.soma_debitos, avisos, ja_importado: jaImportado,
    amostra: res.linhas.slice(0, 8).map(l => ({ data: l.data, valor: l.valor, descricao: l.descricao, contraparte: l.contraparte }))
  };
  if(soPreview) return { preview: true, resumo };
  if(jaImportado) throw new ErroUsuario('Este arquivo já foi importado nesta conta.');
  if(c.formato && c.formato !== res.formato && b.forcar_formato !== true) throw new ErroUsuario(avisos[0]);

  const r = await rpc('fin_importar_extrato', {
    p_ator: ctx.pessoaId, p_conta: conta,
    p_meta: { formato: res.formato, arquivo_nome: txt(b.arquivo_nome, 200), sha256: res.sha256, bytes: Buffer.byteLength(conteudo), conteudo,
              periodo_ini: res.periodo_ini, periodo_fim: res.periodo_fim, saldo_final: res.saldo_final, saldo_data: res.saldo_data,
              forcar_formato: ctx.papel === 'super' || ctx.papel === 'gestor' ? b.forcar_formato === true : false },
    p_linhas: res.linhas.map(l => ({ data: l.data, valor: l.valor, descricao: l.descricao, documento: l.documento, contraparte: l.contraparte,
      contraparte_doc: l.contraparte_doc, fitid: l.fitid, tipo_banco: l.tipo_banco, hash: l.hash }))
  });
  if(r && r.ok === false) throw new ErroUsuario(r.erro);
  return Object.assign({ resumo }, r);
}

async function autenticar(event){
  const pessoaId = event.headers['x-gami-user'] || event.headers['X-Gami-User'] || '';
  const token = event.headers['x-gami-token'] || event.headers['X-Gami-Token'] || '';
  if(!pessoaId || !token) throw new ErroUsuario('Sessão não informada', 401);
  if(!/^[A-Za-z0-9_\-]{2,80}$/.test(pessoaId)) throw new ErroUsuario('Sessão inválida', 401);
  const arr = (await restMain('usuarios_login?pessoa_id=eq.' + encodeURIComponent(pessoaId) + '&select=*&limit=1')).data;
  if(!Array.isArray(arr) || !arr.length) throw new ErroUsuario('Sessão não encontrada', 401);
  const u = arr[0];
  if(u.ativo === false) throw new ErroUsuario('Usuário desativado', 403);
  // mesma regra do supabase-write.js: token principal OU qualquer sessão ativa não expirada (notebook + celular)
  const agora = new Date();
  const ok = (u.token_atual && u.token_atual === token && (!u.token_expira_em || new Date(u.token_expira_em) >= agora)) ||
    (Array.isArray(u.sessoes_ativas) && u.sessoes_ativas.some(s => s && s.t === token && (!s.e || new Date(s.e) >= agora)));
  if(!ok) throw new ErroUsuario('Sessão inválida ou expirada (faça login de novo)', 401);
  let papel = null;
  if(String(u.email || '').toLowerCase() === SUPER_ADMIN_EMAIL && u.pessoa_id === SUPER_ADMIN_PESSOA) papel = 'super';
  else {
    const a = (await rest('fin_acesso?pessoa_id=eq.' + encodeURIComponent(pessoaId) + '&ativo=eq.true&select=papel&limit=1')).data || [];
    if(a.length) papel = a[0].papel;
  }
  return { pessoaId, papel };
}

exports.handler = async function(event){
  const origin = event.headers.origin || event.headers.Origin || '';
  const cors = corsHeaders(origin);
  const resp = (status, obj) => ({ statusCode: status, headers: cors, body: JSON.stringify(obj) });
  if(event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if(event.httpMethod !== 'POST') return resp(405, { ok: false, erro: 'Use POST' });
  if(!MAIN_KEY) return resp(500, { ok: false, erro: 'Servidor sem SUPA_SERVICE_KEY' });
  if(!SUPA_SERVICE_KEY) return resp(500, { ok: false, erro: 'Banco do financeiro configurado sem FIN_SUPA_SERVICE_KEY' });

  let b;
  try { b = JSON.parse(event.body || '{}'); } catch(e){ return resp(400, { ok: false, erro: 'JSON inválido' }); }
  const acao = String(b.acao || 'me');
  if(!Object.prototype.hasOwnProperty.call(ACOES, acao)) return resp(400, { ok: false, erro: 'Ação desconhecida' });

  try {
    const ctx = await autenticar(event);
    if(!ctx.papel) return resp(403, { ok: false, erro: 'Sem acesso ao financeiro', sem_acesso: true });
    if(NIVEL[ctx.papel] < NIVEL[PERM[acao]]) return resp(403, { ok: false, erro: 'Seu papel (' + ctx.papel + ') não permite esta ação' });
    const out = await ACOES[acao](b, ctx);
    return resp(200, Object.assign({ ok: true }, out));
  } catch(err){
    const status = err instanceof ErroUsuario ? err.status : 500;
    if(!(err instanceof ErroUsuario)) console.error('[financeiro]', acao, err);
    return resp(status, { ok: false, erro: err instanceof ErroUsuario ? err.message : 'Erro interno. Nada foi gravado pela metade (tudo é transação).' });
  }
};
