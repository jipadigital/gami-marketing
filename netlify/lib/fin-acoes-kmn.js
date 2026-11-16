// netlify/lib/fin-acoes-kmn.js
// v9 (16/11/2026): CONFERÊNCIA DO KAMINO. O espelho (fin_kmn_*) é preenchido sozinho pelo
// kamino-sync; aqui ficam as ações da tela: listar, ver o histórico e conferir.
// Toda escrita é RPC (transação + ator carimbado + auditoria). Filtros validados antes da URL.
// ============================================================
'use strict';

module.exports = function(h){
  const { rest, rpc, ErroUsuario, txt, dataOk, intOk, textoBusca, svc } = h;

  const PERM = { kmn_resumo: 'leitor', kmn_listar: 'leitor', kmn_ver: 'leitor', kmn_mudancas: 'leitor', kmn_conferir: 'conferente', kmn_sync_status: 'leitor', kmn_recorrencias: 'leitor' };
  const STATUS = ['pendente', 'mudou', 'aguardando_2a', 'ok', 'divergente', 'suspeito'];
  const tipoOk = v => (v === 'receber' ? 'receber' : 'pagar');
  const campoOk = v => (v === 'vencimento' ? 'vencimento' : 'data_pagamento');
  function periodo(b){
    const ini = dataOk(b.ini), fim = dataOk(b.fim);
    if(!ini || !fim || fim < ini) throw new ErroUsuario('Período inválido');
    if((Date.parse(fim) - Date.parse(ini)) / 864e5 > 800) throw new ErroUsuario('Período grande demais (máx. 800 dias)');
    return { ini, fim };
  }
  async function pagina(path, pag, tam){
    const t = tam || 200;
    const p = Math.min(Math.max(0, parseInt(pag, 10) || 0), 1000);
    const { data, headers } = await rest(path, { headers: svc({ 'Range-Unit': 'items', Range: (p * t) + '-' + (p * t + t - 1), Prefer: 'count=exact' }) });
    return { linhas: data || [], total: Number(String(headers.get('content-range') || '').split('/')[1]) || 0, pagina: p, tamanho: t };
  }
  const COLS = 'id,tipo,kamino_id,dados,versao,alterado_em,sumiu_em,pessoa,valor,valor_pago,vencimento,data_pagamento,situacao,unidade,classificacao,oks,ult_res,ult_por,ult_em,conferido_antes,conf_status';

  const acoes = {
    async kmn_resumo(b){
      const { ini, fim } = periodo(b);
      return { resumo: await rpc('fin_kmn_resumo', { p_tipo: tipoOk(b.tipo), p_campo: campoOk(b.campo) === 'vencimento' ? 'vencimento' : 'pagamento', p_ini: ini, p_fim: fim }) };
    },

    async kmn_listar(b){
      const tipo = tipoOk(b.tipo), campo = campoOk(b.campo);
      const { ini, fim } = periodo(b);
      const f = ['tipo=eq.' + tipo, campo + '=gte.' + ini, campo + '=lte.' + fim];
      if(b.sumidos === true) f.push('sumiu_em=not.is.null'); else f.push('sumiu_em=is.null');
      // "falta conferir" = pendente, mudou depois de conferido ou esperando a 2ª pessoa
      if(b.conf === 'falta') f.push('conf_status=in.(pendente,mudou,aguardando_2a)');
      else if(b.conf === 'problema') f.push('conf_status=in.(divergente,suspeito)');
      else if(STATUS.indexOf(b.conf) >= 0) f.push('conf_status=eq.' + b.conf);
      if(b.situacao === 'pagos') f.push('data_pagamento=not.is.null');
      if(b.situacao === 'pendentes') f.push('data_pagamento=is.null');
      if(b.alterados === true) f.push('versao=gt.1');
      const serie = txt(b.serie, 60); if(serie && /^[A-Za-z0-9_.-]+$/.test(serie)) f.push('dados->>serie=eq.' + encodeURIComponent(serie));
      const un = txt(b.unidade, 120);
      if(un) f.push('unidade=eq.' + encodeURIComponent(un));
      const q = textoBusca(b.busca);
      if(q) f.push('or=(pessoa.ilike.*' + encodeURIComponent(q) + '*,dados->>descricao.ilike.*' + encodeURIComponent(q) + '*,dados->>classificacao.ilike.*' + encodeURIComponent(q) + '*)');
      const ordem = campo + '.desc.nullslast,id.desc';
      return pagina('fin_kmn_v?select=' + COLS + '&' + f.join('&') + '&order=' + ordem, b.pagina, 200);
    },

    async kmn_ver(b){
      const id = intOk(b.id); if(!id) throw new ErroUsuario('Lançamento inválido');
      const [l] = (await rest('fin_kmn_v?id=eq.' + id + '&select=*')).data || [];
      if(!l) throw new ErroUsuario('Não encontrado', 404);
      const [versoes, confs, alertas] = await Promise.all([
        rest('fin_kmn_v_mudancas?lanc_id=eq.' + id + '&select=versao,visto_em,mudou,antes,depois&order=versao.desc&limit=100').then(r => r.data || []),
        rest('fin_kmn_conf?lanc_id=eq.' + id + '&select=id,versao,resultado,observacao,por,em&order=em.desc&limit=100').then(r => r.data || []),
        rest('fin_alertas?kmn_lanc_id=eq.' + id + '&select=id,regra,severidade,titulo,status,criado_em,resolvido_por,justificativa&order=criado_em.desc&limit=50').then(r => r.data || []),
      ]);
      return { lanc: l, versoes, confs, alertas };
    },

    async kmn_mudancas(b){
      const { ini, fim } = periodo(b);
      const f = ['versao=gt.1', 'visto_em=gte.' + ini + 'T00:00:00-03:00', 'visto_em=lte.' + fim + 'T23:59:59-03:00'];
      if(b.tipo === 'pagar' || b.tipo === 'receber') f.push('tipo=eq.' + b.tipo);
      return pagina('fin_kmn_v_mudancas?select=id,lanc_id,versao,visto_em,mudou,antes,depois,tipo,kamino_id,pessoa,unidade,sumiu_em&' + f.join('&') + '&order=visto_em.desc,id.desc', b.pagina, 100);
    },

    async kmn_conferir(b, ctx){
      const ids = Array.isArray(b.ids) ? b.ids.map(intOk).filter(Boolean) : [];
      if(!ids.length || ids.length > 500) throw new ErroUsuario('Selecione de 1 a 500 lançamentos');
      const res = ['ok', 'divergente', 'suspeito'].indexOf(b.resultado) >= 0 ? b.resultado : null;
      if(!res) throw new ErroUsuario('Escolha o resultado');
      const obs = txt(b.observacao, 1000);
      if(res !== 'ok' && obs.length < 10) throw new ErroUsuario('Escreva o que está errado (mín. 10 letras)');
      return rpc('fin_kmn_conferir', { p_ator: ctx.pessoaId, p_ids: ids, p_resultado: res, p_obs: obs || null });
    },

    // Recorrências do Kamino (só leitura). pagar: por série do Kamino; receber: por empresa + cidade
    async kmn_recorrencias(b){
      const receber = b.tipo === 'receber';
      const f = [];
      const un = txt(b.unidade, 120); if(un) f.push('unidade=eq.' + encodeURIComponent(un));
      const q = textoBusca(b.busca); if(q) f.push('pessoa=ilike.*' + encodeURIComponent(q) + '*');
      if(!receber && b.so === 'ativas') f.push('futuras=gt.0');
      if(!receber && b.so === 'varia') f.push('valor_varia=is.true');
      if(receber && b.so === 'atraso') f.push('atrasadas=gt.0');
      const view = receber ? 'fin_kmn_v_rec_receber' : 'fin_kmn_v_rec_pagar';
      const ordem = receber ? 'total_atrasado.desc.nullslast,pessoa.asc' : 'proximo_venc.asc.nullslast,pessoa.asc';
      return pagina(view + '?select=*' + (f.length ? '&' + f.join('&') : '') + '&order=' + ordem, b.pagina, 200);
    },

    async kmn_sync_status(){
      const linhas = (await rest('fin_kmn_sync?select=chave,estado,ultimo_ok,ultimo_erro,ultimo_erro_em,atualizado_em')).data || [];
      // só o que interessa na tela (sem a lista de ids da janela)
      return { sync: linhas.map(l => ({ chave: l.chave, ultimo_ok: l.ultimo_ok, ultimo_erro: l.ultimo_erro, ultimo_erro_em: l.ultimo_erro_em, atualizado_em: l.atualizado_em,
        volta: l.estado && l.estado.volta, janela_ate: l.estado && l.estado.v_ate, cursor: l.estado && l.estado.cursor,
        confirmar: l.estado && Array.isArray(l.estado.confirmar) ? l.estado.confirmar.length : 0, ultima_volta: l.estado && l.estado.ultima_volta })) };
    },
  };

  return { acoes, perm: PERM };
};
