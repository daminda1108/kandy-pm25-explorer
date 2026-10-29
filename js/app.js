// app.js — Kandy Air, design A "The Valley", minimal pass (2026-10-29). The map is the page. Over it: the hour in a
// few lines of type (top left), three quiet tools (top right), a slim time strip (bottom), the colour key with the
// contrast-stretch label (bottom left), and a point card that follows its pin. Everything else sits in Details, closed
// by default. The engine (store.js) is unchanged: every number comes from store.field() exactly as the QA gate checks.
// History: v2 "the valley breathes" is git tag v2-valley-breathes; build record kandy_pm25/docs/webapp_A_build_plan_2026-10-29.md.
import { $, $$, getJSON, compass } from './util.js?v=1793254900';
import { activeCity } from './cities.js?v=1793254900';
import { Store, STORE_FCST } from './store.js?v=1793254900';
import { downloadFieldCSV, downloadPointCSV } from './download.js?v=1793254900';
import { Valley, webglOK, pmCss, pmColour } from './valley.js?v=1793254900';
import { envelope, verdict, cellOf, km, townAnswer } from './where.js?v=1793254900';

const CITY = activeCity();
const LT = CITY.tzOffsetH * 3600;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Sri Lanka's monsoon calendar (Department of Meteorology)
const SEASON = (m) => (m === 12 || m <= 2 ? 'North-east monsoon' : m <= 4 ? 'First inter-monsoon'
  : m <= 9 ? 'South-west monsoon' : 'Second inter-monsoon');
const PLACES = ['Kandy', 'Katugastota', 'Peradeniya', 'Halloluwa', 'Ampitiya'];
const SCALE_MAX = 90;
// Differences across the valley are drawn STRETCH times stronger in colour (never in numbers). The model's contrasts
// are a few per cent to about a fifth (stagnant floor vs ridges, +16 % median at rush hours); x4 makes them readable.
const STRETCH = 4;

const store = new Store(CITY);
const st = { year: null, gi: 0, f: null, tab: 'air', drawer: false, conf: false, trueScale: false, pick: null,
             playing: false, timer: null, env: null, roads: true, water: true, urban: false, weather: false, cardAt: null };
let valley = null, parts = null, daily = null, spread = null, flatCv = null, roads = null, hydro = null, ELEV = null;
let built = null, floorElev = 480;

const ltDate = (ts) => new Date((ts + LT) * 1000);
const hhmm = (ts) => { const d = ltDate(ts); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const dayStart = (ts) => Math.floor((ts + LT) / 86400) * 86400 - LT;      // UTC seconds of local midnight
const isoDay = (ts) => ltDate(ts).toISOString().slice(0, 10);
const epTs = (e) => Date.parse(e.ts.replace(' ', 'T') + ':00Z') / 1000 - LT + 1800;   // episode stamps are local, hourly at :30
const tierOf = (y) => (y === STORE_FCST ? 'forecast' : ((store.meta.tiers || {}).extension || []).includes(y) ? 'extension' : 'anchored');
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '–');
const f0 = (x) => (Number.isFinite(x) ? Math.round(x).toString() : '–');
const sg = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(0)} %`;
const stretch = () => (st.trueScale ? 1 : STRETCH);

// ── boot ────────────────────────────────────────────────────────────────────────────────────────────────────
async function boot() {
  await store.init({ extras: false });
  // start the opening hour's data at once, in parallel with the static files (it is the largest first-load item)
  const t0 = Number(new URLSearchParams(location.hash.replace(/^#/, '')).get('t'));
  const y0 = Number.isFinite(t0) && t0 > 0 ? ltDate(t0).getUTCFullYear() : 2022;
  if (store.meta.years.includes(y0)) store.getScalars(y0).catch(() => {});
  let terrain;
  [terrain, parts, daily, spread] = await Promise.all(['terrain3d', 'pattern_parts', 'daily', 'spatial_spread']
    .map((k) => getJSON(`${store.base}/static/${k}.json`).catch(() => null)));
  ELEV = store.static.fields.elev.flat();
  if (terrain) {                                   // median elevation of the valley floor (cells below 520 m): base of the lid
    const fl = terrain.elev.filter((e) => e < 520).sort((a, b) => a - b);
    if (fl.length) floorElev = fl[Math.floor(fl.length / 2)];
  }
  if (terrain && webglOK()) {
    valley = new Valley($('#scene'), { terrain, meta: store.meta, grid: store.meta.grid,
                                       camera: innerWidth < 760 ? 'phone' : 'wide', onPick: (la, lo) => pick(la, lo) });
    valley.followPin(placePoint);
    valley.hover(showTip);
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
  loadLayers();
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
  const slow = setTimeout(() => { $('#busy').hidden = false; }, 150);     // only when it has to wait on the network
  let f;
  try { f = await store.field(year, gi); } finally { clearTimeout(slow); if (my === seekSeq) $('#busy').hidden = true; }
  if (my !== seekSeq) return true;
  st.year = year; st.gi = gi; st.f = f;
  render();
  prefetch(year, gi);
  return true;
}
// warm the next month (and the next year's file at year end) while the user looks at this one
function prefetch(year, gi) {
  const s = scalars(); if (!s || year === STORE_FCST) return;
  const ahead = Math.min(gi + 72, s.hours_utc.length - 1);
  if (ahead !== gi) (window.requestIdleCallback || setTimeout)(() => store.field(year, ahead).catch(() => {}));
  if (gi > s.hours_utc.length - 24 * 4) { const ys = store.meta.years, i = ys.indexOf(year); if (ys[i + 1]) store.getScalars(ys[i + 1]).catch(() => {}); }
}
const scalars = () => store.scalars.get(st.year);

// ── render ──────────────────────────────────────────────────────────────────────────────────────────────────
function render() {
  const f = st.f;
  st.env = parts ? envelope(parts, f, store.meta.eps_floor || 0) : null;
  if (valley) {
    valley.setStretch(stretch());
    valley.setField(f.q50);
    valley.setConfidence(st.conf && st.env ? st.env : null);
    valley.setHazeStrength(st.conf ? 0.6 : 1);
  } else drawFlat();
  renderWeather3d(f);
  renderNow(f);
  renderKey(f);
  drawDay(); markYear();
  renderPoint(f);
  if (st.drawer) renderDrawer(f);
  $('#date').value = isoDay(f.tsUTC);
  writeHash();
}

function renderNow(f) {
  const d = ltDate(f.tsUTC), m = d.getUTCMonth() + 1, tier = tierOf(st.year);
  $('#c-date').textContent = `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[m - 1]} ${d.getUTCFullYear()} · ${SEASON(m)}`;
  $('#c-time').textContent = hhmm(f.tsUTC);
  $('#c-val').textContent = f1(f.basin);
  $('#c-rng').textContent = `${f0(f.basin05)}–${f0(f.basin95)}`;
  const X = (x) => Math.min(100, Math.max(0, x / SCALE_MAX * 100));
  $('#c-band').style.left = X(f.basin05) + '%'; $('#c-band').style.width = Math.max(1, X(f.basin95) - X(f.basin05)) + '%';
  $('#c-med').style.left = `calc(${X(f.basin)}% - 1px)`;
  $('#c-say').textContent = sentence(f);
  $('#tier').textContent = tier === 'anchored' ? 'anchored year'
    : tier === 'extension' ? 'extension year, level uncertain'
    : store.kindAt(st.year, st.gi) === 'recent' ? 'latest analysis' : 'forecast (demonstration)';
}

// one plain sentence: level against WHO values (compared loosely, guidelines are averages) and why the hour looks so
function sentence(f) {
  const v = f.basin, env = st.env;
  const lvl = v < 5 ? 'Clean air' : v < 15 ? 'Fairly clean air' : v < 35 ? 'Above the WHO daily guideline'
    : v < 75 ? 'Polluted, over twice the WHO daily guideline' : 'Heavily polluted';
  const held = env && env.w > 0.5 ? 'air held low in the valley' : env && env.w > 0 ? 'air partly held in the valley'
    : 'air well mixed above the ridges';
  return `${lvl}; ${held}.`;
}

// the key under the colour ramp: what the colours mean and how much the contrast is stretched
function renderKey(f) {
  let a = 0, na = 0, b = 0, nb = 0;
  const qs = [...ELEV].sort((x, y) => x - y), lo = qs[Math.floor(qs.length * 0.25)], hi = qs[Math.floor(qs.length * 0.75)];
  f.q50.forEach((v, i) => { v = Math.max(v, 0); if (ELEV[i] <= lo) { a += v; na++; } else if (ELEV[i] >= hi) { b += v; nb++; } });
  const pf = b > 0 ? (a / na / (b / nb) - 1) * 100 : 0;
  $('#k-stretch').innerHTML = st.trueScale
    ? `True colour scale · floor ${sg(pf)} vs ridges this hour · <u>stretch ×${STRETCH}</u>`
    : `Differences across the valley drawn ×${STRETCH} · floor ${sg(pf)} vs ridges this hour · <u>true scale</u>`;
}

// ── hover readout (mouse): value and departure under the cursor ─────────────────────────────────────────────
function showTip(h) {
  const tip = $('#tip');
  if (!h || !st.f) { tip.hidden = true; return; }
  const i = cellOf(store.meta.grid, h.lat, h.lon), v = Math.max(st.f.q50[i], 0);
  const rel = st.f.basin > 0.5 ? (v / st.f.basin - 1) * 100 : 0, np = nearestPlace(h.lat, h.lon);
  tip.innerHTML = `${np.d < 1.2 ? np.m.n + ' · ' : ''}<b>${f0(v)}</b> µg/m³ · ${sg(rel)} · ${f0(ELEV[i])} m`;
  tip.hidden = false;
  tip.style.transform = `translate(${Math.min(h.x + 14, innerWidth - tip.offsetWidth - 8)}px, ${h.y + 16}px)`;
}

// ── point card ──────────────────────────────────────────────────────────────────────────────────────────────
function nearestPlace(lat, lon) {
  let best = null, bd = Infinity;
  for (const m of store.meta.landmarks) if (m.k !== 'sensor') { const d = km(m.c, [lon, lat]); if (d < bd) { bd = d; best = m; } }
  return { m: best, d: bd };
}
function placePoint(x, y) {                      // keep the card beside its pin and on screen
  const el = $('#point'); if (el.hidden) return;
  if (innerWidth < 760) { el.style.transform = ''; return; }   // phone: docked above the time strip (CSS)
  if (st.cardAt) { el.style.transform = `translate(${st.cardAt[0]}px, ${st.cardAt[1]}px)`; return; }
  const w = el.offsetWidth, h = el.offsetHeight;
  let px = x + 16, py = y - 24;
  if (px + w > innerWidth - 12) px = Math.max(12, x - w - 16);
  py = Math.max(56, Math.min(py, innerHeight - h - 90));
  el.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px)`;
}
let sparkKey = '';
async function renderPoint(f) {
  const el = $('#point');
  if (!st.pick) { el.hidden = true; return; }
  el.hidden = false;
  const { lat, lon } = st.pick, i = cellOf(store.meta.grid, lat, lon), np = nearestPlace(lat, lon);
  $('#pt-name').textContent = np.d < 0.8 ? np.m.n : np.d < 2.5 ? `Near ${np.m.n}` : `${lat.toFixed(3)}° N, ${lon.toFixed(3)}° E`;
  const v = Math.max(f.q50[i], 0), rel = f.basin > 0.5 ? (v / f.basin - 1) * 100 : 0;
  $('#pt-val').textContent = f1(v);
  const r = $('#pt-rel'); r.textContent = `${sg(rel)} vs valley`; r.className = 'pr ' + (rel > 2 ? 'up' : rel < -2 ? 'dn' : 'q');
  $('#pt-sub').textContent = `${f0(ELEV[i])} m · likely ${f0(Math.min(f.q05[i], v))}–${f0(Math.max(f.q95[i], v))}`
    + (built ? ` · ${f0(builtAt(lat, lon))} % built` : '');
  if (st.env) {
    const [cls, txt] = verdict(st.env, i);
    $('#pt-verdict').textContent = cls === 'up' ? 'Plausible maps: above average' : cls === 'dn' ? 'Plausible maps: below average'
      : txt.startsWith('About') ? 'Plausible maps: about average' : 'Plausible maps disagree';
    $('#pt-verdict').title = txt;
  }
  if (!flatCv && valley && valley.pinP == null) valley.setPin(lat, lon);
  if (flatCv) { const g = flatCv._geo, [lo0, la0, lo1, la1] = store.meta.grid.bbox;
    if (g) placePoint(g.x0 + (lon - lo0) / (lo1 - lo0) * g.side, g.y0 + (1 - (lat - la0) / (la1 - la0)) * g.side); }
  // this spot through the local day, against the valley average (dashed)
  const s = scalars(), d0 = dayStart(f.tsUTC), key = `${st.year}|${d0}|${i}`;
  const draw = (pts) => {
    const svg = $('#pt-spark'), W = svg.clientWidth || 180, H = 30; svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const ym = Math.max(20, ...pts.map((p) => Math.max(p.v, p.b))) * 1.08;
    const X = (t) => (t - d0) / 86400 * W, Y = (u) => H - 2 - u / ym * (H - 6);
    const L = (k) => pts.map((p) => `${X(p.t).toFixed(1)},${Y(p[k]).toFixed(1)}`).join(' ');
    svg.innerHTML = `<polyline points="${L('b')}" fill="none" stroke="rgba(242,233,220,.45)" stroke-dasharray="3 3"/>
      <polyline points="${L('v')}" fill="none" stroke="${pmCss(v)}" stroke-width="2"/>
      <line x1="${X(f.tsUTC)}" x2="${X(f.tsUTC)}" y1="0" y2="${H}" stroke="#f2e9dc" stroke-width="1"/>`;
  };
  if (key === sparkKey && renderPoint.cache) { draw(renderPoint.cache); return; }
  sparkKey = key;
  const pts = [];
  for (const gi of dayIdx()) {
    const g = await store.field(st.year, gi);
    pts.push({ t: s.hours_utc[gi], v: Math.max(g.q50[i], 0), b: g.basin });
  }
  if (sparkKey !== key) return;
  renderPoint.cache = pts; draw(pts);
}

// ── time strip ──────────────────────────────────────────────────────────────────────────────────────────────
function dayIdx() {
  const s = scalars(), d0 = dayStart(st.f.tsUTC), out = [];
  let i = st.gi; while (i > 0 && s.hours_utc[i - 1] >= d0) i--;
  for (; i < s.hours_utc.length && s.hours_utc[i] < d0 + 86400; i++) out.push(i);
  return out;
}
function drawDay() {
  const s = scalars(), idx = dayIdx(), svg = $('#day-svg');
  if (!idx.length) return;
  const W = Math.max(200, svg.clientWidth), H = Math.max(30, svg.clientHeight);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const vals = idx.map((i) => ({ t: s.hours_utc[i], v: s.basin[i], lo: Math.max(s.T05[i], s.B_lo ? s.B_lo[i] : 0), hi: s.T95[i] }));
  const ymax = Math.max(40, ...vals.map((x) => x.hi)) * 1.05, d0 = dayStart(st.f.tsUTC);
  const xs = (t) => (t - d0) / 86400 * W, ys = (p) => H - 1 - Math.max(0, p) / ymax * (H - 12);
  const band = vals.map((x) => `${xs(x.t)},${ys(x.hi)}`).join(' ') + ' ' + vals.slice().reverse().map((x) => `${xs(x.t)},${ys(x.lo)}`).join(' ');
  const bars = vals.map((x) => `<rect x="${xs(x.t) - W / 48 + 1}" y="${ys(x.v)}" width="${W / 24 - 2}" height="${H - 1 - ys(x.v)}" rx="1.5" fill="${pmCss(x.v)}" opacity="${x.t === st.f.tsUTC ? 1 : 0.55}"/>`).join('');
  const ticks = [0, 6, 12, 18].map((h) => `<text x="${h / 24 * W + 2}" y="8" fill="rgba(242,233,220,.4)" font-size="9" font-family="Inter">${String(h).padStart(2, '0')}</text>`).join('');
  svg.innerHTML = `<polygon points="${band}" fill="rgba(242,233,220,.07)"/>${bars}
    <line x1="0" x2="${W}" y1="${ys(15)}" y2="${ys(15)}" stroke="rgba(143,199,178,.55)" stroke-dasharray="2 5"/>${ticks}`;
}
function drawYear() {
  if (!daily) return;
  const cv = $('#year-cv'), w = cv.clientWidth, h = 6, dpr = Math.min(devicePixelRatio, 2);
  if (!w) return;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const D = daily.days, n = D.length, bw = w / n;
  D.forEach((d, i) => { ctx.globalAlpha = d[3] === 'extension' ? 0.4 : 1; ctx.fillStyle = pmCss(d[1]); ctx.fillRect(i * bw, 0, Math.ceil(bw) + 0.5, h); });
  ctx.globalAlpha = 1;
  const lab = $('#year-lab'); lab.innerHTML = '';
  let last = '';
  D.forEach((d, i) => {
    const y = isoDay(d[0] + 3600).slice(0, 4);
    if (y !== last) { const s = document.createElement('span'); s.className = 'yl'; s.style.left = (i / n * 100) + '%'; s.textContent = y; lab.append(s); last = y; }
  });
  const m = document.createElement('div'); m.id = 'year-mark';
  Object.assign(m.style, { position: 'absolute', top: '-3px', width: '2px', height: '12px', background: 'var(--paper)', borderRadius: '1px' });
  lab.append(m); markYear();
}
function markYear() {
  const m = $('#year-mark'); if (!m || !daily || !st.f) return;
  const D = daily.days, d0 = dayStart(st.f.tsUTC);
  let i = D.findIndex((d) => d[0] >= d0 - 3600);
  if (i < 0) i = D.length - 1;
  m.style.left = `calc(${i / D.length * 100}% - 1px)`;
}

// ── details drawer ──────────────────────────────────────────────────────────────────────────────────────────
function renderDrawer(f) {
  const s = scalars();
  if (st.tab === 'air') renderAir(f, s);
  else if (st.tab === 'where') renderWhere(f);
  else if (st.tab === 'weather') renderWeather(f);
}
function renderAir(f, s) {
  const local = Math.max(f.basin - f.B, 0), pb = Math.min(100, f.B / Math.max(f.B + local, 1e-6) * 100);
  $('#c-sb').style.width = pb + '%'; $('#c-sl').style.width = (100 - pb) + '%';
  $('#c-pb').textContent = Math.round(pb) + '%'; $('#c-pl').textContent = Math.round(100 - pb) + '%';
  const m = ltDate(f.tsUTC).getUTCMonth() + 1;
  const regional = f.B >= 20 ? 'a heavy regional load' : f.B >= 10 ? 'a moderate regional load' : 'fairly clean regional air';
  $('#air-txt').innerHTML = `${SEASON(m)} air brought ${regional} (<b>${f1(f.B)}</b> µg/m³) into the valley; `
    + (local < 0.5 ? 'the valley adds almost nothing on top this hour.' : `the valley adds <b>${f1(local)}</b> of its own.`);
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
  const ep = store.meta.episodes.find((e) => Math.abs(epTs(e) - f.tsUTC) < 2.5 * 86400);
  $('#air-episode').innerHTML = ep ? `<h4>${ep.title}</h4><p>${ep.note}</p><p class="fine">Source: ${ep.source}</p>` : '';
}
function renderWhere(f) {
  const env = st.env;
  if (!env) { $('#w-places').innerHTML = '<p class="fine">The pattern data did not load.</p>'; return; }
  $('#w-mix').innerHTML = env.w > 0.5
    ? `The air is mixed only to about <b>${f0(env.blh)} m</b> and held in the valley: this is when places differ most.`
    : env.w > 0 ? `The air is mixed to about <b>${f0(env.blh)} m</b>, partly held in the valley.`
    : `The air is mixed to about <b>${f0(env.blh)} m</b>, above the ridges: places differ little this hour.`;
  $('#w-members').textContent = `So each place is also checked against ${env.members} plausible maps with the same valley `
    + 'average; "every map" below means all of them agree.'
    + (tierOf(st.year) !== 'anchored' ? ' This year uses the 2019–2023 typical pattern.' : '');
  $('#w-places').innerHTML = PLACES.map((n) => {
    const m = store.meta.landmarks.find((x) => x.n === n); if (!m) return '';
    const i = cellOf(store.meta.grid, m.c[1], m.c[0]), [cls, txt] = verdict(env, i);
    const rel = f.basin > 0.5 ? (Math.max(f.q50[i], 0) / f.basin - 1) * 100 : 0;
    return `<div class="place"><div class="nm">${n}</div><div class="vd v-${cls}">${sg(rel)}</div>
      <div class="rg">${txt}</div></div>`;
  }).join('');
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
  $('#episodes').innerHTML = store.meta.episodes.map((e) => `<button class="chip" data-ep="${e.id}">${e.title}</button>`).join('');
  $('#d-tier').textContent = store.meta.tier_note || '';
  $('#d-integrity').textContent = store.meta.integrity || '';
  $('#d-credits').innerHTML = (store.meta.credits || []).map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join('');
  // key ticks at their true places on the 0-90 ramp
  const kt = $('.kt'); kt.style.position = 'relative'; kt.style.height = '12px';
  kt.innerHTML = [5, 15, 35, 75].map((w) => `<span style="position:absolute;left:${w / SCALE_MAX * 100}%;transform:translateX(-50%)">${w}</span>`).join('')
    + '<span style="position:absolute;right:0">µg/m³</span>';
  $('#date').min = `${store.meta.years[0]}-01-01`;
}

// ── interaction ─────────────────────────────────────────────────────────────────────────────────────────────
function openDrawer(on, tab) {
  st.drawer = on; if (tab) st.tab = tab;
  $('#drawer').hidden = !on; $('#open-details').setAttribute('aria-expanded', String(on));
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === st.tab)));
  $$('.pane').forEach((p) => p.classList.toggle('on', p.id === `p-${st.tab}`));
  if (on && st.f) renderDrawer(st.f);
  if (st.f) writeHash();
}
function pick(lat, lon) {
  st.pick = { lat, lon }; sparkKey = ''; st.cardAt = null;
  if (valley) valley.setPin(lat, lon);
  if (st.f) render();
}
function unpick() { st.pick = null; if (valley) valley.setPin(null); $('#point').hidden = true; if (flatCv) drawFlat(); writeHash(); }
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
  clearTimeout(st.timer);
  // chained, not an interval: the next hour starts only after this one is drawn, so slow loads never pile up
  const tick = async () => { if (!st.playing) return; await stepHour(1); if (st.playing) st.timer = setTimeout(tick, 700); };
  if (on) st.timer = setTimeout(tick, 250);
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
function tipAt(e, html) {
  const tip = $('#tip'); tip.innerHTML = html; tip.hidden = false;
  tip.style.transform = `translate(${Math.max(8, Math.min(e.clientX - tip.offsetWidth / 2, innerWidth - tip.offsetWidth - 8))}px, ${e.clientY - 34}px)`;
}

// ── layers: urban development and weather ─────────────────────────────────────────────────────────────────
async function setUrban(on) {
  st.urban = on; $('#urban-tg').checked = on; $('#k-urban').hidden = !on;
  if (on && !built) {
    built = await getJSON(`${store.base}/static/built.json`).catch(() => null);
    if (valley && built) valley.setBuilt(built);
  }
  if (valley) valley.showBuilt(on); else if (st.f) drawFlat();
  if (st.f) { renderPoint(st.f); writeHash(); }
}
function builtAt(lat, lon) {
  const n = built.n, r = Math.round((lat - built.lat0) / (built.lat1 - built.lat0) * (n - 1));
  const c = Math.round((lon - built.lon0) / (built.lon1 - built.lon0) * (n - 1));
  return r >= 0 && r < n && c >= 0 && c < n ? built.pct[r * n + c] : NaN;
}
let wxSeq = 0, wxWind = null;
async function renderWeather3d(f) {
  $('#k-wx').hidden = !st.weather;
  if (!st.weather) { if (valley) valley.showWeather(false); return; }
  const my = ++wxSeq, wind = await store.windField(st.year, st.gi).catch(() => null);
  if (my !== wxSeq) return;
  wxWind = wind;
  if (valley) { valley.setWeather({ wind, rain: f.rain, blh: f.blh, floorElev }); valley.showWeather(true); }
  else drawFlat();
  const bits = [];
  if (Number.isFinite(f.wspd)) bits.push(f.wspd < 0.5 ? 'calm' : `wind ${f.wspd.toFixed(1)} m/s from the ${compass(f.wdir)}`);
  bits.push(Number.isFinite(f.rain) ? (f.rain >= 0.1 ? `rain ${f.rain.toFixed(1)} mm this hour` : 'no rain') : 'rain not carried');
  if (Number.isFinite(f.blh)) bits.push(`air mixed to ${f0(f.blh)} m (the lid)`);
  $('#k-wx').textContent = bits.join(' · ') + (wind ? '' : ' · no wind field for this hour');
}
function setWeather(on) { st.weather = on; $('#wx-tg').checked = on; if (st.f) { renderWeather3d(st.f); writeHash(); } }

// the point card can be dragged by its title; it then stays where it is put until closed or a new spot is chosen
function wireDrag() {
  const el = $('#point'), h = $('#pt-drag');
  let start = null;
  h.addEventListener('pointerdown', (e) => {
    if (innerWidth < 760 || e.target.closest('.x')) return;
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(el.style.transform) || [0, 0, 0];
    start = [e.clientX, e.clientY, +m[1], +m[2]]; try { h.setPointerCapture(e.pointerId); } catch { /* ended pointer */ }
  });
  h.addEventListener('pointermove', (e) => {
    if (!start) return;
    const x = Math.max(4, Math.min(innerWidth - el.offsetWidth - 4, start[2] + e.clientX - start[0]));
    const y = Math.max(4, Math.min(innerHeight - el.offsetHeight - 4, start[3] + e.clientY - start[1]));
    st.cardAt = [x, y]; el.style.transform = `translate(${x}px, ${y}px)`;
  });
  h.addEventListener('pointerup', () => { start = null; });
}

function setTrueScale(on) { st.trueScale = on; $('#true-tg').checked = on; if (st.f) render(); }
function wire() {
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => openDrawer(true, b.dataset.tab)));
  $('#open-details').addEventListener('click', () => openDrawer(!st.drawer));
  $('#close-details').addEventListener('click', () => openDrawer(false));
  $('#open-layers').addEventListener('click', () => {
    const p = $('#layers'); p.hidden = !p.hidden; $('#open-layers').setAttribute('aria-expanded', String(!p.hidden));
  });
  $('#roads-tg').addEventListener('change', (e) => { st.roads = e.target.checked; loadLayers(); writeHash(); });
  $('#water-tg').addEventListener('change', (e) => { st.water = e.target.checked; loadLayers(); writeHash(); });
  $('#w-conf').addEventListener('change', (e) => { st.conf = e.target.checked; render(); });
  $('#true-tg').addEventListener('change', (e) => setTrueScale(e.target.checked));
  $('#urban-tg').addEventListener('change', (e) => setUrban(e.target.checked));
  $('#wx-tg').addEventListener('change', (e) => setWeather(e.target.checked));
  $('#reset-view').addEventListener('click', () => { if (valley) valley.resetView(); });
  wireDrag();
  $('#k-stretch').addEventListener('click', () => setTrueScale(!st.trueScale));
  $('#point-x').addEventListener('click', unpick);
  $('#pt-csv').addEventListener('click', () => st.pick && downloadPointCSV(store, st.f, st.pick.lat, st.pick.lon, CITY));
  $('#town-a').addEventListener('change', () => renderTowns(st.f));
  $('#town-b').addEventListener('change', () => renderTowns(st.f));
  $('#episodes').addEventListener('click', (e) => {
    const ep = store.meta.episodes.find((x) => x.id === e.target.dataset.ep); if (ep) seekTs(epTs(ep));
  });
  $('#play').addEventListener('click', () => play(!st.playing));
  $('#prev-day').addEventListener('click', () => seekTs(st.f.tsUTC - 86400));
  $('#next-day').addEventListener('click', () => seekTs(st.f.tsUTC + 86400));
  $('#date').addEventListener('change', (e) => {
    if (!e.target.value) return;
    seekTs(Date.parse(e.target.value + 'T00:00:00Z') / 1000 - LT + ltDate(st.f.tsUTC).getUTCHours() * 3600 + 1800);
  });
  $('#latest').addEventListener('click', goLatest);
  // day ribbon and year band: press and drag to scrub; hover shows what is under the pointer
  const dayAt = (e) => { const b = $('#day').getBoundingClientRect(); return Math.min(23, Math.max(0, Math.floor((e.clientX - b.left) / b.width * 24))); };
  const yearAt = (e) => { const b = $('#year').getBoundingClientRect(), D = daily.days;
    return D[Math.min(D.length - 1, Math.max(0, Math.floor((e.clientX - b.left) / b.width * D.length)))]; };
  const scrub = (el, onAt, onTip) => {
    let on = false;
    el.addEventListener('pointerdown', (e) => { on = true; try { el.setPointerCapture(e.pointerId); } catch { /* synthetic or ended pointer */ } lastH = lastD = null; onAt(e); });
    el.addEventListener('pointermove', (e) => { onTip(e); if (on) onAt(e); });
    const end = () => { on = false; }; el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', () => { $('#tip').hidden = true; });
  };
  let lastH = null, lastD = null;
  scrub($('#day'), (e) => { const h = dayAt(e); if (h !== lastH) { lastH = h; seekTs(dayStart(st.f.tsUTC) + h * 3600 + 1800); } },
    (e) => {
      const s = scalars(), h = dayAt(e), gi = dayIdx()[h]; if (gi == null) return;
      tipAt(e, `${String(h).padStart(2, '0')}:30 · <b>${f0(s.basin[gi])}</b> µg/m³`);
    });
  scrub($('#year'), (e) => { if (!daily) return; const d = yearAt(e); if (d !== lastD) { lastD = d; seekTs(d[0] + ltDate(st.f.tsUTC).getUTCHours() * 3600 + 1800); } },
    (e) => { if (!daily) return; const d = yearAt(e), dt = ltDate(d[0] + 3600);
      tipAt(e, `${dt.getUTCDate()} ${MON[dt.getUTCMonth()]} ${dt.getUTCFullYear()} · day mean <b>${f0(d[1])}</b> · peak ${f0(d[2])}`); });
  // Layers closes when you click elsewhere
  addEventListener('pointerdown', (e) => {
    if (!$('#layers').hidden && !e.target.closest('#layers, #open-layers')) { $('#layers').hidden = true; $('#open-layers').setAttribute('aria-expanded', 'false'); }
  });
  $('#open-about').addEventListener('click', () => $('#about').classList.add('on'));
  $('#close-about').addEventListener('click', () => $('#about').classList.remove('on'));
  $('#about').addEventListener('click', (e) => { if (e.target.id === 'about') $('#about').classList.remove('on'); });
  addEventListener('keydown', (e) => {
    const tg = e.target;
    if (tg && tg.matches && tg.matches('input, select, textarea')) return;
    if (e.key === 'Escape') { $('#about').classList.remove('on'); $('#layers').hidden = true; if (st.pick) unpick(); }
    else if (e.key === 'ArrowRight') { if (e.shiftKey) seekTs(st.f.tsUTC + 86400); else stepHour(1); }
    else if (e.key === 'ArrowLeft') { if (e.shiftKey) seekTs(st.f.tsUTC - 86400); else stepHour(-1); }
    else if (e.key === ' ' && !(tg && tg.matches && tg.matches('button'))) { e.preventDefault(); play(!st.playing); }
  });
  $('#dl-field').addEventListener('click', () => downloadFieldCSV(store, st.f, CITY));
  $('#dl-png').addEventListener('click', downloadView);
  $('#copy-link').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); $('#copy-link').textContent = 'Link copied'; }
    catch { $('#copy-link').textContent = 'Copy the address bar'; }
    setTimeout(() => { $('#copy-link').textContent = 'Copy a link to this hour'; }, 1800);
  });
}

// roads and hydrology share one file (layers.json, OpenStreetMap), loaded after the first view
let layersJob = null;
async function loadLayers() {
  if (!layersJob) layersJob = getJSON(`${store.base}/static/layers.json`).catch(() => ({})).then((L) => {
    roads = L.roads || []; hydro = { rivers: L.rivers || [], water: L.water || [] };
    if (valley) { valley.setRoads(roads); valley.setWater(hydro.rivers, hydro.water); }
  });
  await layersJob;
  if (valley) { valley.showRoads(st.roads); valley.showWater(st.water); } else if (st.f) drawFlat();
}

function downloadView() {
  const src = valley ? valley.snapshot() : flatCv, W = src.width, H = src.height;
  const out = document.createElement('canvas'); out.width = W; out.height = H + Math.round(H / 14);
  const c = out.getContext('2d');
  c.fillStyle = '#0f0d0b'; c.fillRect(0, 0, out.width, out.height); c.drawImage(src, 0, 0);
  const f = st.f, lt = ltDate(f.tsUTC).toISOString().slice(0, 16).replace('T', ' ');
  c.fillStyle = '#f2e9dc'; c.font = `${Math.round(H / 42)}px Inter, sans-serif`;
  c.fillText(`Kandy PM2.5 · ${lt} Sri Lanka time · valley average ${f1(f.basin)} µg/m³ (likely ${f0(f.basin05)}–${f0(f.basin95)})`, 16, H + H / 34);
  c.fillStyle = 'rgba(242,233,220,.6)'; c.font = `${Math.round(H / 60)}px Inter, sans-serif`;
  c.fillText(`Research reconstruction. Within-valley pattern is physics, not measured${st.trueScale ? '' : `; differences drawn ×${STRETCH}`}.`, 16, H + H / 17);
  const a = document.createElement('a'); a.href = out.toDataURL('image/png');
  a.download = `${CITY.downloadPrefix}_${lt.replace(/[: ]/g, '')}.png`; a.click();
}

// ── 2-D fallback (no WebGL): the 16x16 field drawn smooth on shaded relief, with water, roads and town names ─
const toPx = (g, lo0, la0, lo1, la1) => ([x, y]) => [g.x0 + (x - lo0) / (lo1 - lo0) * g.side, g.y0 + (1 - (y - la0) / (la1 - la0)) * g.side];
function drawFlat() {
  const cv = flatCv, w = innerWidth, h = innerHeight;
  const dpr = Math.min(devicePixelRatio, 2); cv.width = w * dpr; cv.height = h * dpr;
  cv.style.width = w + 'px'; cv.style.height = h + 'px';
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0f0d0b'; ctx.fillRect(0, 0, w, h);
  const g = store.meta.grid, side = Math.min(w, h) * 0.8, x0 = (w - side) / 2, y0 = (h - side) / 2;
  const tmp = document.createElement('canvas'); tmp.width = g.n_lon; tmp.height = g.n_lat;
  const tc = tmp.getContext('2d'), im = tc.createImageData(g.n_lon, g.n_lat), m = st.f.basin, k = stretch();
  for (let r = 0; r < g.n_lat; r++) for (let c = 0; c < g.n_lon; c++) {
    const v = Math.max(st.f.q50[r * g.n_lon + c], 0), o = ((g.n_lat - 1 - r) * g.n_lon + c) * 4;
    const [rgb, a] = pmColour(Math.max(0, m + k * (v - m)));
    const thick = Math.min(1.25, Math.max(0.08, 0.6 + 2.5 * k * (m > 0.5 ? v / m - 1 : 0)));   // as the 3-D haze
    im.data.set([rgb[0], rgb[1], rgb[2], Math.min(255, (60 + 195 * a) * thick)], o);
  }
  tc.putImageData(im, 0, 0);
  ctx.imageSmoothingEnabled = true;
  if (store.static.hillshade) { ctx.globalAlpha = 0.55; ctx.drawImage(store.static.hillshade, x0, y0, side, side); ctx.globalAlpha = 1; }
  ctx.drawImage(tmp, x0, y0, side, side);
  const env = st.env;
  if (st.conf && env) {
    const oc = tc.createImageData(g.n_lon, g.n_lat);
    for (let r = 0; r < g.n_lat; r++) for (let c = 0; c < g.n_lon; c++) {
      const i = r * g.n_lon + c, o = ((g.n_lat - 1 - r) * g.n_lon + c) * 4;
      const u = Math.max(0, (env.up[i] - 0.85) / 0.15), d = Math.max(0, (env.dn[i] - 0.85) / 0.15);
      const mm = Math.min(1, Math.max(0, (Math.abs(env.mag[i]) - 3) / 10));
      oc.data.set(u >= d ? [232, 163, 90] : [143, 199, 178], o); oc.data[o + 3] = 200 * Math.max(u, d) * mm;
    }
    tc.putImageData(oc, 0, 0); ctx.drawImage(tmp, x0, y0, side, side);
  }
  cv._geo = { x0, y0, side };
  const P = toPx(cv._geo, ...g.bbox);
  if (st.urban && built) {
    const bc = document.createElement('canvas'); bc.width = built.n; bc.height = built.n;
    const bx = bc.getContext('2d'), bi = bx.createImageData(built.n, built.n);
    for (let r = 0; r < built.n; r++) for (let c = 0; c < built.n; c++) {
      const o = ((built.n - 1 - r) * built.n + c) * 4; bi.data.set([237, 227, 209, Math.min(230, 3.2 * built.pct[r * built.n + c])], o);
    }
    bx.putImageData(bi, 0, 0); ctx.drawImage(bc, x0, y0, side, side);
  }
  if (st.weather && wxWind) {
    ctx.strokeStyle = 'rgba(223,238,245,.9)'; ctx.lineWidth = 1.2; ctx.beginPath();
    const w = wxWind, step = Math.max(1, Math.round(w.gx / 18));
    let vmax = 0.5; for (let c = 0; c < w.U.length; c++) vmax = Math.max(vmax, Math.hypot(w.U[c], w.V[c]));
    for (let r = step >> 1; r < w.gy; r += step) for (let c = step >> 1; c < w.gx; c += step) {
      const k = r * w.gx + c, u = w.U[k], v = w.V[k], sp = Math.hypot(u, v); if (sp < 0.05) continue;
      const [px, py] = P([w.lons[c], w.lats[r]]), L = (0.3 + 0.7 * sp / vmax) * side / 36;
      const ex = px + u / sp * L, ey = py - v / sp * L;
      ctx.moveTo(px, py); ctx.lineTo(ex, ey);
      const a = Math.atan2(ey - py, ex - px);
      ctx.moveTo(ex, ey); ctx.lineTo(ex - 5 * Math.cos(a - 0.5), ey - 5 * Math.sin(a - 0.5));
      ctx.moveTo(ex, ey); ctx.lineTo(ex - 5 * Math.cos(a + 0.5), ey - 5 * Math.sin(a + 0.5));
    }
    ctx.stroke();
  }
  ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, side, side); ctx.clip();
  const path = (pts) => pts.forEach((q, j) => { const [px, py] = P(q); if (j) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
  if (st.water && hydro) {
    ctx.fillStyle = 'rgba(95,159,196,.85)';
    for (const wf of hydro.water) { const ring = (wf.c && wf.c[0]) || []; if (ring.length > 2) { ctx.beginPath(); path(ring); ctx.fill(); } }
    ctx.strokeStyle = 'rgba(127,182,214,.95)'; ctx.lineWidth = 1.4; ctx.beginPath();
    for (const r of hydro.rivers) path(r.c);
    ctx.stroke();
  }
  if (st.roads && roads) for (const rk of [1, 2, 3]) {
    ctx.strokeStyle = `rgba(242,233,220,${[0, 0.3, 0.5, 0.8][rk]})`; ctx.lineWidth = rk === 3 ? 1.6 : 0.8; ctx.beginPath();
    for (const r of roads) if ((r.r || 1) === rk && r.t === 'ln') path(r.c);
    ctx.stroke();
  }
  ctx.restore();
  ctx.font = '12px Inter, sans-serif'; ctx.fillStyle = '#f2e9dc';
  for (const lm of store.meta.landmarks.filter((x) => x.k !== 'sensor')) {
    const [x, y] = P(lm.c); ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 7); ctx.fill(); ctx.fillText(lm.n, x + 6, y + 4);
  }
  if (st.pick) {
    const [x, y] = P([st.pick.lon, st.pick.lat]);
    ctx.strokeStyle = '#f2e9dc'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.stroke();
  }
}
function flatPick(e) {
  const gg = flatCv._geo, b = flatCv.getBoundingClientRect(), [lo0, la0, lo1, la1] = store.meta.grid.bbox;
  const u = (e.clientX - b.left - gg.x0) / gg.side, v = 1 - (e.clientY - b.top - gg.y0) / gg.side;
  if (u >= 0 && u <= 1 && v >= 0 && v <= 1) pick(la0 + v * (la1 - la0), lo0 + u * (lo1 - lo0));
}

// ── links: #t=<UTC s>&d=air|where|weather|data (details open)&p=lat,lon&true=1&roads=0&water=0&agree=1 ─────
let writing = false;
function writeHash() {
  const p = new URLSearchParams();
  p.set('t', String(st.f.tsUTC));
  if (st.drawer) p.set('d', st.tab);
  if (st.pick) p.set('p', `${st.pick.lat.toFixed(4)},${st.pick.lon.toFixed(4)}`);
  if (st.trueScale) p.set('true', '1');
  if (st.conf) p.set('agree', '1');
  if (!st.roads) p.set('roads', '0');
  if (!st.water) p.set('water', '0');
  if (st.urban) p.set('urban', '1');
  if (st.weather) p.set('wx', '1');
  const h = `#${p}`;
  if (h === location.hash) return;
  writing = true; history.replaceState(null, '', h); setTimeout(() => { writing = false; }, 0);
}
async function restoreFromHash() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));
  // older links: tab= (A, first pass) and sheet=when|where|data (v2) open the same panes
  const tab = p.get('d') || p.get('tab') || ({ when: 'air', where: 'where', data: 'data' })[p.get('sheet')];
  if (['air', 'where', 'weather', 'data'].includes(tab)) openDrawer(true, tab);
  st.trueScale = p.get('true') === '1'; $('#true-tg').checked = st.trueScale;
  st.conf = p.get('agree') === '1'; $('#w-conf').checked = st.conf;
  st.roads = p.get('roads') !== '0'; $('#roads-tg').checked = st.roads;
  st.water = p.get('water') !== '0'; $('#water-tg').checked = st.water;
  if (roads) loadLayers();
  if ((p.get('urban') === '1') !== st.urban) setUrban(p.get('urban') === '1');
  st.weather = p.get('wx') === '1'; $('#wx-tg').checked = st.weather;
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
