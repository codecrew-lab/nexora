// NEXORA web push notifications (PWA).
// Requires nexora-api.js (nexoraClient) and the service worker registered by pwa-installer.js.
(function () {
  // Public VAPID key: safe to publish. The private key lives only in the server's settings.
  const VAPID_PUBLIC_KEY = 'BEpJ1qR_iCpWkKLvvW2MGPs0f52mrnQ2fkGpQoTD1xmEWSqaNF6V08JnFCFo34Lz4ObQrOKrQSTsTzNftvaK_Rk';
  const STORE_KEY = 'NEXORA_push_enabled_v1';

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

  function supported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  function keyToBytes(base64url) {
    const padded = (base64url + '='.repeat((4 - base64url.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(padded), ch => ch.charCodeAt(0));
  }

  function sameKey(buffer, bytes) {
    if (!buffer) return true; // the browser does not report the key; assume it is ours
    const current = new Uint8Array(buffer);
    return current.length === bytes.length && current.every((value, index) => value === bytes[index]);
  }

  function readEnabled() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch (_) { return {}; }
  }
  function writeEnabled(map) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(map)); } catch (_) {}
  }
  const keyFor = (role, code) => role + ':' + String(code || '').toUpperCase();

  async function registration() {
    if (!navigator.serviceWorker.controller) {
      // pwa-installer.js registers on load; make sure a registration exists either way.
      await navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
    return navigator.serviceWorker.ready;
  }

  async function callFunction(body) {
    // nexora-api.js declares nexoraClient with const, so it is not on window.
    const client = typeof nexoraClient !== 'undefined' ? nexoraClient : null;
    if (!client) throw new Error('Notification service unavailable.');
    const { data, error } = await client.functions.invoke('push-notify', { body });
    // The function's own message (data.error) is more useful than the HTTP status.
    if (error || data?.error) throw new Error(data?.error || error?.message || 'Notification request failed.');
    return data;
  }

  // Why push cannot be used on this device, or '' if it can.
  function blocker() {
    if (isIOS && !isStandalone) return 'On iPhone/iPad, first tap Share → "Add to Home Screen", then open NEXORA from your home screen to turn on notifications.';
    if (!supported()) return 'This browser does not support notifications. Try Chrome, Edge, Firefox or Safari (installed app).';
    if (Notification.permission === 'denied') return 'Notifications are blocked for NEXORA. Allow them in your browser or phone settings, then try again.';
    return '';
  }

  async function currentSubscription() {
    if (!supported()) return null;
    const reg = await registration();
    return reg.pushManager.getSubscription();
  }

  async function isEnabled(role, code) {
    if (blocker() || Notification.permission !== 'granted') return false;
    const sub = await currentSubscription();
    return Boolean(sub && readEnabled()[keyFor(role, code)]);
  }

  async function enable(role, code) {
    const reason = blocker();
    if (reason) throw new Error(reason);
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notifications were not allowed.');
    const reg = await registration();
    let sub = await reg.pushManager.getSubscription();
    // A subscription made with another server key cannot receive our notifications: replace it.
    if (sub && !sameKey(sub.options?.applicationServerKey, keyToBytes(VAPID_PUBLIC_KEY))) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(VAPID_PUBLIC_KEY) });
    }
    await callFunction({ action: 'subscribe', role, student_code: code || undefined, subscription: sub.toJSON() });
    const map = readEnabled();
    map[keyFor(role, code)] = true;
    writeEnabled(map);
  }

  async function disable(role, code) {
    const map = readEnabled();
    delete map[keyFor(role, code)];
    writeEnabled(map);
    const sub = await currentSubscription().catch(() => null);
    if (!sub) return;
    await callFunction({ action: 'unsubscribe', endpoint: sub.endpoint, role, student_code: code || undefined }).catch(() => {});
    // Keep the browser subscription if another student/parent on this device still uses it.
    if (!Object.keys(map).length) await sub.unsubscribe().catch(() => {});
  }

  // Renders a status line and an on/off button into `container`.
  // getContext() must return { role: 'student' | 'parent', code } or null when not signed in.
  function mount(container, getContext) {
    if (!container) return;
    container.innerHTML = '<p data-push-status style="margin:0 0 10px;color:var(--text-secondary);font-size:.88rem;line-height:1.5;">Checking notifications…</p><button type="button" class="btn" data-push-toggle hidden></button>';
    const status = container.querySelector('[data-push-status]');
    const button = container.querySelector('[data-push-toggle]');

    async function refresh() {
      const ctx = getContext();
      const reason = blocker();
      if (!ctx) { status.textContent = 'Sign in to manage notifications.'; button.hidden = true; return; }
      if (reason) { status.textContent = reason; button.hidden = true; return; }
      const on = await isEnabled(ctx.role, ctx.code).catch(() => false);
      status.textContent = on
        ? '✅ Notifications are on for this device.'
        : (ctx.role === 'parent'
            ? 'Get alerts for attendance, new homework and marks.'
            : 'Get alerts for new assignments, marks and messages from your teacher.');
      button.hidden = false;
      button.disabled = false;
      button.textContent = on ? 'Turn off notifications' : '🔔 Turn on notifications';
      button.dataset.on = on ? 'true' : 'false';
    }

    button.addEventListener('click', async () => {
      const ctx = getContext();
      if (!ctx) return;
      button.disabled = true;
      const turningOn = button.dataset.on !== 'true';
      status.textContent = turningOn ? 'Turning on notifications…' : 'Turning off notifications…';
      try {
        if (turningOn) await enable(ctx.role, ctx.code);
        else await disable(ctx.role, ctx.code);
      } catch (error) {
        await refresh();
        status.textContent = error.message || 'Could not update notifications.';
        return;
      }
      await refresh();
      window.dispatchEvent(new CustomEvent('NEXORAPushChanged'));
    });

    refresh();
    return { refresh };
  }

  window.NEXORAPush = { supported, blocker, isEnabled, enable, disable, mount, callFunction };
})();
