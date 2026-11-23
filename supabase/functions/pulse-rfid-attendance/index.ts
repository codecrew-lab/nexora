import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

function safeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aa = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = aa.length ^ bb.length;
  const length = Math.max(aa.length, bb.length);
  for (let i = 0; i < length; i++) diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

function indiaDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const expectedSecret = Deno.env.get("PULSE_RFID_DEVICE_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!expectedSecret || expectedSecret.length < 32 || !supabaseUrl || !serviceRoleKey) {
    console.error("RFID attendance is missing required server configuration.");
    return json({ error: "RFID attendance is not configured." }, 503);
  }

  const suppliedSecret = req.headers.get("x-pulse-device-secret") ?? "";
  if (!safeEqual(suppliedSecret, expectedSecret)) {
    return json({ error: "Unauthorized device." }, 401);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const rawUid = (body as { card_uid?: unknown })?.card_uid;
  if (typeof rawUid !== "string") return json({ error: "card_uid is required." }, 400);
  const cardUid = rawUid.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  if (!/^[0-9A-F]{8,20}$/.test(cardUid)) {
    return json({ error: "Invalid card UID format." }, 400);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const { data: card, error: cardError } = await admin
      .from("student_rfid_cards")
      .select("student_id")
      .eq("card_uid", cardUid)
      .eq("active", true)
      .maybeSingle();

    if (cardError) throw cardError;
    if (!card) return json({ result: "unregistered_card" }, 404);

    const { data: student, error: studentError } = await admin
      .from("students")
      .select("student_code, student_name")
      .eq("id", card.student_id)
      .maybeSingle();

    if (studentError) throw studentError;
    if (!student?.student_code) return json({ error: "Student record unavailable." }, 404);

    const attendanceDate = indiaDate();
    const { error: insertError } = await admin.from("attendance_records").insert({
      student_code: student.student_code,
      attendance_date: attendanceDate,
      status: "Present",
      marked_by: null,
    });

    if (insertError?.code === "23505") {
      const { data: existing, error: existingError } = await admin
        .from("attendance_records")
        .select("status")
        .eq("student_code", student.student_code)
        .eq("attendance_date", attendanceDate)
        .maybeSingle();
      if (existingError) throw existingError;
      return json({
        result: "already_marked",
        status: existing?.status ?? "Recorded",
        student_name: student.student_name ?? "Student",
        attendance_date: attendanceDate,
      });
    }
    if (insertError) throw insertError;

    return json({
      result: "present_marked",
      student_name: student.student_name ?? "Student",
      attendance_date: attendanceDate,
    });
  } catch (error) {
    console.error("RFID attendance processing failed:", error);
    return json({ error: "Attendance could not be recorded." }, 500);
  }
});
