// service-worker.js
// PWA Gâmi Marketing — v23.111
// SEGURANÇA: cache só de assets estáticos. APIs sempre fresh.

const CACHE_VERSION = 'v23-111-2026-08-14';
const CACHE_NAME = 'gami-' + CACHE_VERSION;

// 🚫 NUNCA cacheia: APIs, functions, autenticação
const NEVER_CACHE = [
  /\.netlify\/functions\//i,
  /supabase\.co/i,
  /graph\.facebook\.com/i,
  /taximachine\.com\.br/i,
  /api\.anthropic\.com/i,
  /api\.github\.com/i,
  /githubusercontent\.com/i  // imagens de stories vêm daqui
];

// ✅ Cache-first (assets estáticos de longa duração)
const CACHE_FIRST = [
  /\.(woff|woff2|ttf|eot|otf)$/i,
  /fonts\.googleapis\.com/i,
  /fonts\.gstatic\.com/i,
  /cdnjs\.cloudflare\.com/i,
  /unpkg\.com/i,
  /\.(png|jpg|jpeg|svg|webp|ico|gif)$/i,
  /\/broches-gami\//i,
  /\/icons\//i
];

// INSTALL
self.addEventListener('install', function(event) {
  console.log('[SW]', CACHE_VERSION, 'install');
  // Pré-cache só do que é seguro: manifest e icons
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll([
        '/manifest.json',
        '/icons/icon-192.png',
        '/icons/icon-512.png',
        '/icons/apple-touch-icon.png'
      ]).catch(function(e){ console.warn('[SW] pre-cache parcial:', e); });
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

// ACTIVATE — limpa caches antigos
self.addEventListener('activate', function(event) {
  console.log('[SW]', CACHE_VERSION, 'activate');
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(n) {
          return n.indexOf('gami-') === 0 && n !== CACHE_NAME;
        }).map(function(n) {
          console.log('[SW] limpando cache antigo:', n);
          return caches.delete(n);
        })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// FETCH — interceptação cautelosa
self.addEventListener('fetch', function(event) {
  var req = event.request;
  var url = req.url;
  
  // Só intercepta GET
  if (req.method !== 'GET') return;
  
  // Ignora extensões browser, dev tools, chrome-extension://
  if (!url.startsWith('http')) return;
  
  // 🚫 APIs e functions: SEMPRE network, NUNCA cache
  if (NEVER_CACHE.some(function(p){ return p.test(url); })) {
    return;  // deixa o browser tratar normalmente, SW não interfere
  }
  
  // ✅ Cache-first pra assets estáticos
  if (CACHE_FIRST.some(function(p){ return p.test(url); })) {
    event.respondWith(
      caches.match(req).then(function(cached) {
        if (cached) return cached;
        return fetch(req).then(function(res) {
          if (res && res.ok) {
            var clone = res.clone();
            caches.open(CACHE_NAME).then(function(c){ c.put(req, clone); }).catch(function(){});
          }
          return res;
        }).catch(function() {
          return cached || new Response('', { status: 504 });
        });
      })
    );
    return;
  }
  
  // 🌐 Network-first pra TUDO O MAIS (HTML, JS inline, etc)
  // Sempre tenta servidor primeiro. Cache só como fallback se offline.
  event.respondWith(
    fetch(req).then(function(res) {
      // Só cacheia respostas same-origin
      if (res && res.ok && (res.type === 'basic' || res.type === 'default')) {
        var clone = res.clone();
        caches.open(CACHE_NAME).then(function(c){ c.put(req, clone); }).catch(function(){});
      }
      return res;
    }).catch(function() {
      // Offline: tenta servir do cache
      return caches.match(req).then(function(cached) {
        if (cached) return cached;
        // Se nem no cache tem, retorna offline page (se for navegação)
        if (req.mode === 'navigate') {
          return caches.match('/');
        }
        return new Response('Offline', { status: 504, statusText: 'Offline' });
      });
    })
  );
});

// MESSAGE — controle externo
self.addEventListener('message', function(event) {
  if (!event.data) return;
  
  // Atualização forçada
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  // Limpa cache (kill switch)
  if (event.data.type === 'CLEAR_CACHE') {
    caches.keys().then(function(names) {
      Promise.all(names.map(function(n){ return caches.delete(n); }));
    });
  }
});
