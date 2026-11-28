const CACHE_NAME = 'NEXORA-Pwa-v34';

// Keep this list limited to files that should be available offline.
// Each file is cached independently so one missing/renamed optional page
// cannot prevent the new service worker from installing.
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
  './classroom.html',
  './analytics.html',
  './settings.html',
  './style.css',
  './navigation.js',
  './student-auth.js',
  './supabase.js',
  './attendance-utils.js',
  './teacher-rfid.js',
  './pwa-installer.js',
  './portal-switcher.js',
  './back-navigation.js',
  './push-notifications.js',
  './manifest.json',
  './pwa-icon.svg',
  './pwa-icon.png'
];

const STATIC_ASSET_PATHS = new Set(
  ASSETS_TO_CACHE.map(path => new URL(path, self.registration.scope).pathname)
);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Do not let a single 404 or transient network error block an update.
    await Promise.all(ASSETS_TO_CACHE.map(async path => {
      try {
        const response = await fetch(new Request(path, { cache: 'reload' }));
        if (response && response.ok && response.type === 'basic') {
          await cache.put(path, response);
        } else {
          console.warn('[NEXORA SW] Skipped unavailable asset:', path, response && response.status);
        }
      } catch (error) {
        console.warn('[NEXORA SW] Could not precache asset:', path, error);
      }
    }));

    await self.skipWaiting();
  })());
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

    // Network-first: installed apps receive the current GitHub Pages files.
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

// ---- Push notifications ----
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {
    data = { body: event.data ? event.data.text() : '' };
  }
  const scope = self.registration.scope;
  const title = data.title || 'NEXORA';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: new URL('./pwa-icon.png', scope).href,
    badge: new URL('./pwa-icon.png', scope).href,
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    data: { url: new URL(data.url || './index.html', scope).href }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const scope = self.registration.scope;
  let target = event.notification.data?.url || new URL('./index.html', scope).href;
  // Only open pages inside NEXORA.
  if (!target.startsWith(scope)) target = new URL('./index.html', scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (client.url === target && 'focus' in client) return client.focus();
    }
    const existing = windows.find(client => client.url.startsWith(scope));
    if (existing && 'navigate' in existing) {
      await existing.navigate(target).catch(() => {});
      return existing.focus();
    }
    return self.clients.openWindow(target);
  })());
});
