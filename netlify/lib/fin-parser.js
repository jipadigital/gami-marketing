// netlify/lib/fin-parser.js
// Leitura de EXTRATO bancário (OFX ou CSV) e de LANÇAMENTOS (CSV exportado do Kamino).
// Roda no SERVIDOR (financeiro.js). Regra de ouro: na dúvida, RECUSA o arquivo
// (melhor erro claro do que número errado entrando no financeiro).
// ============================================================
'use strict';
const crypto = require('crypto');

function sha256(s){ return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }

function semAcento(s){ return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, ''); }
function norm(s){ return semAcento(s).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }

// "1.234,56" | "-1.234,56" | "R$ 1.234,56" | "(1.234,56)" | "1234.56" | "1,234.56" | "1234,5" -> number (centavos exatos)
function parseValor(v){
  if(v == null) return null;
  if(typeof v === 'number') return isFinite(v) ? Math.round(v * 100) / 100 : null;
  let s = String(v).trim();
  if(!s) return null;
  let neg = false;
  if(/^\(.*\)$/.test(s)){ neg = true; s = s.slice(1, -1); }
  s = s.replace(/R\$|BRL|\s/gi, '');
  if(/^-/.test(s)){ neg = !neg; s = s.slice(1); }
  if(/-$/.test(s)){ neg = !neg; s = s.slice(0, -1); }       // "123,45-" (alguns bancos)
  if(/^\+/.test(s)) s = s.slice(1);
  if(/[DC]$/i.test(s)){ if(/D$/i.test(s)) neg = !neg; s = s.slice(0, -1); }  // "123,45D"
  if(!/^[\d.,]+$/.test(s)) return null;
  const ultVirg = s.lastIndexOf(','), ultPonto = s.lastIndexOf('.');
  if(ultVirg >= 0 && ultPonto >= 0){
    if(ultVirg > ultPonto) s = s.replace(/\./g, '').replace(',', '.');   // 1.234,56
    else s = s.replace(/,/g, '');                                        // 1,234.56
  } else if(ultVirg >= 0){
    const dec = s.length - ultVirg - 1;
    if((s.match(/,/g) || []).length > 1 || dec === 3) return null;       // ambíguo -> recusa
    s = s.replace(',', '.');
  } else if(ultPonto >= 0){
    const partes = s.split('.');
    if(partes.length > 2){ if(partes.slice(1).every(p => p.length === 3)) s = s.replace(/\./g, ''); else return null; }
    else if(partes[1].length === 3) return null;                          // "1.234" ambíguo -> recusa
  }
  const n = Number(s);
  if(!isFinite(n)) return null;
  return Math.round((neg ? -n : n) * 100) / 100;
}

function pad(n){ return String(n).padStart(2, '0'); }
function dataValida(y, m, d){
  if(y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if(dt.getUTCMonth() !== m - 1) return null;
  return y + '-' + pad(m) + '-' + pad(d);
}
// dd/mm/aaaa | dd/mm/aa | aaaa-mm-dd | aaaammdd (OFX) | com hora opcional
function parseData(v){
  if(v == null) return null;
  if(typeof v === 'number' && v > 20000 && v < 80000){   // serial do Excel
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return dataValida(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  const s = String(v).trim();
  let m;
  if((m = s.match(/^(\d{4})(\d{2})(\d{2})/))) return dataValida(+m[1], +m[2], +m[3]);
  if((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return dataValida(+m[1], +m[2], +m[3]);
  if((m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/))) return dataValida(+m[3], +m[2], +m[1]);
  if((m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2})(?!\d)/))) return dataValida(2000 + +m[3], +m[2], +m[1]);
  return null;
}

// CPF/CNPJ (inclusive mascarado tipo ***.123.456-**)
function extrairDoc(s){
  const t = String(s || '');
  let m = t.match(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/);           // CNPJ
  if(m) return m[0].replace(/\D/g, '');
  m = t.match(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/) || t.match(/[*\d]{3}\.[*\d]{3}\.[*\d]{3}-[*\d]{2}/);
  return m ? m[0] : null;
}

// Tira o "Pix enviado", "TED para" etc e fica só com quem recebeu/pagou
const PREFIXOS = [
  'PIX ENVIADO PARA', 'PIX ENVIADO', 'PIX RECEBIDO DE', 'PIX RECEBIDO', 'PIX EMITIDO', 'PIX TRANSF', 'PIX QR CODE', 'PIX',
  'TRANSFERENCIA ENVIADA PARA', 'TRANSFERENCIA ENVIADA', 'TRANSFERENCIA RECEBIDA DE', 'TRANSFERENCIA RECEBIDA', 'TRANSFERENCIA',
  'TED ENVIADA', 'TED RECEBIDA', 'TED PARA', 'TED DE', 'TED', 'DOC ENVIADO', 'DOC RECEBIDO', 'DOC',
  'PAGAMENTO DE BOLETO', 'PAGAMENTO BOLETO', 'PAGTO BOLETO', 'BOLETO PAGO', 'PAGAMENTO', 'PAGTO', 'PGTO',
  'ENVIO', 'RECEBIMENTO', 'TRANSF', 'DEBITO', 'CREDITO'
];
function extrairContraparte(desc, nome){
  let base = (nome && String(nome).trim()) ? String(nome) : String(desc || '');
  base = base.replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, ' ').replace(/[*\d]{3}\.[*\d]{3}\.[*\d]{3}-[*\d]{2}/g, ' ');
  let n = norm(base);
  let mudou = true;
  while(mudou){
    mudou = false;
    for(const p of PREFIXOS){
      if(n === p){ n = ''; mudou = true; break; }
      if(n.indexOf(p + ' ') === 0){ n = n.slice(p.length + 1).trim(); mudou = true; break; }
    }
    n = n.replace(/^(PARA|DE|A|AO|DA|DO)\s+/, '');
  }
  n = n.replace(/\b\d{5,}\b/g, ' ').replace(/\s+/g, ' ').trim();     // ids/números longos
  return n.length >= 3 ? n : null;
}

// Hash da linha: conteúdo + nº da ocorrência daquele mesmo conteúdo no arquivo.
// Assim, extratos com período sobreposto não duplicam, e 2 tarifas iguais no mesmo dia continuam sendo 2.
function atribuirHashes(linhas){
  const cont = {};
  for(const l of linhas){
    const base = [l.data, l.valor.toFixed(2), norm(l.descricao), norm(l.documento || '')].join('|');
    const n = cont[base] = (cont[base] || 0) + 1;
    l.hash = sha256(base + '|' + n);
  }
  return linhas;
}

// ------------------------------------------------------------ OFX
function ofxTag(bloco, tag){
  const m = bloco.match(new RegExp('<' + tag + '>([^<\\r\\n]*)', 'i'));
  return m ? m[1].trim() : null;
}
// OFX: ponto é sempre decimal (padrão da especificação); vírgula só em banco fora do padrão
function parseValorOFX(v){
  if(v == null) return null;
  const s = String(v).trim().replace(/\s/g, '');
  if(!/^[-+]?\d+([.,]\d+)?$/.test(s)) return null;
  const n = Number(s.replace(',', '.'));
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function decodeEnt(s){ return s == null ? s : s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"); }

function parseOFX(texto){
  const erros = [];
  const t = String(texto);
  if(!/<OFX>/i.test(t)) return { ok: false, erro: 'Arquivo OFX sem a tag <OFX>.' };
  const blocos = t.split(/<STMTTRN>/i).slice(1).map(b => b.split(/<\/STMTTRN>|<\/BANKTRANLIST>/i)[0]);
  const linhas = [];
  blocos.forEach((b, i) => {
    const data = parseData(ofxTag(b, 'DTPOSTED'));
    const valor = parseValorOFX(ofxTag(b, 'TRNAMT'));
    const name = decodeEnt(ofxTag(b, 'NAME')), memo = decodeEnt(ofxTag(b, 'MEMO'));
    const descricao = [name, memo].filter(Boolean).filter((v, k, a) => a.indexOf(v) === k).join(' - ') || ofxTag(b, 'TRNTYPE') || '';
    if(!data){ erros.push('Transação ' + (i + 1) + ': data inválida (' + ofxTag(b, 'DTPOSTED') + ')'); return; }
    if(valor == null){ erros.push('Transação ' + (i + 1) + ': valor inválido (' + ofxTag(b, 'TRNAMT') + ')'); return; }
    if(valor === 0) return;  // linha informativa
    linhas.push({
      data, valor, descricao: descricao.slice(0, 500),
      documento: ofxTag(b, 'CHECKNUM') || ofxTag(b, 'REFNUM') || null,
      contraparte: extrairContraparte(memo && name ? (name + ' ' + memo) : descricao, null),
      contraparte_doc: extrairDoc(descricao),
      fitid: ofxTag(b, 'FITID'), tipo_banco: ofxTag(b, 'TRNTYPE')
    });
  });
  const ledger = t.match(/<LEDGERBAL>([\s\S]*?)(<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>)/i);
  const saldo_final = ledger ? parseValorOFX(ofxTag(ledger[1], 'BALAMT')) : null;
  const saldo_data = ledger ? parseData(ofxTag(ledger[1], 'DTASOF')) : null;
  return {
    ok: true, formato: 'ofx', linhas, erros,
    periodo_ini: parseData(ofxTag(t, 'DTSTART')), periodo_fim: parseData(ofxTag(t, 'DTEND')),
    saldo_final, saldo_data,
    conta_banco: { banco: ofxTag(t, 'BANKID'), agencia: ofxTag(t, 'BRANCHID'), numero: ofxTag(t, 'ACCTID') }
  };
}

// ------------------------------------------------------------ CSV
function detectarSeparador(linha){
  const cand = [';', '\t', ',', '|'];
  let melhor = ';', max = -1;
  for(const c of cand){ const n = contarFora(linha, c); if(n > max){ max = n; melhor = c; } }
  return melhor;
}
function contarFora(linha, sep){ let n = 0, q = false; for(const ch of linha){ if(ch === '"') q = !q; else if(ch === sep && !q) n++; } return n; }
function splitCSV(texto, sep){
  const rows = []; let row = [], cel = '', q = false;
  for(let i = 0; i < texto.length; i++){
    const ch = texto[i];
    if(q){
      if(ch === '"'){ if(texto[i + 1] === '"'){ cel += '"'; i++; } else q = false; }
      else cel += ch;
    } else if(ch === '"') q = true;
    else if(ch === sep){ row.push(cel); cel = ''; }
    else if(ch === '\n'){ row.push(cel); rows.push(row); row = []; cel = ''; }
    else if(ch !== '\r') cel += ch;
  }
  if(cel !== '' || row.length){ row.push(cel); rows.push(row); }
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(c => c !== ''));
}
function achaColuna(cab, sinonimos){
  const h = cab.map(c => norm(c));
  for(const s of sinonimos){ const i = h.indexOf(norm(s)); if(i >= 0) return i; }
  for(const s of sinonimos){ const i = h.findIndex(x => x.indexOf(norm(s)) === 0); if(i >= 0) return i; }
  return -1;
}
function lerTabela(texto){
  const limpo = String(texto).replace(/^﻿/, '');
  const primeiras = limpo.split('\n').slice(0, 30);
  const sep = detectarSeparador(primeiras.find(l => l.trim()) || '');
  const rows = splitCSV(limpo, sep);
  return { rows, sep };
}
function acharCabecalho(rows, obrigatorias){
  for(let i = 0; i < Math.min(rows.length, 25); i++){
    if(obrigatorias.every(s => achaColuna(rows[i], s) >= 0)) return i;
  }
  return -1;
}

const COL_EXT = {
  data: ['data', 'data lancamento', 'data do lancamento', 'data movimento', 'data movimentacao', 'dt lancamento', 'date', 'data transacao'],
  descricao: ['descricao', 'historico', 'lancamento', 'detalhes', 'transacao', 'memo', 'descricao do lancamento', 'identificacao'],
  valor: ['valor', 'valor r', 'valor rs', 'valor (r$)', 'montante', 'amount', 'valor da transacao'],
  credito: ['credito', 'entrada', 'entradas', 'valor credito'],
  debito: ['debito', 'saida', 'saidas', 'valor debito'],
  tipo: ['tipo', 'natureza', 'c d', 'tipo de transacao', 'credito debito'],
  documento: ['documento', 'n documento', 'numero documento', 'doc', 'id', 'identificador', 'id da transacao', 'codigo'],
  contraparte: ['nome', 'favorecido', 'beneficiario', 'destinatario', 'pagador', 'origem destino', 'contraparte', 'nome do favorecido', 'recebedor'],
  saldo: ['saldo', 'saldo r', 'saldo apos lancamento', 'saldo do dia']
};

function parseCSVExtrato(texto){
  const { rows } = lerTabela(texto);
  if(rows.length < 2) return { ok: false, erro: 'CSV vazio ou sem linhas.' };
  let hi = acharCabecalho(rows, [COL_EXT.data, COL_EXT.valor]);
  if(hi < 0) hi = acharCabecalho(rows, [COL_EXT.data, COL_EXT.credito]);
  if(hi < 0) return { ok: false, erro: 'Não achei o cabeçalho do CSV (preciso de colunas "Data" e "Valor", ou "Data" + "Crédito"/"Débito").' };
  const cab = rows[hi];
  const c = {}; for(const k in COL_EXT) c[k] = achaColuna(cab, COL_EXT[k]);
  if(c.descricao < 0) return { ok: false, erro: 'CSV sem coluna de descrição/histórico.' };
  const linhas = [], erros = []; let ultSaldo = null, ultData = null;
  for(let i = hi + 1; i < rows.length; i++){
    const r = rows[i];
    const get = k => (c[k] >= 0 ? r[c[k]] : '');
    const desc = get('descricao');
    if(/^saldo/i.test(norm(desc)) && !get('valor') && !get('credito') && !get('debito')) continue;
    const data = parseData(get('data'));
    if(!data){
      if(r.filter(x => x).length <= 2) continue;         // rodapé/linha solta
      erros.push('Linha ' + (i + 1) + ': data inválida ("' + get('data') + '")'); continue;
    }
    let valor;
    if(c.valor >= 0){
      valor = parseValor(get('valor'));
      const tp = norm(get('tipo'));
      if(valor != null && valor > 0 && (tp === 'D' || tp.indexOf('DEBITO') === 0 || tp.indexOf('SAIDA') === 0)) valor = -valor;
    } else {
      const cr = parseValor(get('credito')), db = parseValor(get('debito'));
      if(cr) valor = Math.abs(cr); else if(db) valor = -Math.abs(db); else valor = 0;
    }
    if(valor == null){ erros.push('Linha ' + (i + 1) + ': valor inválido ("' + (get('valor') || get('credito') || get('debito')) + '")'); continue; }
    if(/^saldo/i.test(norm(desc))) continue;               // linha de saldo do dia, não é movimento
    if(valor === 0) continue;
    const sd = c.saldo >= 0 ? parseValor(get('saldo')) : null;
    if(sd != null && (!ultData || data >= ultData)){ ultSaldo = sd; ultData = data; }
    const nome = get('contraparte');
    linhas.push({
      data, valor, descricao: (desc || nome || '').slice(0, 500),
      documento: get('documento') || null,
      contraparte: extrairContraparte(desc, nome),
      contraparte_doc: extrairDoc(desc + ' ' + nome),
      fitid: null, tipo_banco: get('tipo') || null
    });
  }
  const datas = linhas.map(l => l.data).sort();
  return {
    ok: true, formato: 'csv', linhas, erros,
    periodo_ini: datas[0] || null, periodo_fim: datas[datas.length - 1] || null,
    saldo_final: ultSaldo, saldo_data: ultSaldo != null ? ultData : null, conta_banco: null
  };
}

function parseExtrato(texto, nomeArquivo){
  const t = String(texto || '');
  if(!t.trim()) return { ok: false, erro: 'Arquivo vazio.' };
  const ehOfx = /OFXHEADER|<OFX>/i.test(t.slice(0, 5000)) || /\.ofx$/i.test(nomeArquivo || '');
  const res = ehOfx ? parseOFX(t) : parseCSVExtrato(t);
  if(!res.ok) return res;
  if(!res.linhas.length) return { ok: false, erro: 'Nenhuma movimentação encontrada no arquivo.' + (res.erros.length ? ' ' + res.erros.slice(0, 3).join(' | ') : '') };
  if(res.erros.length) return { ok: false, erro: res.erros.length + ' linha(s) com problema. Nada foi importado (pra não entrar extrato pela metade): ' + res.erros.slice(0, 5).join(' | ') };
  if(!res.periodo_ini || !res.periodo_fim){
    const ds = res.linhas.map(l => l.data).sort();
    res.periodo_ini = res.periodo_ini || ds[0]; res.periodo_fim = res.periodo_fim || ds[ds.length - 1];
  }
  atribuirHashes(res.linhas);
  res.sha256 = sha256(t);
  res.soma_creditos = round2(res.linhas.filter(l => l.valor > 0).reduce((a, l) => a + l.valor, 0));
  res.soma_debitos = round2(res.linhas.filter(l => l.valor < 0).reduce((a, l) => a + l.valor, 0));
  return res;
}
function round2(n){ return Math.round(n * 100) / 100; }

// ------------------------------------------------------------ LANÇAMENTOS (Kamino CSV)
const COL_LANC = {
  id: ['codigo', 'id', 'cod', 'numero', 'n', 'identificador', 'id do lancamento'],
  tipo: ['tipo', 'natureza', 'tipo de lancamento', 'operacao'],
  pessoa: ['pessoa', 'fornecedor', 'cliente', 'favorecido', 'beneficiario', 'nome', 'pagador', 'contato'],
  pessoa_doc: ['cpf cnpj', 'cnpj cpf', 'documento', 'cpf', 'cnpj'],
  descricao: ['descricao', 'historico', 'observacao', 'detalhes'],
  categoria: ['classificacao', 'categoria', 'conta gerencial', 'plano de contas', 'conta contabil'],
  unidade: ['unidade de negocio', 'unidade'],
  conta_nome: ['conta', 'conta bancaria', 'conta pagadora', 'conta de pagamento', 'banco'],
  valor: ['valor', 'valor bruto', 'valor total', 'valor liquido', 'valor original', 'valor r'],
  vencimento: ['vencimento', 'data de vencimento', 'data vencimento', 'dt vencimento'],
  data_pagamento: ['data de pagamento', 'data pagamento', 'pagamento', 'pago em', 'data do pagamento', 'data de recebimento', 'data recebimento', 'data baixa', 'data de baixa'],
  situacao: ['situacao', 'status', 'estado'],
  competencia: ['competencia', 'data de competencia', 'mes de competencia'],
  centro_custo: ['centro de custo', 'centro custo']
};

function parseLancamentos(texto, tipoPadrao){
  const { rows } = lerTabela(texto);
  if(rows.length < 2) return { ok: false, erro: 'Arquivo vazio.' };
  let hi = acharCabecalho(rows, [COL_LANC.valor, COL_LANC.vencimento]);
  if(hi < 0) hi = acharCabecalho(rows, [COL_LANC.valor, COL_LANC.data_pagamento]);
  if(hi < 0) return { ok: false, erro: 'Não achei o cabeçalho (preciso de "Valor" e "Vencimento" ou "Data de pagamento").' };
  const cab = rows[hi];
  const c = {}; for(const k in COL_LANC) c[k] = achaColuna(cab, COL_LANC[k]);
  // "Pagamento" sozinho pode ser o tipo; evita confundir coluna de data com tipo
  if(c.data_pagamento >= 0 && c.data_pagamento === c.tipo) c.tipo = -1;
  const linhas = [], erros = [];
  for(let i = hi + 1; i < rows.length; i++){
    const r = rows[i];
    const get = k => (c[k] >= 0 ? (r[c[k]] || '') : '');
    if(r.filter(x => x).length <= 1) continue;
    let valor = parseValor(get('valor'));
    if(valor == null || valor === 0){ if(/total/i.test(r.join(' '))) continue; erros.push('Linha ' + (i + 1) + ': valor inválido ("' + get('valor') + '")'); continue; }
    const tpTxt = norm(get('tipo'));
    let tipo = tipoPadrao;
    if(/RECEB|RECEITA|ENTRADA|COBRANCA|CREDITO/.test(tpTxt)) tipo = 'receber';
    else if(/PAGA|DESPESA|SAIDA|DEBITO/.test(tpTxt)) tipo = 'pagar';
    else if(!tipo) tipo = valor < 0 ? 'pagar' : null;
    if(!tipo){ erros.push('Linha ' + (i + 1) + ': não sei se é a pagar ou a receber (escolha o tipo na importação)'); continue; }
    const venc = get('vencimento') ? parseData(get('vencimento')) : null;
    const pag = get('data_pagamento') ? parseData(get('data_pagamento')) : null;
    if(get('vencimento') && !venc){ erros.push('Linha ' + (i + 1) + ': vencimento inválido ("' + get('vencimento') + '")'); continue; }
    if(get('data_pagamento') && !pag){ erros.push('Linha ' + (i + 1) + ': data de pagamento inválida ("' + get('data_pagamento') + '")'); continue; }
    const raw = {}; cab.forEach((h, k) => { if(h) raw[h] = r[k]; });
    const l = {
      tipo, valor: Math.abs(valor), pessoa: get('pessoa') || null, pessoa_doc: (get('pessoa_doc') || '').replace(/[^\d*]/g, '') || null,
      descricao: get('descricao') || null, categoria: get('categoria') || null, unidade: get('unidade') || null,
      conta_nome: get('conta_nome') || null, centro_custo: get('centro_custo') || null, competencia: get('competencia') ? parseData(get('competencia')) : null, vencimento: venc, data_pagamento: pag, situacao: get('situacao') || null, raw
    };
    const idExt = get('id');
    l.chave = idExt ? ('ID:' + idExt) : ('H:' + sha256([tipo, l.valor.toFixed(2), norm(l.pessoa), venc, norm(l.descricao), norm(l.categoria)].join('|')));
    linhas.push(l);
  }
  if(!linhas.length) return { ok: false, erro: 'Nenhum lançamento encontrado.' + (erros.length ? ' ' + erros.slice(0, 3).join(' | ') : '') };
  if(erros.length) return { ok: false, erro: erros.length + ' linha(s) com problema. Nada foi importado: ' + erros.slice(0, 5).join(' | ') };
  // chaves de conteúdo repetidas no mesmo arquivo: numera pra não fundir 2 lançamentos iguais
  const vistos = {};
  for(const l of linhas){ if(l.chave.indexOf('H:') === 0){ const n = vistos[l.chave] = (vistos[l.chave] || 0) + 1; if(n > 1) l.chave += ':' + n; } }
  const ds = linhas.map(l => l.vencimento || l.data_pagamento).filter(Boolean).sort();
  return { ok: true, formato: 'csv', linhas, sha256: sha256(texto), periodo_ini: ds[0] || null, periodo_fim: ds[ds.length - 1] || null };
}

// ------------------------------------------------------------ FLYP / ZL Hub (Transações Financeiras)
// CSV do botão "CSV" da tela ?p=pix: "","Direção","Tipo","Contraparte","Valor","Valor Liquidado","Data","Status","Ações".
// A Direção vem VAZIA no CSV (na tela é só um ícone), então é deduzida. Regra validada em 6.121 linhas reais
// (01/01 a 09/11/2026, 100% de acerto): boleto/a receber = entrada; Pix com "Emitir/Ver Nota", status
// "Efetivado" ou taxa de exatamente R$ 1,00 = entrada (recarga de empresa); o resto do Pix = saída (saque do condutor).
// Se o arquivo trouxer a Direção preenchida (ou a pessoa exportar filtrando só Entrada/Saída), ela manda.
const COL_FLYP = {
  direcao: ['direcao'],
  tipo: ['tipo'],
  contraparte: ['contraparte'],
  valor: ['valor'],
  liquido: ['valor liquidado', 'valor liquido'],
  data: ['data'],
  status: ['status', 'situacao']
};
const STATUS_FLYP = {
  'CONCLUIDO': 'concluido', 'EFETIVADO': 'efetivado', 'ABERTO': 'aberto', 'EM ANALISE': 'em_analise', 'EXPIRADO': 'expirado',
  'REJEITADO': 'rejeitado', 'VENCIDO': 'vencido', 'QUITADO': 'quitado', 'AGUARDANDO APROVACAO': 'aguardando_aprovacao',
  'PAGO': 'quitado', 'CANCELADO': 'cancelado'
};
function parseFlyp(texto, opcoes){
  const forcar = opcoes && (opcoes.direcao === 'entrada' || opcoes.direcao === 'saida') ? opcoes.direcao : null;
  // o separador sai da linha do CABEÇALHO (o texto do botão "Copy" vem com uma linha de título antes)
  const limpo = String(texto).replace(/^﻿/, '');
  const linhaCab = limpo.split('\n').slice(0, 30).find(l => /contraparte/i.test(l) && /status/i.test(l)) || '';
  const rows = splitCSV(limpo, detectarSeparador(linhaCab));
  if(rows.length < 2) return { ok: false, erro: 'Arquivo vazio.' };
  const hi = acharCabecalho(rows, [COL_FLYP.contraparte, COL_FLYP.liquido, COL_FLYP.status]);
  if(hi < 0) return { ok: false, erro: 'Não parece o CSV da FLYP (preciso das colunas Contraparte, Valor Liquidado e Status da tela Transações Financeiras).' };
  const cab = rows[hi];
  const c = {}; for(const k in COL_FLYP) c[k] = achaColuna(cab, COL_FLYP[k]);
  // "Valor" não pode cair em "Valor Liquidado"
  c.valor = cab.findIndex(h => norm(h) === 'VALOR');
  c.tipo = cab.findIndex(h => norm(h) === 'TIPO');
  c.data = cab.findIndex(h => norm(h) === 'DATA');
  if(c.valor < 0 || c.data < 0 || c.tipo < 0) return { ok: false, erro: 'Faltam as colunas Tipo, Valor ou Data no CSV da FLYP.' };
  const linhas = [], erros = [];
  for(let i = hi + 1; i < rows.length; i++){
    const r = rows[i];
    const get = k => (c[k] >= 0 ? String(r[c[k]] || '').trim() : '');
    if(r.filter(x => x).length <= 2) continue;
    const valor = parseValor(get('valor')), liq = parseValor(get('liquido'));
    if(valor == null || liq == null){ erros.push('Linha ' + (i + 1) + ': valor inválido ("' + get('valor') + '" / "' + get('liquido') + '")'); continue; }
    const dt = get('data');
    const data = parseData(dt);
    if(!data){ erros.push('Linha ' + (i + 1) + ': data inválida ("' + dt + '")'); continue; }
    const mh = dt.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    const hora = mh ? pad(+mh[1]) + ':' + mh[2] + ':' + (mh[3] || '00') : null;
    if(mh && (+mh[1] > 23 || +mh[2] > 59 || +(mh[3] || 0) > 59)){ erros.push('Linha ' + (i + 1) + ': hora inválida ("' + dt + '")'); continue; }
    const cpBruto = get('contraparte');
    const temNota = /\b(EMITIR|VER)\s+NOTA\b/.test(norm(cpBruto));
    const contraparte = cpBruto.replace(/\s*(Emitir|Ver)\s+Nota\s*$/i, '').replace(/\s+/g, ' ').trim();
    if(!contraparte){ erros.push('Linha ' + (i + 1) + ': sem contraparte'); continue; }
    const tipoTxt = norm(get('tipo'));
    const tipo = /BOLETO/.test(tipoTxt) ? 'boleto' : /RECEBER/.test(tipoTxt) ? 'a_receber' : /PIX/.test(tipoTxt) ? 'pix' : /CARTAO/.test(tipoTxt) ? 'cartao' : 'outros';
    const stNorm = norm(get('status'));
    const status = STATUS_FLYP[stNorm] || 'outro';
    const taxa = round2(valor - liq);
    const dirTxt = norm(get('direcao'));
    let direcao = /ENTRADA/.test(dirTxt) ? 'entrada' : /SAIDA/.test(dirTxt) ? 'saida' : forcar;
    if(!direcao){
      if(tipo === 'boleto' || tipo === 'a_receber') direcao = 'entrada';
      else if(tipo === 'pix') direcao = (temNota || status === 'efetivado' || taxa === 1) ? 'entrada' : 'saida';
      else { erros.push('Linha ' + (i + 1) + ': não sei se "' + get('tipo') + '" é entrada ou saída (exporte filtrando a Direção e escolha na importação)'); continue; }
    }
    const categoria = tipo === 'boleto' ? 'boleto' : tipo === 'a_receber' ? 'a_receber'
      : tipo === 'pix' ? (direcao === 'saida' ? 'saque' : 'recarga') : 'outro';
    linhas.push({ data, hora, direcao, tipo, categoria, contraparte: contraparte.slice(0, 200), valor: round2(valor), valor_liquido: round2(liq), taxa,
                  status, status_original: get('status').slice(0, 40) || '?', tem_nota: temNota });
  }
  if(!linhas.length) return { ok: false, erro: 'Nenhuma transação encontrada.' + (erros.length ? ' ' + erros.slice(0, 3).join(' | ') : '') };
  if(erros.length) return { ok: false, erro: erros.length + ' linha(s) com problema. Nada foi importado: ' + erros.slice(0, 5).join(' | ') };
  // hash sem o status (o status muda com o tempo e a linha continua sendo a mesma) + nº da ocorrência
  const cont = {};
  for(const l of linhas){
    const base = ['FLYP', l.data, l.hora || '', l.tipo, l.direcao, norm(l.contraparte), l.valor.toFixed(2), l.valor_liquido.toFixed(2)].join('|');
    const n = cont[base] = (cont[base] || 0) + 1;
    l.hash = sha256(base + '|' + n);
  }
  const ds = linhas.map(l => l.data).sort();
  return { ok: true, formato: 'flyp_csv', linhas, sha256: sha256(texto), periodo_ini: ds[0], periodo_fim: ds[ds.length - 1] };
}

module.exports = { parseExtrato, parseLancamentos, parseFlyp, parseValor, parseData, extrairContraparte, extrairDoc, norm, sha256 };
