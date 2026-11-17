# SMARTSEED / PULSE teacher account security

The teacher portal now uses **individual email-and-password accounts**. Public signup does not grant teacher permissions. Every new teacher request remains pending until a school administrator approves it.

## Security model

- Each teacher signs in with their own verified email address and password.
- New accounts receive no teacher role at signup.
- A verified account can submit a teacher-access request.
- Only a user whose server-controlled Supabase `app_metadata.role` is `school_admin` can list, approve, or reject requests.
- Approval sets `app_metadata.role = teacher` on that individual Auth user.
- All approved teachers can see and manage all student records, subject to the existing teacher RLS policies.
- Student accounts cannot be upgraded to teacher accounts through the request flow.
- The teacher approval-request table has no direct access for `anon` or `authenticated`; only the trusted Edge Function uses the service role.
- The browser never receives the service-role key.

## Required first-time setup

**Do these steps with the school's authorised administrator.** The current project has no account with the `school_admin` role, so the first administrator must be bootstrapped manually before teachers can be approved.

1. In Supabase Dashboard, open **Authentication → Users**.
2. Invite or create an Auth user for the official school administrator using an email address the school controls. Verify that email.
3. Open that user's **App Metadata** (not User Metadata) and set:
   ```json
   { "role": "school_admin" }
   ```
   Do not put this role in User Metadata. User Metadata can be edited by the account holder and is not trusted for permissions.
4. Apply the migration `supabase/migrations/20261117190000_individual_teacher_approval.sql` to the connected Supabase project. It creates the private approval-request table and removes the old shared-email shortcut from `is_auraway_teacher()`.
5. Deploy the Edge Function source at `supabase/functions/hyper-function/index.ts` to the existing function slug **hyper-function** for project `iazlemocpuhzwtrkyfgw`. Keep the existing `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` server secrets configured. Do not put either key in GitHub Pages or browser code.
6. In Supabase Authentication settings, enable the Email provider and choose the school's email-confirmation policy. Set the Site URL and allowed redirect URLs for the published PULSE website.
7. The first administrator signs in at `teacher.html` with the email/password account created in step 2. If the admin metadata was changed while signed in, sign out and sign in again to refresh the token.
8. Teachers can now create their own accounts. They must verify their email and sign in to submit a request. The administrator reviews requests in **School Admin — Teacher Approvals** and approves or rejects each one.
9. After approval, the teacher must sign out and sign in again so the new app-metadata role appears in their access token.

## Important migration effect

The old shared identity `teacher@auraway.app` is no longer automatically trusted by the teacher RLS helper. It is **not** automatically promoted to school administrator. Use an official school-controlled administrator account for the bootstrap step above. Until the first administrator is configured and the migration/function are deployed, the teacher portal should remain unavailable rather than grant broad access.

## Verification checklist

- A newly registered, unapproved account cannot open teacher data.
- A student-role account cannot request teacher access.
- A normal teacher cannot list or approve requests.
- A school administrator can approve a pending teacher.
- After signing in again, the approved teacher can view the student roster.
- An unapproved account still cannot read teacher-only tables directly through the Supabase API.
- No service-role key or admin approval secret appears in frontend files.

## Rollback note

Do not restore the old shared-access function or the email-based bypass in `is_auraway_teacher()` as a quick fix. If an issue occurs, pause teacher access and have the school administrator review the migration and Edge Function deployment. Existing student and attendance rows are not modified by this migration.
