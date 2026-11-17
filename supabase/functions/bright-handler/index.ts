import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

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
      return json({ error: "The login details are incorrect." }, 401);
    }

    const email = "teacher@auraway.app";
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Sign in only to the existing teacher account. Never create users or change
    // account metadata/passwords here; this preserves the existing account.
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
