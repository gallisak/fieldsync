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
    if (!res.ok) continue;
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

async function networkFirst(request, url) {
  const cache = await caches.open(SHELL);
  try {
    const res = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NAVIGATION_TIMEOUT_MS)),
    ]);
    if (res.ok && !res.redirected) await cache.put(url.pathname, res.clone());
    return res;
  } catch {
    const fallback = url.pathname.startsWith('/tickets/') ? '/tickets/_' : '/';
    return (await cache.match(url.pathname)) ?? (await cache.match(fallback)) ?? Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/_next/static/')) event.respondWith(cacheFirst(request));
  else if (request.mode === 'navigate') event.respondWith(networkFirst(request, url));
});
