'use strict';
// Погода на улице и прогноз осадков: Open-Meteo (https://open-meteo.com), бесплатно и без ключа.
// Браузер ходит туда напрямую — запросы не тратят лимиты Worker и D1.

const Weather = (() => {
  const API = 'https://api.open-meteo.com/v1/forecast';
  const CACHE_MS = 15 * 60 * 1000;
  const cache = new Map(); // pastDays -> { at, data }

  // WMO weather codes -> текст и значок
  const CODES = {
    0: ['Ясно', '☀️'], 1: ['Преимущественно ясно', '🌤️'], 2: ['Переменная облачность', '⛅'], 3: ['Пасмурно', '☁️'],
    45: ['Туман', '🌫️'], 48: ['Изморозь, туман', '🌫️'],
    51: ['Слабая морось', '🌦️'], 53: ['Морось', '🌦️'], 55: ['Сильная морось', '🌧️'],
    56: ['Ледяная морось', '🌧️'], 57: ['Сильная ледяная морось', '🌧️'],
    61: ['Небольшой дождь', '🌦️'], 63: ['Дождь', '🌧️'], 65: ['Сильный дождь', '🌧️'],
    66: ['Ледяной дождь', '🌧️'], 67: ['Сильный ледяной дождь', '🌧️'],
    71: ['Небольшой снег', '🌨️'], 73: ['Снег', '🌨️'], 75: ['Сильный снег', '❄️'], 77: ['Снежная крупа', '🌨️'],
    80: ['Небольшой ливень', '🌦️'], 81: ['Ливень', '🌧️'], 82: ['Сильный ливень', '⛈️'],
    85: ['Снегопад', '🌨️'], 86: ['Сильный снегопад', '❄️'],
    95: ['Гроза', '⛈️'], 96: ['Гроза с градом', '⛈️'], 99: ['Сильная гроза с градом', '⛈️'],
  };
  const describe = (code) => CODES[code] || ['—', '🌡️'];

  async function fetchWeather(site, pastDays) {
    const hit = cache.get(pastDays);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
    const q = new URLSearchParams({
      latitude: site.lat,
      longitude: site.lon,
      current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,is_day',
      hourly: 'temperature_2m,relative_humidity_2m,precipitation_probability,precipitation',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max',
      timezone: 'auto',
      timeformat: 'unixtime',
      wind_speed_unit: 'ms',
      past_days: String(pastDays),
      forecast_days: '3',
    });
    const res = await fetch(`${API}?${q}`);
    if (!res.ok) throw new Error(`open-meteo: HTTP ${res.status}`);
    const data = await res.json();
    cache.set(pastDays, { at: Date.now(), data });
    return data;
  }

  // Часовые точки за прошлое в формате корзин дашборда: Map(ts -> { t:{n,avg,min,max}, h:{…} })
  function outdoorBuckets(data, from, to) {
    const m = new Map();
    const hr = data?.hourly;
    if (!hr) return m;
    hr.time.forEach((ts, i) => {
      if (ts <= from || ts > to) return;
      const a = {};
      const t = hr.temperature_2m[i], h = hr.relative_humidity_2m[i];
      if (t != null) a.t = { n: 1, avg: t, min: t, max: t };
      if (h != null) a.h = { n: 1, avg: h, min: h, max: h };
      if (a.t || a.h) m.set(ts, a);
    });
    return m;
  }

  // Ближайшие 12 часов осадков + короткая фраза для человека.
  function precipOutlook(data, nowSec) {
    const hr = data.hourly;
    const hours = [];
    for (let i = 0; i < hr.time.length && hours.length < 12; i++) {
      if (hr.time[i] + 3600 <= nowSec) continue;
      hours.push({ ts: hr.time[i], mm: hr.precipitation[i] || 0, prob: hr.precipitation_probability[i] ?? 0 });
    }
    const wet = hours.find((h) => h.mm >= 0.1 && h.prob >= 40);
    let summary;
    if (!wet) summary = 'Без осадков ближайшие 12 ч';
    else if (wet.ts <= nowSec) summary = `Осадки сейчас, вероятность ${wet.prob} %`;
    else summary = `Осадки около ${hhmm(wet.ts)}, вероятность ${wet.prob} %`;
    return { hours, summary };
  }

  const capitalize = (str) => str.charAt(0).toUpperCase() + str.slice(1);

  function hhmm(ts) {
    return new Date(ts * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  function node(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const fmt = (v, d = 0) => (v == null ? '—' : v.toFixed(d).replace('.', ',').replace(/^-0$/, '0'));

  function render(box, site, data, nowSec) {
    box.replaceChildren();
    const c = data.current;
    const [text, icon] = describe(c.weather_code);

    // --- сейчас ---
    const now = node('div', 'wx-now');
    const head = node('div', 'card-name', 'Погода сейчас');
    const t = node('div', 'card-t', fmt(c.temperature_2m, 1));
    t.append(node('small', null, '°C'));
    const cond = node('div', 'wx-cond');
    cond.append(node('span', 'wx-icon', icon), node('span', null, text));
    now.append(head, t, cond,
      node('div', 'card-meta', `Ощущается ${fmt(c.apparent_temperature)}° · ${fmt(c.relative_humidity_2m)} % · ветер ${fmt(c.wind_speed_10m)} м/с`));

    // --- осадки на 12 часов ---
    const { hours, summary } = precipOutlook(data, nowSec);
    const rain = node('div', 'wx-rain');
    rain.append(node('div', 'wx-title', 'Осадки, 12 ч'), node('div', 'wx-summary', summary));
    const bars = node('div', 'wx-bars');
    bars.setAttribute('role', 'img');
    bars.setAttribute('aria-label', hours.map((h) => `${hhmm(h.ts)}: ${fmt(h.mm, 1)} мм, ${h.prob} %`).join('; '));
    const maxMm = Math.max(2, ...hours.map((h) => h.mm));
    hours.forEach((h, i) => {
      const col = node('div', 'wx-col');
      col.title = `${hhmm(h.ts)} — ${fmt(h.mm, 1)} мм, вероятность ${h.prob} %`;
      const prob = node('span', 'wx-prob', h.prob >= 20 ? `${h.prob}%` : '');
      const track = node('span', 'wx-track');
      const bar = node('span', 'wx-bar');
      bar.style.height = `${Math.max(h.mm > 0 ? 8 : 0, (h.mm / maxMm) * 100)}%`;
      bar.style.opacity = String(0.35 + 0.65 * (h.prob / 100));
      track.append(bar);
      const lbl = node('span', 'wx-hour', i % 3 === 0 ? hhmm(h.ts).slice(0, 2) : '');
      col.append(prob, track, lbl);
      bars.append(col);
    });
    rain.append(bars);

    // --- 3 дня ---
    const days = node('div', 'wx-days');
    const d = data.daily;
    const off = data.utc_offset_seconds || 0;
    d.time.forEach((ts, i) => {
      // timeformat=unixtime: суточные метки — местная полночь, сдвигаем на utc_offset, чтобы взять дату.
      const date = new Date((ts + off) * 1000);
      const today = new Date((nowSec + off) * 1000);
      const diff = Math.round((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
        - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / 86400000);
      if (diff < 0) return;
      const label = diff === 0 ? 'Сегодня' : diff === 1 ? 'Завтра'
        : capitalize(date.toLocaleDateString('ru-RU', { weekday: 'short', timeZone: 'UTC' }));
      const row = node('div', 'wx-day');
      const [dtext, dicon] = describe(d.weather_code[i]);
      const ic = node('span', 'wx-icon', dicon);
      ic.title = dtext;
      row.append(node('span', 'wx-dname', label), ic,
        node('span', 'wx-dtemp', `${fmt(d.temperature_2m_max[i])}° / ${fmt(d.temperature_2m_min[i])}°`),
        node('span', 'wx-dprecip', d.precipitation_sum[i] >= 0.1
          ? `${fmt(d.precipitation_sum[i], 1)} мм · ${d.precipitation_probability_max[i] ?? 0} %`
          : 'без осадков'));
      days.append(row);
    });

    const credit = node('a', 'wx-credit', 'Погода: Open-Meteo.com');
    credit.href = 'https://open-meteo.com/';
    credit.target = '_blank';
    credit.rel = 'noopener';

    box.append(now, rain, days, credit);
  }

  return { fetchWeather, outdoorBuckets, render };
})();
