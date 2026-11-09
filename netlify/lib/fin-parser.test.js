// Testes do parser financeiro. Rodar: node netlify/lib/fin-parser.test.js
'use strict';
const assert = require('assert');
const P = require('./fin-parser');
let ok = 0; const t = (nome, fn) => { try { fn(); ok++; } catch(e){ console.error('FALHOU:', nome, '\n ', e.message); process.exitCode = 1; } };

t('valores BR', () => {
  assert.strictEqual(P.parseValor('1.234,56'), 1234.56);
  assert.strictEqual(P.parseValor('-1.234,56'), -1234.56);
  assert.strictEqual(P.parseValor('R$ 1.234,56'), 1234.56);
  assert.strictEqual(P.parseValor('(150,00)'), -150);
  assert.strictEqual(P.parseValor('150,00-'), -150);
  assert.strictEqual(P.parseValor('1,234.56'), 1234.56);
  assert.strictEqual(P.parseValor('1234.56'), 1234.56);
  assert.strictEqual(P.parseValor('0,1'), 0.1);
  assert.strictEqual(P.parseValor('1.234.567,89'), 1234567.89);
  assert.strictEqual(P.parseValor('1.234'), null, 'ambíguo deve recusar');
  assert.strictEqual(P.parseValor('abc'), null);
  assert.strictEqual(P.parseValor('0,10') + P.parseValor('0,20'), 0.30000000000000004); // por isso arredonda no somatório
});

t('datas', () => {
  assert.strictEqual(P.parseData('05/11/2026'), '2026-11-05');
  assert.strictEqual(P.parseData('5/1/26'), '2026-01-05');
  assert.strictEqual(P.parseData('2026-11-05'), '2026-11-05');
  assert.strictEqual(P.parseData('20261105120000[-3:BRT]'), '2026-11-05');
  assert.strictEqual(P.parseData('31/02/2026'), null);
  assert.strictEqual(P.parseData('xx'), null);
});

t('contraparte', () => {
  assert.strictEqual(P.extrairContraparte('Pix enviado - João da Silva'), 'JOAO DA SILVA');
  assert.strictEqual(P.extrairContraparte('PIX ENVIADO PARA MARIA SOUZA ***.123.456-**'), 'MARIA SOUZA');
  assert.strictEqual(P.extrairContraparte('TED RECEBIDA DE CUCA POP LTDA 12.345.678/0001-90'), 'CUCA POP LTDA');
  assert.strictEqual(P.extrairContraparte('Tarifa', 'Fulano'), 'FULANO');
  assert.strictEqual(P.extrairDoc('CUCA 12.345.678/0001-90'), '12345678000190');
});

const OFX = `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL
<BANKACCTFROM><BANKID>403<BRANCHID>0001<ACCTID>1234567</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20261101<DTEND>20261105
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261102100000[-3:BRT]<TRNAMT>-150.00<FITID>a1<MEMO>Pix enviado - Joao da Silva
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261103<TRNAMT>1000.50<FITID>a2<MEMO>Pix recebido - Cuca Pop LTDA</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261103<TRNAMT>-2.00<FITID>a3<MEMO>Tarifa
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261103<TRNAMT>-2.00<FITID>a4<MEMO>Tarifa
</BANKTRANLIST><LEDGERBAL><BALAMT>5846.50<DTASOF>20261105</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

t('OFX SGML', () => {
  const r = P.parseExtrato(OFX, 'cora.ofx');
  assert.ok(r.ok, r.erro);
  assert.strictEqual(r.formato, 'ofx');
  assert.strictEqual(r.linhas.length, 4);
  assert.strictEqual(r.linhas[0].valor, -150);
  assert.strictEqual(r.linhas[0].contraparte, 'JOAO DA SILVA');
  assert.strictEqual(r.linhas[1].valor, 1000.5);
  assert.strictEqual(r.saldo_final, 5846.5);
  assert.strictEqual(r.saldo_data, '2026-11-05');
  assert.strictEqual(r.periodo_ini, '2026-11-01');
  assert.notStrictEqual(r.linhas[2].hash, r.linhas[3].hash, '2 tarifas iguais = 2 linhas');
  assert.strictEqual(r.soma_debitos, -154);
  assert.strictEqual(r.conta_banco.numero, '1234567');
});

t('OFX sobreposto gera mesmos hashes (não duplica)', () => {
  const a = P.parseExtrato(OFX, 'a.ofx');
  const b = P.parseExtrato(OFX.replace('<DTEND>20261105', '<DTEND>20261106'), 'b.ofx');
  assert.deepStrictEqual(a.linhas.map(l => l.hash), b.linhas.map(l => l.hash));
  assert.notStrictEqual(a.sha256, b.sha256);
});

t('OFX com valor quebrado recusa tudo', () => {
  const r = P.parseExtrato(OFX.replace('-150.00', '-150,00,0'), 'x.ofx');
  assert.strictEqual(r.ok, false);
  assert.ok(/Nada foi importado/.test(r.erro));
});

t('CSV valor único com sinal', () => {
  const csv = '﻿Extrato Cora\nData;Descrição;Valor;Saldo\n02/11/2026;Pix enviado - Joao;-150,00;850,00\n03/11/2026;Pix recebido - Cuca Pop;1.000,50;1.850,50\n03/11/2026;Saldo do dia;;1.850,50\n';
  const r = P.parseExtrato(csv, 'x.csv');
  assert.ok(r.ok, r.erro);
  assert.strictEqual(r.linhas.length, 2);
  assert.strictEqual(r.linhas[1].valor, 1000.5);
  assert.strictEqual(r.saldo_final, 1850.5);
  assert.strictEqual(r.saldo_data, '2026-11-03');
});

t('CSV crédito/débito separados', () => {
  const csv = 'Data,Histórico,Crédito,Débito\n"02/11/2026","Pagamento boleto, Energisa",,"1.200,00"\n03/11/2026,Pix recebido,500.00,\n';
  const r = P.parseExtrato(csv, 'x.csv');
  assert.ok(r.ok, r.erro);
  assert.strictEqual(r.linhas[0].valor, -1200);
  assert.strictEqual(r.linhas[0].descricao, 'Pagamento boleto, Energisa');
  assert.strictEqual(r.linhas[1].valor, 500);
});

t('CSV tipo C/D', () => {
  const csv = 'Data;Descricao;Valor;Tipo\n02/11/2026;Aluguel;3.500,00;D\n02/11/2026;Recebimento;200,00;C\n';
  const r = P.parseExtrato(csv, 'x.csv');
  assert.ok(r.ok, r.erro);
  assert.strictEqual(r.linhas[0].valor, -3500);
  assert.strictEqual(r.linhas[1].valor, 200);
});

t('CSV sem cabeçalho reconhecível', () => {
  const r = P.parseExtrato('a;b;c\n1;2;3\n', 'x.csv');
  assert.strictEqual(r.ok, false);
});

t('CSV com data ruim recusa tudo', () => {
  const r = P.parseExtrato('Data;Descricao;Valor\n02/11/2026;A;10,00\n99/99/2026;B;5,00\n', 'x.csv');
  assert.strictEqual(r.ok, false);
});

t('Lançamentos Kamino', () => {
  const csv = 'Código;Pessoa;Descrição;Classificação;Vencimento;Data de pagamento;Valor;Situação\n101;Energisa;Luz;Infraestrutura;10/11/2026;10/11/2026;1.234,56;Pago\n102;Fulano;Serviço;Comerciais;15/11/2026;;800,00;Pendente\n';
  const r = P.parseLancamentos(csv, 'pagar');
  assert.ok(r.ok, r.erro);
  assert.strictEqual(r.linhas.length, 2);
  assert.strictEqual(r.linhas[0].chave, 'ID:101');
  assert.strictEqual(r.linhas[0].valor, 1234.56);
  assert.strictEqual(r.linhas[0].data_pagamento, '2026-11-10');
  assert.strictEqual(r.linhas[1].data_pagamento, null);
  assert.strictEqual(r.linhas[1].tipo, 'pagar');
});

t('Lançamentos sem id: iguais não se fundem', () => {
  const csv = 'Pessoa;Vencimento;Valor\nX;10/11/2026;100,00\nX;10/11/2026;100,00\n';
  const r = P.parseLancamentos(csv, 'pagar');
  assert.ok(r.ok, r.erro);
  assert.notStrictEqual(r.linhas[0].chave, r.linhas[1].chave);
});

console.log(ok + ' testes passaram' + (process.exitCode ? ' (HÁ FALHAS)' : ''));
