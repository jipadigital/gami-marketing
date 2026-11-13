// Netlify Function: envia push (Web Push) pros aparelhos de uma ou mais pessoas.
// Endpoint: /.netlify/functions/send-push   (exige sessão do painel ou chamada interna)
//
// Body (POST):
// {
//   "pessoa_ids": ["id1", "id2"],   // ou "pessoa_id": "id_unico"
//   "titulo": "Nova tarefa de Cleyton",
//   "mensagem": "Postar 3 stories sobre...",
//   "tipo": "tarefa_nova",            // opcional
//   "url": "/?aba=tarefas"            // opcional (só caminho do próprio painel)
// }
// Body de diagnóstico (não envia nada): { "acao": "diagnostico" }
//
// 13/11/2026: reescrita. A versão antiga lia a tabela de inscrições num formato que não
// existe mais e mandava o texto num formato que o app não lê: nenhum push saía. A lógica de
// envio agora mora em netlify/lib/push.js (a mesma usada pelo push de compromissos).

const { exigirSessao } = require('../lib/sessao');
const { paresVapid, inscricoesDe, enviarParaPessoas } = require('../lib/push');

exports.handler = async function (event) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors };
  // SEGURANÇA (auditoria 13/11/2026): exige a sessão do painel ou chamada interna.
  const _acesso = await exigirSessao(event);
  if (!_acesso.ok) return _acesso.resposta(cors);
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ erro: 'Use POST' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ erro: 'JSON inválido' }) }; }

  // Diagnóstico: mostra se o servidor tem chaves de push e quantos aparelhos de QUEM CHAMA
  // estão inscritos. Não envia nada. (A chave pública não é segredo; mostramos só o começo
  // pra conferir com a que o painel usa.)
  if (body.acao === 'diagnostico') {
    const pares = paresVapid();
    let meus = null;
    try { if (_acesso.usuario) meus = (await inscricoesDe([_acesso.usuario.pessoa_id])).length; } catch (e) { meus = 'erro: ' + e.message; }
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({ ok: true, pares_de_chave: pares.length, chaves_publicas: pares.map((p) => String(p.publicKey).slice(0, 10)), meus_aparelhos_inscritos: meus }),
    };
  }

  let pessoaIds = [];
  if (Array.isArray(body.pessoa_ids)) pessoaIds = body.pessoa_ids;
  else if (body.pessoa_id) pessoaIds = [body.pessoa_id];
  if (!pessoaIds.length) return { statusCode: 400, headers: cors, body: JSON.stringify({ erro: 'pessoa_id ou pessoa_ids obrigatório' }) };

  try {
    const r = await enviarParaPessoas(pessoaIds, {
      titulo: body.titulo,
      mensagem: body.mensagem,
      tipo: body.tipo,
      url: body.url,
    });
    return { statusCode: r.ok ? 200 : 500, headers: cors, body: JSON.stringify(r) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ ok: false, erro: String((e && e.message) || e) }) };
  }
};
