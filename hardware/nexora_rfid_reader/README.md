# NEXORA RFID reader (ESP32 + RC522)

The reader sits at the classroom door. A student taps their card, the reader
sends the card UID to Supabase, and the student is marked **Present** for today.
The OLED shows the student's name and the buzzer confirms the result.

```
 card ──► RC522 ──SPI──► ESP32 ──HTTPS──► pulse-rfid-attendance ──► record_rfid_scan()
                           │                (edge function)            (Postgres)
                     OLED + buzzer                                         │
                                                         attendance_records, rfid_scan_events
```

## Parts

| Part | Notes |
| --- | --- |
| ESP32 DevKit V1 (ESP32-WROOM-32) | Any 4 MB ESP32 board works |
| RC522 13.56 MHz reader | **3.3 V only.** 5 V damages it |
| SSD1306 128×64 I2C OLED | Optional |
| Passive buzzer | Optional |
| MIFARE Classic / NTAG cards or fobs | One per student |

## Wiring

| RC522 | ESP32 |   | OLED | ESP32 |   | Buzzer | ESP32 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SDA (SS) | GPIO 5 | | SDA | GPIO 21 | | + | GPIO 25 |
| SCK | GPIO 18 | | SCL | GPIO 15 | | − | GND |
| MOSI | GPIO 23 | | VCC | 3.3 V | | | |
| MISO | GPIO 19 | | GND | GND | | | |
| RST | GPIO 22 | | | | | | |
| 3.3V | 3.3 V | | | | | | |
| GND | GND | | | | | | |

Pins can be changed in `config.h`.

## Install

1. **Arduino IDE** → Boards Manager → install **esp32 by Espressif Systems**.
   Version **2.0.17** works with no changes. On 3.x, see *Troubleshooting* below.
2. Library Manager → install:
   - `MFRC522` by GithubCommunity (1.4.11)
   - `Adafruit SSD1306` and `Adafruit GFX Library`
   - `ArduinoJson` by Benoit Blanchon (**7.x**)
3. Copy `config.example.h` to `config.h` and fill in:
   - `WIFI_SSID` / `WIFI_PASSWORD` (2.4 GHz network)
   - `DEVICE_SECRET`: the same value as the `PULSE_RFID_DEVICE_SECRET`
     edge-function secret in Supabase
   - `DEVICE_ID`: a short name such as `main-gate` or `class-8a`
4. Open `nexora_rfid_reader.ino`, select **ESP32 Dev Module**, and upload.
5. Open the Serial Monitor at **115200** baud to see what the reader is doing.

`config.h` is git-ignored. Never commit it: the repository is public and the
device secret lets anyone mark attendance.

## What the reader shows

| Screen | Sound | Meaning |
| --- | --- | --- |
| `PRESENT MARKED` + name | two rising beeps | Marked present |
| `PRESENT - LATE` + name | high then low beep | Marked present, after the late cut-off |
| `ALREADY MARKED` + name | one long beep | Already recorded today (shows the status if a teacher set Absent/Leave) |
| `UNKNOWN CARD` + UID | three low beeps | Card is not registered. A teacher can assign it in the portal |
| `SAVED OFFLINE` | two short beeps | No connection. The tap is stored and synced automatically |
| `DEVICE REJECTED` | falling tones | `DEVICE_SECRET` doesn't match the Supabase secret |
| `RFID READER ERROR` | falling tones at boot | The ESP32 can't talk to the RC522. Check the wiring |

`Q5` in the top bar means 5 taps are waiting to sync.

## Registering cards

1. Tap the new card on the reader. It shows **UNKNOWN CARD** and the UID.
2. In the **Teacher Portal → RFID Attendance**, the card appears under
   *Unknown cards*. Pick the student and press **Assign**.
3. Tap again. The reader now shows the student's name.

Lost card: press **Deactivate** next to it in the portal, then assign the new card.

## How it behaves

- **Attendance date** is decided by the server in IST (`Asia/Kolkata`).
- **First tap of the day** creates Present. Later taps never overwrite Present,
  Absent or Leave, including a teacher's manual change.
- **Late** taps are those after the cut-off set in the teacher portal (default 09:30).
- **Same card twice** within 5 seconds is ignored.
- **Offline queue**: up to 150 taps are stored in flash with their tap time and
  survive a power cut. They're sent after 8 seconds with no taps, so syncing
  never slows down a queue of students. Taps older than 7 days are discarded by
  the server.
- **Heartbeat** every 5 minutes, so the teacher portal can show whether the reader
  is online, its Wi-Fi signal and its queue size.
- **RC522 watchdog**: the reader is re-initialised if it stops responding.
- **TLS** is verified against the Google Trust Services and Let's Encrypt roots in
  `certificates.h` (valid until 2035–2036).

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `config.h is missing` | Copy `config.example.h` to `config.h` |
| `DEVICE_SECRET ... at least 32 characters` | Use a longer secret, e.g. `openssl rand -hex 24`, in both `config.h` and Supabase |
| `MFRC522Extended.cpp: ordered comparison of pointer with integer zero` | ESP32 core 3.x uses a stricter compiler. Use core 2.0.17, or edit lines 824 and 847 of `MFRC522Extended.cpp` from `backLen > 0` to `*backLen > 0` |
| Stuck on `Connecting WiFi...` | ESP32 only supports 2.4 GHz. Check the SSID and password |
| Every tap shows `SAVED OFFLINE` while Wi-Fi works | Check the Serial Monitor. A TLS error usually means the clock hasn't synced (NTP blocked) or the certificate changed |
| `SERVER ERROR HTTP 503` | The edge function is missing a secret, or the database migration hasn't been run |
| Reads stop after a while | Usually power. Give the RC522 a clean 3.3 V supply and keep its wires short |

## Security notes

RFID UIDs can be copied, and the device secret can be extracted from a reader
someone takes away. Treat a tap as a convenience, not proof of identity: keep the
reader where a teacher can see it, and use the portal to correct records. If a
reader is lost, change `PULSE_RFID_DEVICE_SECRET` in Supabase and re-flash the
other readers.
