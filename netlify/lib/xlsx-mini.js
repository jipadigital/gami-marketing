// netlify/lib/xlsx-mini.js
// Leitor MÍNIMO de .xlsx sem dependência externa (o pacote "xlsx" do npm tem falha conhecida).
// .xlsx = ZIP de XMLs. Lê só o necessário: nomes das abas, textos compartilhados e células (valor + fórmula).
// Defesas: limite de tamanho descompactado (zip bomb), de nº de arquivos, de linhas/colunas; nada é executado.
'use strict';
const zlib = require('zlib');

const LIM = { entradas: 400, descompactado: 60 * 1024 * 1024, porArquivo: 25 * 1024 * 1024, linhas: 20000, colunas: 200 };

function lerZip(buf){
  // fim do diretório central (procura a assinatura nos últimos 64 KB)
  let eocd = -1;
  for(let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--){ if(buf.readUInt32LE(i) === 0x06054b50){ eocd = i; break; } }
  if(eocd < 0) throw new Error('Arquivo não é um .xlsx válido');
  const total = buf.readUInt16LE(eocd + 10), cdOff = buf.readUInt32LE(eocd + 16);
  if(total > LIM.entradas) throw new Error('Planilha com arquivos internos demais');
  const arquivos = {}; let soma = 0, p = cdOff;
  for(let k = 0; k < total; k++){
    if(p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Planilha corrompida');
    const metodo = buf.readUInt16LE(p + 10), comp = buf.readUInt32LE(p + 20), descomp = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), loc = buf.readUInt32LE(p + 42);
    const nome = buf.slice(p + 46, p + 46 + nl).toString('utf8');
    p += 46 + nl + el + cl;
    if(!/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(nome)) continue; // só o que interessa
    if(Object.prototype.hasOwnProperty.call(arquivos, nome)) throw new Error('Planilha corrompida (arquivo interno repetido)');
    if(descomp > LIM.porArquivo) throw new Error('Aba grande demais');
    if(loc + 30 > buf.length || buf.readUInt32LE(loc) !== 0x04034b50) throw new Error('Planilha corrompida');
    const ini = loc + 30 + buf.readUInt16LE(loc + 26) + buf.readUInt16LE(loc + 28);
    if(ini + comp > buf.length) throw new Error('Planilha corrompida');
    const dados = buf.slice(ini, ini + comp);
    // orçamento pelo tamanho REAL descompactado (o tamanho declarado no zip pode ser mentira)
    const resta = LIM.descompactado - soma;
    if(resta <= 0) throw new Error('Planilha grande demais');
    let out;
    if(metodo === 0) out = dados;
    else if(metodo === 8){ try { out = zlib.inflateRawSync(dados, { maxOutputLength: Math.min(LIM.porArquivo, resta) }); } catch(e){ throw new Error('Planilha grande demais ou corrompida'); } }
    else throw new Error('Compressão não suportada');
    if(out.length !== descomp) throw new Error('Planilha corrompida (tamanho não confere)');
    soma += out.length;
    arquivos[nome] = out.toString('utf8');
  }
  return arquivos;
}

function ent(s){
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
    const l = e.toLowerCase();
    if(l === 'lt') return '<'; if(l === 'gt') return '>'; if(l === 'amp') return '&'; if(l === 'quot') return '"'; if(l === 'apos') return "'";
    const n = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
    return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
  });
}
function textoRico(xml){ let t = ''; const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g; let m; while((m = re.exec(xml))) t += m[1]; return ent(t); }
function colIdx(ref){ const m = /^([A-Z]+)/.exec(ref); let n = 0; for(const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }

// Devolve [{ nome, linhas: [[{v, f}]] }] (v = número | texto | booleano | null; f = fórmula se houver)
function lerXlsx(buf){
  if(!Buffer.isBuffer(buf) || buf.length < 100) throw new Error('Arquivo vazio');
  const a = lerZip(buf);
  const wb = a['xl/workbook.xml'], rels = a['xl/_rels/workbook.xml.rels'];
  if(!wb || !rels) throw new Error('Arquivo não é uma planilha do Excel (.xlsx)');
  const alvo = {}; rels.replace(/<Relationship\b[^>]*>/g, tag => {
    const id = /\bId="([^"]+)"/.exec(tag), t = /\bTarget="([^"]+)"/.exec(tag);
    if(id && t) alvo[id[1]] = t[1].replace(/^\/?(xl\/)?/, 'xl/');
    return tag;
  });
  const ss = []; (a['xl/sharedStrings.xml'] || '').replace(/<si>([\s\S]*?)<\/si>/g, (m, x) => { ss.push(textoRico(x)); return m; });
  const abas = [];
  wb.replace(/<sheet\b[^>]*>/g, tag => {
    const nome = /\bname="([^"]*)"/.exec(tag), rid = /\br:id="([^"]+)"/.exec(tag);
    if(nome && rid) abas.push({ nome: ent(nome[1]), arq: alvo[rid[1]] });
    return tag;
  });
  const data1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(wb);   // planilhas do Mac antigo: datas contam de 1904
  const res = abas.map(ab => {
    const xml = a[ab.arq] || '';
    const linhas = [];
    const reRow = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g; let mr;
    while((mr = reRow.exec(xml))){
      const rn = /\br="(\d+)"/.exec(mr[1]);
      const r = (rn ? +rn[1] : linhas.length + 1) - 1;
      if(!mr[2]) continue;
      if(r >= LIM.linhas) break;
      const cel = [];
      const reC = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let mc;
      while((mc = reC.exec(mr[2]))){
        const at = mc[1], corpo = mc[2] || '';
        const ref = /\br="([A-Z]+)\d+"/.exec(at); if(!ref) continue;
        const ci = colIdx(ref[1]); if(ci >= LIM.colunas) continue;
        const t = (/\bt="([^"]+)"/.exec(at) || [])[1];
        const vm = /<v>([\s\S]*?)<\/v>/.exec(corpo), fm = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(corpo);
        let v = null;
        if(t === 's') v = vm ? (ss[+vm[1]] != null ? ss[+vm[1]] : null) : null;
        else if(t === 'inlineStr') v = textoRico(corpo);
        else if(t === 'str' || t === 'e') v = vm ? ent(vm[1]) : null;
        else if(t === 'b') v = vm ? vm[1] === '1' : null;
        else v = vm ? Number(vm[1]) : null;
        if(typeof v === 'number' && !isFinite(v)) v = null;
        cel[ci] = { v, f: fm ? ent(fm[1]) : null };
      }
      linhas[r] = cel;
    }
    return { nome: ab.nome, linhas };
  });
  res.data1904 = data1904;
  return res;
}

// serial do Excel -> 'aaaa-mm-dd' / 'hh:mm:ss'
function serialData(n, base1904){
  if(typeof n !== 'number') return null;
  const s = base1904 ? n + 1462 : n;   // 1904 -> 1900
  if(s < 20000 || s > 80000) return null;
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(s) * 864e5); return d.toISOString().slice(0, 10);
}
function serialHora(n){ if(typeof n !== 'number' || n < 0) return null; const fr = n % 1; const s = Math.round(fr * 86400) % 86400; return String(Math.floor(s / 3600)).padStart(2, '0') + ':' + String(Math.floor(s / 60) % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }

module.exports = { lerXlsx, serialData, serialHora, LIM };
