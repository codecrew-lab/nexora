import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const allowedOrigins = new Set([
  "https://zaminmohammed78-bit.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:5500",
]);

function cors(origin: string | null) {
  const allowed = origin && allowedOrigins.has(origin)
    ? origin
    : "https://zaminmohammed78-bit.github.io";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: Record<string, unknown>, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405, origin);

  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\\s+/i, "");
    if (!token) return json({ error: "Sign in as a teacher first." }, 401, origin);

    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) {
      return json({ error: "Student account service is not configured." }, 503, origin);
    }

    const admin = createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: authData, error: authError } = await admin.auth.getUser(token);
    const teacher = authData?.user;
    const role = teacher?.app_metadata?.role;
    const isAuthorizedTeacher = teacher?.email?.toLowerCase() === "teacher@auraway.app"
      || role === "teacher"
      || role === "school_admin";

    // Match the teacher portal's existing authorization rule. Roles come from
    // app_metadata, which users cannot edit themselves.
    if (authError || !teacher || !isAuthorizedTeacher) {
      return json({ error: "Only an authorized teacher can manage student passwords." }, 403, origin);
    }

    const body = await req.json().catch(() => ({}));
    const studentId = Number(body?.student_id);
    const password = typeof body?.password === "string" ? body.password : "";
    if (!Number.isSafeInteger(studentId) || studentId <= 0) {
      return json({ error: "A valid student record is required." }, 400, origin);
    }
    if (password.length < 10 || password.length > 72) {
      return json({ error: "Password must be between 10 and 72 characters." }, 400, origin);
    }

    const { data: student, error: studentError } = await admin
      .from("students")
      .select("id,student_name,student_code,auth_user_id")
      .eq("id", studentId)
      .maybeSingle();
    if (studentError) throw studentError;
    if (!student) return json({ error: "Student record not found." }, 404, origin);

    const email = student.student_code.trim().toLowerCase() + "@students.pulse.app";
    let accountId: string | null = student.auth_user_id || null;

    if (accountId) {
      const { data: updated, error } = await admin.auth.admin.updateUserById(accountId, {
        password,
        email,
        email_confirm: true,
        app_metadata: { role: "student" },
        user_metadata: { display_name: student.student_name },
      });
      if (error) throw error;
      accountId = updated.user.id;
    } else {
      const { data: listed, error: listError } = await admin.auth.admin.listUsers({
        page: 1,
        perPage: 1000,
      });
      if (listError) throw listError;

      const existing = listed.users.find(user => user.email?.toLowerCase() === email);
      if (existing) {
        const { data: updated, error } = await admin.auth.admin.updateUserById(existing.id, {
          password,
          email_confirm: true,
          app_metadata: { ...existing.app_metadata, role: "student" },
          user_metadata: { ...existing.user_metadata, display_name: student.student_name },
        });
        if (error) throw error;
        accountId = updated.user.id;
      } else {
        const { data: created, error } = await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          app_metadata: { role: "student" },
          user_metadata: { display_name: student.student_name },
        });
        if (error) throw error;
        accountId = created.user.id;
      }
    }

    const { error: linkError } = await admin
      .from("students")
      .update({ auth_user_id: accountId })
      .eq("id", student.id);
    if (linkError) throw linkError;

    return json({
      success: true,
      student_name: student.student_name,
      student_code: student.student_code,
      message: "Permanent password saved. Share it privately with the student.",
    }, 200, origin);
  } catch (error) {
    console.error("Student account password update failed:", error);
    return json({
      error: error instanceof Error ? error.message : "Unable to update student password.",
    }, 500, origin);
  }
});
