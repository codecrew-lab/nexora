# Backend: NEXORA server + PostgreSQL

The portals and RFID readers talk to the NEXORA server in `server/`, which
stores everything in our own PostgreSQL database. This guide covers how it
works, how to set up the database, and how to run and publish the server.

## How it works

```
Web portal / Android apps ──HTTPS──► NEXORA server (Node) ──► PostgreSQL
        nexora-api.js                 server/src/app.js        RLS policies, functions
ESP32 readers ──HTTPS, device secret──►  /api/rfid/attendance
```

- **Sign-in.** Accounts live in `auth.users` with bcrypt password hashes. The
  server issues a one-hour access token (a signed JWT) and a refresh token. A
  session lasts seven days from sign-in and is never extended.
- **Data access.** Pages call `nexoraClient.from('table')…` and
  `nexoraClient.rpc('function')`. The server turns each call into one
  parameterised SQL statement and runs it **as the caller's database role**
  (`anon` or `authenticated`) with the token's claims visible to `auth.uid()`
  and `auth.jwt()`. Row-level-security policies in the database decide what
  each user may read and write. The server adds no permissions of its own.
- **Server functions.** Teacher code sign-in, `student-enroll` (add a user with
  their login and RFID card), `student-account-manager` (set a password),
  `parent-report` and the reader endpoint run with the server's own database
  privileges, after their own checks.

## Set up the database

Needs Node 22.9 or newer and an empty PostgreSQL database (version 14 or newer).

```sh
cp .env.example .env        # then fill it in; .env is git-ignored
cd server
npm install
npm run db:setup            # roles, auth schema, every table, policy and function
npm run db:check            # confirms the database has everything the portals use
```

`db:setup` applies `db/platform.sql` and then each file in `db/migrations/` in
filename order, recording them in `public.nexora_schema_migrations`. It is safe
to run again: applied files are skipped. It also creates the teacher account
(`teacher@auraway.app`), which is signed in to with the two teacher codes
([teacher-login.md](teacher-login.md)).

**The database user** in `DATABASE_URL` owns the tables, and needs permission
to create roles the first time. The server admin user of Azure Database for
PostgreSQL can do both. If the connection times out, the database firewall does
not allow your address yet (Azure portal → the server → Networking → Firewall
rules).

After that the database is empty apart from the teacher account. Students are
added from the teacher portal (*Add User & Map RFID Card*).

| Setting | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. Add `?sslmode=require` for a remote database |
| `JWT_SECRET` | Signs session tokens. At least 32 random characters. Changing it signs everyone out |
| `TEACHER_LOGIN_CODE`, `TEACHER_ACCESS_CODE` | Teacher portal sign-in codes |
| `PULSE_RFID_DEVICE_SECRET` | Shared secret of the RFID readers, at least 32 characters |
| `NEXORA_ALLOWED_ORIGINS` | Optional. Browser origins allowed to call the API |
| `TRUST_PROXY` | Set to `1` behind a reverse proxy, so rate limits see real client addresses |
| `PORT` | Default 8787 |

## Run the server

```sh
cd server
npm start                   # http://localhost:8787, reads ../.env
```

Pages opened from `localhost` / `127.0.0.1` (for example with VS Code Live
Server) use `http://localhost:8787` automatically, so the whole system can be
tried on one machine.

## Publish it

1. **Host the server** anywhere that gives it a public **HTTPS** address and can
   reach the database: Azure App Service, a VM behind Caddy or nginx, a
   container host. HTTPS is required: the site is served over HTTPS and the
   Android apps refuse plain HTTP. Set the same variables as in `.env` in the
   host's environment, and allow the host's outbound address in the database
   firewall. `https://<server>/healthz` returns `{"status":"ok"}` when the
   server can reach the database.
2. **Point the portals at it** in `nexora-api.js`:
   ```js
   const NEXORA_PRODUCTION_API_URL = 'https://api.your-school.example';
   ```
   Merge to `main`. GitHub Pages publishes the portals; build and distribute new
   Android APKs (they bundle the same files).
3. **Re-flash the readers** with the new `ATTENDANCE_ENDPOINT`
   ([reader guide](../hardware/nexora_rfid_reader/README.md)). The server's
   certificate must chain to a root in the reader's `certificates.h`.

Until step 2 is merged with a real address, the published portals have no
backend and show "service unavailable".

## Changing the schema later

Add a file to `db/migrations/` (named `YYYYMMDDHHMMSS_what_it_does.sql`) and run
`cd server && npm run db:migrate`.

New tables are not reachable from the portals until you grant access. Every
table needs, in its migration:

```sql
alter table public.my_table enable row level security;
revoke all on table public.my_table from public, anon;
grant select, insert, update, delete on table public.my_table to authenticated;
create policy "…" on public.my_table for select to authenticated using (…);
```

Without row-level security, a grant to `authenticated` lets every signed-in
student read and change the whole table. New functions are executable by
everyone by default: `revoke all on function … from public` and grant them to
`authenticated` only, as the existing migrations do.

## Backups

The database is the only copy of the school's records. Turn on automated
backups at your database host (Azure keeps point-in-time backups by default),
or take your own with `pg_dump "$DATABASE_URL" > nexora-$(date +%F).sql`.
