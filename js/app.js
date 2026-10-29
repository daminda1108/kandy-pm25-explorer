// app.js — Kandy Air, redesign A "The Valley" (2026-10-29; approved phase-0 mock-ups in design/mockups/, plan
// kandy_pm25/docs/webapp_A_build_plan_2026-10-29.md). The valley full-bleed with this hour's haze; the answer on one
// card; detail in a drawer (Air mass, Where, Weather, Data); time along the bottom (this day hour by hour, every day
// since 2019). The engine (store.js) is unchanged: every number comes from store.field() exactly as the QA gate checks.
// Replaces v2 "the valley breathes" (git tag v2-valley-breathes).
import { $, $$, getJSON, compass } from './util.js?v=1793242300';
import { activeCity } from './cities.js?v=1793242300';
import { Store, STORE_FCST } from './store.js?v=1793242300';
import { downloadFieldCSV, downloadPointCSV } from './download.js?v=1793242300';
import { Valley, webglOK, pmCss, pmColour } from './valley.js?v=1793242300';
import { envelope, verdict, cellOf, townAnswer } from './where.js?v=1793242300';

const CITY = activeCity();
const LT = CITY.tzOffsetH * 3600;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Sri Lanka's monsoon calendar (Department of Meteorology)
const SEASON = (m) => (m === 12 || m <= 2 ? 'North-east monsoon' : m <= 4 ? 'First inter-monsoon'
  : m <= 9 ? 'South-west monsoon' : 'Second inter-monsoon');
const PLACES = [['Kandy', 'city centre'], ['Katugastota', 'river, north'], ['Peradeniya', 'west, university'],
                ['Halloluwa', 'valley floor, north-west']];
const SCALE_MAX = 90;

const store = new Store(CITY);
const st = { year: null, gi: 0, f: null, tab: 'air', conf: true, pick: null, playing: false, timer: null, env: null };
let valley = null, parts = null, daily = null, spread = null, flatCv = null;

const ltDate = (ts) => new Date((ts + LT) * 1000);
const hhmm = (ts) => { const d = ltDate(ts); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const dayStart = (ts) => Math.floor((ts + LT) / 86400) * 86400 - LT;      // UTC seconds of local midnight
const isoDay = (ts) => ltDate(ts).toISOString().slice(0, 10);
const epTs = (e) => Date.parse(e.ts.replace(' ', 'T') + ':00Z') / 1000 - LT + 1800;   // episode stamps are local, hourly at :30
const tierOf = (y) => (y === STORE_FCST ? 'forecast' : ((store.meta.tiers || {}).extension || []).includes(y) ? 'extension' : 'anchored');
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '–');
const f0 = (x) => (Number.isFinite(x) ? Math.round(x).toString() : '–');

// ── boot ────────────────────────────────────────────────────────────────────────────────────────────────────
async function boot() {
  await store.init({ extras: false });
  let terrain;
  [terrain, parts, daily, spread] = await Promise.all(['terrain3d', 'pattern_parts', 'daily', 'spatial_spread']
    .map((k) => getJSON(`${store.base}/static/${k}.json`).catch(() => null)));
  if (terrain && webglOK()) {
    valley = new Valley($('#scene'), { terrain, meta: store.meta, grid: store.meta.grid,
                                       camera: innerWidth < 760 ? 'phone' : 'wide', onPick: (la, lo) => pick(la, lo) });
  } else {
    document.body.classList.add('no3d'); $('#scene').style.display = 'none';
    flatCv = $('#flat'); flatCv.addEventListener('click', flatPick);
  }
  fillStatic();
  wire();
  drawYear();
  addEventListener('resize', () => { drawYear(); if (st.f) { drawDay(); if (flatCv) drawFlat(); } });
  if (!(await restoreFromHash())) {
    const ep = store.meta.episodes.find((e) => e.id === CITY.defaultEpisode) || store.meta.episodes[0];
    await seekTs(epTs(ep));
  }
  addEventListener('hashchange', () => { if (!writing) restoreFromHash(); });
  const l = $('#loading'); l.classList.add('done'); setTimeout(() => l.remove(), 500);
}

// ── seeking ─────────────────────────────────────────────────────────────────────────────────────────────────
function nearestIdx(hours, ts) {
  let lo = 0, hi = hours.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (hours[m] <= ts) lo = m; else hi = m; }
  return Math.abs(hours[hi] - ts) < Math.abs(hours[lo] - ts) ? hi : lo;
}
async function seekTs(ts) {
  const fc = store.forecast;
  if (fc && ts > fc.hours[0] - 1800) return seek(STORE_FCST, nearestIdx(fc.hours, ts));
  const ys = store.meta.years;
  const y = Math.min(ys[ys.length - 1], Math.max(ys[0], ltDate(ts).getUTCFullYear()));
  const s = await store.getScalars(y);
  return seek(y, nearestIdx(s.hours_utc, ts));
}
let seekSeq = 0;
async function seek(year, gi) {
  const my = ++seekSeq;
  const f = await store.field(year, gi);
  if (my !== seekSeq) return true;
  st.year = year; st.gi = gi; st.f = f;
  render();
  return true;
}
const scalars = () => store.scalars.get(st.year);

// ── render ──────────────────────────────────────────────────────────────────────────────────────────────────
function render() {
  const f = st.f, s = scalars(), tier = tierOf(st.year);
  st.env = parts ? envelope(parts, f, store.meta.eps_floor || 0) : null;
  if (valley) {
    valley.setField(f.q50);
    const showConf = st.tab === 'where' && st.conf && st.env;
    valley.setConfidence(showConf ? st.env : null);
    valley.setHazeStrength(showConf ? 0.55 : 1);
  } else drawFlat();
  renderCard(f, tier);
  renderTier(tier);
  drawDay(); markYear();
  renderAir(f, s); renderWhere(f); renderWeather(f);
  $('#date').value = isoDay(f.tsUTC);
  writeHash();
}

function episodeNear(ts) { return store.meta.episodes.find((e) => Math.abs(epTs(e) - ts) < 2.5 * 86400); }

function renderCard(f, tier) {
  const d = ltDate(f.tsUTC), m = d.getUTCMonth() + 1;
  $('#c-date').textContent = `${DOW[d.getUTCDay()]} · ${d.getUTCDate()} ${MON[m - 1]} ${d.getUTCFullYear()} · ${SEASON(m)}`;
  $('#c-time').textContent = hhmm(f.tsUTC);
  $('#c-val').textContent = f1(f.basin);
  $('#c-core').textContent = f0(f.core);
  $('#c-rng').textContent = `${f0(f.basin05)}–${f0(f.basin95)}`;
  const X = (x) => Math.min(100, Math.max(0, x / SCALE_MAX * 100));
  $('#c-band').style.left = X(f.basin05) + '%'; $('#c-band').style.width = Math.max(1, X(f.basin95) - X(f.basin05)) + '%';
  $('#c-med').style.left = `calc(${X(f.basin)}% - 1px)`;
  const local = Math.max(f.basin - f.B, 0), pb = Math.min(100, f.B / Math.max(f.B + local, 1e-6) * 100);
  $('#c-sb').style.width = pb + '%'; $('#c-sl').style.width = (100 - pb) + '%';
  $('#c-pb').textContent = Math.round(pb) + '%'; $('#c-pl').textContent = Math.round(100 - pb) + '%';
  $('#c-say').textContent = sentence(f);
  const b = [], env = st.env;
  if (env) b.push(env.w > 0.5 ? 'Shallow mixing · air held in the valley'
    : env.w > 0 ? 'Partly mixed' : `Mixed to ${f0(f.blh)} m`);
  const ep = episodeNear(f.tsUTC);
  if (ep) b.push(`Documented: ${ep.title}`);
  if (tier === 'forecast') b.push(store.kindAt(st.year, st.gi) === 'recent' ? 'Recent analysis' : 'Forecast (demonstration)');
  $('#c-badges').innerHTML = b.map((t) => `<span class="badge">${t}</span>`).join('');
}

// one plain sentence. WHO guidelines are averages over a day or a year, so an hour is compared loosely ("at the level
// of"), never as a breach
function sentence(f) {
  const v = f.basin;
  const lvl = v < 5 ? 'Clean air, below the WHO annual guideline'
    : v < 15 ? 'Fairly clean: under the level of the WHO 24-hour guideline'
    : v < 35 ? 'Above the level of the WHO 24-hour guideline'
    : v < 75 ? 'Polluted: more than twice the level of the WHO 24-hour guideline' : 'Heavily polluted';
  const local = Math.max(v - f.B, 0);
  const why = v < 1 ? '.' : local > f.B ? ', most of it made in the valley.'
    : local > 0.25 * f.B ? ', a regional load plus the valley\'s own.' : ', almost all of it arriving from outside.';
  return lvl + why;
}

function renderTier(tier) {
  const t = $('#tier'), lab = t.querySelector('span');
  t.className = 'badge' + (tier === 'extension' ? ' ext' : tier === 'forecast' ? ' fc' : '');
  lab.textContent = tier === 'anchored' ? 'Anchored year · level scaled to the CEA station'
    : tier === 'extension' ? 'Extension year · level uncertain (reads ~40 % low)' : 'Forecast · demonstration';
}

// ── time bar ────────────────────────────────────────────────────────────────────────────────────────────────
function dayIdx() {
  const s = scalars(), d0 = dayStart(st.f.tsUTC), out = [];
  let i = st.gi; while (i > 0 && s.hours_utc[i - 1] >= d0) i--;
  for (; i < s.hours_utc.length && s.hours_utc[i] < d0 + 86400; i++) out.push(i);
  return out;
}
function drawDay() {
  const s = scalars(), idx = dayIdx(), svg = $('#day-svg'), top = 14;
  if (!idx.length) return;
  // drawn in the element's own pixels so the labels are not stretched
  const W = Math.max(200, svg.clientWidth), H = Math.max(40, svg.clientHeight);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const vals = idx.map((i) => ({ t: s.hours_utc[i], v: s.basin[i], b: s.B[i],
                                  lo: Math.max(s.T05[i], s.B_lo ? s.B_lo[i] : 0), hi: s.T95[i] }));
  const ymax = Math.max(40, ...vals.map((x) => x.hi)) * 1.05;
  const d0 = dayStart(st.f.tsUTC);
  const xs = (t) => (t - d0) / 86400 * W, ys = (p) => H - 2 - Math.max(0, p) / ymax * (H - top - 4);
  const line = (k) => vals.map((x) => `${xs(x.t)},${ys(x[k])}`).join(' ');
  const band = vals.map((x) => `${xs(x.t)},${ys(x.hi)}`).join(' ') + ' '
    + vals.slice().reverse().map((x) => `${xs(x.t)},${ys(x.lo)}`).join(' ');
  const now = xs(st.f.tsUTC), who = ys(15);
  const ticks = [0, 6, 12, 18].map((h) => `<text x="${h / 24 * W + 4}" y="10" fill="rgba(242,233,220,.45)" font-size="10" font-family="Inter">${String(h).padStart(2, '0')}:00</text>`).join('');
  svg.innerHTML = `
    <polygon points="${band}" fill="rgba(242,233,220,.10)"/>
    <line x1="0" x2="${W}" y1="${who}" y2="${who}" stroke="rgba(143,199,178,.5)" stroke-dasharray="2 6" vector-effect="non-scaling-stroke"/>
    ${W < 520 ? '' : `<text x="${W * 0.36}" y="${who - 4}" fill="rgba(143,199,178,.9)" font-size="10" font-family="Inter" paint-order="stroke" stroke="#17140f" stroke-width="3">WHO 24-h guideline · 15</text>`}
    <polyline points="${line('b')}" fill="none" stroke="#b9a88f" stroke-width="1.5" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>
    <polyline points="${line('v')}" fill="none" stroke="#e8a35a" stroke-width="2.4" vector-effect="non-scaling-stroke"/>
    <line x1="${now}" x2="${now}" y1="0" y2="${H}" stroke="#f2e9dc" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    ${ticks}`;
}
function drawYear() {
  if (!daily) return;
  const cv = $('#year-cv'), w = cv.clientWidth, h = 22, dpr = Math.min(devicePixelRatio, 2);
  if (!w) return;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const D = daily.days, n = D.length, bw = w / n;
  D.forEach((d, i) => { ctx.globalAlpha = d[3] === 'extension' ? 0.45 : 1; ctx.fillStyle = pmCss(d[1]); ctx.fillRect(i * bw, 2, Math.ceil(bw) + 0.5, 18); });
  ctx.globalAlpha = 1;
  const lab = $('#year-lab'); lab.innerHTML = '';
  let last = '', firstExt = -1;
  D.forEach((d, i) => {
    const y = isoDay(d[0] + 3600).slice(0, 4);
    if (d[3] === 'extension') { if (firstExt < 0) firstExt = i; return; }
    if (y !== last) { const s = document.createElement('span'); s.className = 'yl'; s.style.left = (i / n * 100) + '%'; s.textContent = y; lab.append(s); last = y; }
  });
  if (firstExt >= 0) {
    const e = document.createElement('span'); e.className = 'ext'; e.style.left = (firstExt / n * 100) + '%';
    e.textContent = innerWidth < 760 ? '2024– · EXTENSION' : '2024 – 2026 · EXTENSION, LEVEL UNCERTAIN'; lab.append(e);
  }
  const m = document.createElement('div'); m.id = 'year-mark';
  Object.assign(m.style, { position: 'absolute', top: '0', width: '2px', height: '24px', background: 'var(--paper)' });
  lab.append(m); markYear();
}
function markYear() {
  const m = $('#year-mark'); if (!m || !daily || !st.f) return;
  const D = daily.days, d0 = dayStart(st.f.tsUTC);
  let i = D.findIndex((d) => d[0] >= d0 - 3600);
  if (i < 0) i = D.length - 1;
  m.style.left = `calc(${i / D.length * 100}% - 1px)`;
}

// ── drawer panes ────────────────────────────────────────────────────────────────────────────────────────────
function renderAir(f, s) {
  const local = Math.max(f.basin - f.B, 0);
  $('#air-b').textContent = `${f1(f.B)} µg/m³`; $('#air-l').textContent = `${f1(local)} µg/m³`;
  const m = ltDate(f.tsUTC).getUTCMonth() + 1;
  const regional = f.B >= 20 ? 'a heavy regional load' : f.B >= 10 ? 'a moderate regional load' : 'fairly clean regional air';
  $('#air-txt').innerHTML = `${SEASON(m)} air brought ${regional} (${f1(f.B)} µg/m³) into the valley. `
    + (local < 0.5 ? 'Right now the valley adds almost nothing on top: the air is well mixed and its own emissions are carried away.'
      : `The valley adds <b>${f1(local)}</b> of its own on top.`);
  const idx = dayIdx(), W = 300, H = 116, d0 = dayStart(f.tsUTC);
  const ymax = Math.max(30, ...idx.map((i) => Math.max(s.basin[i], s.B[i]))) * 1.08;
  const sx = (t) => (t - d0) / 86400 * W, sy = (p) => H - Math.max(0, p) / ymax * (H - 6);
  const bTop = idx.map((i) => `${sx(s.hours_utc[i])},${sy(s.B[i])}`).join(' ');
  const tTop = idx.map((i) => `${sx(s.hours_utc[i])},${sy(Math.max(s.basin[i], s.B[i]))}`).join(' ');
  const bRev = idx.slice().reverse().map((i) => `${sx(s.hours_utc[i])},${sy(s.B[i])}`).join(' ');
  const x0 = sx(s.hours_utc[idx[0]]), x1 = sx(s.hours_utc[idx[idx.length - 1]]), xn = sx(f.tsUTC);
  $('#air-stack').innerHTML = `<polygon points="${x0},${H} ${bTop} ${x1},${H}" fill="#b9a88f" opacity=".75"/>
    <polygon points="${tTop} ${bRev}" fill="#e8a35a" opacity=".85"/>
    <line x1="${xn}" x2="${xn}" y1="0" y2="${H}" stroke="#f2e9dc" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
  const ep = episodeNear(f.tsUTC);
  $('#air-episode').innerHTML = ep ? `<h4>${ep.title}</h4><p>${ep.note}</p><p class="fine">Source: ${ep.source}</p>` : '';
}

function placeCard(nm, sub, lat, lon) {
  const env = st.env, i = cellOf(store.meta.grid, lat, lon), [cls, txt] = verdict(env, i);
  const lo = env.lo[i], hi = env.hi[i], s = (x) => (x > 0 ? '+' : '') + x.toFixed(0);
  const X = (p) => 50 + Math.max(-50, Math.min(50, p / 40 * 50));
  const col = cls === 'up' ? 'var(--accent)' : cls === 'dn' ? 'var(--cool)' : 'rgba(242,233,220,.45)';
  return `<div class="place"><div class="nm">${nm}<small>${sub}</small></div>
    <div class="vd v-${cls}">${txt}</div>
    <div class="rg">${Math.abs(hi - lo) < 1 ? s(lo) + ' %' : s(lo) + ' % to ' + s(hi) + ' %'} against the valley average
      across the plausible maps (or 0 % in an even valley)</div>
    <div class="bar"><u></u><i style="left:${X(lo)}%;width:${Math.max(2, X(hi) - X(lo))}%;background:${col}"></i></div></div>`;
}
function renderWhere(f) {
  const env = st.env;
  if (!env) { $('#w-places').innerHTML = '<p class="fine">The pattern data did not load.</p>'; return; }
  const H = parts.H_ridge_m;
  // H is the model's confinement height (M = 1 + k.w.c, w = (H - BLH)/H), not the ridge height (relief ~850 m)
  $('#w-mix').innerHTML = env.w > 0.5
    ? `The air is mixed only to about <b>${f0(env.blh)} m</b>, well under the ${f0(H)} m below which the model treats the valley as trapped: this is when places can differ most.`
    : env.w > 0 ? `The air is mixed to about <b>${f0(env.blh)} m</b>, a little under the ${f0(H)} m below which the model treats the valley as trapped.`
    : `The air is mixed to about <b>${f0(env.blh)} m</b>, above the ${f0(H)} m below which the model treats the valley as trapped: the plausible maps differ only by the satellite surface, and an even valley is as likely.`;
  $('#w-members').textContent = `${env.members} plausible maps, each with this hour's valley average; a perfectly even valley is also possible.`
    + (tierOf(st.year) !== 'anchored' ? ' In this year the delivered map uses the 2019–2023 typical pattern; the plausible maps are built from this hour\'s mixing.' : '');
  const lm = (n) => store.meta.landmarks.find((x) => x.n === n);
  let html = '';
  if (st.pick) html += placeCard('Your spot', `${st.pick.lat.toFixed(3)}° N, ${st.pick.lon.toFixed(3)}° E`, st.pick.lat, st.pick.lon);
  html += PLACES.map(([n, sub]) => { const m = lm(n); return m ? placeCard(n, sub, m.c[1], m.c[0]) : ''; }).join('');
  $('#w-places').innerHTML = html;
  renderTowns(f);
}
function renderTowns(f) {
  const lm = store.meta.landmarks.filter((m) => m.k !== 'sensor');
  const a = lm.find((m) => m.n === $('#town-a').value), b = lm.find((m) => m.n === $('#town-b').value);
  if (!a || !b) return;
  $('#w-towns').innerHTML = a === b ? '<p class="fine">Choose two different towns.</p>' : townAnswer(a, b, f.basin, spread);
}

function renderWeather(f) {
  const rows = [];
  if (Number.isFinite(f.wspd)) rows.push(['Wind (10 m)', f.wspd < 0.5 ? 'calm' : `${f.wspd.toFixed(1)} m/s from the ${compass(f.wdir)}`]);
  if (Number.isFinite(f.blh)) rows.push(['Mixing height', `${f0(f.blh)} m`]);
  if (Number.isFinite(f.t2m)) rows.push(['Temperature', `${f.t2m.toFixed(1)} °C`]);
  if (Number.isFinite(f.rh)) rows.push(['Humidity', `${f0(f.rh)} %`]);
  if (Number.isFinite(f.rain)) rows.push(['Rain this hour', `${f.rain.toFixed(1)} mm`]);
  $('#wx-kv').innerHTML = rows.length ? rows.map(([k, v]) => `<span>${k}</span><span class="num">${v}</span>`).join('')
    : '<span>No weather is carried for this hour.</span><span></span>';
  const calm = f.wspd < 1.5, shallow = f.blh < (parts ? parts.H_ridge_m : 300);
  $('#wx-txt').textContent = !Number.isFinite(f.blh) ? ''
    : calm && shallow ? 'Light wind under a shallow mixed layer: what the valley emits stays in it.'
    : shallow ? 'A shallow mixed layer: the ridges hold the air in, though the wind moves it along the valley.'
    : 'A deep mixed layer: the valley\'s air is stirred well above the ridges and diluted.';
  $('#wx-cav').textContent = 'Weather from ERA5 (rain from GPM IMERG). ' + (store.meta.wind_note || '');
}

function fillStatic() {
  const lm = store.meta.landmarks.filter((m) => m.k !== 'sensor');
  for (const id of ['#town-a', '#town-b']) $(id).innerHTML = lm.map((m) => `<option>${m.n}</option>`).join('');
  $('#town-a').value = 'Kandy'; $('#town-b').value = 'Peradeniya';
  $('#episodes').innerHTML += store.meta.episodes.map((e) => `<option value="${e.id}">${e.title}</option>`).join('');
  $('#d-tier').textContent = store.meta.tier_note || '';
  $('#d-integrity').textContent = store.meta.integrity || '';
  $('#d-credits').innerHTML = (store.meta.credits || []).map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join('');
  const sc = $('#c-scale');
  for (const w of [15, 35, 75]) {
    const d = document.createElement('span'); d.className = 'who'; d.style.left = (w / SCALE_MAX * 100) + '%'; d.textContent = w; sc.append(d);
  }
  $('#date').min = `${store.meta.years[0]}-01-01`;
}

// ── interaction ─────────────────────────────────────────────────────────────────────────────────────────────
function setTab(tab) {
  st.tab = tab;
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $$('.pane').forEach((p) => p.classList.toggle('on', p.id === `p-${tab}`));
  if (st.f) render();
}
function pick(lat, lon) {
  st.pick = { lat, lon };
  if (valley) valley.setPin(lat, lon);
  if (st.tab !== 'where') setTab('where'); else render();
}
async function stepHour(k) {
  const s = scalars(), gi = st.gi + k;
  if (gi >= 0 && gi < s.hours_utc.length) return seek(st.year, gi);
  if (st.year === STORE_FCST) return play(false);
  const ys = store.meta.years, yi = ys.indexOf(st.year) + Math.sign(k);
  if (yi < 0 || yi >= ys.length) return play(false);
  const s2 = await store.getScalars(ys[yi]);
  return seek(ys[yi], k > 0 ? 0 : s2.hours_utc.length - 1);
}
function play(on) {
  st.playing = on; $('#play').textContent = on ? '❚❚' : '▶'; $('#play').setAttribute('aria-label', on ? 'Pause' : 'Play the day');
  clearInterval(st.timer);
  if (on) st.timer = setInterval(() => stepHour(1), 900);
}
async function goLatest() {
  $('#latest').disabled = true;
  try { if (!store.forecast) await store.initForecast(); } catch (e) { console.warn('forecast tier off:', e); }
  $('#latest').disabled = false;
  if (store.forecast) {
    const h = store.forecast.hours, now = Date.now() / 1000;
    return seek(STORE_FCST, nearestIdx(h, Math.min(Math.max(now, h[0]), h[h.length - 1])));
  }
  const ys = store.meta.years, s = await store.getScalars(ys[ys.length - 1]);
  return seek(ys[ys.length - 1], s.hours_utc.length - 1);
}
function wire() {
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $$('.navb[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('#w-conf').addEventListener('change', (e) => { st.conf = e.target.checked; render(); });
  $('#town-a').addEventListener('change', () => renderTowns(st.f));
  $('#town-b').addEventListener('change', () => renderTowns(st.f));
  $('#play').addEventListener('click', () => play(!st.playing));
  $('#prev-day').addEventListener('click', () => seekTs(st.f.tsUTC - 86400));
  $('#next-day').addEventListener('click', () => seekTs(st.f.tsUTC + 86400));
  $('#date').addEventListener('change', (e) => {
    if (!e.target.value) return;
    seekTs(Date.parse(e.target.value + 'T00:00:00Z') / 1000 - LT + ltDate(st.f.tsUTC).getUTCHours() * 3600 + 1800);
  });
  $('#episodes').addEventListener('change', (e) => {
    const ep = store.meta.episodes.find((x) => x.id === e.target.value);
    if (ep) seekTs(epTs(ep));
    e.target.value = '';
  });
  $('#latest').addEventListener('click', goLatest);
  $('#day').addEventListener('click', (e) => {
    const b = e.currentTarget.getBoundingClientRect(), fr = (e.clientX - b.left) / b.width;
    seekTs(dayStart(st.f.tsUTC) + Math.min(23, Math.floor(fr * 24)) * 3600 + 1800);
  });
  $('#year').addEventListener('click', (e) => {
    if (!daily) return;
    const b = e.currentTarget.getBoundingClientRect(), D = daily.days;
    const d = D[Math.min(D.length - 1, Math.max(0, Math.floor((e.clientX - b.left) / b.width * D.length)))];
    seekTs(d[0] + ltDate(st.f.tsUTC).getUTCHours() * 3600 + 1800);
  });
  $('#open-about').addEventListener('click', () => $('#about').classList.add('on'));
  $('#close-about').addEventListener('click', () => $('#about').classList.remove('on'));
  $('#about').addEventListener('click', (e) => { if (e.target.id === 'about') $('#about').classList.remove('on'); });
  addEventListener('keydown', (e) => {
    const tg = e.target;
    if (tg && tg.matches && tg.matches('input, select, textarea')) return;
    if (e.key === 'Escape') $('#about').classList.remove('on');
    else if (e.key === 'ArrowRight') stepHour(1);
    else if (e.key === 'ArrowLeft') stepHour(-1);
    else if (e.key === ' ' && !(tg && tg.matches && tg.matches('button'))) { e.preventDefault(); play(!st.playing); }
  });
  $('#dl-field').addEventListener('click', () => downloadFieldCSV(store, st.f, CITY));
  $('#dl-point').addEventListener('click', () => {
    const p = st.pick || CITY.core;
    downloadPointCSV(store, st.f, p.lat, p.lon, CITY);
  });
  $('#dl-png').addEventListener('click', downloadView);
  $('#copy-link').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); $('#copy-link').textContent = 'Link copied'; }
    catch { $('#copy-link').textContent = 'Copy the address bar'; }
    setTimeout(() => { $('#copy-link').textContent = 'Copy a link to this hour'; }, 1800);
  });
}

function downloadView() {
  const src = valley ? valley.snapshot() : flatCv, W = src.width, H = src.height;
  const out = document.createElement('canvas'); out.width = W; out.height = H + Math.round(H / 14);
  const c = out.getContext('2d');
  c.fillStyle = '#0f0d0b'; c.fillRect(0, 0, out.width, out.height); c.drawImage(src, 0, 0);
  const f = st.f, lt = ltDate(f.tsUTC).toISOString().slice(0, 16).replace('T', ' ');
  c.fillStyle = '#f2e9dc'; c.font = `${Math.round(H / 42)}px Inter, sans-serif`;
  c.fillText(`Kandy PM2.5 · ${lt} Sri Lanka time · valley average ${f1(f.basin)} µg/m³ (90 % range ${f0(f.basin05)}–${f0(f.basin95)})`, 16, H + H / 34);
  c.fillStyle = 'rgba(242,233,220,.6)'; c.font = `${Math.round(H / 60)}px Inter, sans-serif`;
  c.fillText('Research reconstruction. Level scaled to the CEA Kandy station; the within-valley pattern is physics, not measured.', 16, H + H / 17);
  const a = document.createElement('a'); a.href = out.toDataURL('image/png');
  a.download = `${CITY.downloadPrefix}_${lt.replace(/[: ]/g, '')}.png`; a.click();
}

// ── 2-D fallback (no WebGL): the 16x16 field drawn smooth, with the town names ─────────────────────────────
function drawFlat() {
  const cv = flatCv, w = innerWidth, h = innerWidth < 760 ? Math.max(300, innerHeight * 0.52) : innerHeight;
  const dpr = Math.min(devicePixelRatio, 2); cv.width = w * dpr; cv.height = h * dpr;
  cv.style.width = w + 'px'; cv.style.height = h + 'px';
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0f0d0b'; ctx.fillRect(0, 0, w, h);
  const g = store.meta.grid, side = Math.min(w, h) * 0.86, x0 = (w - side) / 2, y0 = (h - side) / 2;
  const tmp = document.createElement('canvas'); tmp.width = g.n_lon; tmp.height = g.n_lat;
  const tc = tmp.getContext('2d'), im = tc.createImageData(g.n_lon, g.n_lat);
  for (let r = 0; r < g.n_lat; r++) for (let c = 0; c < g.n_lon; c++) {
    const [rgb, a] = pmColour(st.f.q50[r * g.n_lon + c]), o = ((g.n_lat - 1 - r) * g.n_lon + c) * 4;
    im.data.set([rgb[0], rgb[1], rgb[2], 80 + 175 * a], o);
  }
  tc.putImageData(im, 0, 0);
  ctx.imageSmoothingEnabled = true;
  if (store.static.hillshade) { ctx.globalAlpha = 0.55; ctx.drawImage(store.static.hillshade, x0, y0, side, side); ctx.globalAlpha = 1; }
  ctx.drawImage(tmp, x0, y0, side, side);
  const env = st.env;
  if (st.tab === 'where' && st.conf && env) {            // the same agreement colours as the 3-D overlay
    const oc = tc.createImageData(g.n_lon, g.n_lat);
    for (let r = 0; r < g.n_lat; r++) for (let c = 0; c < g.n_lon; c++) {
      const i = r * g.n_lon + c, o = ((g.n_lat - 1 - r) * g.n_lon + c) * 4;
      const u = Math.max(0, (env.up[i] - 0.85) / 0.15), d = Math.max(0, (env.dn[i] - 0.85) / 0.15);
      const m = Math.min(1, Math.max(0, (Math.abs(env.mag[i]) - 3) / 10));
      oc.data.set(u >= d ? [232, 163, 90] : [143, 199, 178], o); oc.data[o + 3] = 200 * Math.max(u, d) * m;
    }
    tc.putImageData(oc, 0, 0); ctx.drawImage(tmp, x0, y0, side, side);
  }
  cv._geo = { x0, y0, side };
  const [lo0, la0, lo1, la1] = g.bbox;
  ctx.font = '12px Inter, sans-serif'; ctx.fillStyle = '#f2e9dc';
  for (const m of store.meta.landmarks.filter((x) => x.k !== 'sensor')) {
    const x = x0 + (m.c[0] - lo0) / (lo1 - lo0) * side, y = y0 + (1 - (m.c[1] - la0) / (la1 - la0)) * side;
    ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 7); ctx.fill(); ctx.fillText(m.n, x + 6, y + 4);
  }
}
function flatPick(e) {
  const gg = flatCv._geo, b = flatCv.getBoundingClientRect(), [lo0, la0, lo1, la1] = store.meta.grid.bbox;
  const u = (e.clientX - b.left - gg.x0) / gg.side, v = 1 - (e.clientY - b.top - gg.y0) / gg.side;
  if (u >= 0 && u <= 1 && v >= 0 && v <= 1) pick(la0 + v * (la1 - la0), lo0 + u * (lo1 - lo0));
}

// ── links: #t=<UTC seconds>&tab=air|where|weather|data&p=lat,lon (v2's #sheet=when|where|data still opens) ─
let writing = false;
function writeHash() {
  const p = new URLSearchParams();
  p.set('t', String(st.f.tsUTC));
  if (st.tab !== 'air') p.set('tab', st.tab);
  if (st.pick) p.set('p', `${st.pick.lat.toFixed(4)},${st.pick.lon.toFixed(4)}`);
  const h = `#${p}`;
  if (h === location.hash) return;
  writing = true; history.replaceState(null, '', h); setTimeout(() => { writing = false; }, 0);
}
async function restoreFromHash() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));
  const tab = p.get('tab') || ({ when: 'air', where: 'where', data: 'data' })[p.get('sheet')];
  if (['air', 'where', 'weather', 'data'].includes(tab)) setTab(tab);
  const pp = (p.get('p') || '').split(',').map(Number);
  if (pp.length === 2 && pp.every(Number.isFinite)) { st.pick = { lat: pp[0], lon: pp[1] }; if (valley) valley.setPin(pp[0], pp[1]); }
  const t = Number(p.get('t'));
  if (!p.get('t') || !Number.isFinite(t)) return false;
  // a link past the end of the record points into the forecast tier, which loads on demand
  const lastDay = daily ? daily.days[daily.days.length - 1][0] : Infinity;
  if (t > lastDay + 86400 && !store.forecast) { try { await store.initForecast(); } catch { /* tier off */ } }
  return seekTs(t);
}

boot().catch((err) => {
  console.error(err);
  const l = $('#loading'); if (l) l.innerHTML = `<p class="err">The data could not be loaded: ${err.message}</p>`;
});
