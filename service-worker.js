// Service worker di Lupus.
// Strategia: rispondi subito dalla cache se disponibile (così l'app si apre
// istantaneamente anche offline), e nel frattempo aggiorna la cache in
// background con quello che arriva dalla rete, per la prossima visita.

const CACHE_NAME = 'lupus-cache-v1';

const APP_SHELL = [
  './index_v2.html',
  './roles.json',
  './manifest.json',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-192.png',
  './assets/icons/icon-maskable-512.png',
  './assets/cards/veggente.png',
  './assets/cards/contadino.png'
];

self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      // addAll fallisce tutto se anche un solo file manca (es. una carta non ancora
      // caricata sul repo): li aggiungo uno per uno per non bloccare l'installazione.
      return Promise.all(
        APP_SHELL.map(function(url){
          return cache.add(url).catch(function(err){
            console.warn('Service worker: impossibile mettere in cache', url, err);
          });
        })
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(
        keys.filter(function(k){ return k !== CACHE_NAME; })
            .map(function(k){ return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(event){
  if(event.request.method !== 'GET') return;
  // lascio passare le richieste verso altri domini (es. i font di Google) senza intercettarle
  if(!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(event.request).then(function(cached){
      var rete = fetch(event.request).then(function(risposta){
        if(risposta && risposta.status === 200){
          var copia = risposta.clone();
          caches.open(CACHE_NAME).then(function(cache){ cache.put(event.request, copia); });
        }
        return risposta;
      }).catch(function(){
        return cached;
      });
      return cached || rete;
    })
  );
});
