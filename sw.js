const CACHE_NAME = 'NEXORA-Pwa-v23';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './parent.html',
  './teacher.html',
  './portals.html',
  './planner.html',
  './timetable.html',
  './exam.html',
  './quiz.html',  './marks.html',
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

// Only these same-origin app files may be stored for offline use.
// Supabase/Auth/API requests are deliberately excluded.
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
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);
  const scopeUrl = new URL(self.registration.scope);

  // Never intercept external services such as Supabase or third-party CDNs.
  if (requestUrl.origin !== scopeUrl.origin) return;

  const isNavigation = request.mode === 'navigate';
  const isStaticAsset = STATIC_ASSET_PATHS.has(requestUrl.pathname);

  // Do not cache same-origin API endpoints or arbitrary dynamic responses.
  if (!isNavigation && !isStaticAsset) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      const cachedResponse = await cache.match(request);
      const networkRequest = fetch(request).then(response => {
        if (response && response.ok && response.type === 'basic') {
          cache.put(request, response.clone()).catch(() => {});
        }
        return response;
      });

      if (cachedResponse) {
        // Refresh static content in the background; never cache private API data.
        networkRequest.catch(() => {});
        return cachedResponse;
      }

      try {
        return await networkRequest;
      } catch (error) {
        if (isNavigation) {
          const offlinePage = await cache.match(new URL('./portals.html', scopeUrl).href);
          if (offlinePage) return offlinePage;
        }
        return new Response('NEXORA is offline. This page is not available in the offline cache.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    })
  );
});
