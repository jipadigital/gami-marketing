// NAV FIX v3 - safe init
(function(){
  function safeRun(fn){ try{ fn(); }catch(e){ console.warn('nav init:', e.message); } }

  window.nav = function(el, page){
    safeRun(function(){
      document.querySelectorAll('.nav-item').forEach(function(n){ n.classList.remove('active'); });
      if(el) el.classList.add('active');
      document.querySelectorAll('.page').forEach(function(p){
        p.classList.remove('active');
        p.style.cssText = 'display:none';
      });
      var pg = document.getElementById('pg-' + page);
      if(pg){
        pg.classList.add('active');
        pg.style.cssText = 'display:block;visibility:visible;opacity:1';
        try{ document.getElementById('main-content').scrollTop = 0; }catch(e){}
      }
      var s = function(fn, d){ setTimeout(function(){ safeRun(fn); }, d||60); };
      if(page==='dashboard')     { s(initDashboard); s(renderAlertasCampanhas,120); }
      if(page==='calendario')    { s(function(){ renderCalendar(); renderProximosBdays(); }); }
      if(page==='tarefas')       { s(initTarefas); }
      if(page==='campanhas')     { s(function(){ syncMeta(); }); }
      if(page==='cidades')       { s(function(){ voltarCidades(); renderCidadesGrid(); }); }
      if(page==='pessoas')       { s(renderPessoas); }
      if(page==='inbox')         { s(renderInboxLista); }
      if(page==='blog')          { s(initBlogPage); }
      if(page==='ranking')       { s(function(){ if(typeof renderRanking==='function') renderRanking(); }); }
      if(page==='ideias')        { s(function(){ if(typeof renderIdeias==='function') renderIdeias(); }); }
      if(page==='comandos')      { s(function(){ renderCmdTab('Conteúdo e Posts'); }); }
      if(page==='relatorio-diario') { s(function(){ if(typeof initRelatorio==='function') initRelatorio(); }); }
      if(page==='jipa-dashboard'){ s(initJipaDashboard); }
      if(page==='jipa-clientes') { s(renderJipaClientes); }
      if(page==='jipa-tarefas')  { s(renderJipaTarefas); }
      if(page==='jipa-conteudo') { s(renderJipaConteudo); }
      if(page==='jipa-trafego')  { s(renderJipaTrafego); }
      if(page==='jipa-financeiro'){ s(renderJipaFinanceiro); }
      if(page==='jipa-pipeline') { s(renderJipaPipeline); }
      if(page==='jipa-propostas'){ s(renderJipaPropostas); }
      if(page==='jipa-relatorios'){ s(renderJipaRelatorios); }
      if(page==='jipa-midia')    { s(initMidiaJipa); }
    });
  };

  // Safe app start
  function appStart(){
    safeRun(function(){
      var pg = document.getElementById('pg-dashboard');
      if(pg){ pg.style.display='block'; pg.classList.add('active'); }
      var nG = document.getElementById('nav-gami');
      var nJ = document.getElementById('nav-jipa');
      if(nG) nG.style.display='block';
      if(nJ) nJ.style.display='none';
      var first = document.querySelector('#nav-gami .nav-item');
      if(first) first.classList.add('active');
    });
    setTimeout(function(){ safeRun(function(){ initDashboard(); }); }, 150);
    setTimeout(function(){ safeRun(function(){ renderAlertasCampanhas(); }); }, 250);
    setTimeout(function(){ safeRun(function(){ initSupabase(); }); }, 1500);
    setInterval(function(){ safeRun(function(){ syncTudo(false); }); }, 5*60*1000);
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', function(){ setTimeout(appStart, 100); });
  } else {
    setTimeout(appStart, 100);
  }

  console.log('✅ Nav fix v3 loaded');
})();
