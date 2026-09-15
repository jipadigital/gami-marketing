// netlify/functions/sorteio-terca.mjs
// -----------------------------------------------------------------------------
// 🌟 Pessoa Gâmi da semana — sorteio ÚNICO no servidor (toda terça).
// Antes o sorteio era feito no aparelho de cada pessoa que abria o ranking, o que
// causava CORRIDA (dois aparelhos sorteavam quase juntos → dois ganhadores +20).
// Agora roda 1x, no schedule. Idempotente: se já sorteou a semana, não repete.
//
// Grava +20 (tipo_acao 'spotlight') em pontos_log e o vencedor em
// configuracoes/spotlight_semana (o card do ranking só EXIBE esse valor).
// Env: SUPA_SERVICE_KEY.
//
// SCHEDULE desligado por ora (pra testar via HTTP). Depois ligar:
//   export const config = { schedule: '0 11 * * 2' };  // terça 11h UTC = 08h BR
// -----------------------------------------------------------------------------

const SUPA_URL = 'https://tdbyzsouhrhmhpctttps.supabase.co';

// Roda toda TERÇA às 11h UTC (08h no horário BR). Idempotente: só sorteia 1x/semana.
export const config = { schedule: '0 11 * * 2' };

export default async () => {
  const SVC = process.env.SUPA_SERVICE_KEY;
  if(!SVC) return json({ ok:false, error:'SUPA_SERVICE_KEY ausente' });
  const sh = () => ({ apikey: SVC, Authorization: 'Bearer ' + SVC, 'Content-Type': 'application/json' });

  // semanaKey = data LOCAL (BR, UTC-3) da terça
  const brNow = new Date(Date.now() - 3 * 3600 * 1000);
  const semanaKey = brNow.toISOString().slice(0, 10);
  const ref = 'spotlight_' + semanaKey;

  // idempotência: já tem o +20 desta semana?
  const rc = await fetch(SUPA_URL + '/rest/v1/pontos_log?tipo_acao=eq.spotlight&referencia_id=eq.' + encodeURIComponent(ref) + '&select=id&limit=1', { headers: sh() });
  const jc = await rc.json().catch(() => []);
  if(Array.isArray(jc) && jc.length) return json({ ok:true, ja_sorteado:true, semana: semanaKey });

  // pessoas elegíveis (exclui contas de teste)
  const rp = await fetch(SUPA_URL + '/rest/v1/pessoas?select=id,nome,cargo,foto', { headers: sh() });
  let pessoas = await rp.json().catch(() => []);
  if(!Array.isArray(pessoas)) pessoas = [];
  const elig = pessoas.filter(p => p && p.id && p.nome && !/\bteste\b/i.test(p.nome));
  if(!elig.length) return json({ ok:false, error:'sem pessoas elegíveis' });

  const esc = elig[Math.floor(Math.random() * elig.length)];

  // +20
  const reg = {
    pessoa_id: esc.id, pessoa_nome: esc.nome, tipo_acao: 'spotlight', categoria: 'cultura',
    pontos: 20, descricao: '🌟 Pessoa Gâmi da semana', origem: 'auto', referencia_id: ref, data_acao: semanaKey
  };
  const ri = await fetch(SUPA_URL + '/rest/v1/pontos_log', { method:'POST', headers: Object.assign(sh(), { Prefer:'return=minimal' }), body: JSON.stringify(reg) });
  if(!ri.ok){ const t = await ri.text().catch(()=> ''); return json({ ok:false, error:'insert pontos HTTP '+ri.status, detalhe: t.slice(0,150) }); }

  // config (valor como STRING JSON — mesmo formato que o cliente lê)
  const valor = JSON.stringify({ semana: semanaKey, pessoa_id: esc.id, nome: esc.nome, foto: esc.foto || '', cargo: esc.cargo || '', ts: new Date().toISOString() });
  await fetch(SUPA_URL + '/rest/v1/configuracoes?on_conflict=chave', { method:'POST', headers: Object.assign(sh(), { Prefer:'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify({ chave:'spotlight_semana', valor: valor, updated_at: new Date().toISOString() }) });

  return json({ ok:true, sorteado: esc.nome, pessoa_id: esc.id, semana: semanaKey });
};

function json(o){ return new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type':'application/json' } }); }
