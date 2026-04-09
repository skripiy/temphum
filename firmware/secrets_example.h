// Переименуйте этот файл в secrets.h перед компиляцией
#ifndef SECRETS_H
#define SECRETS_H

// Настройки Wi-Fi
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

// Настройки MongoDB Atlas Data API
// URL вашего Data API Endpoint. Обычно выглядит как: https://data.mongodb-api.com/app/<App-ID>/endpoint/data/v1/action/insertOne
const char* MONGO_ENDPOINT = "YOUR_MONGO_DATA_API_ENDPOINT";

// API Ключ для аутентификации запросов к Data API
const char* MONGO_API_KEY = "YOUR_MONGO_API_KEY";

// Названия базы данных и коллекции
const char* MONGO_DB_NAME = "meteo_db";
const char* MONGO_COLLECTION_RAW = "weather_raw";
const char* MONGO_DATASOURCE = "Cluster0"; // Имя вашего кластера (datasource)

#endif
