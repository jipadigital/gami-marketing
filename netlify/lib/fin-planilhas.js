// netlify/lib/fin-planilhas.js
// Lê as planilhas antigas do financeiro (EMPRESAS e CRÉDITOS, uma aba por semana/mês) e transforma em
// linhas limpas para o banco. Tudo validado; o que não dá pra entender vira AVISO (nunca é "chutado").
'use strict';
const P = require('./fin-parser');
const { serialData, serialHora } = require('./xlsx-mini');

const norm = P.norm;
function celV(c){ return c ? c.v : null; }
function txt(v, n){ if(v == null) return ''; return String(v).replace(/\s+/g, ' ').trim().slice(0, n || 200); }
function num(v){ if(typeof v === 'number') return Math.round(v * 100) / 100; const n = P.parseValor(v); return n == null ? null : n; }
let BASE1904 = false;   // definido por planilha (Excel do Mac antigo conta datas de 1904)
function data(v){ if(typeof v === 'number') return serialData(v, BASE1904); return P.parseData(v); }
function hora(v){
  if(typeof v === 'number') return serialHora(v);
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(v || ''));
  return m && +m[1] < 24 && +m[2] < 60 ? String(+m[1]).padStart(2, '0') + ':' + m[2] + ':' + (m[3] || '00') : null;
}
function docDe(v){ const d = String(v == null ? '' : v).replace(/\D/g, ''); return d.length === 14 || d.length === 11 ? d : null; }
function achaCab(linhas, obrig, max){
  for(let r = 0; r < Math.min(linhas.length, max || 10); r++){
    const l = linhas[r]; if(!l) continue;
    const h = Array.from(l, c => norm(celV(c) == null ? '' : String(celV(c))));   // a linha pode ter buracos (colunas vazias)
    if(obrig.every(o => h.some(x => x === o || x.indexOf(o) === 0))) return { r, h };
  }
  return null;
}
const ix = (h, nomes) => { for(const n of nomes){ const i = h.indexOf(n); if(i >= 0) return i; } for(const n of nomes){ const i = h.findIndex(x => x.indexOf(n) === 0); if(i >= 0) return i; } return -1; };

// "2610 a 0111", "2912 A 0401", "3003 à 0504" -> semana (ano da planilha; dezembro->janeiro vira o ano anterior)
function semanaDaAba(nome, ano){
  const m = /(\d{2})(\d{2})\s*(?:a|à|ate|até|-|�)\s*(\d{2})(\d{2})/i.exec(nome);
  if(!m) return null;
  const [d1, m1, d2, m2] = [+m[1], +m[2], +m[3], +m[4]];
  const a1 = (m1 === 12 && m2 === 1) ? ano - 1 : ano;
  const ini = P.parseData(String(d1).padStart(2, '0') + '/' + String(m1).padStart(2, '0') + '/' + a1);
  const fim = P.parseData(String(d2).padStart(2, '0') + '/' + String(m2).padStart(2, '0') + '/' + ano);
  if(!ini || !fim || fim < ini || (Date.parse(fim) - Date.parse(ini)) / 864e5 > 13) return null;
  return { ini, fim };
}

// ---------------- EMPRESAS ----------------
function parseEmpresas(abas, ano){
  const linhas = [], avisos = [], resumoAbas = [];
  const cont = {};
  for(const ab of abas){
    const sem = semanaDaAba(ab.nome, ano);
    if(!sem){ if(ab.linhas.length > 1) avisos.push('Aba "' + ab.nome + '" ignorada: o nome não é uma semana (ex.: 2610 a 0111). Lance à mão se precisar.'); resumoAbas.push({ aba: ab.nome, status: 'ignorada' }); continue; }
    const cab = achaCab(ab.linhas, ['EMPRESA', 'A RECEBER']);
    if(!cab){ avisos.push('Aba "' + ab.nome + '": não achei o cabeçalho (EMPRESA / A RECEBER).'); resumoAbas.push({ aba: ab.nome, status: 'sem cabeçalho' }); continue; }
    const h = cab.h;
    const cEmp = ix(h, ['EMPRESA']), cVal = h.indexOf('A RECEBER'), cDesc = ix(h, ['DESCONTO']), cPago = ix(h, ['VALOR PAGO', 'VALOR RECEBIDO']);
    const cObs = ix(h, ['OBSERVACAO']), cBanco = ix(h, ['NOME NO BANCO']);
    let cDoc = ix(h, ['CNPJ', 'CPF CNPJ', 'CNPJ CPF']);
    if(cDoc < 0){ // coluna sem título com CNPJ/CPF
      let melhor = -1, max = 0;
      for(let c = 0; c < Math.min(cEmp, 6); c++){ let n = 0; for(let r = cab.r + 1; r < ab.linhas.length; r++){ const l = ab.linhas[r]; if(l && docDe(celV(l[c]))) n++; } if(n > max){ max = n; melhor = c; } }
      if(max >= 3) cDoc = melhor;
    }
    let lidas = 0, ok = 0;
    for(let r = cab.r + 1; r < ab.linhas.length; r++){
      const l = ab.linhas[r]; if(!l) continue;
      const emp = txt(celV(l[cEmp]), 200);
      const val = num(celV(l[cVal]));
      if(!emp && val == null) continue;
      lidas++;
      if(!emp || /^TOTA/i.test(norm(emp)) || norm(emp).length < 2){ continue; } // linha de total / vazia
      if(val == null || val < 0){ avisos.push('Aba "' + ab.nome + '" linha ' + (r + 1) + ': valor a receber inválido, linha ignorada.'); continue; }
      const desc = cDesc >= 0 ? (num(celV(l[cDesc])) || 0) : 0;
      const pago = cPago >= 0 ? num(celV(l[cPago])) : null;
      if(val === 0 && !(pago > 0)) continue;
      const doc = cDoc >= 0 ? docDe(celV(l[cDoc])) : null;
      const base = 'E|' + sem.ini + '|' + (doc || norm(emp));
      const n = cont[base] = (cont[base] || 0) + 1;
      linhas.push({ semana_ini: sem.ini, semana_fim: sem.fim, empresa: emp, empresa_doc: doc, valor: val,
        desconto: desc > 0 && desc <= val ? desc : 0, recebido: pago > 0 ? pago : 0,
        observacao: cObs >= 0 ? txt(celV(l[cObs]), 500) : '', nome_no_banco: cBanco >= 0 ? txt(celV(l[cBanco]), 200) : '',
        chave: P.sha256(base + '|' + n) });
      if(desc > val) avisos.push('Aba "' + ab.nome + '" linha ' + (r + 1) + ': desconto maior que o valor, desconto ignorado.');
      ok++;
    }
    resumoAbas.push({ aba: ab.nome, semana: sem.ini + ' a ' + sem.fim, linhas: ok });
  }
  conferirAno(linhas.map(l => l.semana_ini), ano, avisos);
  return { linhas, avisos, abas: resumoAbas };
}

// ---------------- CRÉDITOS ----------------
function motivoDe(obs){
  const o = norm(obs);
  if(/SEMANAL/.test(o)) return 'pagamento_semanal';
  if(/ZERAND|ZERAD/.test(o)) return 'zeragem';
  if(/TESTE/.test(o)) return 'teste';
  if(/REEMBOLS/.test(o)) return 'reembolso';
  if(/CORTESIA/.test(o)) return 'cortesia';
  if(/BONU/.test(o) && /INICI|CADASTR|INDICA/.test(o)) return 'bonus_inicio';
  if(/BONU|ACAO|PROMOC/.test(o)) return 'bonus_acao';   // : não pegar "TRANSACAO"/"COMPENSACAO"
  if(/ERRO|AJUST|CORRE/.test(o)) return 'ajuste';
  return 'outro';
}
function parseCreditos(abas, ano){
  BASE1904 = !!abas.data1904;
  const linhas = [], avisos = [], resumoAbas = [];
  const cont = {};
  for(const ab of abas){
    if(/CONF/i.test(norm(ab.nome))){ resumoAbas.push({ aba: ab.nome, status: 'conferência (cópia), ignorada' }); continue; }
    const cab = achaCab(ab.linhas, ['DATA', 'VALOR']);
    if(!cab){ if(ab.linhas.length > 1) avisos.push('Aba "' + ab.nome + '": não achei o cabeçalho (Data / Valor).'); resumoAbas.push({ aba: ab.nome, status: 'sem cabeçalho' }); continue; }
    const h = cab.h;
    const c = { data: h.indexOf('DATA'), hora: h.indexOf('HORA'), emp: ix(h, ['EMPRESA']), val: h.indexOf('VALOR'), ent: ix(h, ['ENTREGADOR']),
                os: h.indexOf('OS'), op: ix(h, ['OPERADOR']), obs: ix(h, ['OBSERVACAO']), idEnt: ix(h, ['ID DO ENTREGADOR']) };
    // checagem de colunas desalinhadas: a coluna "Valor" tem que ser número na maioria das linhas
    let nums = 0, tot = 0;
    for(let r = cab.r + 1; r < ab.linhas.length; r++){ const l = ab.linhas[r]; if(!l || !l[c.data] || celV(l[c.data]) == null) continue; tot++; const vv = celV(l[c.val]); if(typeof vv === 'number' || (typeof vv === 'string' && /R\$|\d,\d{2}\s*$/.test(vv))) nums++; }
    if(tot >= 3 && nums / tot < 0.6){ avisos.push('Aba "' + ab.nome + '" NÃO importada: as colunas estão desalinhadas com o cabeçalho (a coluna Valor não tem números). Arrume a aba e importe de novo.'); resumoAbas.push({ aba: ab.nome, status: 'colunas desalinhadas' }); continue; }
    let ok = 0;
    for(let r = cab.r + 1; r < ab.linhas.length; r++){
      const l = ab.linhas[r]; if(!l) continue;
      const dt = data(celV(l[c.data]));
      const val = num(celV(l[c.val]));
      const entTxt = c.ent >= 0 ? txt(celV(l[c.ent]), 200) : '';
      const emp = c.emp >= 0 ? txt(celV(l[c.emp]), 200) : '';
      if(!dt && !entTxt && !emp){ continue; }             // linha de total / vazia
      if(!dt){ avisos.push('Aba "' + ab.nome + '" linha ' + (r + 1) + ': sem data válida, ignorada.'); continue; }
      if(val == null || val <= 0){ avisos.push('Aba "' + ab.nome + '" linha ' + (r + 1) + ': valor inválido, ignorada.'); continue; }
      if(val > 100000){ avisos.push('Aba "' + ab.nome + '" linha ' + (r + 1) + ': valor acima de R$ 100 mil (parece total), ignorada.'); continue; }
      // "Nome Sobrenome 917" -> nome + ID do entregador
      let benef = entTxt, idEnt = c.idEnt >= 0 ? txt(celV(l[c.idEnt]), 40).replace(/\D/g, '') : '';
      const mId = /^(.*?)[\s-]+(\d{1,9})$/.exec(entTxt);
      if(mId && mId[1].length >= 2){ benef = mId[1].trim(); if(!idEnt) idEnt = mId[2]; }
      let tipo = 'entregador';
      if(!benef){ benef = emp; tipo = 'empresa'; }
      if(!benef || norm(benef).length < 2){ avisos.push('Aba "' + ab.nome + '" linha ' + (r + 1) + ': sem entregador nem empresa, ignorada.'); continue; }
      const hr = c.hora >= 0 ? hora(celV(l[c.hora])) : null;
      const obs = c.obs >= 0 ? txt(celV(l[c.obs]), 500) : '';
      const base = 'C|' + dt + '|' + (hr || '-') + '|' + norm(benef) + '|' + val.toFixed(2);
      const n = cont[base] = (cont[base] || 0) + 1;
      linhas.push({ data: dt, hora: hr, valor: val, beneficiario: benef, beneficiario_tipo: tipo, entregador_id: idEnt || null,
        empresa: tipo === 'entregador' ? emp : '', os: c.os >= 0 ? txt(celV(l[c.os]), 60) : '', operador: c.op >= 0 ? txt(celV(l[c.op]), 100) : '',
        motivo: motivoDe(obs), observacao: obs, chave: P.sha256(base + '|' + n) });
      ok++;
    }
    resumoAbas.push({ aba: ab.nome, linhas: ok });
  }
  conferirAno(linhas.map(l => l.data), ano, avisos);
  return { linhas, avisos, abas: resumoAbas };
}

// o ano escolhido não bate com as datas? (ex.: escolheram 2025 numa planilha de 2026)
function conferirAno(datas, ano, avisos){
  if(!datas.length) return;
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const fora = datas.filter(d => d.slice(0, 4) !== String(ano) && !(d.slice(0, 4) === String(ano - 1) && d.slice(5, 7) === '12')).length;
  const futuro = datas.filter(d => d > hoje).length;
  if(fora > datas.length * 0.2) avisos.unshift('ATENÇÃO: ' + fora + ' de ' + datas.length + ' linhas têm data fora de ' + ano + '. Confira se escolheu o ano certo da planilha.');
  if(futuro) avisos.unshift('ATENÇÃO: ' + futuro + ' linha(s) com data no FUTURO. Provavelmente o ano escolhido está errado.');
}

// ================= AS OUTRAS PLANILHAS (uma aba por mês; motoboys uma por semana) =================
const MESES = { JANEIRO: 1, FEVEREIRO: 2, MARCO: 3, ABRIL: 4, MAIO: 5, JUNHO: 6, JULHO: 7, AGOSTO: 8, SETEMBRO: 9, OUTUBRO: 10, NOVEMBRO: 11, DEZEMBRO: 12 };
function mesDaAba(nome, ano){
  const n = norm(nome);
  for(const k in MESES){ if(n.indexOf(k) >= 0){ const a = /(20\d{2})/.exec(n); return { mes: MESES[k], ano: a ? +a[1] : ano }; } }
  return null;
}
function primeiroDia(m){ return m.ano + '-' + String(m.mes).padStart(2, '0') + '-01'; }
// valor "solto": "R$15,00 Valor promocional" -> 15 (e devolve o texto que sobrou, pra observação)
function numSolto(v){
  if(typeof v === 'number') return { n: Math.round(v * 100) / 100, resto: '' };
  const s = String(v == null ? '' : v);
  const n = num(s); if(n != null) return { n, resto: '' };
  const m = /(\d{1,3}(?:\.\d{3})+,\d{1,2}|\d+,\d{1,2}|\d+(?:\.\d{1,2})?)/.exec(s);
  if(!m) return { n: null, resto: s };
  const x = P.parseValor(m[1]); return { n: x, resto: s.replace(m[0], '').replace(/R\$/g, '').replace(/\s+/g, ' ').trim() };
}
function formaDe(v){
  const f = norm(v);
  if(!f) return null;
  if(/PIX/.test(f)) return 'pix'; if(/DINHEIRO|ESPECIE/.test(f)) return 'dinheiro'; if(/CORTESIA|DOACAO|BRINDE/.test(f)) return 'cortesia';
  if(/CARTAO|CREDITO|DEBITO/.test(f)) return 'cartao'; if(/BOLETO/.test(f)) return 'boleto'; if(/SEMANAL|DESCONT/.test(f)) return 'desconto_semanal';
  return 'outro';
}
function ehTotal(nome){ const n = norm(nome); return !n || /^TOTA/.test(n) || n === 'SOMA'; }
function chaveDe(cont, base){ const k = cont[base] = (cont[base] || 0) + 1; return P.sha256(base + '|' + k); }

// BAGS / CAMISETAS: NOME, (DATA), (TAM), QUANT, FORMA, VALOR UNITÁRIO, VALOR DO 1 PAG, DATA DO 1 PAG, PAGO EM NOME DE QUEM
function parseVendas(abas, ano, tipo){
  BASE1904 = !!abas.data1904;
  const linhas = [], avisos = [], resumoAbas = [], cont = {};
  for(const ab of abas){
    const cab = achaCab(ab.linhas, ['NOME', 'QUANT']);
    if(!cab){ resumoAbas.push({ aba: ab.nome, status: ab.linhas.length > 1 ? 'sem cabeçalho (NOME / QUANT)' : 'vazia' }); continue; }
    const h = cab.h, m = mesDaAba(ab.nome, ano);
    const c = { nome: ix(h, ['NOME']), qtd: ix(h, ['QUANT']), tam: ix(h, ['TAM']), forma: ix(h, ['FORMA DE PAGAMENTO', 'FORMA']), unit: ix(h, ['VALOR UNITARIO']),
                pag1: ix(h, ['VALOR DO 1 PAG', 'VALOR DO 1O PAG', 'VALOR DAS 2', 'VALOR PAGO']), data: ix(h, ['DATA DO PAGAMENTO', 'DATA']),
                quem: ix(h, ['PAGAMENTO EM NOME DE QUEM']), conf: ix(h, ['CONFIRMACAO', 'CONF']) };
    let ok = 0;
    for(let r = cab.r + 1; r < ab.linhas.length; r++){
      const l = ab.linhas[r]; if(!l) continue;
      const nome = txt(celV(l[c.nome]), 200);
      if(ehTotal(nome)) continue;
      const qtd = Math.max(1, Math.round(Number(num(celV(l[c.qtd]))) || 1));
      const formaTxt = c.forma >= 0 ? txt(celV(l[c.forma]), 60) : '';
      const forma = formaDe(formaTxt);
      const u = numSolto(c.unit >= 0 ? celV(l[c.unit]) : null);
      let dt = c.data >= 0 ? data(celV(l[c.data])) : null;
      if(!dt && m) dt = primeiroDia(m);
      if(!dt){ avisos.push('Aba "' + ab.nome + '" linha ' + (r + 1) + ': sem data e o nome da aba não é um mês, ignorada.'); continue; }
      const obs = [];
      if(forma === 'cortesia') obs.push('cortesia/doação (planilha: ' + (formaTxt || 'cortesia') + ')');
      if(u.resto) obs.push(u.resto);
      if(u.n == null && forma !== 'cortesia'){ avisos.push('Aba "' + ab.nome + '" linha ' + (r + 1) + ' (' + nome + '): valor unitário ilegível, ignorada.'); continue; }
      const unit = forma === 'cortesia' ? 0 : u.n;
      const total = Math.round(qtd * unit * 100) / 100;
      const p1 = numSolto(c.pag1 >= 0 ? celV(l[c.pag1]) : null);
      let pago = p1.n != null && p1.n > 0 ? Math.min(p1.n, total) : 0;
      const confTxt = c.conf >= 0 ? norm(celV(l[c.conf])) : '';
      if(!pago && total > 0 && /\bOK\b/.test(confTxt)) pago = total;   // "ok" sem valor do 1º pag = pago inteiro
      if(p1.n != null && p1.n > total && total > 0) obs.push('planilha dizia pago ' + p1.n.toFixed(2).replace('.', ','));
      const quem = c.quem >= 0 ? txt(celV(l[c.quem]), 200) : '';
      linhas.push({ tipo, data: dt, nome, quantidade: qtd, tamanho: c.tam >= 0 ? txt(celV(l[c.tam]), 40) : '', forma, valor_unitario: unit, valor: total,
        valor_pago: pago, data_pagamento: dt, pago_por: quem, observacao: obs.join(' · ').slice(0, 500), chave: chaveDe(cont, tipo + '|' + dt + '|' + norm(nome) + '|' + total) });
      ok++;
    }
    resumoAbas.push({ aba: ab.nome, linhas: ok });
  }
  conferirAno(linhas.map(l => l.data), ano, avisos);
  return { linhas, avisos, abas: resumoAbas };
}

// MOTOBOYS NOVOS: NOME, VALOR, DATA, PAGAMENTO EM NOME DE QUEM, CONF.
function parseMotoNovos(abas, ano){
  BASE1904 = !!abas.data1904;
  const linhas = [], avisos = [], resumoAbas = [], cont = {};
  for(const ab of abas){
    const cab = achaCab(ab.linhas, ['NOME', 'VALOR']);
    if(!cab){ resumoAbas.push({ aba: ab.nome, status: ab.linhas.length > 1 ? 'sem cabeçalho (NOME / VALOR)' : 'vazia' }); continue; }
    const h = cab.h, m = mesDaAba(ab.nome, ano);
    const c = { nome: ix(h, ['NOME']), valor: ix(h, ['VALOR']), data: ix(h, ['DATA']), quem: ix(h, ['PAGAMENTO EM NOME DE QUEM']) };
    let ok = 0;
    for(let r = cab.r + 1; r < ab.linhas.length; r++){
      const l = ab.linhas[r]; if(!l) continue;
      const nome = txt(celV(l[c.nome]), 200); if(ehTotal(nome)) continue;
      const v = numSolto(celV(l[c.valor]));
      if(v.n == null || v.n <= 0){ avisos.push('Aba "' + ab.nome + '" linha ' + (r + 1) + ' (' + nome + '): valor inválido, ignorada.'); continue; }
      let dt = c.data >= 0 ? data(celV(l[c.data])) : null; if(!dt && m) dt = primeiroDia(m);
      if(!dt){ avisos.push('Aba "' + ab.nome + '" linha ' + (r + 1) + ': sem data, ignorada.'); continue; }
      const quem = c.quem >= 0 ? txt(celV(l[c.quem]), 200) : '';
      linhas.push({ tipo: 'moto_novo', data: dt, nome, valor: v.n, valor_pago: v.n, data_pagamento: dt, forma: 'pix', pago_por: quem,
        observacao: v.resto.slice(0, 300), chave: chaveDe(cont, 'moto_novo|' + dt + '|' + norm(nome) + '|' + v.n) });
      ok++;
    }
    resumoAbas.push({ aba: ab.nome, linhas: ok });
  }
  conferirAno(linhas.map(l => l.data), ano, avisos);
  return { linhas, avisos, abas: resumoAbas };
}

// MOTOBOYS (semanal): aba "0501 a 1101"; Nome, Faturamento, Valor a pagar (21%), Total do entregador
function parseMotoboys(abas, ano){
  const linhas = [], avisos = [], resumoAbas = [], cont = {};
  for(const ab of abas){
    const sem = semanaDaAba(ab.nome, ano);
    if(!sem){ resumoAbas.push({ aba: ab.nome, status: 'ignorada (o nome não é uma semana)' }); continue; }
    const cab = achaCab(ab.linhas, ['NOME', 'FATURAMENTO']);
    if(!cab){ avisos.push('Aba "' + ab.nome + '": não achei o cabeçalho (Nome / Faturamento).'); resumoAbas.push({ aba: ab.nome, status: 'sem cabeçalho' }); continue; }
    const h = cab.h;
    const c = { nome: ix(h, ['NOME']), fat: ix(h, ['FATURAMENTO']), gami: ix(h, ['VALOR A PAGAR']), ent: ix(h, ['TOTAL DO ENTREGADOR']) };
    let ok = 0, divergentes = 0;
    for(let r = cab.r + 1; r < ab.linhas.length; r++){
      const l = ab.linhas[r]; if(!l) continue;
      const nome = txt(celV(l[c.nome]), 200); if(ehTotal(nome)) continue;
      const fat = num(celV(l[c.fat]));
      if(fat == null){ avisos.push('Aba "' + ab.nome + '" linha ' + (r + 1) + ' (' + nome + '): faturamento ilegível, ignorada.'); continue; }
      if(fat === 0) continue;
      const g = c.gami >= 0 ? num(celV(l[c.gami])) : null, e = c.ent >= 0 ? num(celV(l[c.ent])) : null;
      const gami = g != null ? g : Math.round(fat * 21) / 100, ent = e != null ? e : Math.round((fat - gami) * 100) / 100;
      const pct = fat > 0 ? Math.round(gami / fat * 10000) / 100 : 21;
      if(Math.abs(gami + ent - fat) > 0.05) divergentes++;
      linhas.push({ tipo: 'motoboy_semanal', data: sem.ini, semana_ini: sem.ini, semana_fim: sem.fim, nome, valor: fat, percentual: Math.min(100, Math.max(0, pct)),
        valor_gami: gami, valor_entregador: ent, observacao: Math.abs(gami + ent - fat) > 0.05 ? 'planilha: Gâmi + entregador não fecha com o faturamento' : '',
        chave: chaveDe(cont, 'motoboy|' + sem.ini + '|' + norm(nome) + '|' + fat) });
      ok++;
    }
    if(divergentes) avisos.push('Aba "' + ab.nome + '": ' + divergentes + ' linha(s) em que Gâmi + entregador não fecha com o faturamento (marcadas na observação).');
    resumoAbas.push({ aba: ab.nome, semana: sem.ini + ' a ' + sem.fim, linhas: ok });
  }
  return { linhas, avisos, abas: resumoAbas };
}

// DESCONTOS: abas "MÊS - BANCO" e "MÊS - FORA DO BANCO"; nome, VALOR, MOTIVO, DATA, (RESPONSÁVEL)
function parseDescontos(abas, ano){
  BASE1904 = !!abas.data1904;
  const linhas = [], avisos = [], resumoAbas = [], cont = {};
  for(const ab of abas){
    const nAba = norm(ab.nome);
    if(/CONFERENCIA/.test(nAba)){ resumoAbas.push({ aba: ab.nome, status: 'conferência (cópia), ignorada' }); continue; }
    const tipo = /FORA/.test(nAba) ? 'desconto_fora' : /BANCO/.test(nAba) ? 'desconto_banco' : null;
    if(!tipo){ resumoAbas.push({ aba: ab.nome, status: 'ignorada (não diz se é BANCO ou FORA DO BANCO)' }); continue; }
    const cab = achaCab(ab.linhas, ['VALOR', 'MOTIVO']);
    if(!cab){ resumoAbas.push({ aba: ab.nome, status: ab.linhas.length > 1 ? 'sem cabeçalho (VALOR / MOTIVO)' : 'vazia' }); continue; }
    const h = cab.h, m = mesDaAba(ab.nome, ano);
    const c = { valor: ix(h, ['VALOR']), motivo: ix(h, ['MOTIVO']), data: ix(h, ['DATA']), resp: ix(h, ['RESPONSAVEL']) };
    c.nome = ix(h, ['NOME DA EMPRESA', 'NOME DO FAVORECIDO', 'NOME']);
    if(c.nome < 0) c.nome = 0;   // uma aba tem o cabeçalho "C" no lugar do nome: o nome é a 1ª coluna
    let ok = 0;
    for(let r = cab.r + 1; r < ab.linhas.length; r++){
      const l = ab.linhas[r]; if(!l) continue;
      const nome = txt(celV(l[c.nome]), 200); if(ehTotal(nome)) continue;
      const v = num(celV(l[c.valor]));
      if(v == null || v <= 0){ avisos.push('Aba "' + ab.nome + '" linha ' + (r + 1) + ' (' + nome + '): valor inválido, ignorada.'); continue; }
      let dt = c.data >= 0 ? data(celV(l[c.data])) : null; if(!dt && m) dt = primeiroDia(m);
      if(!dt){ avisos.push('Aba "' + ab.nome + '" linha ' + (r + 1) + ': sem data, ignorada.'); continue; }
      const motivo = txt(celV(l[c.motivo]), 300) || '(sem motivo na planilha)';
      const resp = c.resp >= 0 ? txt(celV(l[c.resp]), 100) : '';
      linhas.push({ tipo, data: dt, nome, valor: v, motivo, responsavel: tipo === 'desconto_fora' ? (resp || '(não informado na planilha)') : resp,
        chave: chaveDe(cont, tipo + '|' + dt + '|' + norm(nome) + '|' + v + '|' + norm(motivo)) });
      ok++;
    }
    resumoAbas.push({ aba: ab.nome, linhas: ok });
  }
  conferirAno(linhas.map(l => l.data), ano, avisos);
  return { linhas, avisos, abas: resumoAbas };
}

module.exports = { parseEmpresas, parseCreditos, parseVendas, parseMotoNovos, parseMotoboys, parseDescontos, semanaDaAba, motivoDe, mesDaAba, numSolto };
