// Скопируйте этот файл в config.h и заполните. config.h не коммитьте — в нём пароль Wi-Fi и токены.
#pragma once

#define WIFI_SSID      "your-wifi"        // только 2,4 ГГц
#define WIFI_PASS      "your-password"

// URL вашего Worker + /api/ingest
#define API_URL        "https://climate-monitor.temphum.workers.dev/api/ingest"

// ---------- датчики (до 3 на одной плате) ----------
// Каждый датчик — отдельное «устройство» на дашборде со своим токеном:
//   node scripts/add-device.mjs home    "Дом"   1
//   node scripts/add-device.mjs outside "Улица" 2
//
// Модели: SENSOR_AM2301 (= DHT21), SENSOR_DHT22, SENSOR_DHT11 — провод DATA на свой GPIO;
//         SENSOR_BME280 — I2C (SDA = GPIO 21, SCL = GPIO 22), плюс давление; PIN для него не используется.
//         BME280 на плате может быть только один.
#define SENSOR_COUNT   2                  // 1, если подключён только один датчик

#define SENSOR_1_MODEL SENSOR_AM2301      // в доме
#define SENSOR_1_PIN   5
#define SENSOR_1_TOKEN "token-from-add-device-home"

#define SENSOR_2_MODEL SENSOR_AM2301      // на улице
#define SENSOR_2_PIN   4
#define SENSOR_2_TOKEN "token-from-add-device-outside"

// #define SENSOR_3_MODEL SENSOR_BME280
// #define SENSOR_3_PIN   -1
// #define SENSOR_3_TOKEN "..."

// GPIO, от которого питаются датчики (выключаются во сне); -1 = питание от 3V3
#define SENSOR_POWER_PIN  -1

// ---------- питание ----------
// POWER_ALWAYS_ON  — плата от USB: замер раз в READ_INTERVAL_S, отправка пачкой раз в SEND_INTERVAL_S.
// POWER_DEEP_SLEEP — батарея: просыпается раз в READ_INTERVAL_S, мерит и снова спит;
//                    Wi-Fi включается только раз в SEND_EVERY_N_READS замеров.
#define POWER_MODE     POWER_ALWAYS_ON

#define READ_INTERVAL_S  60               // в deep sleep разумно 300–900
#define SEND_INTERVAL_S  300              // только для POWER_ALWAYS_ON
#define SEND_EVERY_N_READS 6              // только для POWER_DEEP_SLEEP: 6 × 300 с = отправка раз в 30 мин
#define BUFFER_SIZE      1440             // замеров на датчик без связи (в deep sleep — не больше 160, RTC-память 8 КБ)

// Калибровка, если датчик систематически врёт относительно эталона (по номеру датчика)
#define SENSOR_1_TEMP_OFFSET 0.0f
#define SENSOR_1_HUM_OFFSET  0.0f
#define SENSOR_2_TEMP_OFFSET 0.0f
#define SENSOR_2_HUM_OFFSET  0.0f

// Необязательно: корневой сертификат для проверки TLS. Без него соединение шифруется,
// но подлинность сервера не проверяется (см. README, раздел «Безопасность»).
// #define ROOT_CA "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n"
