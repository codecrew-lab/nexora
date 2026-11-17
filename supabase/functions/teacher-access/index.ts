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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      console.error("Teacher access service is missing server configuration.");
      return json({ error: "Teacher access is temporarily unavailable." }, 503);
    }

    const authorization = req.headers.get("Authorization") || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token) return json({ error: "Sign in before continuing." }, 401);

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: authData, error: authError } = await admin.auth.getUser(token);
    if (authError || !authData.user) return json({ error: "Your session is invalid. Sign in again." }, 401);

    const user = authData.user;
    const role = user.app_metadata?.role;
    const isSchoolAdmin = role === "school_admin";
    const body = await req.json().catch(() => ({}));
    const action = body?.action;

    if (action === "request") {
      if (role === "teacher" || isSchoolAdmin) {
        return json({ status: "approved", message: "This account is already approved." });
      }
      const fullName = typeof body?.full_name === "string" ? body.full_name.trim() : "";
      if (fullName.length < 2 || fullName.length > 100 || !user.email) {
        return json({ error: "Enter your name and verify your email address." }, 400);
      }

      const { data: existing, error: lookupError } = await admin
        .from("teacher_access_requests")
        .select("id,status")
        .eq("user_id", user.id)
        .maybeSingle();
      if (lookupError) throw lookupError;

      if (existing?.status === "approved") {
        return json({ status: "approved", message: "This account is already approved." });
      }
      if (existing?.status === "pending") {
        return json({ status: "pending", message: "Your request is waiting for school-admin approval." });
      }

      if (existing?.status === "rejected") {
        const { error } = await admin.from("teacher_access_requests").update({
          full_name: fullName,
          email: user.email,
          status: "pending",
          created_at: new Date().toISOString(),
          reviewed_at: null,
          reviewed_by: null,
        }).eq("id", existing.id);
        if (error) throw error;
      } else {
        const { error } = await admin.from("teacher_access_requests").insert({
          user_id: user.id,
          full_name: fullName,
          email: user.email,
          status: "pending",
        });
        if (error) throw error;
      }
      return json({ status: "pending", message: "Your request has been sent to the school administrator." });
    }

    if (!isSchoolAdmin) return json({ error: "Only an approved school administrator can perform this action." }, 403);

    if (action === "list") {
      const { data, error } = await admin.from("teacher_access_requests")
        .select("id,user_id,full_name,email,status,created_at")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(100);
      if (error) throw error;
      return json({ requests: data || [] });
    }

    const requestId = typeof body?.request_id === "string" ? body.request_id : "";
    if (!requestId) return json({ error: "A valid request ID is required." }, 400);

    const { data: request, error: requestError } = await admin
      .from("teacher_access_requests")
      .select("id,user_id,status")
      .eq("id", requestId)
      .maybeSingle();
    if (requestError) throw requestError;
    if (!request || request.status !== "pending") {
      return json({ error: "This request is no longer pending." }, 404);
    }

    if (action === "approve") {
      const { data: targetData, error: targetError } = await admin.auth.admin.getUserById(request.user_id);
      if (targetError || !targetData.user) return json({ error: "The teacher account could not be found." }, 404);
      const target = targetData.user;
      const { error: roleError } = await admin.auth.admin.updateUserById(target.id, {
        app_metadata: { ...target.app_metadata, role: "teacher" },
      });
      if (roleError) throw roleError;
      const { error: updateError } = await admin.from("teacher_access_requests").update({
        status: "approved",
        reviewed_at: new Date().toISOString(),
        reviewed_by: user.id,
      }).eq("id", request.id);
      if (updateError) throw updateError;
      return json({ status: "approved", message: "Teacher approved. They must sign in again to refresh their permissions." });
    }

    if (action === "reject") {
      const { error } = await admin.from("teacher_access_requests").update({
        status: "rejected",
        reviewed_at: new Date().toISOString(),
        reviewed_by: user.id,
      }).eq("id", request.id);
      if (error) throw error;
      return json({ status: "rejected", message: "Teacher request rejected." });
    }

    return json({ error: "Unsupported action." }, 400);
  } catch (error) {
    console.error("Teacher access request failed:", error);
    return json({ error: "Teacher access could not be completed. Please try again." }, 500);
  }
});
