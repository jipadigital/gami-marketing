// NAV FIX - Emergency override
(function() {
  function fixNav() {
    window.nav = function(el, page) {
      try {
        document.querySelectorAll('.nav-item').forEach(function(n) {
          n.classList.remove('active');
          n.style.borderLeft = '';
        });
        if (el) {
          el.classList.add('active');
          el.style.borderLeft = '3px solid var(--orange)';
        }
        document.querySelectorAll('.page').forEach(function(p) {
          p.classList.remove('active');
          p.style.display = 'none';
        });
        var pg = document.getElementById('pg-' + page);
        if (pg) {
          pg.classList.add('active');
          pg.style.display = 'block';
          try { document.getElementById('main-content').scrollTop = 0; } catch(e) {}
        }
        var s = function(fn, d) { setTimeout(function(){ try{fn();}catch(e){console.warn(e)} }, d||50); };
        if (page === 'dashboard')       { s(initDashboard); s(renderAlertasCampanhas, 100); }
        if (page === 'cidades')         { s(function(){ voltarCidades(); renderCidadesGrid(); }); }
        if (page === 'pessoas')         { s(renderPessoas); }
        if (page === 'inbox')           { s(renderInboxLista); }
        if (page === 'blog')            { s(initBlogPage); }
        if (page === 'guia-n8n')        { s(function(){ navGuiaTab('inicio'); }); }
        if (page === 'relatorio-diario'){ s(initRelatorio); }
        if (page === 'comandos')        { s(function(){ renderCmdTab('Conteudo e Posts'); }); }
        if (page === 'ranking')         { s(renderRanking); }
        if (page === 'ideias')          { s(renderIdeias); }
        if (page === 'campanhas')       { s(renderCampanhas); }
      } catch(err) { console.error('nav error:', err); }
    };
    
    // Also fix initial dashboard display
    var dash = document.getElementById('pg-dashboard');
    if (dash) {
      dash.style.display = 'block';
      dash.classList.add('active');
    }
    
    console.log('✅ Nav fix applied');
  }
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fixNav);
  } else {
    fixNav();
  }
})();
