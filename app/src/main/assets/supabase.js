// Supabase browser client configuration.
// The publishable key is safe to expose in the browser; protect data with RLS policies.
const SUPABASE_URL = 'https://iazlemocpuhzwtrkyfgw.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_sbS10vHYIrxhHsqnQNoWgA_WzREJj_-';

// Enforce a fixed seven-day maximum from the successful sign-in.
// Token refreshes must not extend this deadline. Signing out removes the session immediately.
const PULSE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Keep each portal's session separate so opening the Teacher portal cannot
// sign out the Student portal (and vice versa) in the same browser.
const PULSE_PORTAL_ROLE = (() => {
  const page = window.location.pathname.split('/').pop().toLowerCase();
  if (page === 'teacher.html' || (page === 'calendar.html' && new URLSearchParams(window.location.search).get('portal') === 'teacher')) return 'teacher';
  if (page === 'parent.html') return 'parent';
  return 'student';
})();
const PULSE_AUTH_STORAGE_KEY = 'sb-iazlemocpuhzwtrkyfgw-' + PULSE_PORTAL_ROLE + '-auth-token';

const pulseSessionStorage = {
  getItem(key) {
    try {
      const stored = window.localStorage.getItem(key);
      if (!stored) return null;

      // Support sessions saved before this 7-day storage wrapper was introduced.
      let parsed;
      try { parsed = JSON.parse(stored); } catch (_) { return stored; }
      if (parsed && typeof parsed === 'object' && typeof parsed.value === 'string' && typeof parsed.expiresAt === 'number') {
        if (Date.now() >= parsed.expiresAt) {
          window.localStorage.removeItem(key);
          return null;
        }
        return parsed.value;
      }

      window.localStorage.setItem(key, JSON.stringify({
        value: stored,
        expiresAt: Date.now() + PULSE_SESSION_TTL_MS
      }));
      return stored;
    } catch (_) {
      return null;
    }
  },
  setItem(key, value) {
    try {
      // Supabase writes the session again whenever it rotates tokens. Preserve the
      // original deadline instead of silently turning seven days into a sliding window.
      const previous = window.localStorage.getItem(key);
      let expiresAt = Date.now() + PULSE_SESSION_TTL_MS;
      if (previous) {
        try {
          const parsed = JSON.parse(previous);
          if (parsed && typeof parsed.expiresAt === 'number' && parsed.expiresAt > Date.now()) {
            expiresAt = parsed.expiresAt;
          }
        } catch (_) {
          // A legacy, unwrapped session starts its seven-day window on this save.
        }
      }
      window.localStorage.setItem(key, JSON.stringify({ value, expiresAt }));
    } catch (_) {
      // If browser storage is unavailable, Supabase will report an auth/storage issue.
    }
  },
  removeItem(key) {
    try { window.localStorage.removeItem(key); } catch (_) {}
  }
};

function pulseResetSessionDeadline() {
  try {
    const raw = window.localStorage.getItem(PULSE_AUTH_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.value === "string") {
      window.localStorage.setItem(PULSE_AUTH_STORAGE_KEY, JSON.stringify({
        value: parsed.value,
        expiresAt: Date.now() + PULSE_SESSION_TTL_MS
      }));
    }
  } catch (_) {}
}

const supabaseClient = (window.supabase?.createClient)
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storage: pulseSessionStorage,
        storageKey: PULSE_AUTH_STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    })
  : null;
