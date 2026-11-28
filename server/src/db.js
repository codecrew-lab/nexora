// Database access. `run(context, work)` runs `work(query)` in one transaction.
//
//   context = null                      the server's own privileges (it owns the
//                                       tables, so row-level security does not apply)
//   context = { role, claims }          a browser request: the transaction runs as
//                                       the `anon` or `authenticated` database role
//                                       with the caller's token claims visible to
//                                       auth.uid() / auth.jwt(), so grants and RLS
//                                       policies decide what it may do
//
// Both settings are transaction-local, so nothing leaks to the next request
// that reuses the pooled connection.
const REQUEST_ROLES = new Set(['anon', 'authenticated']);
const SET_CONTEXT = `select set_config('request.jwt.claims', $1, true), set_config('role', $2, true)`;

function contextParams(context) {
  if (!REQUEST_ROLES.has(context.role)) throw new Error('Unknown request role.');
  return [JSON.stringify(context.claims || {}), context.role];
}

export function createPgDatabase(pool) {
  return {
    async run(context, work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (context) await client.query(SET_CONTEXT, contextParams(context));
        const result = await work((sql, params) => client.query(sql, params));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

// The same interface over PGlite (in-process Postgres), used by the tests.
export function createPgliteDatabase(pglite) {
  return {
    run(context, work) {
      return pglite.transaction(async tx => {
        if (context) await tx.query(SET_CONTEXT, contextParams(context));
        return work((sql, params) => tx.query(sql, params));
      });
    },
    close: () => pglite.close(),
  };
}
