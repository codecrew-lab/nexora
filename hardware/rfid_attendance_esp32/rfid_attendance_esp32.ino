#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <MFRC522.h>

// ESP32 DevKit V1 + RC522 wiring
#define RFID_SS_PIN   5
#define RFID_RST_PIN  22
#define RFID_SCK_PIN  18
#define RFID_MISO_PIN 19
#define RFID_MOSI_PIN 23

const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* RFID_ENDPOINT = "https://iazlemocpuhzwtrkyfgw.supabase.co/functions/v1/pulse-rfid-attendance";

// Store the device secret here only for this supervised prototype.
// Never commit a real secret to GitHub or share it in chat.
const char* DEVICE_SECRET = "PASTE_DEVICE_SECRET_LOCALLY";

// Add the current trusted root CA certificate for Supabase's TLS certificate.
// Do not replace TLS verification with setInsecure().
static const char* SUPABASE_ROOT_CA = R"EOF(
-----BEGIN CERTIFICATE-----
PASTE_CURRENT_TRUSTED_ROOT_CA_HERE
-----END CERTIFICATE-----
)EOF";

MFRC522 reader(RFID_SS_PIN, RFID_RST_PIN);
WiFiClientSecure secureClient;

String readCardUid() {
  String uid;
  for (byte i = 0; i < reader.uid.size; i++) {
    if (reader.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(reader.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();
  return uid;
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWi-Fi connected.");
}

void sendAttendance(const String& uid) {
  if (WiFi.status() != WL_CONNECTED) connectWiFi();

  HTTPClient http;
  secureClient.setCACert(SUPABASE_ROOT_CA);
  if (!http.begin(secureClient, RFID_ENDPOINT)) {
    Serial.println("Could not start secure HTTPS connection.");
    return;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-pulse-device-secret", DEVICE_SECRET);
  const String payload = String("{\"card_uid\":\"") + uid + "\"}";
  const int code = http.POST(payload);
  const String response = code > 0 ? http.getString() : "";
  Serial.printf("HTTP status: %d\n", code);
  Serial.println(response);
  http.end();
}

void setup() {
  Serial.begin(115200);
  SPI.begin(RFID_SCK_PIN, RFID_MISO_PIN, RFID_MOSI_PIN, RFID_SS_PIN);
  reader.PCD_Init();
  connectWiFi();
  Serial.println("PULSE RFID reader ready. Tap a card.");
}

void loop() {
  if (!reader.PICC_IsNewCardPresent() || !reader.PICC_ReadCardSerial()) {
    delay(50);
    return;
  }

  const String uid = readCardUid();
  Serial.print("Card UID: ");
  Serial.println(uid);
  sendAttendance(uid);

  reader.PICC_HaltA();
  reader.PCD_StopCrypto1();
  delay(1500); // Reduce repeated reads while the same card remains on the reader.
}
