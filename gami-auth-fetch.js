/* gami-auth-fetch.js (10/11/2026)
   A função da Machine (/.netlify/functions/machine) agora exige a sessão do dashboard.
   Em vez de mexer em cada uma das chamadas espalhadas pelo index.html, este script
   acrescenta X-Gami-User + X-Gami-Token automaticamente SÓ nas chamadas para ela
   (mesmo domínio). Nada é enviado para outros sites. */
(function(){
  'use strict';
  if(window.__gamiAuthFetch) return;
  window.__gamiAuthFetch = true;
  var original = window.fetch;
  if(typeof original !== 'function') return;
  var ALVOS = ['/.netlify/functions/machine'];
  function precisa(url){
    try {
      var u = new URL(url, location.href);
      if(u.origin !== location.origin) return false;   // nunca manda a sessão pra fora
      return ALVOS.some(function(a){ return u.pathname === a; });
    } catch(e){ return false; }
  }
  window.fetch = function(entrada, opcoes){
    try {
      var url = typeof entrada === 'string' ? entrada : (entrada && entrada.url) || '';
      if(precisa(url)){
        var uid = '', tok = '';
        try { var u = JSON.parse(localStorage.getItem('gami_usuario_logado') || 'null'); uid = (u && (u.id || u.pessoa_id)) || ''; } catch(e){}
        try { tok = localStorage.getItem('gami_sessao_token') || ''; } catch(e){}
        opcoes = Object.assign({}, opcoes || {});
        var h = new Headers(opcoes.headers || (typeof entrada !== 'string' && entrada.headers) || {});
        if(uid && !h.has('X-Gami-User')) h.set('X-Gami-User', uid);
        if(tok && !h.has('X-Gami-Token')) h.set('X-Gami-Token', tok);
        opcoes.headers = h;
      }
    } catch(e){}
    return original.call(this, entrada, opcoes);
  };
})();
