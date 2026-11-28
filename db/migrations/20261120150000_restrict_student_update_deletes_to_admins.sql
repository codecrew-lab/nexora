-- Restrict deletion of live student activity to the dedicated school administrator.
-- Teachers can continue viewing and posting updates; student updates remain intact unless
-- an authorised administrator explicitly deletes them from the Teacher Portal.
drop policy if exists "Teachers delete student updates" on public.student_updates;

create policy "School admins delete student updates"
on public.student_updates
for delete
to authenticated
using (
  coalesce(
    (select auth.jwt() -> 'app_metadata' ->> 'role') = 'school_admin'
    or (select auth.jwt() ->> 'email') = 'teacher@auraway.app',
    false
  )
);
