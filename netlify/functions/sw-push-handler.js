// ============================================================
// Snippet pra adicionar no SERVICE-WORKER.JS existente
// 
// Cole esse código no FINAL do arquivo /service-worker.js
// que está na raiz do projeto Netlify (junto com index.html).
// ============================================================

// Handler de PUSH (chamado pelo navegador quando chega push)
self.addEventListener('push', function(event){
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch(e){
    data = { titulo: 'Gâmi', mensagem: event.data ? event.data.text() : '' };
  }
  
  const titulo = data.titulo || 'Gâmi Marketing';
  const opts = {
    body: data.mensagem || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tipo || 'gami-notif',
    requireInteraction: false,
    data: {
      url: data.url || '/',
      ts: data.ts || Date.now()
    },
    actions: [
      { action: 'abrir', title: 'Abrir' },
      { action: 'fechar', title: 'Dispensar' }
    ]
  };
  
  event.waitUntil(
    self.registration.showNotification(titulo, opts)
  );
});

// Click na notificação: foca/abre a janela do app
self.addEventListener('notificationclick', function(event){
  event.notification.close();
  if(event.action === 'fechar') return;
  
  const url = (event.notification.data && event.notification.data.url) || '/';
  
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clients){
      // Se já tem janela do app aberta, foca nela
      for(let i = 0; i < clients.length; i++){
        const c = clients[i];
        if(c.url.indexOf(self.location.origin) >= 0){
          c.focus();
          if(c.navigate && url !== '/') c.navigate(url);
          return;
        }
      }
      // Senão, abre nova
      if(self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

// Quando recebe mensagem do app (futuro)
self.addEventListener('message', function(event){
  if(event.data && event.data.type === 'SKIP_WAITING'){
    self.skipWaiting();
  }
});
