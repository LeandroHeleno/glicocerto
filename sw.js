const CACHE='glicocerto-v1';
const ASSETS=['/glicocerto/','/glicocerto/index.html','/glicocerto/manifest.webmanifest'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))); self.clients.claim();});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if (/supabase\.co|openai\.com|api\.|nightscout/i.test(u.hostname)) return; // não intercepta suas APIs
  if (e.request.mode==='navigate'){ e.respondWith(fetch(e.request).catch(()=>caches.match('/glicocerto/index.html'))); return; }
  if (u.origin===location.origin && u.pathname.startsWith('/glicocerto/')){
    e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));
  }
});
