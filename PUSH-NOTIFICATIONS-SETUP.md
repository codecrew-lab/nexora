# Push notifications setup (PWA)

NEXORA sends web push notifications to students and parents who turn them on.
This works in the installed PWA and in Chrome, Edge, Firefox and Safari. On
iPhone/iPad (iOS 16.4+) the user must first **Add to Home Screen** and open
NEXORA from there.

## What gets sent

| Event | Who is notified | Opens |
|---|---|---|
| Teacher publishes an assignment | Targeted students + their parents | Classroom / Parent portal |
| Attendance marked today (RFID or teacher) | Parents | Parent portal |
| Teacher adds marks | That student + their parents | Marks / Parent portal |
| Teacher uses **🔔 Send Notification** | All / a class / one student; students, parents or both | Dashboard / Parent portal |

Attendance edits for past dates do not notify anyone. Changing a record to the
same status does not notify anyone either.

## Files

- `push-notifications.js`: turns notifications on and off in the browser.
- `sw.js`: shows notifications and opens the right page when one is tapped.
- `supabase/functions/push-notify/index.ts`: saves subscriptions and sends pushes.
- `supabase/migrations/20261128120000_create_push_notifications.sql`: the `push_subscriptions` table plus triggers.

## One-time setup

The keys are in `.secrets/supabase-secrets.env` on the developer's PC. That
folder is git-ignored, so **never commit it**.

1. **Edge function secrets.** Supabase Dashboard → Edge Functions → Secrets. Add:
   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
   - `PUSH_WEBHOOK_SECRET`

   Copy the values from `.secrets/supabase-secrets.env`.

2. **Deploy the function.** Edge Functions → Deploy a new function:
   - Name it `push-notify`.
   - Paste in `supabase/functions/push-notify/index.ts`.
   - Verify JWT can stay on or off. The website and the database trigger both
     send the public app key, and the function checks who is calling itself.

3. **Vault secret for the database trigger.** In the SQL Editor, run the line
   below. Use the same `PUSH_WEBHOOK_SECRET` value as in step 1:

   ```sql
   select vault.create_secret('<PUSH_WEBHOOK_SECRET>', 'nexora_push_webhook_secret');
   ```

4. **Database.** Run
   `supabase/migrations/20261128120000_create_push_notifications.sql` in the
   SQL Editor.

5. **Publish the site.** Push to GitHub Pages. The service worker cache version
   was bumped, so installed apps pick up the new `sw.js`.

## Testing

1. Open the student dashboard and tap **🔔 Turn on notifications**. You can also
   do this from Settings.
2. Open the parent portal, enter a student code and turn on notifications on
   the report page.
3. In the teacher portal, use **🔔 Send Notification**. It reports how many
   devices received the notification.
4. Publish an assignment or add marks. The notification should arrive within
   a few seconds.

If nothing arrives, check Edge Functions → `push-notify` → Logs. For the
database triggers, also check `select * from net._http_response order by created desc limit 20;`.

## Changing the keys

If the VAPID keys are ever regenerated:

1. Update the public key in `push-notifications.js`.
2. Update the Supabase secrets.
3. Run `delete from public.push_subscriptions;`. Everyone then turns
   notifications on again.
