// service-worker.js
// v25.13 — network-first pro HTML, cache-first pros assets
// Atualizado automaticamente quando index.html muda

const CACHE_VERSION = 'gami-v25-13-' + Date.now();
const CACHE_NAME = CACHE_VERSION;

// Arquivos básicos pro PWA funcionar offline
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json'
];

// =====================================================
// INSTALL — pré-cacheia o básico
// =====================================================
self.addEventListener('install', (event) => {
  console.log('[SW] Instalando', CACHE_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()) // ativa imediatamente
  );
});

// =====================================================
// ACTIVATE — limpa caches antigos
// =====================================================
self.addEventListener('activate', (event) => {
  console.log('[SW] Ativando', CACHE_VERSION);
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names
          .filter((name) => name !== CACHE_NAME && name.startsWith('gami-'))
          .map((name) => {
            console.log('[SW] Deletando cache antigo:', name);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// =====================================================
// MESSAGE — recebe SKIP_WAITING do banner "Atualizar"
// =====================================================
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.log('[SW] SKIP_WAITING recebido');
    self.skipWaiting();
  }
});

// =====================================================
// FETCH — estratégias diferentes por tipo de recurso
// =====================================================
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Só intercepta requests do mesmo origin
  if (url.origin !== self.location.origin) return;
  
  // Não cacheia: Netlify functions, Supabase, API externa
  if (url.pathname.startsWith('/.netlify/') || 
      url.pathname.startsWith('/api/') ||
      url.hostname !== self.location.hostname) {
    return; // deixa o browser fazer normal
  }
  
  // index.html / "/" — NETWORK FIRST (sempre tenta atualizar)
  if (url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Atualiza cache com nova versão
          if (response.ok) {
            const respClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, respClone));
          }
          return response;
        })
        .catch(() => caches.match(event.request)) // offline fallback
    );
    return;
  }
  
  // Outros assets (imagens, CSS, JS) — CACHE FIRST com revalidação em background
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request).then((response) => {
        if (response.ok) {
          const respClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, respClone));
        }
        return response;
      }).catch(() => cached);
      
      return cached || fetchPromise;
    })
  );
});
