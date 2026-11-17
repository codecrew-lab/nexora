# PULSE teacher code-only sign-in setup

This change replaces teacher sign-up with a sign-in form containing only:
- Login Code
- Secret Access Code
- Sign In

## Supabase function secrets

In the Supabase project dashboard, open **Edge Functions → Secrets** and add:

- `TEACHER_LOGIN_CODE`: set this to the login code provided by the school.
- `TEACHER_ACCESS_CODE`: keep the existing value already configured. Do not rotate or replace it for this change.

The function also uses the existing project secrets:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Never put these values in website JavaScript or commit them to GitHub.

## Deploy the Edge Function

Deploy the function in `supabase/functions/bright-handler` to the linked Supabase project. The teacher page calls the function route:

`/functions/v1/bright-handler`

After deployment, test sign-in using both codes. The function only signs in to the existing teacher account; it does not create users, change account metadata, change passwords, or modify student data.

## Data safety

No SQL migration is required for this login change. It does not read, update, or delete student, attendance, marks, or RFID rows.
