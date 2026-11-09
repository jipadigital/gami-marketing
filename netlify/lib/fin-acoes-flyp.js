// netlify/lib/fin-acoes-flyp.js
// Dados da FLYP (ZL Hub, franquia Machine) dentro do financeiro: saques Pix dos condutores,
// recargas das empresas e boletos. Origem: CSV exportado da tela "Transações Financeiras".
//
// BLINDAGEM (dado sensível: nomes de condutores + dinheiro):
//  * trava PRÓPRIA: ter papel no financeiro não basta. Só o super ou quem ele liberar em fin_flyp_acesso.
//  * toda leitura passa por RPC que registra quem viu o quê (fin_flyp_leituras, imutável).
//  * lista sempre filtrada e paginada (200), período limitado; não existe ação de exportar.
//  * nada de log com conteúdo; erros genéricos pro cliente.
// ============================================================
'use strict';

module.exports = function(h){
  const { rpc, ErroUsuario, txt, dataOk, P } = h;

  const UNIDADE_PADRAO = '6104'; // Gami Delivery São Luís (única unidade na FLYP hoje)
  const CATEGORIAS = ['saque', 'recarga', 'boleto', 'a_receber', 'outro'];
  const STATUS = ['concluido', 'efetivado', 'aberto', 'em_analise', 'expirado', 'rejeitado', 'vencido', 'quitado', 'aguardando_aprovacao', 'cancelado', 'outro'];

  // perm 'leitor' = mínimo do financeiro; a trava real é exigirFlyp() abaixo
  const PERM = { flyp_pode: 'leitor', flyp_resumo: 'leitor', flyp_listar: 'leitor', flyp_importar: 'conferente',
                 flyp_acessos: 'super', flyp_liberar: 'super', flyp_leituras: 'super' };

  async function podeVer(ctx){
    if(ctx.papel === 'super') return true;
    return (await rpc('fin_flyp_pode_ver', { p_pessoa: ctx.pessoaId })) === true;
  }
  async function exigirFlyp(ctx){
    if(!(await podeVer(ctx))) throw new ErroUsuario('Sem acesso aos dados da FLYP', 403);
  }
  const unidade = v => { const u = txt(v || UNIDADE_PADRAO, 20); if(!/^[0-9A-Za-z_-]{1,20}$/.test(u)) throw new ErroUsuario('Unidade inválida'); return u; };
  function periodo(b, maxDias){
    const ini = dataOk(b.ini), fim = dataOk(b.fim);
    if(!ini || !fim || fim < ini) throw new ErroUsuario('Período inválido');
    if((Date.parse(fim) - Date.parse(ini)) / 864e5 > maxDias) throw new ErroUsuario('Período grande demais (máx. ' + maxDias + ' dias)');
    return { ini, fim };
  }

  const acoes = {
    async flyp_pode(b, ctx){ return { pode: await podeVer(ctx), super: ctx.papel === 'super' }; },

    async flyp_resumo(b, ctx){
      await exigirFlyp(ctx);
      const { ini, fim } = periodo(b, 400);
      return { resumo: await rpc('fin_flyp_resumo', { p_ator: ctx.pessoaId, p_unidade: unidade(b.unidade), p_ini: ini, p_fim: fim }) };
    },

    async flyp_listar(b, ctx){
      await exigirFlyp(ctx);
      const { ini, fim } = periodo(b, 62);
      const cat = CATEGORIAS.indexOf(b.categoria) >= 0 ? b.categoria : null;
      const st = STATUS.indexOf(b.status) >= 0 ? b.status : null;
      const busca = txt(b.busca, 60) || null;
      const pagina = Math.min(Math.max(0, parseInt(b.pagina, 10) || 0), 500);
      return await rpc('fin_flyp_listar', { p_ator: ctx.pessoaId, p_unidade: unidade(b.unidade), p_ini: ini, p_fim: fim,
        p_categoria: cat, p_status: st, p_busca: busca, p_pagina: pagina });
    },

    async flyp_importar(b, ctx){
      await exigirFlyp(ctx);
      const conteudo = typeof b.conteudo === 'string' ? b.conteudo : '';
      if(!conteudo) throw new ErroUsuario('Arquivo vazio');
      if(Buffer.byteLength(conteudo) > 4 * 1024 * 1024) throw new ErroUsuario('Arquivo grande demais (máx. 4 MB). Exporte um período menor.');
      const dir = b.direcao === 'entrada' || b.direcao === 'saida' ? b.direcao : null;
      const res = P.parseFlyp(conteudo, { direcao: dir });
      if(!res.ok) throw new ErroUsuario(res.erro);
      const soma = (f) => Math.round(res.linhas.filter(f).reduce((a, l) => a + l.valor, 0) * 100) / 100;
      const resumo = {
        linhas: res.linhas.length, periodo_ini: res.periodo_ini, periodo_fim: res.periodo_fim,
        saques: res.linhas.filter(l => l.categoria === 'saque' && l.status === 'concluido').length,
        saques_valor: soma(l => l.categoria === 'saque' && l.status === 'concluido'),
        recargas: res.linhas.filter(l => l.categoria === 'recarga' && l.status === 'efetivado').length,
        recargas_valor: soma(l => l.categoria === 'recarga' && l.status === 'efetivado'),
        boletos: res.linhas.filter(l => l.categoria === 'boleto' || l.categoria === 'a_receber').length
      };
      if(!b.confirmar) return { preview: true, resumo };
      const r = await rpc('fin_flyp_importar', {
        p_ator: ctx.pessoaId,
        p_meta: { unidade: unidade(b.unidade), arquivo_nome: txt(b.arquivo_nome, 200), sha256: res.sha256, bytes: Buffer.byteLength(conteudo), conteudo },
        p_linhas: res.linhas
      });
      if(r && r.ok === false) throw new ErroUsuario(r.erro);
      return Object.assign({ resumo }, r);
    },

    // ---- só o super
    async flyp_acessos(){
      const [acessos, equipe] = await Promise.all([
        h.lerTodos('fin_flyp_acesso?select=pessoa_id,ativo,liberado_por,liberado_em,atualizado_por,atualizado_em&order=liberado_em.desc', 500),
        h.lerTodos('fin_equipe?select=pessoa_id,nome&order=nome.asc', 2000)
      ]);
      return { acessos, equipe };
    },
    async flyp_liberar(b, ctx){
      const pessoa = txt(b.pessoa_id, 80);
      if(!/^[A-Za-z0-9_-]{2,80}$/.test(pessoa)) throw new ErroUsuario('Pessoa inválida');
      return rpc('fin_flyp_liberar', { p_ator: ctx.pessoaId, p_pessoa: pessoa, p_ativo: b.ativo !== false });
    },
    async flyp_leituras(b){
      const pagina = Math.min(Math.max(0, parseInt(b.pagina, 10) || 0), 1000);
      return { leituras: await h.lerTodos('fin_flyp_leituras?select=id,ator,acao,filtro,qtd,em&order=em.desc&offset=' + (pagina * 200) + '&limit=200', 200) };
    }
  };

  return { acoes, perm: PERM };
};
