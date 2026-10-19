-- Давление (BME280) и ожидаемый интервал отправки устройства (для датчиков в deep sleep).
-- Колонки допускают NULL: у DHT-датчиков давления нет.

ALTER TABLE devices ADD COLUMN last_p REAL;
ALTER TABLE devices ADD COLUMN send_interval INTEGER;   -- секунды, сообщает прошивка
ALTER TABLE devices ADD COLUMN outdoor INTEGER NOT NULL DEFAULT 0;  -- 1 = датчик на улице (без советов по влажности)

ALTER TABLE readings_raw ADD COLUMN p REAL;             -- гПа

ALTER TABLE readings_hourly ADD COLUMN p_avg REAL;
ALTER TABLE readings_hourly ADD COLUMN p_min REAL;
ALTER TABLE readings_hourly ADD COLUMN p_max REAL;

ALTER TABLE readings_daily ADD COLUMN p_avg REAL;
ALTER TABLE readings_daily ADD COLUMN p_min REAL;
ALTER TABLE readings_daily ADD COLUMN p_max REAL;
