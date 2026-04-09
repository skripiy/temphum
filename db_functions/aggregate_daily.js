// Эта функция должна быть настроена в MongoDB Atlas App Services как Scheduled Trigger.
// Расписание запуска: ежедневно (например, в 00:30 каждый день).
//
// === ИНСТРУКЦИЯ ПО НАСТРОЙКЕ TTL ИНДЕКСА В ATLAS UI ===
// 1. Откройте ваш кластер в MongoDB Atlas -> Collections -> meteo_db -> weather_raw.
// 2. Перейдите во вкладку 'Indexes' и нажмите 'Create Index'.
// 3. TTL индекс работает с полями типа Date. Наш ESP32 отправляет сырые данные без Date, 
//    поэтому нам необходимо использовать время из _id (ObjectId содержит timestamp).
//    Чтобы настроить стандартный TTL, проще всего создать отдельное поле даты.
//    Лучший подход: создать Database Trigger On Insert на коллекцию weather_raw:
//      exports = function(changeEvent) {
//          const collection = context.services.get("mongodb-atlas").db("meteo_db").collection("weather_raw");
//          collection.updateOne({_id: changeEvent.documentKey._id}, {$set: {createdAt: new Date()}});
//      };
// 4. После создания такого триггера, в окне создания индекса выберите поле `createdAt: 1`. 
// 5. В настройках 'Options' включите 'Create TTL'.
// 6. Укажите 'Expire After Seconds' равным 604800 (что составляет 7 дней).
// 7. Нажмите 'Review & Create'. Индекс готов! Старые "сырые" данные будут удаляться автоматически.
// ======================================================

exports = async function() {
    // Инициализация подключения к базе данных
    const mongodb = context.services.get("mongodb-atlas");
    const weatherRaw = mongodb.db("meteo_db").collection("weather_raw");
    
    // Определяем период: вчерашний день от 00:00:00 до 23:59:59 (в UTC)
    const today = new Date();
    today.setUTCHours(0,0,0,0);
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    
    // Извлекаем время из _id каждого документа
    // MongoDB ObjectId содержит timestamp в первых 4 байтах.
    const startObjId = objectIdWithTimestamp(yesterday);
    const endObjId = objectIdWithTimestamp(today);

    console.log(`Запуск агрегации данных: за сутки начиная с ${yesterday.toISOString()}`);

    try {
        const pipeline = [
            // Шаг 1: Фильтруем данные за вчерашний день с использованием ObjectId диапазона
            {
                $match: {
                    _id: {
                        $gte: startObjId,
                        $lt: endObjId
                    }
                }
            },
            // Шаг 2: Группируем по дню и вычисляем метрики
            {
                $group: {
                    _id: yesterday.toISOString().split('T')[0], // Устанавливаем ID равным дате, например "2023-11-20"
                    avg_temp: { $avg: "$temperature" },
                    min_temp: { $min: "$temperature" },
                    max_temp: { $max: "$temperature" },
                    avg_humidity: { $avg: "$humidity" },
                    count: { $sum: 1 } // Сохраняем количество замеров за день для статистики
                }
            },
            // Шаг 3: Сохраняем агрегированные данные в коллекцию weather_archive
            {
                $merge: {
                    into: "weather_archive",
                    whenMatched: "replace", // обновляем, если документ с таким ID (датой) уже существует
                    whenNotMatched: "insert" // создаем новый, если не существует
                }
            }
        ];

        // Запуск агрегации
        const result = await weatherRaw.aggregate(pipeline).toArray();
        console.log("Агрегация успешно завершена. Обработано данных для даты:", yesterday.toISOString().split('T')[0]);
    } catch (err) {
        console.error("Ошибка при выполнении агрегации:", err);
    }
};

// Вспомогательная функция для генерации ObjectId на основе даты
function objectIdWithTimestamp(timestamp) {
    // Конвертация Date объекта в секунды (в шестнадцатеричной системе)
    const hexSeconds = Math.floor(timestamp.getTime() / 1000).toString(16);
    // Дополнение нулями для получения корректного 24-символьного ObjectId
    return new BSON.ObjectId(hexSeconds + "0000000000000000");
}
