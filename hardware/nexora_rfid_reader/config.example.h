// NEXORA RFID reader configuration.
//
// 1. Copy this file to config.h in the same folder.
// 2. Fill in your Wi-Fi details and the device secret.
//
// config.h is git-ignored. Never commit it: the repository is public and the
// device secret lets anyone mark attendance.
#pragma once

// ---------------------------------------------------------------------------
// Wi-Fi (2.4 GHz only; the ESP32 cannot join 5 GHz networks)
// ---------------------------------------------------------------------------
#define WIFI_SSID      "AYSHU (kvfi)_EXT"
#define WIFI_PASSWORD  "0552015145"

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
// Must match the PULSE_RFID_DEVICE_SECRET edge-function secret in Supabase.
// Use at least 32 random characters, e.g. the output of: openssl rand -hex 24
#define DEVICE_SECRET  "PASTE_THE_DEVICE_SECRET_HERE"

// Short name for this reader, shown in the teacher portal. Use a-z, 0-9 and -.
#define DEVICE_ID      "main-gate"

#define ATTENDANCE_ENDPOINT \
  "https://iazlemocpuhzwtrkyfgw.supabase.co/functions/v1/pulse-rfid-attendance"

// POSIX time zone for the on-screen clock and offline timestamps (IST = UTC+5:30).
#define TIMEZONE "IST-5:30"

// ---------------------------------------------------------------------------
// Wiring (ESP32 DevKit V1). Change only if your wiring differs.
// ---------------------------------------------------------------------------
// RC522 RFID reader (SPI, 3.3 V only)
#define RFID_SS_PIN    5
#define RFID_RST_PIN   22
#define RFID_SCK_PIN   18
#define RFID_MISO_PIN  19
#define RFID_MOSI_PIN  23

// SSD1306 128x64 I2C OLED (optional; the reader works without it)
#define OLED_SDA_PIN   21
#define OLED_SCL_PIN   15
#define OLED_ADDRESS   0x3C

// Passive buzzer (optional)
#define BUZZER_PIN     4
