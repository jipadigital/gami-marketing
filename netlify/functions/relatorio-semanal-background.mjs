// netlify/functions/relatorio-semanal-background.mjs
// =============================================================================
// RELATÓRIO SEMANAL DA REDE — Gâmi Marketing Dashboard
//
// Roda em BACKGROUND (até 15 min). Gera:
//   • 1 relatório GERAL da rede (11 cidades) + plano de ação ESTRATÉGICO (diretoria)
//   • 1 relatório POR CIDADE + plano de ação OPERACIONAL (gestor)
// Salva tudo na tabela `relatorios_rede` e dispara notificação + push.
//
// 🛡️ TRAVA ANTI-VAZIO: se as 11 cidades não tiverem dados (sync não rodou),
//    a função ABORTA e NÃO gera nada. Nunca manda relatório vazio.
//
// PRÉ-REQUISITOS (env vars no Netlify):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY  (service-key pra escrever)
//   ANTHROPIC_API_KEY                   (a mesma que o blog-ai usa)
//   ANTHROPIC_MODEL                     (opcional, default claude-sonnet-4-6)
//   RELATORIO_MIN_CIDADES               (opcional, default 11)
//
// É disparada pelo cron em `relatorio-semanal.mjs` (segunda de manhã).
// =============================================================================

const SUPA_URL      = process.env.SUPABASE_URL || 'https://tdbyzsouhrhmhpctttps.supabase.co';
const SUPA_KEY      = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL         = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const SITE          = process.env.URL || process.env.DEPLOY_PRIME_URL || '';
const MIN_CIDADES   = parseInt(process.env.RELATORIO_MIN_CIDADES || '11', 10);

const H = { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY, 'Content-Type': 'application/json' };

// ---------- helpers Supabase ----------
async function supaRPC(fn, args) {
  const r = await fetch(SUPA_URL + '/rest/v1/rpc/' + fn, { method: 'POST', headers: H, body: JSON.stringify(args || {}) });
  if (!r.ok) throw new Error('RPC ' + fn + ' HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}
async function supaSelect(path) {
  const r = await fetch(SUPA_URL + '/rest/v1/' + path, { headers: H });
  if (!r.ok) return [];
  return r.json();
}
async function supaUpsert(table, rows) {
  const r = await fetch(SUPA_URL + '/rest/v1/' + table, {
    method: 'POST',
    headers: { ...H, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows)
  });
  if (!r.ok) console.error('[relatorio] upsert', table, 'HTTP', r.status, (await r.text()).slice(0, 200));
}

// ---------- Anthropic ----------
async function anthropic(system, user) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: system,
      messages: [{ role: 'user', content: user }]
    })
  });
  if (!r.ok) throw new Error('Anthropic HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const data = await r.json();
  let txt = (data.content || []).map(b => b.text || '').join('').trim();
  txt = txt.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(txt); } catch (e) { return { resumo: '', relatorio_html: txt, plano_html: '' }; }
}

// ---------- utilidades ----------
function isoSemana(d) {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const ano = dt.getUTCFullYear();
  const w = Math.ceil((((dt - new Date(Date.UTC(ano, 0, 1))) / 86400000) + 1) / 7);
  return ano + '-W' + String(w).padStart(2, '0');
}
function ymd(d) { return d.toISOString().slice(0, 10); }
function normaliza(s) { return (s || '').toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim(); }
function cidadeBate(pCidade, alvo) {
  let lista = pCidade;
  if (typeof lista === 'string') { try { lista = JSON.parse(lista); } catch (e) { lista = [lista]; } }
  if (!Array.isArray(lista)) lista = [lista];
  const a = normaliza(alvo);
  return lista.some(c => normaliza(c) === a || normaliza(c).includes(a) || a.includes(normaliza(c)));
}

async function notificar(pessoaId, titulo, mensagem) {
  const linha = {
    id: (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('n' + Date.now() + Math.random().toString(36).slice(2, 8)),
    para_pessoa_id: pessoaId,
    de_pessoa_id: null,
    de_nome: 'Relatórios da Rede',
    tipo: 'relatorio_semanal',
    titulo: titulo,
    mensagem: mensagem,
    link: 'cidades',
    lida: false
  };
  try { await supaUpsert('notificacoes', [linha]); } catch (e) {}
  // push (best-effort)
  if (SITE) {
    try {
      await fetch(SITE + '/.netlify/functions/send-push', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pessoa_id: pessoaId, titulo: titulo, mensagem: mensagem, tipo: 'relatorio_semanal', url: '/?aba=cidades' })
      });
    } catch (e) {}
  }
}

// =============================================================================
export default async (req) => {
  if (!SUPA_KEY || !ANTHROPIC_KEY) {
    return new Response('Faltam env vars (SUPABASE_SERVICE_KEY / ANTHROPIC_API_KEY)', { status: 500 });
  }

  // 1) Puxa os dados da REDE (uma linha por cidade) — janela de 7 dias
  let rede;
  try { rede = await supaRPC('rel_rede_visao_geral', { p_dias: 7 }); }
  catch (e) { return new Response('Erro ao puxar dados da rede: ' + e.message, { status: 500 }); }
  if (!Array.isArray(rede)) rede = [];

  // 2) 🛡️ TRAVA ANTI-VAZIO
  const num = (v) => parseInt(v || 0) || 0;
  const totalCorridas = rede.reduce((s, r) => s + num(r.total_corridas), 0);
  if (rede.length < MIN_CIDADES || totalCorridas === 0) {
    const msg = `[relatorio-semanal] ABORTADO: dados insuficientes (cidades=${rede.length}, corridas=${totalCorridas}). Nenhum relatório gerado.`;
    console.warn(msg);
    return new Response(msg, { status: 200 });
  }

  const hoje = new Date();
  const ref = isoSemana(hoje);
  const fim = new Date(hoje); fim.setDate(fim.getDate() - 1);
  const ini = new Date(hoje); ini.setDate(ini.getDate() - 7);

  const pessoas = await supaSelect('pessoas?select=id,nome,nivel_permissao,cidade');
  const diretores = pessoas.filter(p => ['diretoria', 'super_admin'].includes(p.nivel_permissao));

  // resumo numérico da rede pra alimentar a IA
  const linhasRede = rede.map(r =>
    `- ${r.cidade || 'Cidade'}: ${num(r.total_corridas)} corridas, ${num(r.total_finalizadas)} finalizadas, ${num(r.motoboys_unicos)} motoboys, ${num(r.empresas_unicos)} empresas`
  ).join('\n');

  let geradosRede = 0, geradosCidade = 0;

  // 3) RELATÓRIO GERAL (diretoria — plano ESTRATÉGICO de rede)
  try {
    const sys = 'Você é analista de operações da Gâmi Delivery (logística de entregas em 11 cidades). Escreva em português do Brasil, objetivo e executivo. Responda SOMENTE com um JSON válido, sem markdown, no formato: {"resumo": "1-2 frases", "relatorio_html": "<h3>...</h3><p>...</p>", "plano_html": "<ul><li>...</li></ul>"}. Use HTML simples (h3, p, ul, li, strong). Sem inventar números além dos fornecidos.';
    const usr = `Relatório SEMANAL da REDE (semana ${ref}). Dados das cidades (últimos 7 dias):\n${linhasRede}\n\nTotal de corridas na rede: ${totalCorridas}.\n\nProduza: (1) relatorio_html = panorama executivo da rede (destaques, cidades que puxam pra cima/baixo, tendência); (2) plano_html = plano de ação ESTRATÉGICO para a DIRETORIA (decisões de rede, prioridades entre cidades, riscos, oportunidades — NÃO tarefas operacionais).`;
    const out = await anthropic(sys, usr);
    await supaUpsert('relatorios_rede', [{
      tipo: 'semanal', escopo: 'rede', cidade_slug: null, cidade_nome: null,
      referencia: ref, periodo_inicio: ymd(ini), periodo_fim: ymd(fim),
      titulo: 'Relatório semanal da rede — ' + ref,
      resumo: out.resumo || '', conteudo_html: out.relatorio_html || '', plano_acao_html: out.plano_html || '',
      metricas: { total_corridas: totalCorridas, cidades: rede.length }
    }]);
    geradosRede = 1;
    for (const d of diretores) await notificar(d.id, '📄 Relatório semanal da rede pronto', 'O panorama das 11 cidades e o plano de ação da semana já estão em Relatórios da Rede.');
  } catch (e) { console.error('[relatorio] rede falhou:', e.message); }

  // 4) RELATÓRIO POR CIDADE (gestor — plano OPERACIONAL)
  for (const r of rede) {
    const nome = r.cidade || 'Cidade';
    try {
      const sys = 'Você é analista de operações da Gâmi Delivery. Português do Brasil, objetivo. Responda SOMENTE com JSON válido (sem markdown): {"resumo":"1-2 frases","relatorio_html":"<h3>...</h3>","plano_html":"<ul><li>...</li></ul>"}. HTML simples. Não invente números.';
      const usr = `Relatório SEMANAL da cidade ${nome} (semana ${ref}). Dados (7 dias): ${num(r.total_corridas)} corridas, ${num(r.total_finalizadas)} finalizadas, ${num(r.motoboys_unicos)} motoboys ativos, ${num(r.empresas_unicos)} empresas ativas.\n\nProduza: (1) relatorio_html = como foi a operação da cidade na semana; (2) plano_html = plano de ação OPERACIONAL para o GESTOR da cidade (ações concretas da semana: empresas a recuperar, motoboys, horários, metas — prático e executável).`;
      const out = await anthropic(sys, usr);
      const slug = normaliza(nome).replace(/\s+/g, '-');
      await supaUpsert('relatorios_rede', [{
        tipo: 'semanal', escopo: 'cidade', cidade_slug: slug, cidade_nome: nome,
        referencia: ref, periodo_inicio: ymd(ini), periodo_fim: ymd(fim),
        titulo: 'Relatório semanal — ' + nome + ' — ' + ref,
        resumo: out.resumo || '', conteudo_html: out.relatorio_html || '', plano_acao_html: out.plano_html || '',
        metricas: { total_corridas: num(r.total_corridas), motoboys: num(r.motoboys_unicos), empresas: num(r.empresas_unicos) }
      }]);
      geradosCidade++;
      // notifica o(s) gestor(es) dessa cidade
      const gestores = pessoas.filter(p => p.nivel_permissao === 'gestor' && cidadeBate(p.cidade, nome));
      for (const g of gestores) await notificar(g.id, '📄 Relatório semanal de ' + nome, 'Seu relatório e plano de ação da semana já estão em Relatórios da Rede.');
    } catch (e) { console.error('[relatorio] cidade', nome, 'falhou:', e.message); }
  }

  const resumo = `Gerados: ${geradosRede} de rede + ${geradosCidade} de cidade (semana ${ref}).`;
  console.log('[relatorio-semanal]', resumo);
  return new Response(resumo, { status: 200 });
};
