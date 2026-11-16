// netlify/lib/kamino-api.js
// -----------------------------------------------------------------------------
// Conversa com a API do Kamino (SÓ LEITURA) e traduz pro formato do espelho do financeiro.
// Usado por: functions/kamino.js (testes do dono) e functions/kamino-sync.js (automático).
//
// Credenciais: env KAMINO_API_JSON {"url","app","cn","idusr","usr","hash"} (usuário só leitura).
// Elas nunca saem daqui: mensagens de erro passam por limpeza.
//
// Privacidade: chave Pix e conta de destino NÃO vão pro banco por extenso, só a impressão
// digital (sha256) + o final mascarado. CPF/CNPJ vai mascarado (e com impressão digital pra
// comparar troca de documento).
// -----------------------------------------------------------------------------
'use strict';
const crypto = require('crypto');

function credenciais() {
  const bruto = process.env.KAMINO_API_JSON || '';
  if (!bruto.trim()) return { erro: 'KAMINO_API_JSON não está configurada no Netlify (ou falta o redeploy).' };
  let j;
  try { j = JSON.parse(bruto); } catch (e) { return { erro: 'KAMINO_API_JSON não é um JSON válido (confira aspas e chaves).' }; }
  const faltam = ['url', 'app', 'cn', 'idusr', 'usr', 'hash'].filter((k) => !String((j && j[k]) || '').trim());
  if (faltam.length) return { erro: 'Faltam campos em KAMINO_API_JSON: ' + faltam.join(', ') };
  let host = '';
  try {
    const u = new URL(String(j.url).trim());
    if (u.protocol !== 'https:') return { erro: 'O "url" do Kamino precisa começar com https://' };
    host = u.host.toLowerCase();
  } catch (e) { return { erro: 'O "url" do Kamino não é um endereço válido.' }; }
  if (!/(^|\.)kamino\.(tech|pro|com\.br)$/.test(host)) return { erro: 'O "url" não é um endereço do Kamino (esperado ...kamino.tech).' };
  return {
    cred: {
      base: String(j.url).trim().replace(/\/+$/, ''),
      headers: { Accept: 'application/json', App: String(j.app).trim(), CN: String(j.cn).trim(), IDUsr: String(j.idusr).trim(), Usr: String(j.usr).trim(), Hash: String(j.hash).trim() },
    },
  };
}

function limpar(cred, m) {
  m = String(m || '').slice(0, 400);
  for (const v of Object.values(cred.headers)) { if (v && v.length >= 6) m = m.split(v).join('[oculto]'); }
  return m.slice(0, 240);
}
function mensagemErro(cred, corpo, trecho) {
  let m = '';
  if (corpo && typeof corpo === 'object') {
    m = corpo.Mensagem || corpo.mensagem || corpo.Message || corpo.message || corpo.title || corpo.Erro || corpo.erro || '';
    if (!m && Array.isArray(corpo.Erros)) m = corpo.Erros.join('; ');
    if (!m && corpo.errors) m = JSON.stringify(corpo.errors);
    if (!m) m = JSON.stringify(corpo);
  } else m = trecho || '';
  return limpar(cred, m);
}

async function get(cred, caminho, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 9000);
  try {
    const r = await fetch(cred.base + caminho, { headers: cred.headers, signal: ctrl.signal });
    const txt = await r.text();
    let corpo = null;
    try { corpo = JSON.parse(txt); } catch (e) { corpo = null; }
    return { status: r.status, corpo, trecho: corpo ? null : txt.slice(0, 160) };
  } finally { clearTimeout(t); }
}

// Lista que vem direto ou dentro de "Dados"
function listaDe(corpo) {
  if (Array.isArray(corpo)) return corpo;
  if (!corpo) return [];
  for (const k of ['Dados', 'dados', 'Lista', 'lista', 'Itens']) if (Array.isArray(corpo[k])) return corpo[k];
  return [];
}

// ---------------- tradução ----------------
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const str = (v) => {
  if (v == null) return null;
  if (typeof v === 'object') return str(v.Nome || v.NomeExibicao || v.Descricao || v.nome || null);
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 300) : null;
};
const num = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};
const data = (v) => {
  if (!v) return null;
  const s = String(v);
  let m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? m[3] + '-' + m[2] + '-' + m[1] : null;
};
const dataHora = (v) => (v ? String(v).slice(0, 19) : null);
const digitos = (v) => String(v == null ? '' : v).replace(/\D/g, '');
function mascaraDoc(v) {
  const d = digitos(v);
  if (!d) return null;
  if (d.length === 11) return '•••.' + d.slice(3, 6) + '.' + d.slice(6, 9) + '-••';
  if (d.length === 14) return '••.' + d.slice(2, 5) + '.' + d.slice(5, 8) + '/' + d.slice(8, 12) + '-••';
  return '•••' + d.slice(-3);
}
function normPix(chave) {
  const c = String(chave || '').trim().toLowerCase();
  if (!c) return '';
  if (c.indexOf('@') > 0) return c;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(c)) return c; // chave aleatória
  const d = digitos(c);
  return d || c;
}
function finalPix(chave) {
  const c = normPix(chave);
  if (!c) return null;
  if (c.indexOf('@') > 0) return c[0] + '•••@' + c.split('@')[1];
  return '•••' + c.slice(-4);
}
const ordenar = (o) => {
  const out = {};
  Object.keys(o).sort().forEach((k) => { if (o[k] !== null && o[k] !== undefined && o[k] !== '') out[k] = o[k]; });
  return out;
};

// Para onde o dinheiro foi (pagamento): Pix > conta bancária. Boleto não tem destino (vai pro emissor).
function destinoPagamento(x) {
  const pix = normPix(x.ChavePixPessoa);
  if (pix) return { hash: sha('PIX:' + pix), desc: 'Pix ' + (str(x.NomeTipoChavePix) || '') + ' ' + finalPix(x.ChavePixPessoa) };
  const conta = digitos(x.ContaCorrentePessoa || x.ContaCorrentePessoaSemDigito) + digitos(x.DigitoContaCorrentePessoa);
  const ag = digitos(x.AgenciaPessoa);
  const banco = digitos(x.CodigoBancoPessoa);
  if (conta && conta.length >= 3) return { hash: sha('CC:' + banco + ':' + ag + ':' + conta), desc: 'Conta ' + (str(x.NomeBancoPessoa) || banco || '') + ' ag ' + (ag || '?') + ' c/c •••' + conta.slice(-3) };
  const contaPix = digitos(x.NumeroContaPix);
  if (contaPix && contaPix.length >= 3) return { hash: sha('CP:' + str(x.NomeBancoPix) + ':' + digitos(x.NumeroAgenciaPix) + ':' + contaPix), desc: 'Conta ' + (str(x.NomeBancoPix) || '') + ' •••' + contaPix.slice(-3) };
  return { hash: null, desc: null };
}

function itemDe(dados, camposConf) {
  const d = ordenar(dados);
  const conf = camposConf.map((k) => (d[k] === undefined ? null : d[k]));
  return { hash: sha(JSON.stringify(d)), hash_conf: sha(JSON.stringify(conf)), dados: d };
}
const CONF = ['valor', 'valor_pago', 'pessoa', 'pessoa_kmn_id', 'destino_hash', 'conta', 'data_pagamento', 'forma'];

function mapPagamento(x) {
  if (!x || !Number.isFinite(Number(x.ID))) return null;
  const p = x.Pessoa && typeof x.Pessoa === 'object' ? x.Pessoa : {};
  const dest = destinoPagamento(x);
  const dados = {
    descricao: str(x.Descricao), obs: str(x.Obs),
    pessoa: str(x.NomePessoa) || str(p.NomeExibicao) || str(p.Nome),
    pessoa_kmn_id: Number(x.IDPessoa) || null,
    pessoa_doc: mascaraDoc(x.CPFCNPJPessoa || p.CPFCNPJ),
    valor: num(x.ValorVencimento), valor_bruto: num(x.ValorBruto), valor_pago: num(x.ValorPagamento),
    juros: num(x.VlrJuros), desconto: num(x.VlrDesc), taxa: num(x.VlrTaxa),
    vencimento: data(x.DataVencimento || x._DataVencimento), competencia: data(x.DataCompetencia || x._DataCompetencia),
    data_pagamento: data(x.DataPagamento || x._DataPagamento), agendado: data(x.DataAgendaPagamento),
    situacao: str(x.DescricaoSituacao), situacao_cod: Number(x.Situacao) || null,
    classificacao: str(x.ContaClassificacao) || str(x.NomeContaClassificacao),
    centro_custo: str(x.NomeCentroCusto) || str(x.CentroCusto), unidade: str(x.NomeUnidadeNegocio) || str(x.UnidadeNegocio),
    conta: str(x.ContaPagamento) || str(x.NomeContaPagamento),
    forma: str(x.DescricaoFormaPagamento), nf: str(x.NroNotaFiscal), boleto: x.NroBoleto ? true : null,
    destino_hash: dest.hash, destino_desc: dest.desc ? dest.desc.replace(/\s+/g, ' ').trim() : null,
    anexos: x.PossuiAnexos === true, conciliado: !!(x.IDConciliacaoBancaria || x.IDExtratoBanco),
    enviado_banco: x.EnviadoAoBanco === true,
    incluido_por: str(x.UsuarioInclusao), incluido_em: dataHora(x.DataHoraInclusao),
    situacao_em: dataHora(x.DataHoraSituacao), codigo_externo: str(x.CodigoExterno),
  };
  return Object.assign({ kamino_id: Number(x.ID) }, itemDe(dados, CONF));
}

function mapRecebimento(x) {
  if (!x || !Number.isFinite(Number(x.ID))) return null;
  const p = x.Pessoa && typeof x.Pessoa === 'object' ? x.Pessoa : {};
  const dados = {
    descricao: str(x.Descri), obs: str(x.Obs),
    pessoa: str(x.NomePessoa) || str(p.NomeExibicao) || str(p.Nome),
    pessoa_kmn_id: Number(x.IDPessoa) || null,
    pessoa_doc: mascaraDoc(x.CPFCNPJ || p.CPFCNPJ),
    valor: num(x.VlrVenc), valor_bruto: num(x.VlrBruto), valor_pago: num(x.VlrPagto),
    desconto: num(x.VlrDescReceb != null ? x.VlrDescReceb : x.VlrDesc), juros: num(x.VlrJuros), taxa: num(x.VlrTaxa),
    vencimento: data(x.DtaVenc), competencia: data(x.DtaCompet), data_pagamento: data(x.DtaPagto),
    situacao: str(x.DescricaoSituacao), situacao_cod: Number(x.SitConta) || null,
    classificacao: str(x.NomeContaOrigem), centro_custo: str(x.NomeCentroCusto), unidade: str(x.NomeUnidadeNegocio),
    conta: str(x.NomeContaDestino) || str(x.ContaPagamento) || str(x.contaBancoRecebimento),
    forma: str(x.NomeTipoReceb), nf: str(x.NroNFSe) || str(x.NroNFe),
    conciliado: !!(x.IDConciliacaoBancaria || x.IDExtratoBanco),
    incluido_por_id: Number(x.IDUsuarioInclusao) || null, incluido_em: dataHora(x.DataHoraInclusao),
    codigo_externo: str(x.CodigoExterno),
  };
  return Object.assign({ kamino_id: Number(x.ID) }, itemDe(dados, CONF));
}

function mapPessoa(x) {
  if (!x || !Number.isFinite(Number(x.ID))) return null;
  const doc = digitos(x.CPFCNPJ);
  const pix = normPix(x.ChavePix);
  const it = {
    kamino_id: Number(x.ID),
    nome: str(x.NomeExibicao) || str(x.Nome),
    doc: doc ? sha('DOC:' + doc) : null,
    pix_tipo: str(x.TipoChavePix),
    pix_hash: pix ? sha('PIX:' + pix) : null,
    pix_final: pix ? finalPix(x.ChavePix) : null,
    ativo: x.Ativo !== false,
  };
  it.hash = sha(JSON.stringify([it.nome, it.doc, it.pix_tipo, it.pix_hash, it.ativo]));
  return it;
}

module.exports = { credenciais, mensagemErro, limpar, get, listaDe, mapPagamento, mapRecebimento, mapPessoa, sha };
