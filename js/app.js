// app.js — Kandy Air, redesign v2 "the valley breathes" (plan kandy_pm25/docs/webapp_redesign_v2_plan_2026-10-27.md).
// One scene, three questions: what is the air like now (3-D valley + one sentence), why does it change through the
// day (the day strip), how much of it is ours (the split bar). Everything else lives in the sheet. The engine
// (store.js, field.js) is untouched; every number shown comes from store.field() exactly as before.
import { $, el, fmt, clamp, compass, getJSON } from './util.js?v=1793200000';
import { activeCity } from './cities.js?v=1793200000';
import { Store, STORE_FCST } from './store.js?v=1793200000';
import { colourMode, paintField } from './field.js?v=1793200000';
import { WindLayer, windWords } from './wind.js?v=1793200000';
import { Timeline } from './timeline.js?v=1793200000';
import { Overlay } from './overlay.js?v=1793200000';
import { MapView } from './mapview.js?v=1793200000';
import { downloadFieldCSV, downloadPointCSV } from './download.js?v=1793200000';
import { ValleyScene, webglOK, pmCss } from './scene.js?v=1793200000';
import { DayStrip } from './daystrip.js?v=1793200000';
import { zoneGrid, zoneStats, relWords } from './zones.js?v=1793200000';

const CITY = activeCity();
const LT = CITY.tzOffsetH * 3600;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
                'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MAP = 840;

const store = new Store(CITY);
const state = { year: null, gi: 0, cur: null, pin: null, uq: false, pattern: true, flat: false, cmp: 'wkd',
                cmpTouched: false, playing: false };
let scene = null, strip = null, timeline = null, act = null, terrain = null, ZG = null;
let flat = null;          // { mapview, overlay, wind, hill }

const lt = (ts) => new Date((ts + LT) * 1000);
const hhmm = (ts) => { const d = lt(ts); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const dayKey = (ts) => lt(ts).toISOString().slice(0, 10);

// ── boot ────────────────────────────────────────────────────────────────
async function boot() {
  await store.init();
  [terrain, act] = await Promise.all([getJSON(`${store.base}/static/terrain3d.json`).catch(() => null),
                                      getJSON(`${store.base}/static/activity.json`).catch(() => null)]);
  strip = new DayStrip($('#strip'), (k) => goDayIndex(k));
  timeline = new Timeline($('#timeline'), store.meta.years, (y, gi) => { seek(y, gi); });

  const anchored = (store.meta.tiers || {}).anchored || [];
  const y0 = anchored.length ? anchored[anchored.length - 1] : store.meta.years[store.meta.years.length - 1];
  timeline.addYear(y0, await store.getScalars(y0));
  (async () => { for (const y of store.meta.years) if (y !== y0) {
    try { timeline.addYear(y, await store.getScalars(y)); timeline.draw(); } catch (e) { console.warn(e); } } })();
  try { await store.initForecast(); } catch (e) { console.warn('forecast tier off:', e); }
  await buildAvailability();
  refreshPickers(false);

  if (terrain && webglOK()) {
    scene = new ValleyScene($('#scene'), { terrain, meta: store.meta, roads: store.static.layers.roads || [],
                                           camera: innerWidth < 760 ? 'phone' : 'explore' });
    wireScenePick();
  } else {
    state.flat = true; $('#flat-toggle').checked = true; $('#flat-toggle').disabled = true;
  }
  layoutForWidth();
  wire();
  fillStatic();

  const ok = await restoreFromHash();
  if (!ok) {
    const ep = store.meta.episodes.find((e) => e.id === CITY.defaultEpisode) || store.meta.episodes[0];
    await seekLocal(ep ? ep.ts : CITY.defaultTs);
  }
  window.addEventListener('hashchange', () => { if (!writing) restoreFromHash(); });
  const l = $('#loading'); l.classList.add('done'); setTimeout(() => l.remove(), 450);
}

// phone: the headline and key move below the scene, onto paper
function layoutForWidth() {
  const narrow = innerWidth < 760, hl = $('.headline'), key = $('.key'), stage = $('.stage');
  if (narrow && hl.parentElement === stage) { stage.after(hl); hl.after(key); }
  if (!narrow && hl.parentElement !== stage) { stage.append(hl); stage.append(key); }
}

// ── seeking ────────────────────────────────────────────────────────────
async function seek(year, gi) {
  const s = await store.getScalars(year);
  state.year = year; state.gi = clamp(gi, 0, s.hours_utc.length - 1);
  const f = await store.field(year, state.gi);
  state.cur = f;
  const wf = await store.windField(year, state.gi);
  const day = await dayOf(year, state.gi);
  state.day = day;
  const sunday = lt(f.tsUTC).getUTCDay() === 0;
  if (!state.cmpTouched) setCmp(sunday ? 'sun' : 'wkd', false);
  render(f, wf, day);
  timeline.setCursor(year, state.gi);
  syncPickers(f.tsUTC);
  writeHash(f);
}

async function seekLocal(str) {        // "YYYY-MM-DD HH:MM" Sri Lanka time
  const [d, t] = str.split(' ');
  return seekTs(Date.parse(`${d}T${t}:00Z`) / 1000 - LT);
}
async function seekTs(ts) {
  let best = null;
  for (const y of yearKeys()) {
    const s = await store.getScalars(y), H = s.hours_utc;
    if (!H.length || ts < H[0] - 86400 || ts > H[H.length - 1] + 86400) continue;
    for (let i = 0; i < H.length; i++) { const dd = Math.abs(H[i] - ts); if (!best || dd < best.d) best = { d: dd, y, i }; }
  }
  if (best && best.d <= 86400) { await seek(best.y, best.i); return true; }
  return false;
}

// the hours of the chosen hour's local day (within one year file), each with its valley average and range
const dayCache = new Map();
async function dayOf(year, gi) {
  const s = await store.getScalars(year), key = `${year}:${dayKey(s.hours_utc[gi])}`;
  if (dayCache.has(key)) return { ...dayCache.get(key), cur: dayCache.get(key).gis.indexOf(gi) };
  const want = dayKey(s.hours_utc[gi]), gis = [];
  for (let i = Math.max(0, gi - 30); i < Math.min(s.hours_utc.length, gi + 30); i++)
    if (dayKey(s.hours_utc[i]) === want) gis.push(i);
  const hours = [];
  for (const i of gis) {
    const f = await store.field(year, i);
    const h = lt(s.hours_utc[i]).getUTCHours();
    hours.push({ label: hhmm(s.hours_utc[i]), pm: f.basin, lo: f.basin05, hi: f.basin95, blh: f.blh,
                 traffic: trafficAt(h, lt(s.hours_utc[i]).getUTCDay() === 0), B: f.B });
  }
  const rec = { year, gis, hours, hour0: lt(s.hours_utc[gis[0]]).getUTCHours(), key: want };
  dayCache.set(key, rec);
  if (dayCache.size > 40) dayCache.delete(dayCache.keys().next().value);
  return { ...rec, cur: gis.indexOf(gi) };
}
function trafficAt(h, sunday) {
  if (!act) return 0;
  return act.traffic[h] * (sunday ? act.sunday_k[h] : 1);
}
function goDayIndex(k) { if (state.day) seek(state.day.year, state.day.gis[k]); }
async function shiftDay(dir) { if (state.cur) await seekTs(state.cur.tsUTC + dir * 86400); }

// ── render ─────────────────────────────────────────────────────────────
function render(f, wf, day) {
  const d = lt(f.tsUTC), h = d.getUTCHours(), hf = h + d.getUTCMinutes() / 60;
  const sunday = d.getUTCDay() === 0;
  const q = drawnField(f);
  if (scene) scene.setHour({ q, grid: store.meta.grid, avg: state.uq ? f.basin95 : f.basin, blh: f.blh, wind: wf,
                             rain: f.rain, hour: hf, traffic: trafficAt(h, sunday) });
  if (state.flat) drawFlat(f, wf, q);

  // headline
  const dateTxt = `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  $('#hl-when').textContent = `${dateTxt} · ${hhmm(f.tsUTC)}`;
  const isF = store.isForecast(f.year);
  const v = state.uq ? f.basin95 : f.basin;
  $('#hl-num').textContent = isF ? `${Math.round(f.basin05)}–${Math.round(f.basin95)}` : Math.round(v);
  $('#hl-range').innerHTML = `<span class="band" style="background:${pmCss(v)};color:${v < 30 ? '#1c1d1f' : '#fff'}">${whoWords(f.basin)}</span>`
    + (isF ? `90 % range, most likely near ${Math.round(f.basin)}` : (state.uq ? `top of the 90 % range (middle ${Math.round(f.basin)})`
      : `valley average · likely between ${Math.round(f.basin05)} and ${Math.round(f.basin95)}`));
  $('#hl-sentence').textContent = sentence(f, h, sunday);
  const tier = tierNote(f);
  $('#hl-tier').hidden = !tier; $('#hl-tier').textContent = tier || '';

  // split: arrived from outside vs made in the valley (the model's background vs the rest)
  const out = clamp(f.B / Math.max(f.basin, 0.1), 0, 1);
  $('#split-out').style.width = `${out * 100}%`; $('#split-in').style.width = `${(1 - out) * 100}%`;
  $('#split-out-v').textContent = `${Math.round(out * 100)} %`;
  $('#split-in-v').textContent = `${Math.round((1 - out) * 100)} %`;

  // day strip
  $('#day-title').textContent = dateTxt;
  strip.set({ hours: day.hours, cur: Math.max(0, day.cur), hour0: day.hour0,
              station: act ? act.station[state.cmp] : null });
  renderWhere(f);
  renderTrust(f);
}

function drawnField(f) {
  let q = state.uq ? f.q95 : f.q50;
  if (!state.pattern) q = new Float32Array(q.length).fill(state.uq ? f.basin95 : f.basin);
  return q;
}

function whoWords(v) {
  if (v < 15) return 'within the WHO day guideline';
  const r = v / 15;
  return `${r < 3 ? r.toFixed(1) : Math.round(r)}× the WHO day guideline`;
}

// one sentence, from the hour's own numbers
function sentence(f, h, sunday) {
  const part = h <= 4 ? 'Night' : h === 5 ? 'Before dawn' : h <= 9 ? 'Morning rush hour' : h <= 15 ? 'Midday'
             : h === 16 ? 'Late afternoon' : h <= 20 ? 'Evening rush hour' : 'Late evening';
  const out = [];
  let lead = part + (sunday ? ' on a Sunday' : '');
  if (Number.isFinite(f.blh)) {
    const m = Math.round(f.blh / 10) * 10;
    lead += m < 300 ? `, under a shallow mixing layer about ${m} m deep` : m < 700 ? `, with the air mixing to about ${m} m`
          : `, with the air mixing up to about ${m} m`;
  }
  out.push(lead + '.');
  if (Number.isFinite(f.wspd)) out.push(`${cap(windWords(f.wspd))}${f.wspd >= 0.3 ? ` from the ${compassWords(f.wdir)}` : ''}.`);
  if (Number.isFinite(f.rain) && f.rain >= 0.5) out.push(`Raining, about ${f.rain.toFixed(1)} mm in the hour.`);
  if (h <= 4) out.push('Traffic has stopped; at the station these are usually the cleanest hours.');
  else if (sunday && h >= 6 && h <= 9) out.push('On Sunday mornings the station measures about a fifth less than on weekdays.');
  else if (h >= 6 && h <= 9 && f.blh < 400) out.push('The morning’s traffic and cooking smoke have little room to spread.');
  else if (h >= 11 && h <= 15 && f.blh > 700) out.push('A deep layer spreads what the city emits.');
  return out.join(' ');
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const WORDS = { N: 'north', NNE: 'north-north-east', NE: 'north-east', ENE: 'east-north-east', E: 'east', ESE: 'east-south-east',
  SE: 'south-east', SSE: 'south-south-east', S: 'south', SSW: 'south-south-west', SW: 'south-west', WSW: 'west-south-west',
  W: 'west', WNW: 'west-north-west', NW: 'north-west', NNW: 'north-north-west' };
const compassWords = (deg) => WORDS[compass(deg)] || compass(deg);

function tierNote(f) {
  if (store.isForecast(f.year)) {
    const kind = store.kindAt(f.year, f.gi);
    return (kind === 'recent' ? 'Recent hours, modelled from a near-real-time global analysis.'
          : kind === 'level_only' ? 'Level only: no weather is available for these hours.' : 'A forecast.')
      + ' A demonstration: not yet checked against the Kandy station, and the range is deliberately wide.';
  }
  const ext = (store.meta.tiers || {}).extension || [];
  if (ext.includes(f.year)) return 'After 2023 the level is modelled from weather; against the station it reads about 40 % low. Read this hour as a guide.';
  return '';
}

// ── sheet: where, trust ────────────────────────────────────────────────
function renderWhere(f) {
  if (!store.static.fields) return;
  if (!ZG) ZG = zoneGrid(store.static.fields.elev);
  const zs = zoneStats(f.q50, ZG, f.basin);
  $('#zones').innerHTML = zs.map((z) => `<div class="zn-row"><span>${z.name} <small>${z.range}</small></span>`
    + `<span>${relWords(z.pct)}</span></div>`).join('');
  if (state.pin) showPoint(state.pin.lat, state.pin.lon, false);
}

function renderTrust(f) {
  const ext = ((store.meta.tiers || {}).extension || []).includes(f.year), fc = store.isForecast(f.year);
  const rows = [
    ['How polluted the year is', fc ? 'Forecast: not checked' : ext ? 'Modelled from weather; reads about 40 % low at the station'
      : 'Fitted to the Kandy station on 2019 to mid-2021; within about 1 % on later years', fc || ext ? 'uncertain' : 'anchored'],
    ['The rhythm of the day', 'Rush-hour peaks and clean nights match the station', 'timing right'],
    ['The seasons', 'The worst months are right; the swing is too strong (3–4× vs about 2× at the station)', 'too strong'],
    ['Which days are worse', 'About as good as a global air-quality model adjusted to the station', 'a guide'],
    ['Where in the valley', 'An assumption a few per cent strong; cannot rank streets or towns', 'indicative'],
    ['From outside vs made here', 'Roughly half and half over a year; from how the model is built', 'estimate'],
    ['The 90 % range', 'Held the station’s value about 87 % of the time on later hours', 'checked'],
  ];
  $('#trust').innerHTML = rows.map(([a, b, c]) => `<div class="trust-row"><span><b>${a}.</b> ${b}</span><span class="lvl">${c}</span></div>`).join('');
}

function showPoint(lat, lon, open = true) {
  const g = store.meta.grid, f = state.cur; if (!f) return;
  const li = nearIdx(g.lats, lat), lj = nearIdx(g.lons, lon);
  const elev = store.static.fields.elev[li][lj];
  if (!ZG) ZG = zoneGrid(store.static.fields.elev);
  const z = zoneStats(f.q50, ZG, f.basin)[ZG[li * g.n_lon + lj]];
  $('#point').innerHTML = `<b>${z.name}</b> (${Math.round(elev)} m). This hour the zone is ${relWords(z.pct)}; the valley average is `
    + `${fmt(f.basin)} µg/m³ (90 % range ${fmt(f.basin05)}–${fmt(f.basin95)}). Not a street-level reading: within a 1 km square, `
    + `kerbside and garden air can differ many times over.`;
  $('#dl-point').disabled = false;
  if (open) openSheet('where');
}
function nearIdx(a, v) { let bi = 0, bd = Infinity; a.forEach((x, i) => { const d = Math.abs(x - v); if (d < bd) { bd = d; bi = i; } }); return bi; }

function wireScenePick() {
  const host = $('#scene'); let down = null;
  host.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  host.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || performance.now() - down.t > 400) return;
    const ll = scene.pick(e.clientX, e.clientY);
    if (ll) { state.pin = { lat: ll[1], lon: ll[0] }; showPoint(ll[1], ll[0]); }
  });
}

// ── flat-map fallback (2-D: hillshade, field, roads, wind) ─────────────
function ensureFlat() {
  if (flat) return flat;
  const pan = $('#mappan'), bbox = store.meta.grid.bbox;
  for (const id of ['hill', 'field', 'wind', 'vec']) pan.append(el('canvas', { id: `cv-${id}`, class: 'maplayer', width: MAP, height: MAP }));
  const overlay = new Overlay($('#cv-vec'), bbox);
  overlay.setData(store.static.layers, store.static.emission, { sources: store.static.sources, terrain: store.static.terrain });
  const wind = new WindLayer($('#cv-wind')); wind.start();
  const mapview = new MapView($('#mapstack'), pan, bbox, () => {});
  mapview.onClick((e) => {
    const [lon, lat] = mapview.screenToLatLon(e.clientX, e.clientY);
    state.pin = { lat, lon }; showPoint(lat, lon);
  });
  flat = { overlay, wind, mapview, hill: $('#cv-hill').getContext('2d') };
  return flat;
}
function drawFlat(f, wf, q) {
  const F = ensureFlat();
  F.hill.clearRect(0, 0, MAP, MAP); F.hill.drawImage(store.static.hillshade, 0, 0, MAP, MAP);
  paintField($('#cv-field'), q, colourMode(f.q50, 'auto'), store.meta.grid.n_lat);
  F.overlay.draw(); F.wind.setField(wf);
}
function setFlat(on) {
  state.flat = on || !scene;
  $('#flatmap').hidden = !state.flat; $('#scene').hidden = state.flat;
  if (scene) state.flat ? scene.pause() : scene.resume();
  if (state.cur) seek(state.year, state.gi);
}

// ── controls ───────────────────────────────────────────────────────────
function wire() {
  document.querySelectorAll('.key input[data-layer]').forEach((cb) => cb.addEventListener('change', () => {
    if (scene) scene.setLayers({ [cb.dataset.layer]: cb.checked });
  }));
  document.querySelectorAll('[data-sheet]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); openSheet(b.dataset.sheet); }));
  document.querySelectorAll('#sheet [data-close]').forEach((b) => b.addEventListener('click', closeSheet));
  document.querySelectorAll('.sheet-tabs button').forEach((b) => b.addEventListener('click', () => openSheet(b.dataset.tab)));
  $('#cam-reset').addEventListener('click', () => scene && scene.setCamera(innerWidth < 760 ? 'phone' : 'explore'));
  $('#day-prev').addEventListener('click', () => shiftDay(-1));
  $('#day-next').addEventListener('click', () => shiftDay(1));
  $('#play').addEventListener('click', () => (state.playing ? stopPlay() : startPlay()));
  document.querySelectorAll('.seg-b[data-cmp]').forEach((b) => b.addEventListener('click', () => { state.cmpTouched = true; setCmp(b.dataset.cmp); }));
  $('#uq').addEventListener('change', (e) => { state.uq = e.target.checked; redraw(); });
  $('#pattern-toggle').addEventListener('change', (e) => { state.pattern = e.target.checked; redraw(); });
  $('#flat-toggle').addEventListener('change', (e) => setFlat(e.target.checked));
  $('#dl-csv').addEventListener('click', () => state.cur && downloadFieldCSV(store, state.cur, CITY));
  $('#dl-point').addEventListener('click', () => state.cur && state.pin && downloadPointCSV(store, state.cur, state.pin.lat, state.pin.lon, CITY));
  $('#copy-link').addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText(location.href); e.target.textContent = 'Link copied'; }
    catch { e.target.textContent = 'Copy the address bar'; }
    setTimeout(() => { e.target.textContent = 'Copy a link to this hour'; }, 1800);
  });
  ['#sel-year', '#sel-month', '#sel-day', '#sel-hour'].forEach((s) => $(s).addEventListener('change', () => {
    if (syncing) return;
    refreshPickers(true);
    const r = AVAIL.hours.get(`${+$('#sel-year').value}-${+$('#sel-month').value}-${+$('#sel-day').value}-${+$('#sel-hour').value}`);
    if (r) seek(r[0], r[1]);
  }));
  document.addEventListener('keydown', (e) => {
    if (/SELECT|INPUT/.test(e.target.tagName) || !$('#sheet').hidden) return;
    if (e.key === 'ArrowLeft') step(-1); else if (e.key === 'ArrowRight') step(1);
    else if (e.key === ' ') { e.preventDefault(); state.playing ? stopPlay() : startPlay(); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
  let rt = null;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { layoutForWidth(); strip.draw(); }, 150); });
  buildJumps(); buildEpisodes();
}
function redraw() { if (state.cur) seek(state.year, state.gi); }
async function step(d) {
  const s = await store.getScalars(state.year);
  const gi = state.gi + d;
  if (gi < 0 || gi >= s.hours_utc.length) return seekTs(state.cur.tsUTC + d * 3600);
  return seek(state.year, gi);
}
function setCmp(k, draw = true) {
  state.cmp = k;
  document.querySelectorAll('.seg-b[data-cmp]').forEach((b) => b.classList.toggle('on', b.dataset.cmp === k));
  if (draw && state.cur && state.day) strip.set({ ...strip.d, station: act ? act.station[k] : null });
}
let playT = null;
function startPlay() {
  state.playing = true; $('#play').classList.add('on'); $('#play').textContent = 'Pause';
  playT = setInterval(() => {
    const d = state.day; if (!d) return;
    const k = (d.cur + 1) % d.gis.length; seek(d.year, d.gis[k]);
  }, 1100);
}
function stopPlay() { state.playing = false; clearInterval(playT); const b = $('#play'); if (b) { b.classList.remove('on'); b.textContent = 'Play the day'; } }

function openSheet(tab) {
  $('#sheet').hidden = false;
  document.querySelectorAll('.sheet-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('.sheet-body [data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
  if (tab === 'when') requestAnimationFrame(() => { timeline._fit && timeline._fit(); timeline.draw(); });
}
function closeSheet() { $('#sheet').hidden = true; }

function fillStatic() {
  $('#integrity').textContent = store.meta.integrity || '';
  const ul = $('#credits'); ul.innerHTML = '';
  for (const [what, who] of store.meta.credits || []) ul.append(el('li', {}, `${what}: ${who}`));
  $('#wind-src').textContent = (store.meta.wind_note || CITY.windCaveat || '') + ' Shown as moving streaks near the ground.';
  if (act) {
    $('#traffic-src').textContent = act.traffic_source + ' On Sundays the movers are thinned by the drop in PM2.5 the station measures at each hour, a lower bound on the drop in traffic.';
    const r = act.station_ratios['morning rush 06-09'], w = act.station_ratios['whole day'];
    $('#station-src').textContent = `${act.station_source} Sunday ÷ weekday: morning rush ${r.ratio.toFixed(2)} [${r.lo.toFixed(2)}, ${r.hi.toFixed(2)}], whole day ${w.ratio.toFixed(2)} [${w.lo.toFixed(2)}, ${w.hi.toFixed(2)}], over ${r.months} months. Drawn on the day strip as a dashed line, shape only.`;
  }
}

// notable hours: scan the loaded year
function buildJumps() {
  const box = $('#jumps');
  const inYear = (fn) => async () => {
    const y = state.year, s = await store.getScalars(y); let best = null;
    for (let i = 0; i < s.hours_utc.length; i++) { const c = fn(s, i); if (c != null && (!best || c > best.c)) best = { c, i }; }
    if (best) { await seek(y, best.i); closeSheet(); }
  };
  [['Worst hour of the year', inYear((s, i) => s.basin[i])],
   ['Cleanest hour of the year', inYear((s, i) => -Math.max(s.basin[i], 0))],
   ['Wettest hour', inYear((s, i) => (s.rain && s.rain[i] != null ? s.rain[i] : null))],
   ['Shallowest, calmest air', inYear((s, i) => (s.blh[i] > 0 ? -(s.blh[i] * Math.max(s.wspd[i], 0.05)) : null))],
  ].forEach(([t, fn]) => { const b = el('button', {}, t); b.addEventListener('click', fn); box.append(b); });
}
function buildEpisodes() {
  const box = $('#episodes');
  for (const ep of store.meta.episodes || []) {
    const b = el('button', {}, ep.title);
    b.addEventListener('click', async () => {
      $('#episode-card').innerHTML = `<p>${ep.note}</p><p class="src">Source: ${ep.source}</p>`;
      await seekLocal(ep.ts);
    });
    box.append(b);
  }
}

// ── date pickers driven by what the payload holds ───────────────────────
const AVAIL = { hours: new Map(), days: new Map(), years: [] };
function yearKeys() { return store.forecast ? [...store.meta.years, STORE_FCST] : [...store.meta.years]; }
function parts(ts) { const d = lt(ts); return { Y: d.getUTCFullYear(), M: d.getUTCMonth() + 1, D: d.getUTCDate(), H: d.getUTCHours(), mi: d.getUTCMinutes() }; }
async function buildAvailability() {
  AVAIL.hours.clear(); AVAIL.days.clear();
  for (const yk of yearKeys()) {
    const s = await store.getScalars(yk), isF = yk === STORE_FCST;
    for (let i = 0; i < s.hours_utc.length; i++) {
      const { Y, M, D, H, mi } = parts(s.hours_utc[i]);
      AVAIL.hours.set(`${Y}-${M}-${D}-${H}`, [yk, i, isF, mi]);
      const r = AVAIL.days.get(`${Y}-${M}-${D}`) || { fcst: false }; r.fcst ||= isF; AVAIL.days.set(`${Y}-${M}-${D}`, r);
    }
  }
  AVAIL.years = [...new Set([...AVAIL.days.keys()].map((k) => +k.split('-')[0]))].sort((a, b) => a - b);
}
const dayRec = (Y, M, D) => AVAIL.days.get(`${Y}-${M}-${D}`);
const monthHas = (Y, M) => { for (let d = 1; d <= 31; d++) if (dayRec(Y, M, d)) return true; return false; };
function opt(v, label, dis = false) { const o = el('option', { value: String(v) }, label); o.disabled = dis; return o; }
function refreshPickers(keep) {
  const yS = $('#sel-year'), mS = $('#sel-month'), dS = $('#sel-day'), hS = $('#sel-hour');
  const wY = keep ? +yS.value : NaN, wM = keep ? +mS.value : NaN, wD = keep ? +dS.value : NaN, wH = keep ? +hS.value : NaN;
  const ext = (store.meta.tiers || {}).extension || [];
  yS.innerHTML = '';
  for (const y of AVAIL.years) {
    let f = false; for (let m = 1; m <= 12 && !f; m++) for (let d = 1; d <= 31; d++) { const r = dayRec(y, m, d); if (r && r.fcst) { f = true; break; } }
    yS.append(opt(y, `${y}${f ? ' ▸' : ext.includes(y) ? ' (modelled)' : ''}`));
  }
  yS.value = AVAIL.years.includes(wY) ? wY : AVAIL.years[AVAIL.years.length - 1];
  const Y = +yS.value;
  mS.innerHTML = ''; for (let m = 1; m <= 12; m++) mS.append(opt(m, MONTHS[m - 1], !monthHas(Y, m)));
  let M = monthHas(Y, wM) ? wM : [...Array(12).keys()].map((i) => 12 - i).find((m) => monthHas(Y, m)) || 1; mS.value = M;
  const nd = new Date(Date.UTC(Y, M, 0)).getUTCDate();
  dS.innerHTML = ''; for (let d = 1; d <= nd; d++) { const r = dayRec(Y, M, d); dS.append(opt(d, r && r.fcst ? `${d} ▸` : String(d), !r)); }
  let D = dayRec(Y, M, wD) ? wD : [...Array(nd).keys()].map((i) => nd - i).find((d) => dayRec(Y, M, d)) || 1; dS.value = D;
  hS.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const r = AVAIL.hours.get(`${Y}-${M}-${D}-${h}`);
    hS.append(opt(h, `${String(h).padStart(2, '0')}:${r ? String(r[3]).padStart(2, '0') : CITY.minuteLabel}${r && r[2] ? ' ▸' : ''}`, !r));
  }
  hS.value = AVAIL.hours.has(`${Y}-${M}-${D}-${wH}`) ? wH : ([...Array(24).keys()].find((h) => AVAIL.hours.has(`${Y}-${M}-${D}-${h}`)) ?? 0);
}
let syncing = false;
function syncPickers(ts) {
  if (!AVAIL.years.length) return;
  syncing = true;
  const { Y, M, D, H } = parts(ts);
  $('#sel-year').value = Y; $('#sel-month').value = M; $('#sel-day').value = D; $('#sel-hour').value = H;
  refreshPickers(true);
  syncing = false;
}

// ── deep links: #t=<unix>&uq=1&pat=0 ───────────────────
let writing = false;
function writeHash(f) {
  const p = new URLSearchParams();
  p.set('t', String(f.tsUTC));
  if (state.uq) p.set('uq', '1');
  if (!state.pattern) p.set('pat', '0');
  const h = `#${p}`;
  if (h === location.hash) return;
  writing = true; history.replaceState(null, '', h); setTimeout(() => { writing = false; }, 0);
}
async function restoreFromHash() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));
  const t = Number(p.get('t'));
  if (p.get('uq') === '1') { state.uq = true; $('#uq').checked = true; }
  if (p.get('pat') === '0') { state.pattern = false; $('#pattern-toggle').checked = false; }
  if (!p.get('t') || !Number.isFinite(t)) return false;
  return seekTs(t);
}

boot().catch((err) => {
  console.error(err);
  const l = $('#loading'); if (l) l.innerHTML = `<p class="err">The data could not be loaded: ${err.message}</p>`;
});
