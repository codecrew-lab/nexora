-- PULSE database performance follow-up
-- Applied to project iazlemocpuhzwtrkyfgw on 2026-11-16.
-- These indexes cover foreign keys reported by Supabase Performance Advisors.

create index if not exists academic_calendar_events_created_by_idx
  on public.academic_calendar_events (created_by);

create index if not exists student_sibling_link_requests_requester_student_id_idx
  on public.student_sibling_link_requests (requester_student_id);

create index if not exists student_sibling_link_requests_target_student_id_idx
  on public.student_sibling_link_requests (target_student_id);

create index if not exists student_sibling_links_created_by_idx
  on public.student_sibling_links (created_by);

create index if not exists student_sibling_links_student_b_id_idx
  on public.student_sibling_links (student_b_id);
