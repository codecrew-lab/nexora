# Teacher sign-in

The teacher portal's sign-in form has two fields: **Login Code** and
**Secret Access Code**. There is no teacher sign-up.

## How it works

1. `teacher.html` sends both codes to the NEXORA server
   (`POST /api/auth/teacher-login`).
2. The server compares them with `TEACHER_LOGIN_CODE` and `TEACHER_ACCESS_CODE`
   from its environment. Five wrong attempts from one address block further
   attempts for 15 minutes.
3. If both match, the server starts a session for the existing account
   `teacher@auraway.app` and returns it. It never creates accounts, changes
   passwords or touches student data.

The portal also accepts any account whose `raw_app_meta_data.role` is `teacher`
or `school_admin`. Database policies use the same rule
(`public.is_auraway_teacher()`).

## Setup

Set both codes in the server's environment (`.env` locally):

```
TEACHER_LOGIN_CODE=…
TEACHER_ACCESS_CODE=…
```

Restart the server after changing them. Never put these values in website
JavaScript or commit them: the repository is public.

The account `teacher@auraway.app` is created by the first migration
(`npm run db:setup`, see [postgres.md](postgres.md)); `npm run db:check`
confirms it is there. It has no password, so the two codes are the only way in.

## Account model

One shared teacher identity is used because the school has one shared pair of
codes. Anyone who knows both codes has full teacher access, so share them only
with trusted staff, and change them when someone leaves. Changing the codes does
not end sessions that are already signed in; those expire within seven days. To
end them immediately:

```sql
delete from auth.nexora_sessions
where user_id = (select id from auth.users where lower(email) = 'teacher@auraway.app');
```
