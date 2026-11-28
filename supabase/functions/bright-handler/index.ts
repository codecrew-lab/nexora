import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Browser origins allowed to call this function: the GitHub Pages site, the
// Android apps, and local development. The Android apps load pages from
// file:///android_asset, which browsers report as the origin "null". That is
// safe here because this function uses no cookies or ambient credentials.
// Set the NEXORA_ALLOWED_ORIGINS secret (comma-separated) to override.
const allowedOrigins = new Set(
  (Deno.env.get("NEXORA_ALLOWED_ORIGINS") ??
    "https://codecrew-lab.github.io,null,http://localhost:3000,http://127.0.0.1:5500")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const defaultOrigin = "https://codecrew-lab.github.io";

const isAllowedOrigin = (origin: string | null) => !origin || allowedOrigins.has(origin);

const corsHeaders = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : defaultOrigin,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});

const jsonFor = (origin: string | null) => (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });

// Per-isolate throttling is defense-in-depth only. Configure an edge/WAF rate
// limit as well before production use because serverless instances can scale.
const failedAttempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const current = failedAttempts.get(key);
  if (!current || current.resetAt <= now) {
    failedAttempts.set(key, { count: 0, resetAt: now + WINDOW_MS });
    return false;
  }
  return current.count >= MAX_FAILURES;
}

function recordFailure(key: string): void {
  const now = Date.now();
  const current = failedAttempts.get(key);
  if (!current || current.resetAt <= now) {
    failedAttempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    current.count += 1;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const json = jsonFor(origin);
  if (req.method === "OPTIONS") {
    if (!isAllowedOrigin(origin)) return new Response("Origin not allowed", { status: 403 });
    return new Response("ok", { headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  if (!isAllowedOrigin(origin)) {
    return json({ error: "Origin not allowed." }, 403);
  }

  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  if (isRateLimited(ip)) {
    return json({ error: "Too many attempts. Please wait 15 minutes and try again." }, 429);
  }

  try {
    const loginCode = Deno.env.get("TEACHER_LOGIN_CODE");
    const accessCode = Deno.env.get("TEACHER_ACCESS_CODE");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!loginCode || !accessCode || !supabaseUrl || !serviceRoleKey) {
      console.error("Teacher sign-in is missing required server configuration.");
      return json({ error: "Teacher sign-in is not configured yet." }, 503);
    }

    const body = await req.json().catch(() => ({}));
    const suppliedLoginCode = typeof body?.login_code === "string" ? body.login_code.trim() : "";
    const suppliedAccessCode = typeof body?.access_code === "string" ? body.access_code : "";

    if (
      body?.action !== "signin" ||
      !constantTimeEqual(suppliedLoginCode, loginCode) ||
      !constantTimeEqual(suppliedAccessCode, accessCode)
    ) {
      recordFailure(ip);
      return json({ error: "The login details are incorrect." }, 401);
    }

    failedAttempts.delete(ip);

    const email = "teacher@auraway.app";
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Only authenticate the existing teacher account. Never create users or
    // change account metadata/passwords, and never access student records.
    const { data: listed, error: listError } = await admin.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    if (listError) throw listError;

    const teacher = listed.users.find((user) => user.email?.toLowerCase() === email);
    if (!teacher) {
      return json({ error: "The existing teacher account was not found. Contact the school administrator." }, 404);
    }

    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (linkError) throw linkError;

    const tokenHash = linkData.properties?.hashed_token;
    if (!tokenHash) throw new Error("Supabase did not return a one-time sign-in token.");
    return json({ token_hash: tokenHash });
  } catch (error) {
    console.error("Teacher sign-in error:", error);
    return json({ error: "Teacher sign-in could not be completed. Please try again." }, 500);
  }
});
