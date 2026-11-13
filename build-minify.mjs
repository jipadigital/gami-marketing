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

// -----------------------------------------------------------------------------
// MANIFESTO DOS STORIES (13/11/2026)
// As functions de stories listavam as imagens pela API pública do GitHub e mandavam pro
// Instagram a URL do raw.githubusercontent, o que obrigava o repositório a ser PÚBLICO.
// Agora o build grava stories/manifest.json com a lista de arquivos de cada categoria, e as
// functions leem esse manifesto e usam a imagem servida pelo próprio site. Assim o
// repositório pode ser privado. As imagens continuam sendo geridas do mesmo jeito: basta
// subir o arquivo na pasta stories/<categoria>/ e fazer o deploy.
// À prova de falha: se algo der errado aqui, o build NÃO quebra (as functions ainda têm o
// caminho antigo como reserva enquanto o repositório for público).
try {
  const { readdir, stat } = await import('node:fs/promises');
  const EXT = ['jpg', 'jpeg', 'png', 'webp'];
  const categorias = {};
  let total = 0;
  for (const d of await readdir('stories', { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const itens = [];
    for (const nome of (await readdir('stories/' + d.name)).sort()) {
      if (nome.startsWith('.')) continue;
      if (!EXT.includes(nome.split('.').pop().toLowerCase())) continue;
      const s = await stat('stories/' + d.name + '/' + nome);
      if (s.isFile()) itens.push({ nome, size: s.size });
    }
    categorias[d.name] = itens;
    total += itens.length;
  }
  await writeFile('stories/manifest.json', JSON.stringify({ gerado_em: new Date().toISOString(), categorias }), 'utf8');
  console.log(`[stories] manifest.json: ${Object.keys(categorias).length} categorias, ${total} imagens`);
} catch (e) {
  console.error('[stories] não consegui gerar o manifest (as functions usam a reserva):', (e && e.message) || e);
}
