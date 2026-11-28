// NEXORA web push notifications.
//
// Actions (POST JSON body):
//   subscribe    – student (Supabase session JWT) or parent (student code) saves this device.
//   unsubscribe  – removes this device's subscriptions (by endpoint).
//   broadcast    – teacher sends a custom notification to all / a class / one student.
//   event        – database trigger (x-nexora-push-secret header): new assignment,
//                  attendance change, new marks.
//
// Required secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, PUSH_WEBHOOK_SECRET.
// Optional: VAPID_SUBJECT (mailto: or https: contact URL).
// Works with "Verify JWT" on or off: callers send the publishable key, and this
// function performs its own student / parent / teacher / trigger checks.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const allowedOrigins = new Set([
  "https://zaminmohammed78-bit.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:5500",
]);
const APP_BASE_URL = "https://zaminmohammed78-bit.github.io/PULSE/";
const TEACHER_EMAIL = "teacher@auraway.app";
const SCHOOL_TIMEZONE = "Asia/Kolkata";

function cors(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : "https://zaminmohammed78-bit.github.io",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: Record<string, unknown>, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

// Simple per-instance rate limit for the unauthenticated parent subscribe path.
const attempts = new Map<string, { count: number; resetAt: number }>();
function rateLimited(req: Request): boolean {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  for (const [key, value] of attempts) if (value.resetAt <= now) attempts.delete(key);
  const bucket = attempts.get(ip);
  if (!bucket) { attempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 }); return false; }
  bucket.count += 1;
  return bucket.count > 20;
}

const clean = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
const normalizeCode = (value: unknown) => clean(value, 40).toUpperCase();

type PushRow = { endpoint: string; p256dh: string; auth: string; role: string; student_code: string };
type Payload = { title: string; body: string; url: string; tag?: string };
type Role = "student" | "parent";

function todayInSchool(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SCHOOL_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function timeInSchool(iso: string | undefined): string {
  const date = iso ? new Date(iso) : new Date();
  return date.toLocaleTimeString("en-IN", { timeZone: SCHOOL_TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: true });
}

function formatDate(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value + "T00:00:00");
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

async function getUser(admin: SupabaseClient, req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!token || token.startsWith("sb_")) return null; // publishable key, not a user session
  const { data, error } = await admin.auth.getUser(token);
  return error ? null : data.user;
}

function isTeacher(user: { email?: string; app_metadata?: Record<string, unknown> } | null): boolean {
  if (!user) return false;
  const role = String(user.app_metadata?.role ?? "");
  return user.email?.toLowerCase() === TEACHER_EMAIL || ["teacher", "school_admin"].includes(role);
}

// Returns student codes for a target, or null meaning "everyone".
async function codesForTarget(admin: SupabaseClient, target: string): Promise<string[] | null> {
  if (!target || target.toUpperCase() === "ALL") return null;
  if (target.startsWith("CLASS:")) {
    const { data, error } = await admin.from("students").select("student_code").eq("class_name", target.slice(6));
    if (error) throw error;
    return (data ?? []).map((row) => row.student_code).filter(Boolean);
  }
  return [target.toUpperCase()];
}

async function findSubscriptions(admin: SupabaseClient, roles: Role[], codes: string[] | null): Promise<PushRow[]> {
  if (codes && codes.length === 0) return [];
  const rows: PushRow[] = [];
  const chunks = codes ? Array.from({ length: Math.ceil(codes.length / 200) }, (_, i) => codes.slice(i * 200, i * 200 + 200)) : [null];
  for (const chunk of chunks) {
    let query = admin.from("push_subscriptions").select("endpoint,p256dh,auth,role,student_code").in("role", roles);
    if (chunk) query = query.in("student_code", chunk);
    const { data, error } = await query.limit(5000);
    if (error) throw error;
    rows.push(...((data ?? []) as PushRow[]));
  }
  return rows;
}

// Sends one payload per role to each device once, and removes expired subscriptions.
async function deliver(admin: SupabaseClient, rows: PushRow[], payloadFor: (role: Role) => Payload): Promise<number> {
  const seen = new Set<string>();
  const unique = rows.filter((row) => {
    const key = row.endpoint + "|" + row.role;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const expired: string[] = [];
  let sent = 0;
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    const results = await Promise.allSettled(batch.map((row) => {
      const payload = payloadFor(row.role as Role);
      const absoluteUrl = new URL(payload.url, APP_BASE_URL).href;
      return webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        JSON.stringify({ ...payload, url: absoluteUrl }),
        { TTL: 60 * 60 * 24, urgency: "high" },
      );
    }));
    results.forEach((result, index) => {
      if (result.status === "fulfilled") { sent++; return; }
      const status = (result.reason as { statusCode?: number })?.statusCode;
      if (status === 404 || status === 410) expired.push(batch[index].endpoint);
      else console.error("Push delivery failed:", status ?? "", (result.reason as Error)?.message ?? "");
    });
  }
  if (expired.length) {
    const { error } = await admin.from("push_subscriptions").delete().in("endpoint", expired);
    if (error) console.error("Could not remove expired subscriptions:", error.message);
  }
  return sent;
}

async function studentByCode(admin: SupabaseClient, code: string) {
  const { data, error } = await admin.from("students").select("id,student_name,class_name,student_code").eq("student_code", code).maybeSingle();
  if (error) throw error;
  return data;
}

async function handleEvent(admin: SupabaseClient, body: Record<string, unknown>): Promise<number> {
  const table = clean(body.table, 60);
  const record = (body.record ?? {}) as Record<string, string>;

  if (table === "assignments") {
    const codes = await codesForTarget(admin, clean(record.target_code, 160) || "ALL");
    const rows = await findSubscriptions(admin, ["student", "parent"], codes);
    const subject = clean(record.subject, 80) || "New assignment";
    const due = formatDate(record.due_date);
    const text = clean(record.title, 160) + (due ? ` · Due ${due}` : "");
    return deliver(admin, rows, (role) => ({
      title: role === "parent" ? `📚 New homework: ${subject}` : `📚 New assignment: ${subject}`,
      body: text,
      url: role === "parent" ? "parent.html" : "classroom.html",
      tag: "assignment-" + record.id,
    }));
  }

  if (table === "attendance_records") {
    // Only notify for today's attendance, not when a teacher corrects old records.
    if (record.attendance_date !== todayInSchool()) return 0;
    const code = normalizeCode(record.student_code);
    const student = await studentByCode(admin, code);
    if (!student) return 0;
    const name = student.student_name || "Your child";
    const status = record.status;
    // RFID v2 rows carry source = 'rfid', the real scan time and an is_late flag.
    const isRfid = String(record.source) === "rfid" || (record.source == null && record.marked_by == null);
    const isLate = String(record.is_late) === "true";
    const message =
      status === "Present"
        ? (isRfid
            ? `${name} arrived at school at ${timeInSchool(record.scanned_at || record.created_at)}${isLate ? " (late)" : ""}.`
            : `${name} was marked present today.`)
        : status === "Absent"
          ? `${name} was marked absent today. Please contact the school if this is unexpected.`
          : `${name} was marked on leave today.`;
    const rows = await findSubscriptions(admin, ["parent"], [code]);
    return deliver(admin, rows, () => ({
      title: status === "Absent" ? "⚠️ Attendance alert" : "📋 Attendance update",
      body: message,
      url: "parent.html",
      tag: `attendance-${code}-${record.attendance_date}`,
    }));
  }

  if (table === "student_marks") {
    const { data: student, error } = await admin.from("students").select("student_name,student_code").eq("id", record.student_id).maybeSingle();
    if (error) throw error;
    if (!student?.student_code) return 0;
    const rows = await findSubscriptions(admin, ["student", "parent"], [student.student_code]);
    const score = `${Number(record.marks_obtained)}/${Number(record.marks_total)}`;
    const subject = clean(record.subject, 80);
    const exam = clean(record.exam_name, 120);
    return deliver(admin, rows, (role) => ({
      title: "📈 New marks published",
      body: role === "parent"
        ? `${student.student_name || "Your child"} scored ${score} in ${subject} (${exam}).`
        : `You scored ${score} in ${subject} (${exam}).`,
      url: role === "parent" ? "parent.html" : "marks.html",
      tag: "marks-" + record.id,
    }));
  }

  return 0;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405, origin);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY");
  const webhookSecret = Deno.env.get("PUSH_WEBHOOK_SECRET");
  if (!supabaseUrl || !serviceKey || !vapidPublic || !vapidPrivate || !webhookSecret || webhookSecret.length < 32) {
    console.error("push-notify is missing required secrets.");
    return json({ error: "Notifications are not configured yet." }, 503, origin);
  }
  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") || APP_BASE_URL, vapidPublic, vapidPrivate);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const action = clean(body.action, 20);

  try {
    if (action === "event") {
      if (!safeEqual(req.headers.get("x-nexora-push-secret") ?? "", webhookSecret)) {
        return json({ error: "Unauthorized." }, 401, origin);
      }
      const sent = await handleEvent(admin, body);
      return json({ ok: true, sent }, 200, origin);
    }

    if (action === "subscribe") {
      const sub = (body.subscription ?? {}) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      const endpoint = clean(sub.endpoint, 1000);
      const p256dh = clean(sub.keys?.p256dh, 200);
      const auth = clean(sub.keys?.auth, 100);
      if (!endpoint.startsWith("https://") || !p256dh || !auth) {
        return json({ error: "Invalid push subscription." }, 400, origin);
      }

      let role: Role;
      let studentCode: string;
      if (body.role === "student") {
        const user = await getUser(admin, req);
        if (!user) return json({ error: "Please sign in again." }, 401, origin);
        const { data: student, error } = await admin.from("students").select("student_code").eq("auth_user_id", user.id).maybeSingle();
        if (error) throw error;
        if (!student?.student_code) return json({ error: "This login is not linked to a student." }, 403, origin);
        role = "student";
        studentCode = student.student_code;
      } else if (body.role === "parent") {
        if (rateLimited(req)) return json({ error: "Too many attempts. Please wait and try again." }, 429, origin);
        const code = normalizeCode(body.student_code);
        if (!/^[A-Z0-9-]{4,40}$/.test(code) || !(await studentByCode(admin, code))) {
          return json({ error: "Invalid student code." }, 400, origin);
        }
        role = "parent";
        studentCode = code;
      } else {
        return json({ error: "Unknown role." }, 400, origin);
      }

      const { error } = await admin.from("push_subscriptions").upsert({
        endpoint, p256dh, auth, role, student_code: studentCode,
        user_agent: clean(req.headers.get("user-agent"), 300) || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "endpoint,role,student_code" });
      if (error) throw error;
      return json({ ok: true }, 200, origin);
    }

    if (action === "unsubscribe") {
      const endpoint = clean(body.endpoint, 1000);
      if (!endpoint) return json({ error: "Missing endpoint." }, 400, origin);
      let query = admin.from("push_subscriptions").delete().eq("endpoint", endpoint);
      if (body.role === "student" || body.role === "parent") query = query.eq("role", body.role);
      const code = normalizeCode(body.student_code);
      if (code) query = query.eq("student_code", code);
      const { error } = await query;
      if (error) throw error;
      return json({ ok: true }, 200, origin);
    }

    if (action === "broadcast") {
      const user = await getUser(admin, req);
      if (!isTeacher(user)) return json({ error: "Teacher sign-in required." }, 403, origin);
      const title = clean(body.title, 80);
      const message = clean(body.message, 300);
      if (!title || !message) return json({ error: "Enter a title and a message." }, 400, origin);
      const audience = clean(body.audience, 20);
      const roles: Role[] = audience === "students" ? ["student"] : audience === "parents" ? ["parent"] : ["student", "parent"];
      const codes = await codesForTarget(admin, clean(body.target, 160) || "ALL");
      const rows = await findSubscriptions(admin, roles, codes);
      const sent = await deliver(admin, rows, (role) => ({
        title: "🔔 " + title,
        body: message,
        url: role === "parent" ? "parent.html" : "index.html",
        tag: "broadcast-" + Date.now(),
      }));
      return json({ ok: true, sent, devices: rows.length }, 200, origin);
    }

    return json({ error: "Unknown action." }, 400, origin);
  } catch (error) {
    console.error("push-notify failed:", error instanceof Error ? error.message : error);
    return json({ error: "Notification request failed. Please try again." }, 500, origin);
  }
});
