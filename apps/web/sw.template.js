// Template: `next build` writes it to public/sw.js with the build id (see next.config.js).
const SHELL = 'shell-__BUILD_ID__';
// '/tickets/_' is the shell of every ticket page: the page reads its id from the address, not from the document.
const PAGES = ['/', '/sign-in', '/tickets/_'];
const NAVIGATION_TIMEOUT_MS = 3000;
const STATIC_ASSET = /(?:\/_next\/)?static\/(?:chunks|css|media)\/[^"'\\\s)]+/g;

async function precache() {
  const cache = await caches.open(SHELL);
  const assets = new Set();
  for (const page of PAGES) {
    const res = await fetch(page, { cache: 'reload' });
    // Fails the install, so the previous worker and its cache stay instead of a shell with holes.
    if (!res.ok) throw new Error(`precache ${page}: HTTP ${res.status}`);
    await cache.put(page, res.clone());
    for (const [path] of (await res.text()).matchAll(STATIC_ASSET)) {
      assets.add(`/_next/${path.replace(/^\/_next\//, '')}`);
    }
  }
  await Promise.all([...assets].map((url) => cache.add(url).catch(() => undefined)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== SHELL).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) await cache.put(request, res.clone());
  return res;
}

// Every ticket URL is answered by the one '/tickets/_' document, so it is stored once.
const cacheKey = (pathname) => (pathname.startsWith('/tickets/') ? '/tickets/_' : pathname);

async function networkFirst(request, url) {
  const cache = await caches.open(SHELL);
  const key = cacheKey(url.pathname);
  try {
    const res = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NAVIGATION_TIMEOUT_MS)),
    ]);
    // A gateway error while the web server is down is as good as no network: the cached shell still works.
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (res.ok && !res.redirected) await cache.put(key, res.clone());
    return res;
  } catch {
    return (await cache.match(key)) ?? (await cache.match('/')) ?? Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/_next/static/')) event.respondWith(cacheFirst(request));
  else if (request.mode === 'navigate') event.respondWith(networkFirst(request, url));
});
