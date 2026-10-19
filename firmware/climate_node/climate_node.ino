// ESP32 climate node: до 3 датчиков на плате (например, дом + улица) -> Cloudflare Worker.
// Каждый датчик — отдельное устройство на сервере со своим токеном и своим буфером.
//
// Два режима питания (POWER_MODE в config.h):
//   POWER_ALWAYS_ON  — плата от USB: замер раз в минуту, отправка пачкой раз в 5 минут.
//   POWER_DEEP_SLEEP — батарея: проснулся, замерил, уснул; Wi-Fi — только раз в N замеров.
// В обоих режимах без связи замеры копятся в кольцевом буфере и досылаются позже.
//
// Библиотеки (Arduino IDE → Library Manager):
//   DHT/AM2301: "DHT sensor library" (Adafruit) + "Adafruit Unified Sensor"
//   BME280:     "Adafruit BME280 Library"     + "Adafruit Unified Sensor"
// Плата: "ESP32 Dev Module" (пакет esp32 by Espressif).

// Значения для config.h (объявлены до него, чтобы config.h мог на них ссылаться).
#define SENSOR_DHT11   1
#define SENSOR_DHT22   2
#define SENSOR_AM2301  3
#define SENSOR_BME280  4
#define POWER_ALWAYS_ON  1
#define POWER_DEEP_SLEEP 2

#include "config.h"

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <time.h>
#include <esp_sleep.h>

// ---------- разбор config.h ----------
#ifndef SENSOR_COUNT
  #define SENSOR_COUNT 1
#endif
#if SENSOR_COUNT < 1 || SENSOR_COUNT > 3
  #error "SENSOR_COUNT: от 1 до 3"
#endif
#ifndef SENSOR_POWER_PIN
  #define SENSOR_POWER_PIN -1
#endif
#ifndef SEND_EVERY_N_READS
  #define SEND_EVERY_N_READS 6
#endif
#ifndef SENSOR_1_PIN
  #define SENSOR_1_PIN -1
#endif
#ifndef SENSOR_2_PIN
  #define SENSOR_2_PIN -1
#endif
#ifndef SENSOR_3_PIN
  #define SENSOR_3_PIN -1
#endif
#ifndef SENSOR_2_MODEL
  #define SENSOR_2_MODEL 0
#endif
#ifndef SENSOR_3_MODEL
  #define SENSOR_3_MODEL 0
#endif
#ifndef SENSOR_2_TOKEN
  #define SENSOR_2_TOKEN ""
#endif
#ifndef SENSOR_3_TOKEN
  #define SENSOR_3_TOKEN ""
#endif
#ifndef SENSOR_1_TEMP_OFFSET
  #define SENSOR_1_TEMP_OFFSET 0.0f
#endif
#ifndef SENSOR_1_HUM_OFFSET
  #define SENSOR_1_HUM_OFFSET 0.0f
#endif
#ifndef SENSOR_2_TEMP_OFFSET
  #define SENSOR_2_TEMP_OFFSET 0.0f
#endif
#ifndef SENSOR_2_HUM_OFFSET
  #define SENSOR_2_HUM_OFFSET 0.0f
#endif
#ifndef SENSOR_3_TEMP_OFFSET
  #define SENSOR_3_TEMP_OFFSET 0.0f
#endif
#ifndef SENSOR_3_HUM_OFFSET
  #define SENSOR_3_HUM_OFFSET 0.0f
#endif

#define IS_DHT(m) ((m) == SENSOR_DHT11 || (m) == SENSOR_DHT22 || (m) == SENSOR_AM2301)
#define USES_BME (SENSOR_1_MODEL == SENSOR_BME280 || (SENSOR_COUNT > 1 && SENSOR_2_MODEL == SENSOR_BME280) || \
                  (SENSOR_COUNT > 2 && SENSOR_3_MODEL == SENSOR_BME280))
#define USES_DHT (IS_DHT(SENSOR_1_MODEL) || (SENSOR_COUNT > 1 && IS_DHT(SENSOR_2_MODEL)) || \
                  (SENSOR_COUNT > 2 && IS_DHT(SENSOR_3_MODEL)))

// Библиотеки подключаются только для используемых моделей — лишние ставить не нужно.
#if USES_BME
  #include <Wire.h>
  #include <Adafruit_BME280.h>
#endif
#if USES_DHT
  #include <DHT.h>
#endif

#define FW_VERSION "1.2.0"
#define MAX_PER_REQUEST 100            // замеров в одном POST (сервер принимает до 500)
#define TIME_VALID      1700000000UL   // время считается синхронизированным после NTP
#define WIFI_TIMEOUT_MS 12000UL
#define NTP_RESYNC_S    (24UL * 3600)  // в deep sleep часы RTC плывут — раз в сутки сверяем по NTP

struct Reading {
  uint32_t ts;
  int16_t  t10;   // температура × 10
  uint16_t h10;   // влажность × 10
  uint16_t p10;   // давление, гПа × 10; 0 = нет данных
};

// В deep sleep обычная RAM стирается, поэтому буферы и служебные данные живут в RTC-памяти (8 КБ).
#if POWER_MODE == POWER_DEEP_SLEEP
  #define RING_LIMIT (SENSOR_COUNT == 1 ? 256 : SENSOR_COUNT == 2 ? 160 : 100)
  #define RING_SIZE (BUFFER_SIZE < RING_LIMIT ? BUFFER_SIZE : RING_LIMIT)
  #define KEEP RTC_DATA_ATTR
#else
  #define RING_SIZE BUFFER_SIZE
  #define KEEP
#endif

static KEEP Reading ring[SENSOR_COUNT][RING_SIZE];
#if POWER_MODE == POWER_DEEP_SLEEP
static_assert(sizeof(ring) <= 6144, "буферы не помещаются в RTC-память: уменьшите BUFFER_SIZE");
#endif
static KEEP uint16_t ringHead[SENSOR_COUNT], ringCount[SENSOR_COUNT];
static KEEP uint32_t lastNtpSync = 0;
static KEEP uint16_t readsSinceSend = 0;
// Кэш канала и BSSID точки доступа: переподключение за ~1 с вместо 3–5 с полного сканирования.
static KEEP uint8_t  wifiBssid[6];
static KEEP int32_t  wifiChannel = 0;

struct SensorSlot {
  int model;
  int pin;
  const char *token;
  float tempOffset, humOffset;
  bool ok;
#if USES_DHT
  DHT *dht;
#endif
};

static SensorSlot sensors[SENSOR_COUNT] = {
  { SENSOR_1_MODEL, SENSOR_1_PIN, SENSOR_1_TOKEN, SENSOR_1_TEMP_OFFSET, SENSOR_1_HUM_OFFSET, false },
#if SENSOR_COUNT > 1
  { SENSOR_2_MODEL, SENSOR_2_PIN, SENSOR_2_TOKEN, SENSOR_2_TEMP_OFFSET, SENSOR_2_HUM_OFFSET, false },
#endif
#if SENSOR_COUNT > 2
  { SENSOR_3_MODEL, SENSOR_3_PIN, SENSOR_3_TOKEN, SENSOR_3_TEMP_OFFSET, SENSOR_3_HUM_OFFSET, false },
#endif
};

#if USES_BME
static Adafruit_BME280 bme;
#endif

// ---------- буфер ----------
static void ringPush(int s, const Reading &r) {
  ring[s][(ringHead[s] + ringCount[s]) % RING_SIZE] = r;
  if (ringCount[s] < RING_SIZE) ringCount[s]++;
  else ringHead[s] = (ringHead[s] + 1) % RING_SIZE;  // переполнение: теряем самый старый
}

static const Reading &ringAt(int s, size_t i) { return ring[s][(ringHead[s] + i) % RING_SIZE]; }

static void ringDrop(int s, size_t n) {
  if (n > ringCount[s]) n = ringCount[s];
  ringHead[s] = (ringHead[s] + n) % RING_SIZE;
  ringCount[s] -= n;
}

static size_t totalBuffered() {
  size_t n = 0;
  for (int s = 0; s < SENSOR_COUNT; s++) n += ringCount[s];
  return n;
}

// ---------- датчики ----------
static void sensorsBegin() {
  bool anyDht = false;
  if (SENSOR_POWER_PIN >= 0) {
    pinMode(SENSOR_POWER_PIN, OUTPUT);
    digitalWrite(SENSOR_POWER_PIN, HIGH);
    delay(10);
  }
  for (int s = 0; s < SENSOR_COUNT; s++) {
    SensorSlot &x = sensors[s];
#if USES_BME
    if (x.model == SENSOR_BME280) {
      x.ok = bme.begin(0x76) || bme.begin(0x77);
      if (x.ok) {
        // Forced mode: датчик меряет только по запросу и не греет сам себя между замерами.
        bme.setSampling(Adafruit_BME280::MODE_FORCED,
                        Adafruit_BME280::SAMPLING_X1, Adafruit_BME280::SAMPLING_X1, Adafruit_BME280::SAMPLING_X1,
                        Adafruit_BME280::FILTER_OFF);
      } else {
        Serial.printf("[sensor %d] BME280 не найден на 0x76/0x77 — проверьте SDA/SCL (и что это BME280, а не BMP280)\n", s + 1);
      }
      continue;
    }
#endif
#if USES_DHT
    if (IS_DHT(x.model)) {
      uint8_t type = x.model == SENSOR_DHT11 ? DHT11 : x.model == SENSOR_DHT22 ? DHT22 : DHT21;
      x.dht = new DHT(x.pin, type);
      x.dht->begin();
      x.ok = true;
      anyDht = true;
    }
#endif
  }
  // DHT после подачи питания готов примерно через 1–2 с
  if (anyDht && SENSOR_POWER_PIN >= 0) delay(2000);
}

static void sensorsPowerOff() {
  if (SENSOR_POWER_PIN >= 0) digitalWrite(SENSOR_POWER_PIN, LOW);
}

static bool readSensor(int s, Reading &out) {
  SensorSlot &x = sensors[s];
  if (!x.ok) return false;
  for (int attempt = 0; attempt < 3; attempt++) {
    float t = NAN, h = NAN, p = NAN;
#if USES_BME
    if (x.model == SENSOR_BME280) {
      if (!bme.takeForcedMeasurement()) { delay(50); continue; }
      t = bme.readTemperature();
      h = bme.readHumidity();
      p = bme.readPressure() / 100.0f;  // Па -> гПа
    }
#endif
#if USES_DHT
    if (x.dht) {
      h = x.dht->readHumidity();
      t = x.dht->readTemperature();
    }
#endif
    if (!isnan(h) && !isnan(t)) {
      t += x.tempOffset;
      h = constrain(h + x.humOffset, 0.0f, 100.0f);
      out.ts = (uint32_t)time(nullptr);
      out.t10 = (int16_t)lroundf(t * 10);
      out.h10 = (uint16_t)lroundf(h * 10);
      out.p10 = (!isnan(p) && p > 300 && p < 1100) ? (uint16_t)lroundf(p * 10) : 0;
      return true;
    }
    delay(2200);  // DHT нельзя опрашивать чаще раза в 2 с
  }
  return false;
}

static void readAll() {
  for (int s = 0; s < SENSOR_COUNT; s++) {
    Reading r;
    if (readSensor(s, r)) {
      ringPush(s, r);
      Serial.printf("[sensor %d] %.1f C, %.1f %%", s + 1, r.t10 / 10.0, r.h10 / 10.0);
      if (r.p10) Serial.printf(", %.1f hPa", r.p10 / 10.0);
      Serial.printf("  (buffered %u)\n", (unsigned)ringCount[s]);
    } else {
      Serial.printf("[sensor %d] read failed — проверьте провода (для DHT — подтяжку DATA к VCC)\n", s + 1);
    }
  }
}

// ---------- Wi-Fi и время ----------
static bool timeSynced() { return time(nullptr) > (time_t)TIME_VALID; }

// Блокирующее подключение (для deep sleep). Сначала пробует кэш канала/BSSID.
static bool connectWifi(uint32_t timeoutMs) {
  WiFi.mode(WIFI_STA);
  bool cached = wifiChannel > 0;
  if (cached) WiFi.begin(WIFI_SSID, WIFI_PASS, wifiChannel, wifiBssid, true);
  else WiFi.begin(WIFI_SSID, WIFI_PASS);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) {
    // Кэш устарел (роутер сменил канал) — через 4 с переходим на обычное подключение.
    if (cached && millis() - start > 4000) {
      cached = false;
      wifiChannel = 0;
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASS);
    }
    delay(50);
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[wifi] не удалось подключиться");
    wifiChannel = 0;
    return false;
  }
  wifiChannel = WiFi.channel();
  memcpy(wifiBssid, WiFi.BSSID(), 6);
  Serial.printf("[wifi] connected in %lu ms, RSSI %d\n", millis() - start, (int)WiFi.RSSI());
  return true;
}

static bool syncTime(uint32_t timeoutMs) {
  configTime(0, 0, "pool.ntp.org", "time.google.com", "time.cloudflare.com");  // UTC
  unsigned long start = millis();
  while (!timeSynced() && millis() - start < timeoutMs) delay(100);
  if (timeSynced()) lastNtpSync = (uint32_t)time(nullptr);
  return timeSynced();
}

// ---------- отправка ----------
static uint32_t sendIntervalS() {
#if POWER_MODE == POWER_DEEP_SLEEP
  return (uint32_t)READ_INTERVAL_S * SEND_EVERY_N_READS;
#else
  return SEND_INTERVAL_S;
#endif
}

static bool sendBatch(int s) {
  size_t n = ringCount[s] < MAX_PER_REQUEST ? ringCount[s] : MAX_PER_REQUEST;
  String body;
  body.reserve(96 + n * 52);
  body += "{\"fw\":\"" FW_VERSION "\",\"rssi\":";
  body += String((int)WiFi.RSSI());  // int8_t без приведения добавился бы как символ
  body += ",\"send_interval\":";
  body += String((unsigned long)sendIntervalS());
  body += ",\"readings\":[";
  char item[80];
  for (size_t i = 0; i < n; i++) {
    const Reading &r = ringAt(s, i);
    int len = snprintf(item, sizeof(item), "%s{\"ts\":%lu,\"t\":%.1f,\"h\":%.1f",
                       i ? "," : "", (unsigned long)r.ts, r.t10 / 10.0, r.h10 / 10.0);
    if (r.p10) snprintf(item + len, sizeof(item) - len, ",\"p\":%.1f}", r.p10 / 10.0);
    else snprintf(item + len, sizeof(item) - len, "}");
    body += item;
  }
  body += "]}";

  WiFiClientSecure client;
#ifdef ROOT_CA
  client.setCACert(ROOT_CA);
#else
  client.setInsecure();
#endif
  HTTPClient http;
  http.setTimeout(15000);
  if (!http.begin(client, API_URL)) {
    Serial.println("[http] begin failed");
    return false;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + sensors[s].token);
  int code = http.POST(body);
  String resp = http.getString();
  http.end();

  if (code == 200) {
    ringDrop(s, n);
    Serial.printf("[http %d] sent %u, buffered %u: %s\n", s + 1, (unsigned)n, (unsigned)ringCount[s], resp.c_str());
    return true;
  }
  Serial.printf("[http %d] error %d: %s\n", s + 1, code, resp.c_str());
  if (code == 400 || code == 413) ringDrop(s, n);  // битая пачка — не застревать на ней навсегда
  return false;
}

static void sendAll() {
  // Досылаем всё накопленное, но не больше 20 запросов на датчик за раз, чтобы не блокировать замеры.
  for (int s = 0; s < SENSOR_COUNT; s++) {
    for (int i = 0; i < 20 && ringCount[s] > 0 && WiFi.status() == WL_CONNECTED; i++) {
      if (!sendBatch(s)) break;
    }
  }
}

#if POWER_MODE == POWER_DEEP_SLEEP
// ======================= батарейный режим =======================
// Весь цикл — в setup(): проснулся, замерил, (иногда) отправил, уснул. loop() не выполняется.

static void goToSleep(unsigned long startedMs) {
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  sensorsPowerOff();
  // Вычитаем время бодрствования, чтобы интервал между замерами оставался ровным.
  uint64_t awakeUs = (uint64_t)(millis() - startedMs) * 1000ULL;
  uint64_t periodUs = (uint64_t)READ_INTERVAL_S * 1000000ULL;
  uint64_t sleepUs = periodUs > awakeUs + 1000000ULL ? periodUs - awakeUs : 1000000ULL;
  Serial.printf("[sleep] %llu s\n", sleepUs / 1000000ULL);
  Serial.flush();
  esp_sleep_enable_timer_wakeup(sleepUs);
  esp_deep_sleep_start();
}

void setup() {
  unsigned long started = millis();
  Serial.begin(115200);
  bool coldBoot = esp_sleep_get_wakeup_cause() != ESP_SLEEP_WAKEUP_TIMER;
  if (coldBoot) {
    delay(200);
    Serial.printf("\nclimate_node %s (deep sleep, every %d s, %d sensor(s))\n", FW_VERSION, READ_INTERVAL_S, SENSOR_COUNT);
  }
  sensorsBegin();

  // Часы RTC идут и во сне, но без NTP (первый старт) замер не к чему привязать.
  bool needTime = !timeSynced() || (uint32_t)time(nullptr) - lastNtpSync > NTP_RESYNC_S;
  if (timeSynced()) readAll();
  readsSinceSend++;

  bool bufferFull = false;
  for (int s = 0; s < SENSOR_COUNT; s++) bufferFull |= ringCount[s] >= RING_SIZE - 2;
  bool due = coldBoot || readsSinceSend >= SEND_EVERY_N_READS || bufferFull;
  if ((due || needTime) && connectWifi(WIFI_TIMEOUT_MS)) {
    if (needTime) {
      bool had = timeSynced();
      if (syncTime(5000) && !had) readAll();  // первый старт: замер, пропущенный без времени
    }
    if (due || totalBuffered() > 0) {
      sendAll();
      readsSinceSend = 0;
    }
  }
  goToSleep(started);
}

void loop() {}

#else
// ======================= режим от USB =======================

static unsigned long lastRead = 0, lastSend = 0, lastWifiTry = 0;
static bool firstRead = true;

static void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (lastWifiTry != 0 && millis() - lastWifiTry < 30000UL) return;
  lastWifiTry = millis();
  Serial.println("[wifi] connecting...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\nclimate_node %s (always on, %d sensor(s))\n", FW_VERSION, SENSOR_COUNT);
  sensorsBegin();
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  ensureWifi();
  configTime(0, 0, "pool.ntp.org", "time.google.com", "time.cloudflare.com");  // UTC
}

void loop() {
  ensureWifi();
  unsigned long now = millis();

  if (firstRead || now - lastRead >= READ_INTERVAL_S * 1000UL) {
    if (!timeSynced()) {
      // Без точного времени замер бесполезен — ждём NTP (нужен Wi-Fi при первом старте).
      if (now - lastRead >= 5000) { Serial.println("[time] waiting for NTP..."); lastRead = now - READ_INTERVAL_S * 1000UL + 5000; }
    } else {
      lastRead = now;
      firstRead = false;
      readAll();
      // Первая отправка — сразу после первого замера, чтобы видеть, что всё работает.
      if (lastSend == 0) lastSend = now - SEND_INTERVAL_S * 1000UL;
    }
  }

  if (totalBuffered() > 0 && now - lastSend >= SEND_INTERVAL_S * 1000UL && WiFi.status() == WL_CONNECTED) {
    lastSend = now;
    sendAll();
  }

  delay(100);
}
#endif
