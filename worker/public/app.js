'use strict';

// ---------------- настройки ----------------
const STALE_AFTER = 15 * 60;          // сек без свежих данных -> «нет данных» (для датчиков в deep sleep — больше, см. staleLimit)
const DEVICES_EVERY = 60 * 1000;      // опрос карточек
const SERIES_EVERY = { '24h': 60 * 1000, '7d': 15 * 60 * 1000, '30d': 15 * 60 * 1000, '1y': 60 * 60 * 1000 };
const FULL_RELOAD_EVERY = 6 * 3600 * 1000; // полная перезагрузка 24ч-данных (подхватить поздние пачки)
const HUMID_HIGH = 70;
const HUMID_LOW = 30;
const MAX_SERIES = 8;                 // в палитре 8 цветов; больше комнат — расширить палитру

// localStorage может быть недоступен (приватный режим) — всё работает и без него.
function storeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function storeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
const store = { get: storeGet, set: storeSet };

const params = new URLSearchParams(location.search);
const KIOSK = params.has('kiosk');
if (KIOSK) {
  document.documentElement.classList.add('kiosk');
  document.documentElement.dataset.theme = 'dark';
}

// Ключ чтения: ?key=... запоминается и убирается из адресной строки.
const KEY_STORE = 'climate.readKey';
if (params.get('key')) {
  store.set(KEY_STORE, params.get('key'));
  params.delete('key');
  history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : ''));
}

const state = {
  range: (KIOSK ? null : store.get('climate.range')) || '24h',
  devices: [],
  now: Math.floor(Date.now() / 1000),
  raw: {},          // 24ч сырые данные по устройствам: { id: { ts:[], t:[], h:[] } }
  rawLoadedAt: 0,
  site: null,       // { lat, lon, name } из wrangler.toml — для погоды на улице
  weather: null,    // ответ Open-Meteo для текущего периода
  resp: null,       // последний ответ /api/series для range != 24h
  charts: {},
};

const $ = (s) => document.querySelector(s);
const ruMonths = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const ruMonthsShort = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const ruDays = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const ruDaysShort = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const ruNames = { MMMM: ruMonths, MMM: ruMonthsShort, WWWW: ruDays, WWW: ruDaysShort };
const fmtNum = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : v.toFixed(d).replace('.', ','));

// ---------------- API ----------------
class AuthError extends Error {}

async function api(path) {
  const headers = {};
  const key = store.get(KEY_STORE);
  if (key) headers['x-read-key'] = key;
  const res = await fetch(path, { headers, cache: 'no-store' });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

function showAuth() {
  $('#auth').hidden = false;
  $('#auth-key').focus();
}
$('#auth-form').addEventListener('submit', (e) => {
  e.preventDefault();
  store.set(KEY_STORE, $('#auth-key').value.trim());
  $('#auth').hidden = true;
  refreshAll(true);
});

// ---------------- данные ----------------
async function loadDevices() {
  const data = await api('/api/devices');
  const changed = data.devices.map((d) => d.id).join() !== state.devices.map((d) => d.id).join();
  state.devices = data.devices.slice(0, MAX_SERIES);
  const siteChanged = JSON.stringify(data.site || null) !== JSON.stringify(state.site);
  state.site = data.site || null;
  if (siteChanged) {
    $('#weather').hidden = !state.site;
    guard(loadWeather());
  }
  state.now = data.now;
  renderCards();
  if (changed || siteChanged) {
    renderLegend();
    rebuildCharts();
  }
}

async function loadSeries(force = false) {
  const charts = $('#charts');
  charts.classList.add('is-loading');
  try {
    if (state.range === '24h') await loadRaw(force);
    else state.resp = await api(`/api/series?range=${state.range}`);
    updateCharts();
  } finally {
    charts.classList.remove('is-loading');
  }
}

// 24 часа: первая загрузка целиком, дальше — только новые строки (экономит лимит чтений D1).
async function loadRaw(force) {
  const full = force || Date.now() - state.rawLoadedAt > FULL_RELOAD_EVERY || !Object.keys(state.raw).length;
  let url = '/api/series?range=24h';
  if (!full) {
    const since = Object.entries(state.raw)
      .filter(([, s]) => s.ts.length)
      .map(([id, s]) => `${encodeURIComponent(id)}:${s.ts[s.ts.length - 1]}`);
    if (since.length) url += '&since=' + since.join(',');
  }
  const resp = await api(url);
  state.now = resp.now;
  if (full) state.rawLoadedAt = Date.now();
  const raw = full ? {} : state.raw;
  for (const [id, s] of Object.entries(resp.series)) {
    const cur = raw[id] || (raw[id] = { ts: [], t: [], h: [], p: [] });
    cur.ts.push(...s.ts); cur.t.push(...s.t); cur.h.push(...s.h);
    cur.p.push(...(s.p || s.ts.map(() => null)));
    let cut = 0;
    while (cut < cur.ts.length && cur.ts[cut] <= resp.from) cut++;
    if (cut) for (const k of ['ts', 't', 'h', 'p']) cur[k].splice(0, cut);
  }
  state.raw = raw;
  state.resp = { ...resp, series: raw };
}

const METRICS = ['t', 'h', 'p'];

// Приводим всё к общей сетке X: 24ч — 5-минутные корзины, остальное уже агрегировано.
// Значение «нет точки в этой корзине» = undefined (uPlot соединяет линию через него),
// а настоящий обрыв связи = null (линия рвётся). Порог обрыва считается для каждого
// устройства по его собственному шагу, поэтому редкие замеры из deep sleep не рвут график.
function buildTable() {
  const resp = state.resp;
  if (!resp) return null;
  const per = state.devices.map((d) => {
    const s = resp.series[d.id] || { ts: [] };
    const m = new Map();
    if (!resp.aggregated) {
      s.ts.forEach((ts, i) => {
        const b = Math.floor(ts / resp.step) * resp.step;
        const a = m.get(b) || {};
        for (const k of METRICS) {
          const v = s[k]?.[i];
          if (v == null) continue;
          const c = a[k] || (a[k] = { n: 0, sum: 0, min: Infinity, max: -Infinity });
          c.n++; c.sum += v; c.min = Math.min(c.min, v); c.max = Math.max(c.max, v);
        }
        m.set(b, a);
      });
      for (const a of m.values()) {
        for (const k of METRICS) if (a[k]) a[k] = { n: a[k].n, avg: a[k].sum / a[k].n, min: a[k].min, max: a[k].max };
      }
    } else {
      s.ts.forEach((ts, i) => {
        const a = {};
        for (const k of METRICS) {
          if (s[`${k}_avg`]?.[i] == null) continue;
          a[k] = { n: s.n[i], avg: s[`${k}_avg`][i], min: s[`${k}_min`][i], max: s[`${k}_max`][i] };
        }
        m.set(ts, a);
      });
    }
    return m;
  });

  // Улица (Open-Meteo) — последней серией; за год не показываем, у Open-Meteo там нужен архивный API.
  if (state.site) {
    per.push(state.weather && state.range !== '1y'
      ? Weather.outdoorBuckets(state.weather, resp.from, resp.now)
      : new Map());
  }

  const xsSet = new Set();
  const gaps = per.map((m) => {
    const keys = [...m.keys()].sort((a, b) => a - b);
    const diffs = keys.slice(1).map((k, i) => k - keys[i]).sort((a, b) => a - b);
    const typical = diffs.length ? diffs[Math.floor(diffs.length / 2)] : resp.step;
    const limit = Math.max(resp.step, typical) * 2.5;
    const g = new Set();
    keys.forEach((k, i) => {
      xsSet.add(k);
      if (i && k - keys[i - 1] > limit) { g.add(keys[i - 1] + resp.step); xsSet.add(keys[i - 1] + resp.step); }
    });
    return g;
  });
  const xs = [...xsSet].sort((a, b) => a - b);

  const pick = (k, f) => per.map((m, di) => xs.map((x) => {
    if (gaps[di].has(x)) return null;
    const v = m.get(x)?.[k]?.[f];
    return v == null ? undefined : round1(v);
  }));
  const table = { xs, per };
  for (const k of METRICS) {
    table[k] = pick(k, 'avg');
    table[k + 'min'] = pick(k, 'min');
    table[k + 'max'] = pick(k, 'max');
  }
  table.hasP = per.some((m) => [...m.values()].some((a) => a.p));
  return table;
}

function round1(v) { return v == null ? null : Math.round(v * 10) / 10; }

function stats(per) {
  return per.map((m) => {
    const out = {};
    for (const k of METRICS) {
      let n = 0, sum = 0, min = Infinity, max = -Infinity;
      m.forEach((a) => {
        if (!a[k]) return;
        n += a[k].n; sum += a[k].avg * a[k].n;
        min = Math.min(min, a[k].min); max = Math.max(max, a[k].max);
      });
      if (n) Object.assign(out, { [k + 'min']: min, [k + 'avg']: sum / n, [k + 'max']: max });
    }
    return Object.keys(out).length ? out : null;
  });
}

// ---------------- карточки ----------------
function dewPoint(t, rh) {
  const a = 17.62, b = 243.12;
  const g = Math.log(rh / 100) + (a * t) / (b + t);
  return (b * g) / (a - g);
}

function ago(sec) {
  if (sec < 90) return 'только что';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

const ICON_WARN = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15 14H1z" fill="var(--warning)"/><path d="M8 6v4M8 11.6v.4" stroke="#0b0b0b" stroke-width="1.6" stroke-linecap="round"/></svg>';
const ICON_DROP = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5C8 1.5 3 7 3 10a5 5 0 0 0 10 0c0-3-5-8.5-5-8.5z" fill="var(--serious)"/></svg>';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function badge(icon, label) {
  const b = el('div', 'badge');
  b.innerHTML = icon;
  b.append(el('span', null, label));
  return b;
}

function renderCards() {
  const wrap = $('#cards');
  wrap.replaceChildren();
  if (!state.devices.length) {
    wrap.append(el('p', 'empty', 'Датчики ещё не зарегистрированы — см. README, шаг «Добавить датчик».'));
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  state.devices.forEach((d, i) => {
    const stale = !d.last_ts || now - d.last_ts > staleLimit(d);
    const card = el('article', 'card' + (stale ? ' is-stale' : ''));
    card.style.setProperty('--c', seriesColor(i));
    const name = el('div', 'card-name');
    name.append(el('span', 'key'), el('span', null, d.name));
    card.append(name);

    if (d.last_t == null) {
      card.append(el('div', 'card-meta', 'Ещё нет данных'));
    } else {
      const t = el('div', 'card-t', fmtNum(d.last_t));
      t.append(el('small', null, '°C'));
      const h = el('div', 'card-h', `${fmtNum(d.last_h, 0)} %`);
      h.append(el('small', null, ' влажность'));
      card.append(t, h, el('div', 'card-meta', `Точка росы ${fmtNum(dewPoint(d.last_t, d.last_h))}°`));
      if (d.last_p != null) card.append(el('div', 'card-meta card-ago', `Давление ${fmtNum(d.last_p, 0)} гПа · ${Math.round(d.last_p * HPA_TO_MMHG)} мм рт. ст.`));
      if (!stale) card.append(el('div', 'card-meta card-ago', ago(now - d.last_ts)));
      // Советы по влажности — только для комнат: на улице 80–90 % это норма.
      if (!stale && !d.outdoor && d.last_h >= HUMID_HIGH) card.append(badge(ICON_DROP, 'Высокая влажность'));
      else if (!stale && !d.outdoor && d.last_h <= HUMID_LOW) card.append(badge(ICON_WARN, 'Сухой воздух'));
    }
    if (stale) card.append(badge(ICON_WARN, d.last_ts ? `Нет данных ${ago(now - d.last_ts)}` : 'Нет данных'));
    wrap.append(card);
  });
  $('#updated').textContent = `Обновлено в ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
}

const HPA_TO_MMHG = 0.750062;

// Датчик в deep sleep присылает пачку раз в send_interval — «нет данных» только после 2,5 пропущенных отправок.
function staleLimit(d) {
  return Math.max(STALE_AFTER, (d.send_interval || 0) * 2.5);
}

// Все линии графиков: комнаты (цвет по порядку) + «Улица» нейтральным пунктиром.
function seriesList() {
  const list = state.devices.map((d, i) => ({ name: d.name, color: seriesColor(i), dashed: false }));
  if (state.site) list.push({ name: state.site.name, color: css('--outdoor'), dashed: true });
  return list;
}

function keyEl(sr) {
  const k = el('span', sr.dashed ? 'key key-dashed' : 'key');
  k.style.setProperty('--c', sr.color);
  return k;
}

function renderLegend() {
  const ul = $('#legend');
  ul.replaceChildren();
  for (const sr of seriesList()) {
    const li = el('li');
    li.append(keyEl(sr), el('span', null, sr.name));
    ul.append(li);
  }
}

function renderStats(table) {
  const tbody = $('#stats tbody');
  tbody.replaceChildren();
  const st = table ? stats(table.per) : [];
  seriesList().forEach((sr, i) => {
    const tr = el('tr');
    const td = el('td');
    const room = el('span', 'room');
    room.append(keyEl(sr), el('span', null, sr.name));
    td.append(room);
    tr.append(td);
    const s = st[i];
    const cols = [[s?.tmin, '°'], [s?.tavg, '°'], [s?.tmax, '°'], [s?.hmin, '%'], [s?.havg, '%'], [s?.hmax, '%']];
    if (table?.hasP) cols.push([s?.pmin, '', 0], [s?.pavg, '', 0], [s?.pmax, '', 0]);
    for (const [v, unit, digits = 1] of cols) {
      tr.append(el('td', 'num', v == null ? '—' : fmtNum(v, digits) + unit));
    }
    tbody.append(tr);
  });
}

// ---------------- графики ----------------
function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function seriesColor(i) { return css(`--series-${(i % MAX_SERIES) + 1}`); }

// Подписи оси времени по-русски: часы, а на смене суток — ещё и дата.
function timeAxisValues(u, splits, axisIdx, space, incr) {
  let prevDay = null;
  return splits.map((v) => {
    const d = new Date(v * 1000);
    const date = `${d.getDate()} ${ruMonthsShort[d.getMonth()]}`;
    if (incr >= 28 * 86400) return ruMonthsShort[d.getMonth()];
    if (incr >= 86400) return date;
    const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const day = d.toDateString();
    const withDate = prevDay !== null && prevDay !== day;
    prevDay = day;
    return withDate ? `${hm}\n${date}` : hm;
  });
}

function axisValuesFmt(unit) {
  return (u, vals) => vals.map((v) => (v == null ? '' : fmtNum(v, Number.isInteger(v) ? 0 : 1) + unit));
}

// Подписи справа у конца каждой линии (≤ 4 комнат), раздвинутые, чтобы не налезали.
function directLabelsPlugin() {
  return {
    hooks: {
      draw: (u) => {
        const n = u.series.length - 1;
        if (n < 1 || n > 4 || KIOSK) return;
        const ctx = u.ctx;
        const dpr = devicePixelRatio || 1;
        const labels = [];
        for (let s = 1; s <= n; s++) {
          const d = u.data[s];
          let i = d.length - 1;
          while (i >= 0 && d[i] == null) i--;
          if (i < 0) continue;
          labels.push({ s, y: u.valToPos(d[i], 'y', true), text: u.series[s].label });
        }
        labels.sort((a, b) => a.y - b.y);
        const gap = 15 * dpr;
        for (let k = 1; k < labels.length; k++) labels[k].y = Math.max(labels[k].y, labels[k - 1].y + gap);
        ctx.save();
        ctx.font = `${12 * dpr}px ${css('--font')}`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        const x = u.bbox.left + u.bbox.width + 8 * dpr;
        for (const l of labels) {
          ctx.fillStyle = u.series[l.s].stroke();
          ctx.fillRect(x, l.y - 1 * dpr, 8 * dpr, 2 * dpr);
          ctx.fillStyle = css('--ink-2');
          ctx.fillText(l.text, x + 12 * dpr, l.y);
        }
        ctx.restore();
      },
    },
  };
}

function tooltipPlugin(field, unit) {
  const tip = $('#tooltip');
  return {
    hooks: {
      setCursor: (u) => {
        const idx = u.cursor.idx;
        if (idx == null || u.cursor.left < 0 || !state.table) { tip.hidden = true; return; }
        const x = u.data[0][idx];
        const resp = state.resp;
        const opts = resp.step >= 86400
          ? { day: 'numeric', month: 'long', weekday: 'short' }
          : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
        tip.replaceChildren(el('div', 'tt-time', new Date(x * 1000).toLocaleString('ru-RU', opts)));
        let any = false;
        for (let s = 1; s < u.series.length; s++) {
          const v = u.data[s][idx];
          if (v == null) continue;
          any = true;
          const row = el('div', 'tt-row');
          const k = el('span', 'key');
          k.style.setProperty('--c', u.series[s].stroke());
          const mn = state.table[field + 'min'][s - 1][idx];
          const mx = state.table[field + 'max'][s - 1][idx];
          row.append(k, el('span', 'tt-val', fmtNum(v) + unit), el('span', 'tt-name', u.series[s].label));
          if (mn != null && mx != null && mx - mn >= 0.1) row.append(el('span', 'tt-range', `${fmtNum(mn)}…${fmtNum(mx)}`));
          tip.append(row);
        }
        if (!any) { tip.hidden = true; return; }
        tip.hidden = false;
        const rect = u.over.getBoundingClientRect();
        const left = rect.left + u.cursor.left;
        const top = rect.top + u.cursor.top;
        const w = tip.offsetWidth, h = tip.offsetHeight;
        tip.style.left = Math.min(Math.max(8, left + 14 + w > innerWidth ? left - w - 14 : left + 14), innerWidth - w - 8) + 'px';
        tip.style.top = Math.min(Math.max(8, top - h / 2), innerHeight - h - 8) + 'px';
      },
    },
  };
}

function makeChart(target, field, unit) {
  const box = $(target);
  box.replaceChildren();
  // В режиме киоска шрифт осей масштабируется от экрана, вместе с ним — место под подписи.
  const fontPx = KIOSK ? Math.max(12, Math.round(Math.min(innerWidth, innerHeight) / 70)) : 12;
  const labelWidth = state.devices.length <= 4 && !KIOSK
    ? Math.min(110, 30 + Math.max(0, ...state.devices.map((d) => d.name.length)) * 7)
    : fontPx * 2;
  const axis = {
    stroke: css('--muted'),
    font: `${fontPx}px ${css('--font')}`,
    grid: { stroke: css('--grid'), width: 1 },
    ticks: { show: false },
  };
  const opts = {
    width: box.clientWidth,
    height: box.clientHeight,
    padding: [8, labelWidth, 0, 0],
    fmtDate: (tpl) => uPlot.fmtDate(tpl, ruNames),
    scales: { x: { time: true } },
    legend: { show: false },
    cursor: { drag: { x: false, y: false }, points: { size: 8, width: 2 }, y: false },
    axes: [
      { ...axis, space: fontPx * 6, size: Math.round(fontPx * 3.8), values: timeAxisValues },
      { ...axis, size: Math.round(fontPx * (field === 'p' ? 4.2 : 3.6)), values: axisValuesFmt(unit === '°' ? '°' : '') },
    ],
    series: [{}, ...seriesList().map((sr) => ({
      label: sr.name,
      stroke: sr.color,
      width: (KIOSK ? 3 : 2) * (sr.dashed ? 0.75 : 1),
      dash: sr.dashed ? [6, 4] : undefined,
      points: { show: false },
      spanGaps: false,
    }))],
    plugins: [tooltipPlugin(field, unit), directLabelsPlugin()],
  };
  const empty = [[], ...seriesList().map(() => [])];
  const u = new uPlot(opts, empty, box);
  u.over.addEventListener('mouseleave', () => { $('#tooltip').hidden = true; });
  return u;
}

function rebuildCharts() {
  Object.values(state.charts).forEach((c) => c.destroy());
  state.charts = {
    t: makeChart('#chart-t', 't', '°'),
    h: makeChart('#chart-h', 'h', '%'),
    p: makeChart('#chart-p', 'p', ' гПа'),
  };
  updateCharts();
}

function updateCharts() {
  const table = buildTable();
  state.table = table;
  if (table && state.charts.t) {
    state.charts.t.setData([table.xs, ...table.t]);
    state.charts.h.setData([table.xs, ...table.h]);
    state.charts.p.setData([table.xs, ...table.p]);
  }
  // Давление показываем, только если хоть один датчик его меряет (BME280).
  const hasP = !!table?.hasP;
  $('#chart-p-card').hidden = !hasP;
  document.querySelectorAll('.p-col').forEach((c) => { c.hidden = !hasP; });
  const note = { '24h': '· 5-минутные средние', '7d': '· средние за час', '30d': '· средние за час', '1y': '· средние за сутки' }[state.range];
  document.querySelectorAll('[data-agg-note]').forEach((n) => { n.textContent = note; });
  renderStats(table);
}

new ResizeObserver(() => {
  for (const [k, u] of Object.entries(state.charts)) {
    const box = $(`#chart-${k}`);
    if (box.clientWidth && (box.clientWidth !== u.width || box.clientHeight !== u.height)) {
      u.setSize({ width: box.clientWidth, height: box.clientHeight });
    }
  }
}).observe($('#charts'));

// Перерисовать цвета при смене светлой/тёмной темы ОС.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  renderCards(); renderLegend(); rebuildCharts();
});

// ---------------- фильтр периода ----------------
document.querySelectorAll('.seg button').forEach((b) => {
  b.setAttribute('aria-checked', String(b.dataset.range === state.range));
  b.addEventListener('click', () => {
    if (b.dataset.range === state.range) return;
    state.range = b.dataset.range;
    store.set('climate.range', state.range);
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    schedule();
    guard(loadSeries(true));
    guard(loadWeather());
  });
});

// ---------------- цикл обновления ----------------
let timers = [];
function schedule() {
  timers.forEach(clearInterval);
  timers = [
    setInterval(() => guard(loadDevices()), DEVICES_EVERY),
    setInterval(() => guard(loadSeries()), SERIES_EVERY[state.range]),
    setInterval(() => guard(loadWeather()), 15 * 60 * 1000),
  ];
}

const PAST_DAYS = { '24h': 1, '7d': 7, '30d': 30, '1y': 0 };

async function loadWeather() {
  if (!state.site) return;
  try {
    state.weather = await Weather.fetchWeather(state.site, PAST_DAYS[state.range]);
    Weather.render($('#weather'), state.site, state.weather, Math.floor(Date.now() / 1000));
    updateCharts();
  } catch (err) {
    // Погода — дополнение: без неё дашборд работает как обычно.
    console.warn(err);
  }
}

async function refreshAll(force) {
  await guard(loadDevices());
  await guard(loadSeries(force));
}

async function guard(p) {
  try {
    await p;
  } catch (err) {
    if (err instanceof AuthError) showAuth();
    else {
      console.error(err);
      $('#updated').textContent = 'Нет связи с сервером, повторю позже';
    }
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshAll(false);
});
setInterval(() => { if (state.devices.length) renderCards(); }, 30 * 1000);

refreshAll(true).then(schedule);
