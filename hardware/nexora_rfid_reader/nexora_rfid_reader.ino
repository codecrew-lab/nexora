// NEXORA RFID attendance reader
// ESP32 DevKit V1 + RC522 reader, optional SSD1306 OLED and passive buzzer.
//
// A student taps a card -> the reader POSTs the card UID to the
// pulse-rfid-attendance Supabase edge function -> the server marks the student
// Present for today (IST) and replies with the student's name.
//
// Reliability features:
//   * Offline queue: if Wi-Fi or the server is down, taps are saved in flash
//     with their time and sent automatically when the connection returns.
//   * Duplicate-tap protection: the same card is ignored for a few seconds.
//   * RC522 health check: the reader is re-initialised if it stops responding.
//   * Heartbeat: the teacher portal shows whether this reader is online.
//
// Setup: copy config.example.h to config.h and fill it in. See README.md.

#if __has_include("config.h")
#include "config.h"
#else
#error "config.h is missing. Copy config.example.h to config.h and fill in your Wi-Fi details and device secret."
#endif

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <MFRC522.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <time.h>

#include "certificates.h"

#define FIRMWARE_VERSION "2.0.0"

static_assert(sizeof(DEVICE_SECRET) > 32, "DEVICE_SECRET in config.h must be at least 32 characters.");

// ---------------------------------------------------------------------------
// Timing (milliseconds)
// ---------------------------------------------------------------------------
static const uint32_t SAME_CARD_COOLDOWN_MS = 5000;     // ignore the same card re-tapped within this time
static const uint32_t RESULT_SCREEN_MS = 4000;          // how long a result stays on the OLED
static const uint32_t HTTP_TIMEOUT_MS = 10000;
static const uint32_t WIFI_BOOT_WAIT_MS = 20000;
static const uint32_t WIFI_RETRY_MS = 15000;
static const uint32_t HEARTBEAT_INTERVAL_MS = 5UL * 60UL * 1000UL;
static const uint32_t READER_CHECK_MS = 30000;
static const uint32_t IDLE_BEFORE_BACKGROUND_MS = 8000; // no syncing while students are queuing to tap
static const uint32_t SYNC_BACKOFF_MIN_MS = 3000;
static const uint32_t SYNC_BACKOFF_MAX_MS = 5UL * 60UL * 1000UL;

static const time_t VALID_TIME_AFTER = 1704067200;      // 2024-01-01: anything earlier means NTP has not synced

// ---------------------------------------------------------------------------
// Hardware
// ---------------------------------------------------------------------------
static const int SCREEN_WIDTH = 128;
static const int SCREEN_HEIGHT = 64;
static const int CHARS_PER_LINE = 21;                   // text size 1 = 6 px per character

MFRC522 rfid(RFID_SS_PIN, RFID_RST_PIN);
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);
Preferences prefs;

bool oledReady = false;
bool readerOk = false;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
String screenStatus = "Starting...";
String screenLine1 = "NEXORA";
String screenLine2 = "";
bool resultActive = false;
uint32_t resultUntil = 0;
uint32_t lastClockDraw = 0;

bool wifiWasConnected = false;
uint32_t lastWifiAttempt = 0;
uint32_t lastHeartbeat = 0;
bool heartbeatDue = true;
uint32_t lastReaderCheck = 0;
uint32_t lastTapAt = 0;

String lastUid = "";
uint32_t lastUidAt = 0;

uint32_t nextSyncAt = 0;
uint32_t syncBackoff = SYNC_BACKOFF_MIN_MS;

// ---------------------------------------------------------------------------
// Offline queue, persisted in NVS flash as one small entry per key ("q0".."q149")
// so adding or removing a tap only rewrites a few bytes.
// ---------------------------------------------------------------------------
static const uint16_t MAX_QUEUE = 150;
static const uint8_t SCAN_TIME_KNOWN = 0x01;

struct QueuedScan {
  char uid[21];
  uint8_t flags;
  uint32_t when;    // unix seconds if SCAN_TIME_KNOWN, otherwise millis() at the tap
  uint32_t bootId;  // lets a millis() timestamp be converted later in the same power cycle
};

uint16_t queueHead = 0;
uint16_t queueCount = 0;
uint32_t bootId = 0;

String queueKey(uint16_t index) {
  return "q" + String(index);
}

void queueSaveIndexes() {
  prefs.putUShort("qh", queueHead);
  prefs.putUShort("qc", queueCount);
}

void queueLoad() {
  queueHead = prefs.getUShort("qh", 0);
  queueCount = prefs.getUShort("qc", 0);
  if (queueHead >= MAX_QUEUE || queueCount > MAX_QUEUE) {
    queueHead = 0;
    queueCount = 0;
    queueSaveIndexes();
  }
}

bool queuePeek(QueuedScan& scan) {
  if (queueCount == 0) return false;
  size_t read = prefs.getBytes(queueKey(queueHead).c_str(), &scan, sizeof(scan));
  scan.uid[sizeof(scan.uid) - 1] = '\0';
  return read == sizeof(scan);
}

void queuePop() {
  if (queueCount == 0) return;
  prefs.remove(queueKey(queueHead).c_str());
  queueHead = (queueHead + 1) % MAX_QUEUE;
  queueCount--;
  queueSaveIndexes();
}

void queuePush(const String& uid) {
  if (queueCount >= MAX_QUEUE) {
    Serial.println("Offline queue full: dropping the oldest tap.");
    queuePop();
  }

  QueuedScan scan = {};
  uid.toCharArray(scan.uid, sizeof(scan.uid));
  time_t now = time(nullptr);
  if (now > VALID_TIME_AFTER) {
    scan.flags = SCAN_TIME_KNOWN;
    scan.when = (uint32_t)now;
  } else {
    scan.flags = 0;
    scan.when = millis();
  }
  scan.bootId = bootId;

  uint16_t index = (queueHead + queueCount) % MAX_QUEUE;
  prefs.putBytes(queueKey(index).c_str(), &scan, sizeof(scan));
  queueCount++;
  queueSaveIndexes();
}

// Unix time of a queued tap, or 0 if it cannot be known (the server then uses
// the time it receives the tap).
uint32_t queuedScanTime(const QueuedScan& scan) {
  if (scan.flags & SCAN_TIME_KNOWN) return scan.when;
  time_t now = time(nullptr);
  if (scan.bootId != bootId || now <= VALID_TIME_AFTER) return 0;
  return (uint32_t)(now - (time_t)((millis() - scan.when) / 1000UL));
}

// ---------------------------------------------------------------------------
// Buzzer
// ---------------------------------------------------------------------------
void playTone(int frequency, int duration) {
  tone(BUZZER_PIN, frequency);
  delay(duration);
  noTone(BUZZER_PIN);
  delay(70);
}

void startupSound()       { playTone(523, 150); playTone(659, 150); playTone(784, 250); }
void cardDetectedSound()  { playTone(1100, 100); }
void wifiConnectedSound() { playTone(1000, 140); playTone(1400, 180); }
void successSound()       { playTone(1200, 120); playTone(1600, 150); }
void lateSound()          { playTone(1200, 120); playTone(900, 220); }
void alreadyMarkedSound() { playTone(900, 450); }
void savedOfflineSound()  { playTone(800, 120); playTone(800, 120); }
void unknownCardSound()   { playTone(450, 180); playTone(450, 180); playTone(450, 180); }
void errorSound()         { playTone(350, 250); playTone(250, 350); }

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------
bool timeIsValid() {
  return time(nullptr) > VALID_TIME_AFTER;
}

String formatNow(const char* pattern, const char* fallback) {
  struct tm info;
  if (!timeIsValid() || !getLocalTime(&info, 10)) return fallback;
  char buffer[16];
  strftime(buffer, sizeof(buffer), pattern, &info);
  return String(buffer);
}

// ---------------------------------------------------------------------------
// OLED
// ---------------------------------------------------------------------------
void drawWifiIcon() {
  if (WiFi.status() == WL_CONNECTED) {
    display.drawPixel(115, 2, SSD1306_WHITE);
    display.drawPixel(113, 3, SSD1306_WHITE);
    display.drawPixel(117, 3, SSD1306_WHITE);
    display.drawPixel(111, 4, SSD1306_WHITE);
    display.drawPixel(119, 4, SSD1306_WHITE);
    display.drawPixel(109, 6, SSD1306_WHITE);
    display.drawPixel(121, 6, SSD1306_WHITE);
    display.fillCircle(115, 9, 2, SSD1306_WHITE);
  } else {
    display.drawLine(109, 2, 122, 10, SSD1306_WHITE);
    display.drawLine(122, 2, 109, 10, SSD1306_WHITE);
  }
}

void drawScreen() {
  if (!oledReady) return;

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);

  display.setCursor(0, 1);
  display.print("NEXORA RFID");
  if (queueCount > 0) {
    display.setCursor(76, 1);
    display.print("Q");
    display.print(queueCount);
  }
  drawWifiIcon();
  display.drawLine(0, 13, 127, 13, SSD1306_WHITE);

  display.setCursor(0, 17);
  display.print(screenStatus.substring(0, CHARS_PER_LINE));

  // Long names wrap onto the second line.
  String first = screenLine1;
  String second = screenLine2;
  if (first.length() > CHARS_PER_LINE && second.length() == 0) {
    second = first.substring(CHARS_PER_LINE);
    first = first.substring(0, CHARS_PER_LINE);
  }
  display.setCursor(0, 30);
  display.print(first.substring(0, CHARS_PER_LINE));
  display.setCursor(0, 40);
  display.print(second.substring(0, CHARS_PER_LINE));

  display.setCursor(0, 54);
  display.print(formatNow("%H:%M:%S", "--:--:--"));
  display.setCursor(68, 54);
  display.print(formatNow("%d-%m-%Y", " no clock"));

  display.display();
}

void showIdle() {
  resultActive = false;
  if (!readerOk) {
    screenStatus = "RFID READER ERROR";
    screenLine1 = "Check RC522 wiring";
    screenLine2 = "";
  } else if (WiFi.status() != WL_CONNECTED) {
    screenStatus = "Tap your card";
    screenLine1 = "WiFi offline";
    screenLine2 = "Taps will sync later";
  } else {
    screenStatus = "Tap your card";
    screenLine1 = "NEXORA";
    screenLine2 = "";
    if (queueCount > 0) screenLine2 = "Syncing " + String(queueCount) + " saved taps";
  }
  drawScreen();
}

// A result (e.g. PRESENT MARKED) stays on screen for RESULT_SCREEN_MS.
void showResult(const String& status, const String& line1, const String& line2) {
  screenStatus = status;
  screenLine1 = line1;
  screenLine2 = line2;
  resultActive = true;
  resultUntil = millis() + RESULT_SCREEN_MS;
  drawScreen();
}

// A progress message shown while the reader is busy (e.g. waiting for the server).
void showBusy(const String& status, const String& line1) {
  screenStatus = status;
  screenLine1 = line1;
  screenLine2 = "";
  resultActive = false;
  drawScreen();
}

// ---------------------------------------------------------------------------
// RC522
// ---------------------------------------------------------------------------
bool readerResponds() {
  byte version = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  return version != 0x00 && version != 0xFF;
}

void initReader() {
  rfid.PCD_Init();
  delay(10);
  readerOk = readerResponds();
  Serial.printf("RC522 %s (version 0x%02X)\n", readerOk ? "ready" : "NOT RESPONDING",
                rfid.PCD_ReadRegister(MFRC522::VersionReg));
}

void maintainReader() {
  if (millis() - lastReaderCheck < READER_CHECK_MS) return;
  lastReaderCheck = millis();
  bool ok = readerResponds();
  if (!ok) {
    Serial.println("RC522 stopped responding; re-initialising.");
    initReader();
  }
  if (ok != readerOk) {
    readerOk = ok;
    if (!resultActive) showIdle();
  }
}

String readCardUid() {
  String uid;
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();
  return uid;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
// Returns the HTTP status (negative for connection/TLS failures). The parsed
// JSON reply, if any, is written to response.
int postToServer(JsonDocument& request, JsonDocument& response) {
  if (WiFi.status() != WL_CONNECTED) return -1;

  request["device_id"] = DEVICE_ID;
  String body;
  serializeJson(request, body);

  WiFiClientSecure client;
  client.setCACert(ROOT_CA_BUNDLE);
  HTTPClient http;
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);

  if (!http.begin(client, ATTENDANCE_ENDPOINT)) return -1;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-pulse-device-secret", DEVICE_SECRET);
  http.addHeader("x-pulse-device-id", DEVICE_ID);

  int code = http.POST(body);
  if (code > 0) {
    String payload = http.getString();
    Serial.printf("Server %d: %s\n", code, payload.c_str());
    if (deserializeJson(response, payload)) response.clear();
  } else {
    Serial.printf("Request failed: %s\n", http.errorToString(code).c_str());
  }
  http.end();
  return code;
}

int sendScan(const String& uid, uint32_t scannedAt, JsonDocument& response) {
  JsonDocument request;
  request["card_uid"] = uid;
  if (scannedAt > 0) request["scanned_at"] = scannedAt;
  return postToServer(request, response);
}

void sendHeartbeat() {
  JsonDocument request;
  request["type"] = "heartbeat";
  request["firmware"] = FIRMWARE_VERSION;
  request["rssi"] = WiFi.RSSI();
  request["queued"] = queueCount;
  JsonDocument response;
  postToServer(request, response);
  lastHeartbeat = millis();
  heartbeatDue = false;
}

// A request worth retrying later: no connection, timeout, or a server-side error.
bool isRetryable(int code) {
  return code < 0 || code >= 500;
}

// ---------------------------------------------------------------------------
// Tap handling
// ---------------------------------------------------------------------------
void saveOffline(const String& uid) {
  queuePush(uid);
  showResult("SAVED OFFLINE", "Tap recorded", "Will sync automatically");
  savedOfflineSound();
}

void handleTap(const String& uid) {
  Serial.println("Card UID: " + uid);
  cardDetectedSound();

  if (WiFi.status() != WL_CONNECTED) {
    saveOffline(uid);
    return;
  }

  showBusy("CHECKING CARD...", "Please wait");

  JsonDocument response;
  int code = sendScan(uid, 0, response);

  if (isRetryable(code)) {
    saveOffline(uid);
    return;
  }

  String result = response["result"] | "";
  String name = response["student_name"] | "Student";
  String status = response["status"] | "";
  bool late = response["late"] | false;

  // Read the result whatever the status code: the v1 server answers unknown
  // cards with HTTP 404 { "result": "unregistered_card" }.
  if (code == 401) {
    showResult("DEVICE REJECTED", "Check DEVICE_SECRET", "in config.h");
    errorSound();
  } else if (result == "present_marked") {
    if (late) {
      showResult("PRESENT - LATE", name, "");
      lateSound();
    } else {
      showResult("PRESENT MARKED", name, "");
      successSound();
    }
  } else if (result == "already_marked") {
    String detail = "";
    if (status.length() > 0 && status != "Present") detail = "Recorded as " + status;
    showResult("ALREADY MARKED", name, detail);
    alreadyMarkedSound();
  } else if (result == "unregistered_card") {
    showResult("UNKNOWN CARD", "UID " + uid, "Ask teacher to add");
    unknownCardSound();
  } else if (result == "student_unavailable") {
    showResult("CARD NOT LINKED", "Student record missing", "Please see teacher");
    errorSound();
  } else {
    String error = response["error"] | "Please try again";
    showResult("SERVER ERROR", error, "HTTP " + String(code));
    errorSound();
  }
}

void checkForCard() {
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return;

  String uid = readCardUid();
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  lastTapAt = millis();

  if (uid == lastUid && millis() - lastUidAt < SAME_CARD_COOLDOWN_MS) {
    lastUidAt = millis();
    return;
  }

  handleTap(uid);
  lastUid = uid;
  lastUidAt = millis();
  lastTapAt = millis();
}

// ---------------------------------------------------------------------------
// Background work: offline replay and heartbeat, only when nobody is tapping
// ---------------------------------------------------------------------------
void syncQueuedScan() {
  if (queueCount == 0 || (int32_t)(millis() - nextSyncAt) < 0) return;

  QueuedScan scan;
  if (!queuePeek(scan)) {
    Serial.println("Unreadable queued tap; discarding.");
    queuePop();
    return;
  }

  JsonDocument response;
  int code = sendScan(String(scan.uid), queuedScanTime(scan), response);

  if (isRetryable(code) || code == 401) {
    // Keep the tap. 401 means the secret is wrong; retrying fast will not help.
    syncBackoff = min(syncBackoff * 2, SYNC_BACKOFF_MAX_MS);
    nextSyncAt = millis() + syncBackoff;
    return;
  }

  // Handled (marked, already marked, unknown card, too old) or invalid: done.
  queuePop();
  syncBackoff = SYNC_BACKOFF_MIN_MS;
  nextSyncAt = millis() + 500;
  if (!resultActive) showIdle();
}

void runBackgroundWork() {
  if (WiFi.status() != WL_CONNECTED || resultActive) return;
  if (millis() - lastTapAt < IDLE_BEFORE_BACKGROUND_MS) return;

  if (heartbeatDue || millis() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
    sendHeartbeat();
    return;
  }
  syncQueuedScan();
}

// ---------------------------------------------------------------------------
// Wi-Fi
// ---------------------------------------------------------------------------
void onWifiConnected() {
  wifiWasConnected = true;
  Serial.print("Wi-Fi connected, IP ");
  Serial.println(WiFi.localIP());
  configTzTime(TIMEZONE, "pool.ntp.org", "time.google.com");
  heartbeatDue = true;
  nextSyncAt = millis() + 2000;
  syncBackoff = SYNC_BACKOFF_MIN_MS;
  wifiConnectedSound();
  if (!resultActive) showIdle();
}

void maintainWifi() {
  bool connected = WiFi.status() == WL_CONNECTED;
  if (connected && !wifiWasConnected) {
    onWifiConnected();
  } else if (!connected && wifiWasConnected) {
    wifiWasConnected = false;
    Serial.println("Wi-Fi lost.");
    if (!resultActive) showIdle();
  }

  if (!connected && millis() - lastWifiAttempt >= WIFI_RETRY_MS) {
    lastWifiAttempt = millis();
    Serial.println("Reconnecting Wi-Fi...");
    WiFi.reconnect();
  }
}

// ---------------------------------------------------------------------------
// Arduino entry points
// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  Serial.println("\nNEXORA RFID reader " FIRMWARE_VERSION " (" DEVICE_ID ")");

  // Calling noTone() before the first tone() logs "LEDC is not initialized" on core 2.x.
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  Wire.begin(OLED_SDA_PIN, OLED_SCL_PIN);
  // Adafruit's begin() succeeds even with no display attached, so probe the bus.
  Wire.beginTransmission(OLED_ADDRESS);
  bool oledAnswers = Wire.endTransmission() == 0;
  Serial.printf("OLED at 0x%02X on SDA %d / SCL %d: %s\n", OLED_ADDRESS, OLED_SDA_PIN, OLED_SCL_PIN,
                oledAnswers ? "found" : "NO ANSWER (check wiring and address)");
  if (!oledAnswers) {
    for (uint8_t address = 1; address < 127; address++) {
      Wire.beginTransmission(address);
      if (Wire.endTransmission() == 0) Serial.printf("  I2C device found at 0x%02X\n", address);
    }
  }
  oledReady = oledAnswers && display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDRESS);
  if (oledReady) {
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(2);
    display.setCursor(10, 22);
    display.print("NEXORA");
    display.display();
  } else {
    Serial.println("OLED not detected; continuing without a display.");
  }

  prefs.begin("nexora", false);
  bootId = prefs.getUInt("boot", 0) + 1;
  prefs.putUInt("boot", bootId);
  queueLoad();
  Serial.printf("Saved offline taps: %u\n", queueCount);

  SPI.begin(RFID_SCK_PIN, RFID_MISO_PIN, RFID_MOSI_PIN, RFID_SS_PIN);
  initReader();

  startupSound();

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  showBusy("Connecting WiFi...", WIFI_SSID);
  uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < WIFI_BOOT_WAIT_MS) {
    delay(250);
  }
  lastWifiAttempt = millis();

  if (WiFi.status() == WL_CONNECTED) {
    onWifiConnected();
    // Give NTP a moment so the first taps and the clock have the right time.
    for (int i = 0; i < 20 && !timeIsValid(); i++) delay(250);
  } else {
    Serial.println("Wi-Fi not available yet; taps will be saved and synced later.");
    errorSound();
  }

  if (!readerOk) errorSound();
  showIdle();
}

void loop() {
  maintainWifi();
  maintainReader();

  if (resultActive && (int32_t)(millis() - resultUntil) >= 0) showIdle();

  if (!resultActive && millis() - lastClockDraw >= 1000) {
    lastClockDraw = millis();
    showIdle();
  }

  if (readerOk) checkForCard();
  runBackgroundWork();
  delay(10);
}
