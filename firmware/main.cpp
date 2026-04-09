#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <DHT.h>
#include "secrets.h"

// Пин, к которому подключен DHT22 (измените по необходимости)
#define DHTPIN 4
#define DHTTYPE DHT22

DHT dht(DHTPIN, DHTTYPE);

// Время глубокого сна (Deep Sleep) в микросекундах (15 минут = 15 * 60 * 1000000)
#define TIME_TO_SLEEP 15 * 60 * 1000000ULL

// Функция для перехода в спящий режим
void goToSleep() {
    Serial.println("Переход в глубокий сон на 15 минут...");
    esp_sleep_enable_timer_wakeup(TIME_TO_SLEEP);
    esp_deep_sleep_start();
}

void setup() {
    Serial.begin(115200);
    delay(1000);
    
    Serial.println("Пробуждение. Инициализация сенсора DHT22...");
    dht.begin();
    
    // Подключение к Wi-Fi
    Serial.print("Подключение к Wi-Fi: ");
    Serial.println(WIFI_SSID);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    
    // Ждем подключения максимум 10 секунд
    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 20) {
        delay(500);
        Serial.print(".");
        attempts++;
    }
    Serial.println();
    
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("Ошибка: Не удалось подключиться к Wi-Fi. Уходим в сон.");
        goToSleep();
    }
    
    Serial.println("Wi-Fi подключен. Чтение данных с сенсора...");
    
    // Чтение температуры и влажности
    float humidity = dht.readHumidity();
    float temperature = dht.readTemperature(); // В градусах Цельсия
    
    // Проверка на ошибки при чтении
    if (isnan(humidity) || isnan(temperature)) {
        Serial.println("Ошибка: Не удалось прочитать данные с сенсора. Уходим в сон.");
        goToSleep();
    }
    
    Serial.print("Температура: ");
    Serial.print(temperature);
    Serial.print(" °C. Влажность: ");
    Serial.print(humidity);
    Serial.println(" %");
    
    // Формируем JSON payload для MongoDB Atlas Data API
    // Мы не отправляем timestamp с ESP32, так как он автоматически будет 
    // доступен в поле _id документа в базе данных
    String payload = "{\"dataSource\":\"" + String(MONGO_DATASOURCE) + "\"," +
                     "\"database\":\"" + String(MONGO_DB_NAME) + "\"," +
                     "\"collection\":\"" + String(MONGO_COLLECTION_RAW) + "\"," +
                     "\"document\":{" +
                     "\"temperature\":" + String(temperature) + "," +
                     "\"humidity\":" + String(humidity) +
                     "}}";
    
    Serial.println("Отправка HTTP POST запроса...");
    
    HTTPClient http;
    http.begin(MONGO_ENDPOINT);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Access-Control-Request-Headers", "*");
    http.addHeader("api-key", MONGO_API_KEY);
    
    int httpResponseCode = http.POST(payload);
    
    if (httpResponseCode > 0) {
        Serial.print("HTTP код ответа: ");
        Serial.println(httpResponseCode);
        String response = http.getString();
        Serial.println("Ответ сервера: " + response);
    } else {
        Serial.print("Ошибка HTTP запроса: ");
        Serial.println(http.errorToString(httpResponseCode));
        // При ошибке HTTP просто уходим в сон, повторим попытку при следующем просыпании
    }
    
    http.end();
    
    // После успешной (или неуспешной) отправки уходим в глубокий сон
    goToSleep();
}

void loop() {
    // В режиме Deep Sleep микроконтроллер перезагружается после просыпания, 
    // поэтому код в loop() не выполняется.
}
