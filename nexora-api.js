// NEXORA API client: the portals' connection to the NEXORA server (server/),
// which signs users in and reads and writes our PostgreSQL database.
//
// Pages use `nexoraClient`:
//   nexoraClient.from('table').select('a,b').eq('a', 1).order('b')   → { data, error }
//   nexoraClient.rpc('function_name', { p_arg: 1 })                  → { data, error }
//   nexoraClient.functions.invoke('parent-report', { body })         → { data, error }
//   nexoraClient.auth.signInWithPassword / signInWithTeacherCodes / getSession / signOut
// Nothing here is secret. The server decides what each signed-in user may do.

// Where the NEXORA server is published (HTTPS, no trailing slash). Pages opened
// from localhost use a local server instead.
const NEXORA_PRODUCTION_API_URL = 'https://nexora-api.azurewebsites.net';

const NEXORA_API_URL = (() => {
  if (typeof window.NEXORA_API_URL === 'string') return window.NEXORA_API_URL;
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return 'http://localhost:8787';
  return NEXORA_PRODUCTION_API_URL;
})();

// Keep each portal's session separate so opening the Teacher portal cannot
// sign out the Student portal (and vice versa) in the same browser.
const NEXORA_PORTAL_ROLE = (() => {
  const page = window.location.pathname.split('/').pop().toLowerCase();
  if (page === 'teacher.html') return 'teacher';
  if (page === 'parent.html') return 'parent';
  return 'student';
})();
const NEXORA_AUTH_STORAGE_KEY = 'nexora-' + NEXORA_PORTAL_ROLE + '-session';

// Sessions issued by the previous backend cannot be used any more.
try { window.localStorage.removeItem('sb-iazlemocpuhzwtrkyfgw-' + NEXORA_PORTAL_ROLE + '-auth-token'); } catch (_) {}

function NEXORACreateClient(baseUrl) {
  const base = baseUrl.replace(/\/+$/, '');
  let refreshing = null;

  // ------------------------------------------------------------- session
  // A session lasts seven days from sign-in; the server enforces the same
  // deadline. Read from storage every time so tabs stay in step.
  function readSession() {
    try {
      const stored = JSON.parse(window.localStorage.getItem(NEXORA_AUTH_STORAGE_KEY) || 'null');
      if (!stored) return null;
      if (!stored.access_token || !stored.user || !(stored.session_expires_at > Date.now())) {
        window.localStorage.removeItem(NEXORA_AUTH_STORAGE_KEY);
        return null;
      }
      return stored;
    } catch (_) {
      return null;
    }
  }

  function writeSession(session) {
    try {
      if (session) window.localStorage.setItem(NEXORA_AUTH_STORAGE_KEY, JSON.stringify(session));
      else window.localStorage.removeItem(NEXORA_AUTH_STORAGE_KEY);
    } catch (_) {
      // Without browser storage the session lasts only until the page reloads.
    }
  }

  const toError = (payload, status) => {
    const source = payload && payload.error !== undefined ? payload.error : payload;
    if (typeof source === 'string') return { message: source, code: '', details: null, hint: null, status };
    return {
      message: (source && source.message) || 'The request failed (' + status + ').',
      code: (source && source.code) || '',
      details: (source && source.details) || null,
      hint: (source && source.hint) || null,
      status
    };
  };

  async function post(path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    let response;
    try {
      response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body === undefined ? {} : body) });
    } catch (_) {
      // Pages look for "fetch" in the message to tell a network problem from a refusal.
      return { ok: false, status: 0, payload: null, error: { message: 'Failed to fetch', code: '', details: null, hint: null, status: 0 } };
    }
    let payload = null;
    try { payload = await response.json(); } catch (_) {}
    return { ok: response.ok, status: response.status, payload, error: response.ok ? null : toError(payload, response.status) };
  }

  // Exchanges the refresh token for a new access token. One request is shared
  // by everything that asks at the same moment.
  function refreshSession(session) {
    if (!refreshing) {
      refreshing = (async () => {
        try {
          const result = await post('/api/auth/refresh', { refresh_token: session.refresh_token });
          if (result.ok && result.payload && result.payload.access_token) {
            writeSession(result.payload);
            return result.payload;
          }
          // The server ended the session: forget it. Anything else (offline,
          // server restarting) keeps it, so a blip does not sign the user out.
          if (result.status === 401) {
            writeSession(null);
            return null;
          }
          return session;
        } finally {
          refreshing = null;
        }
      })();
    }
    return refreshing;
  }

  async function currentSession() {
    const session = readSession();
    if (!session) return null;
    if (session.expires_at * 1000 - Date.now() > 60 * 1000) return session;
    return refreshSession(session);
  }

  // A request on behalf of whoever is signed in (or nobody).
  async function call(path, body) {
    let session = await currentSession();
    let result = await post(path, body, session && session.access_token);
    if (result.status === 401 && session && result.error.code === 'token_expired') {
      session = await refreshSession(session);
      if (session) result = await post(path, body, session.access_token);
    }
    return result;
  }

  // --------------------------------------------------------------- tables
  class Query {
    constructor(table) {
      this.request = { table, action: 'select', columns: '*', filters: [], order: [] };
      this.expect = 'many';
    }
    select(columns) {
      const list = columns === undefined || columns === null || columns === '' ? '*' : columns;
      if (this.request.action === 'select') this.request.columns = list;
      else this.request.returning = list;
      return this;
    }
    insert(values) { this.request.action = 'insert'; this.request.values = values; return this; }
    upsert(values, options) {
      this.request.action = 'upsert';
      this.request.values = values;
      this.request.onConflict = options && options.onConflict;
      this.request.ignoreDuplicates = Boolean(options && options.ignoreDuplicates);
      return this;
    }
    update(values) { this.request.action = 'update'; this.request.values = values; return this; }
    delete() { this.request.action = 'delete'; return this; }
    filter(column, op, value) { this.request.filters.push({ column, op, value }); return this; }
    eq(column, value) { return this.filter(column, 'eq', value); }
    neq(column, value) { return this.filter(column, 'neq', value); }
    gt(column, value) { return this.filter(column, 'gt', value); }
    gte(column, value) { return this.filter(column, 'gte', value); }
    lt(column, value) { return this.filter(column, 'lt', value); }
    lte(column, value) { return this.filter(column, 'lte', value); }
    like(column, value) { return this.filter(column, 'like', value); }
    ilike(column, value) { return this.filter(column, 'ilike', value); }
    is(column, value) { return this.filter(column, 'is', value); }
    in(column, values) { return this.filter(column, 'in', values); }
    order(column, options) {
      const item = { column, ascending: !(options && options.ascending === false) };
      if (options && typeof options.nullsFirst === 'boolean') item.nullsFirst = options.nullsFirst;
      this.request.order.push(item);
      return this;
    }
    limit(count) { this.request.limit = count; return this; }
    single() { this.expect = 'one'; return this; }
    maybeSingle() { this.expect = 'maybe'; return this; }

    async run() {
      const result = await call('/api/db/query', this.request);
      if (!result.ok) return { data: null, error: result.error };
      const data = result.payload ? result.payload.data : null;
      if (this.expect === 'many') return { data: data === undefined ? null : data, error: null };
      const rows = Array.isArray(data) ? data : [];
      if (rows.length === 1) return { data: rows[0], error: null };
      if (rows.length === 0 && this.expect === 'maybe') return { data: null, error: null };
      return {
        data: null,
        error: {
          message: 'JSON object requested, multiple (or no) rows returned',
          code: 'PGRST116',
          details: 'The result contains ' + rows.length + ' rows',
          hint: null,
          status: 406
        }
      };
    }
    then(resolve, reject) { return this.run().then(resolve, reject); }
  }

  // ----------------------------------------------------------------- auth
  async function startSession(path, body) {
    const result = await post(path, body);
    if (!result.ok || !result.payload || !result.payload.access_token) {
      return { data: { user: null, session: null }, error: result.error || toError(null, result.status) };
    }
    writeSession(result.payload);
    return { data: { user: result.payload.user, session: result.payload }, error: null };
  }

  const auth = {
    signInWithPassword(credentials) {
      return startSession('/api/auth/login', { email: credentials.email, password: credentials.password });
    },
    signInWithTeacherCodes(codes) {
      return startSession('/api/auth/teacher-login', { login_code: codes.loginCode, access_code: codes.accessCode });
    },
    async getSession() {
      return { data: { session: await currentSession() }, error: null };
    },
    async signOut() {
      const session = readSession();
      writeSession(null);
      if (session && session.refresh_token) await post('/api/auth/logout', { refresh_token: session.refresh_token });
      return { error: null };
    }
  };

  return {
    auth,
    from: table => new Query(table),
    async rpc(name, args) {
      const result = await call('/api/rpc/' + encodeURIComponent(name), args || {});
      if (!result.ok) return { data: null, error: result.error };
      return { data: result.payload ? result.payload.data : null, error: null };
    },
    functions: {
      // The function's own JSON reply is returned as `data`, also when it
      // reports a failure, so pages can show its message.
      async invoke(name, options) {
        const result = await call('/api/functions/' + encodeURIComponent(name), (options && options.body) || {});
        return { data: result.payload, error: result.error };
      }
    }
  };
}

// null when no server address is configured; pages then show that the service is unavailable.
const nexoraClient = NEXORA_API_URL ? NEXORACreateClient(NEXORA_API_URL) : null;
