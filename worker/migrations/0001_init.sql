-- Начальная схема. Применяется командой: npm run db:migrate (или db:migrate:local)
-- Все метки времени — Unix seconds (UTC).

CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,          -- короткий slug: "bathroom", "bedroom"
  name        TEXT NOT NULL,             -- подпись на дашборде: "Ванная"
  sort        INTEGER NOT NULL DEFAULT 0,-- порядок карточек и цвет линии на графике
  token_hash  TEXT NOT NULL UNIQUE,      -- sha256(hex) токена устройства; сам токен не хранится
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen   INTEGER,                   -- время последнего запроса от устройства
  last_ts     INTEGER,                   -- время самого свежего замера
  last_t      REAL,
  last_h      REAL,
  rssi        INTEGER,
  fw          TEXT
);

-- WITHOUT ROWID + составной PK: вставка строки = 1 запись в лимите D1,
-- а выборка по (device_id, ts) идёт по индексу и читает только нужные строки.
CREATE TABLE IF NOT EXISTS readings_raw (
  device_id TEXT    NOT NULL,
  ts        INTEGER NOT NULL,
  t         REAL    NOT NULL,
  h         REAL    NOT NULL,
  PRIMARY KEY (device_id, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS readings_hourly (
  device_id TEXT    NOT NULL,
  ts        INTEGER NOT NULL,            -- начало часа (UTC)
  n         INTEGER NOT NULL,
  t_avg REAL, t_min REAL, t_max REAL,
  h_avg REAL, h_min REAL, h_max REAL,
  PRIMARY KEY (device_id, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS readings_daily (
  device_id TEXT    NOT NULL,
  ts        INTEGER NOT NULL,            -- локальная полночь (см. TZ в wrangler.toml)
  n         INTEGER NOT NULL,
  t_avg REAL, t_min REAL, t_max REAL,
  h_avg REAL, h_min REAL, h_max REAL,
  PRIMARY KEY (device_id, ts)
) WITHOUT ROWID;
