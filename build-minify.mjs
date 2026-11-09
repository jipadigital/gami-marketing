// build-minify.mjs , roda no BUILD do Netlify (a fonte no git continua legível;
// só o arquivo publicado sai minificado/ofuscado). Tira comentários, espaços, e
// mangla variáveis LOCAIS (os nomes GLOBAIS/funções ficam, senão os onclick quebram).
// À prova de falha: se a minificação der erro, mantém o arquivo original (site feio
// é melhor que site quebrado).
import { minify } from 'html-minifier-terser';
import { readFile, writeFile } from 'node:fs/promises';

const ALVOS = ['index.html', 'verificar-motorista.html'];

const OPTS = {
  collapseWhitespace: true,
  removeComments: true,            // remove o histórico de versões (as "att")
  minifyCSS: true,
  minifyJS: {
    compress: { drop_console: false },
    mangle: true,                  // SÓ variáveis locais (toplevel preservado)
    format: { comments: false },
  },
  keepClosingSlash: true,
  removeAttributeQuotes: false,    // mantém aspas (mais seguro)
};

for (const arquivo of ALVOS) {
  try {
    const src = await readFile(arquivo, 'utf8');
    const out = await minify(src, OPTS);
    await writeFile(arquivo, out, 'utf8');
    const red = Math.round((1 - out.length / src.length) * 100);
    console.log(`[minify] ${arquivo}: ${(src.length / 1024) | 0}kb -> ${(out.length / 1024) | 0}kb (-${red}%)`);
  } catch (e) {
    console.error(`[minify] ${arquivo} FALHOU, mantendo original:`, (e && e.message) || e);
    // não reescreve: o deploy segue com o arquivo original (legível, mas funcional)
  }
}
