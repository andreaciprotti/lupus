// Service worker di Lupus.
// Strategia: rispondi subito dalla cache se disponibile (così l'app si apre
// istantaneamente anche offline), e nel frattempo aggiorna la cache in
// background con quello che arriva dalla rete, per la prossima visita.

const CACHE_NAME = 'lupus-cache-v2';

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

// L'unica risorsa esterna della pagina sono i font di Google: senza queste righe
// il service worker le ignorerebbe (di proposito, per non mettere in cache domini
// a caso), e se il telefono non le avesse mai scaricate prima, offline si
// vedrebbe il font di sistema al posto di Cinzel/EB Garamond/Inter.
const GOOGLE_FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600;700&family=Cinzel+Decorative:wght@700&family=EB+Garamond:ital,wght@0,400;0,500;1,400&family=Inter:wght@400;500;600;700&display=swap';

self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      var shellPromise = Promise.all(
        APP_SHELL.map(function(url){
          // aggiungo uno per uno: se un file manca (es. una carta non ancora
          // caricata sul repo) non deve bloccare l'installazione degli altri
          return cache.add(url).catch(function(err){
            console.warn('Service worker: impossibile mettere in cache', url, err);
          });
        })
      );

      // scarico il foglio di stile dei font, lo metto in cache, poi estraggo
      // gli URL dei singoli file di font (.woff2) che contiene e li scarico a loro volta
      var fontsPromise = fetch(GOOGLE_FONTS_CSS).then(function(risposta){
        if(!risposta.ok) throw new Error('Foglio di stile dei font non raggiungibile');
        return risposta.clone().text().then(function(cssText){
          cache.put(GOOGLE_FONTS_CSS, risposta);
          var urlFont = Array.from(cssText.matchAll(/url\((https:\/\/fonts\.gstatic\.com[^)]+)\)/g))
              .map(function(m){ return m[1]; });
          return Promise.all(urlFont.map(function(fontUrl){
            return fetch(fontUrl).then(function(fontResp){
              if(fontResp.ok) return cache.put(fontUrl, fontResp);
            }).catch(function(){ /* un singolo peso mancante non è grave, si ripiega sul font di sistema */ });
          }));
        });
      }).catch(function(err){
        console.warn('Service worker: impossibile precaricare i font di Google (verranno ripresi al primo utilizzo online)', err);
      });

      return Promise.all([shellPromise, fontsPromise]);
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

  var url = event.request.url;
  var stessoDominio = url.startsWith(self.location.origin);
  var fontGoogle = url.startsWith('https://fonts.googleapis.com') || url.startsWith('https://fonts.gstatic.com');
  // altri domini esterni: li lascio passare senza intercettarli
  if(!stessoDominio && !fontGoogle) return;

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