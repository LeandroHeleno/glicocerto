const CACHE='glicocerto-v2';
const ASSETS=['/glicocerto/','/glicocerto/index.html','/glicocerto/manifest.webmanifest'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))); self.clients.claim();});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (/supabase\.co|openai\.com|api\.|nightscout/i.test(u.hostname)) return;

  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(r => r && r.ok ? r : caches.match('/glicocerto/index.html')) // fallback em 5xx
        .catch(() => caches.match('/glicocerto/index.html'))               // offline
    );
    return;
  }

  if (u.origin === location.origin && u.pathname.startsWith('/glicocerto/')) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
  }
});

