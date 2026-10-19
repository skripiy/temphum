// Climate monitor: приём замеров от ESP32, агрегация по cron, API для дашборда.
// Статика дашборда (public/) отдаётся Cloudflare напрямую, сюда попадают только /api/*.

const HOUR = 3600;
const DAY = 86400;

// Диапазоны дашборда -> таблица и шаг сетки на графике.
const RANGES = {
  '24h': { span: DAY, table: 'readings_raw', step: 300 },
  '7d': { span: 7 * DAY, table: 'readings_hourly', step: HOUR },
  '30d': { span: 30 * DAY, table: 'readings_hourly', step: HOUR },
  '1y': { span: 365 * DAY, table: 'readings_daily', step: DAY },
};

const MAX_BATCH = 500;   // замеров в одном POST
const SQL_CHUNK = 20;    // строк в одном INSERT (5 параметров на строку, лимит D1 — 100 на запрос)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/ingest' && request.method === 'POST') return await ingest(request, env);
      if (url.pathname === '/api/devices' && request.method === 'GET') return await withReadAuth(request, env, () => devices(env));
      if (url.pathname === '/api/series' && request.method === 'GET') return await withReadAuth(request, env, () => series(url, env));
      return json({ error: 'not found' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: 'internal error' }, 500);
    }
  },

  async scheduled(event, env) {
    const now = nowSec();
    if (event.cron === env.DAILY_CRON) {
      await rollupHourly(env, now - 3 * DAY);
      await rollupDaily(env, now);
      await cleanup(env, now);
    } else {
      // Пересчитываем последние 3 часа: туда попадают и поздние пачки из буфера ESP32.
      await rollupHourly(env, now - 3 * HOUR);
    }
  },
};

// ---------- ingest ----------

async function ingest(request, env) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return json({ error: 'unauthorized' }, 401);

  const device = await env.DB.prepare('SELECT id FROM devices WHERE token_hash = ?')
    .bind(await sha256hex(token)).first();
  if (!device) return json({ error: 'unauthorized' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const input = Array.isArray(body?.readings) ? body.readings : [];
  if (input.length > MAX_BATCH) return json({ error: `too many readings (max ${MAX_BATCH})` }, 413);

  const now = nowSec();
  const oldest = now - rawRetentionDays(env) * DAY;
  const readings = [];
  for (const r of input) {
    // Без ts (плата без NTP) берём время сервера — имеет смысл только для одиночного замера.
    const ts = Number.isInteger(r?.ts) ? r.ts : (r?.ts == null && input.length === 1 ? now : null);
    const t = Number(r?.t);
    const h = Number(r?.h);
    if (ts === null || ts < oldest || ts > now + 300) continue;
    if (!Number.isFinite(t) || t < -40 || t > 80) continue;
    if (!Number.isFinite(h) || h < 0 || h > 100) continue;
    // Давление необязательно (BME280); неправдоподобное значение отбрасываем, а сам замер сохраняем.
    const pv = r?.p == null ? NaN : Number(r.p);
    const p = Number.isFinite(pv) && pv >= 300 && pv <= 1100 ? round(pv, 1) : null;
    readings.push({ ts, t: round(t, 1), h: round(h, 1), p });
  }

  const stmts = [];
  for (let i = 0; i < readings.length; i += SQL_CHUNK) {
    const chunk = readings.slice(i, i + SQL_CHUNK);
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?)').join(', ');
    const params = chunk.flatMap((r) => [device.id, r.ts, r.t, r.h, r.p]);
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO readings_raw (device_id, ts, t, h, p) VALUES ${placeholders}`,
    ).bind(...params));
  }

  // Последнее значение кладём прямо в devices, чтобы карточки на дашборде читали 1 строку на комнату.
  const latest = readings.reduce((a, r) => (!a || r.ts > a.ts ? r : a), null);
  const rssi = Number.isInteger(body.rssi) ? body.rssi : null;
  const fw = typeof body.fw === 'string' ? body.fw.slice(0, 32) : null;
  // Интервал отправки (сек): по нему дашборд решает, когда показывать «нет данных».
  const si = Number.isInteger(body.send_interval) && body.send_interval > 0 ? Math.min(body.send_interval, DAY) : null;
  stmts.push(env.DB.prepare(
    `UPDATE devices SET
       last_seen = ?1,
       rssi = COALESCE(?2, rssi),
       fw = COALESCE(?3, fw),
       send_interval = COALESCE(?9, send_interval),
       last_t  = CASE WHEN ?4 IS NOT NULL AND (last_ts IS NULL OR ?4 >= last_ts) THEN ?5 ELSE last_t END,
       last_h  = CASE WHEN ?4 IS NOT NULL AND (last_ts IS NULL OR ?4 >= last_ts) THEN ?6 ELSE last_h END,
       last_p  = CASE WHEN ?4 IS NOT NULL AND (last_ts IS NULL OR ?4 >= last_ts) THEN ?8 ELSE last_p END,
       last_ts = CASE WHEN ?4 IS NOT NULL AND (last_ts IS NULL OR ?4 >= last_ts) THEN ?4 ELSE last_ts END
     WHERE id = ?7`,
  ).bind(now, rssi, fw, latest?.ts ?? null, latest?.t ?? null, latest?.h ?? null, device.id, latest?.p ?? null, si));

  await env.DB.batch(stmts);
  return json({ ok: true, accepted: readings.length, rejected: input.length - readings.length, server_time: now });
}

// ---------- read API ----------

async function withReadAuth(request, env, handler) {
  if (env.READ_KEY) {
    const url = new URL(request.url);
    const key = request.headers.get('x-read-key') || url.searchParams.get('key') || '';
    if (!(await safeEqual(key, env.READ_KEY))) return json({ error: 'unauthorized' }, 401);
  }
  return handler();
}

async function devices(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, sort, outdoor, last_seen, last_ts, last_t, last_h, last_p, send_interval, rssi, fw
     FROM devices ORDER BY sort, created_at, id`,
  ).all();
  return json({ now: nowSec(), site: site(env), devices: results }, 200, { 'cache-control': 'no-store' });
}

// Координаты дома для погоды Open-Meteo (дашборд запрашивает её сам). Не заданы — блока погоды нет.
function site(env) {
  const lat = Number(env.SITE_LAT), lon = Number(env.SITE_LON);
  if (!env.SITE_LAT || !env.SITE_LON || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, name: env.SITE_NAME || 'Open-Meteo' };
}

// GET /api/series?range=24h[&since=bathroom:1700000000,bedroom:1700000060]
// since — инкрементальная дозагрузка: только строки новее указанного ts для каждого устройства.
async function series(url, env) {
  const range = RANGES[url.searchParams.get('range')] ? url.searchParams.get('range') : '24h';
  const { span, table, step } = RANGES[range];
  const now = nowSec();
  const from = now - span;

  const since = new Map();
  for (const part of (url.searchParams.get('since') || '').split(',')) {
    const i = part.lastIndexOf(':');
    const ts = Number(part.slice(i + 1));
    if (i > 0 && Number.isInteger(ts)) since.set(part.slice(0, i), ts);
  }

  const { results: devs } = await env.DB.prepare('SELECT id FROM devices ORDER BY sort, created_at, id').all();
  const cols = table === 'readings_raw'
    ? 'ts, t, h, p'
    : 'ts, n, t_avg, t_min, t_max, h_avg, h_min, h_max, p_avg, p_min, p_max';
  // Запрос на каждое устройство: так используется PK (device_id, ts), а не скан всей таблицы.
  const stmts = devs.map((d) => env.DB.prepare(
    `SELECT ${cols} FROM ${table} WHERE device_id = ? AND ts > ? ORDER BY ts`,
  ).bind(d.id, Math.max(from, since.get(d.id) ?? from)));
  const results = stmts.length ? await env.DB.batch(stmts) : [];

  const out = {};
  devs.forEach((d, i) => {
    const rows = results[i].results;
    const s = {};
    for (const c of cols.split(', ')) {
      const values = rows.map((r) => r[c]);
      // Колонки давления не отдаём, если у устройства его нет (DHT) — меньше трафика.
      if (c.startsWith('p') && values.every((v) => v == null)) continue;
      s[c] = values;
    }
    out[d.id] = s;
  });
  return json({ now, range, from, step, aggregated: table !== 'readings_raw', series: out }, 200, { 'cache-control': 'no-store' });
}

// ---------- cron ----------

async function rollupHourly(env, fromTs) {
  const from = Math.floor(fromTs / HOUR) * HOUR;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO readings_hourly
       (device_id, ts, n, t_avg, t_min, t_max, h_avg, h_min, h_max, p_avg, p_min, p_max)
     SELECT device_id, (ts / 3600) * 3600 AS bucket, COUNT(*),
            ROUND(AVG(t), 2), MIN(t), MAX(t), ROUND(AVG(h), 2), MIN(h), MAX(h),
            ROUND(AVG(p), 2), MIN(p), MAX(p)
     FROM readings_raw WHERE ts >= ?
     GROUP BY device_id, bucket`,
  ).bind(from).run();
}

// Сутки считаются по локальному времени (TZ), прямо из сырых данных за последние 3 дня.
async function rollupDaily(env, now) {
  const off = tzOffsetSec(env.TZ || 'UTC', now);
  const todayStart = Math.floor((now + off) / DAY) * DAY - off;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO readings_daily
       (device_id, ts, n, t_avg, t_min, t_max, h_avg, h_min, h_max, p_avg, p_min, p_max)
     SELECT device_id, ((ts + CAST(?1 AS INTEGER)) / 86400) * 86400 - CAST(?1 AS INTEGER) AS bucket, COUNT(*),
            ROUND(AVG(t), 2), MIN(t), MAX(t), ROUND(AVG(h), 2), MIN(h), MAX(h),
            ROUND(AVG(p), 2), MIN(p), MAX(p)
     FROM readings_raw WHERE ts >= ?2
     GROUP BY device_id, bucket`,
  ).bind(off, todayStart - 2 * DAY).run();
}

async function cleanup(env, now) {
  const hourlyDays = Math.max(31, Number(env.HOURLY_RETENTION_DAYS) || 400);
  const raw = await env.DB.prepare('DELETE FROM readings_raw WHERE ts < ?')
    .bind(now - rawRetentionDays(env) * DAY).run();
  const hourly = await env.DB.prepare('DELETE FROM readings_hourly WHERE ts < ?')
    .bind(now - hourlyDays * DAY).run();
  console.log(`cleanup: raw -${raw.meta.changes}, hourly -${hourly.meta.changes}`);
}

// ---------- helpers ----------

function rawRetentionDays(env) {
  // Не меньше 3 дней: суточная агрегация читает сырые данные за последние 3 дня.
  return Math.max(3, Number(env.RAW_RETENTION_DAYS) || 30);
}

function tzOffsetSec(timeZone, ts) {
  const date = new Date(ts * 1000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime()) / 1000);
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256hex(a), sha256hex(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function round(v, digits) {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
