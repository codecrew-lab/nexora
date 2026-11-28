// NEXORA RFID attendance endpoint.
//
// Called by the ESP32 reader in hardware/nexora_rfid_reader, never by browsers.
// Deploy with JWT verification disabled; the reader authenticates with the
// shared PULSE_RFID_DEVICE_SECRET instead:
//   supabase functions deploy pulse-rfid-attendance --no-verify-jwt
//
// Request:  POST, header x-pulse-device-secret, JSON body
//   scan:      { "card_uid": "39C38E02", "device_id": "main-gate", "scanned_at": 1764213000 }
//              scanned_at (unix seconds or ISO string) is only sent for offline replays.
//   heartbeat: { "type": "heartbeat", "device_id": "main-gate", "firmware": "2.0.0",
//                "rssi": -61, "queued": 0 }
//
// Response: always JSON with a "result" field. Every outcome the reader should
// display (including unknown cards) is HTTP 200; 4xx/5xx mean the request
// itself failed. The reader keeps 5xx/network failures queued and retries.
//   present_marked | already_marked | unregistered_card | student_unavailable |
//   scan_too_old | ok (heartbeat) | error

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const fail = (error: string, status: number) => json({ result: "error", error }, status);

function safeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aa = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = aa.length ^ bb.length;
  const length = Math.max(aa.length, bb.length);
  for (let i = 0; i < length; i++) diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

function parseScannedAt(value: unknown): string | null {
  if (value === undefined || value === null || value === "" || value === 0) return null;
  const date = typeof value === "number"
    ? new Date(value * 1000)
    : typeof value === "string"
    ? new Date(/^\d+$/.test(value) ? Number(value) * 1000 : value)
    : null;
  // Ignore unset device clocks (before 2024) and garbage; the server time is used instead.
  if (!date || Number.isNaN(date.getTime()) || date.getTime() < Date.UTC(2024, 0, 1)) return null;
  return date.toISOString();
}

const asInt = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return fail("Method not allowed.", 405);

  const expectedSecret = Deno.env.get("PULSE_RFID_DEVICE_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!expectedSecret || expectedSecret.length < 32 || !supabaseUrl || !serviceRoleKey) {
    console.error("RFID attendance is missing required server configuration.");
    return fail("RFID attendance is not configured.", 503);
  }

  if (!safeEqual(req.headers.get("x-pulse-device-secret") ?? "", expectedSecret)) {
    return fail("Unauthorized device.", 401);
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return fail("Invalid JSON body.", 400);
  }

  const deviceId = typeof body.device_id === "string"
    ? body.device_id
    : req.headers.get("x-pulse-device-id");

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (body.type === "heartbeat") {
    const { data, error } = await admin.rpc("rfid_device_heartbeat", {
      p_device_id: deviceId,
      p_firmware_version: typeof body.firmware === "string" ? body.firmware : null,
      p_wifi_rssi: asInt(body.rssi),
      p_queued_scans: asInt(body.queued) ?? 0,
    });
    if (error) {
      console.error("RFID heartbeat failed:", error.message);
      return fail("Heartbeat could not be recorded.", 500);
    }
    return json(data as Record<string, unknown>);
  }

  if (typeof body.card_uid !== "string") return fail("card_uid is required.", 400);
  const cardUid = body.card_uid.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  if (!/^[0-9A-F]{8,20}$/.test(cardUid)) return fail("Invalid card UID format.", 400);

  const { data, error } = await admin.rpc("record_rfid_scan", {
    p_card_uid: cardUid,
    p_device_id: deviceId,
    p_scanned_at: parseScannedAt(body.scanned_at),
  });

  if (error) {
    if (error.code === "22023") return fail(error.message, 400);
    // PGRST202: the function does not exist yet (migration not applied).
    console.error("RFID attendance processing failed:", error.code, error.message);
    return fail("Attendance could not be recorded.", error.code === "PGRST202" ? 503 : 500);
  }

  return json(data as Record<string, unknown>);
});
