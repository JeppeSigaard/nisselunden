/* Gemmer siden og musikken på telefonen, så den virker uden internet.
   Nettet prøves først, så rettelser slår igennem; ellers bruges den gemte kopi. */
var LAGER = 'nisselunden-1';
var FILER = ['./', 'index.html', 'app.js', 'musik.mp3', 'vaagen.mp4'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(LAGER).then(function (c) { return c.addAll(FILER); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET' || e.request.headers.get('range')) { return; }
  e.respondWith(
    fetch(e.request).then(function (svar) {
      if (svar && svar.status === 200) {
        var kopi = svar.clone();
        caches.open(LAGER).then(function (c) { c.put(e.request, kopi); });
      }
      return svar;
    }).catch(function () {
      return caches.match(e.request, { ignoreSearch: true });
    })
  );
});
