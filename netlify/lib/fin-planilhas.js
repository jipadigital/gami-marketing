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

module.exports = { parseEmpresas, parseCreditos, semanaDaAba, motivoDe };
