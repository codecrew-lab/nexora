const CACHE_NAME = 'NEXORA-Pwa-v26';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './parent.html',
  './teacher.html',
  './portals.html',
  './planner.html',
  './timetable.html',
  './exam.html',
  './quiz.html',
  './marks.html',
  './attendance.html',
  './flashcards.html',
  './classroom.html',
  './notes.html',
  './analytics.html',
  './focus.html',
  './progress.html',
  './search.html',
  './settings.html',
  './style.css',
  './navigation.js',
  './student-auth.js',
  './supabase.js',
  './pwa-installer.js',
  './portal-switcher.js',
  './back-navigation.js',
  './manifest.json',
  './pwa-icon.svg'
];

const STATIC_ASSET_PATHS = new Set(
  ASSETS_TO_CACHE.map(path => new URL(path, self.registration.scope).pathname)
);

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key.startsWith('NEXORA-Pwa-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);
  const scopeUrl = new URL(self.registration.scope);

  if (requestUrl.origin !== scopeUrl.origin) return;

  const isNavigation = request.mode === 'navigate';
  const isStaticAsset = STATIC_ASSET_PATHS.has(requestUrl.pathname);
  if (!isNavigation && !isStaticAsset) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Always ask the live site first. This prevents an installed Chrome PWA
    // from repeatedly showing an older cached portals.html after deployment.
    try {
      const response = await fetch(request, { cache: 'no-store' });
      if (response && response.ok && response.type === 'basic') {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    } catch (error) {
      const cached = await cache.match(request);
      if (cached) return cached;

      if (isNavigation) {
        const offlinePage = await cache.match(new URL('./portals.html', scopeUrl).href);
        if (offlinePage) return offlinePage;
      }

      return new Response('NEXORA is offline. This page is not available in the offline cache.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  })());
});
