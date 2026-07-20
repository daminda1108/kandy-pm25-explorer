// app.js — PM2.5 Explorer orchestrator (city-aware: Kandy default, Medellín
// proving ground). All per-city behaviour comes from cities.js.

import { $, el, fmt, fmtCI, clamp } from './util.js?v=1784523379';
import { activeCity } from './cities.js?v=1784523379';
import { Store } from './store.js?v=1784523379';
import { colourMode, paintField, paintColourbar } from './field.js?v=1784523379';
import { WindLayer } from './wind.js?v=1784523379';
import { Timeline } from './timeline.js?v=1784523379';
import { Overlay } from './overlay.js?v=1784523379';
import { initPanels, updatePanels, pointQuery, clearPin } from './panels.js?v=1784523379';
import { initShowcase } from './showcase.js?v=1784523379';
import { MapView } from './mapview.js?v=1784523379';
import { downloadPNG, downloadFieldCSV, downloadPointCSV } from './download.js?v=1784523379';

const MAP = 840;                    // internal map canvas resolution (square)
const CITY = activeCity();
const LT_OFFSET = CITY.tzOffsetH * 3600;

const state = { year: null, gi: 0, playing: false, showUQ: false,
                scaleMode: 'auto', cur: null, pin: null, tier: 'model' };

const store = new Store(CITY);
let timeline, wind, overlay, hillCtx, mapview, showcase;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                'August', 'September', 'October', 'November', 'December'];

function ltDate(tsUTC) { return new Date((tsUTC + LT_OFFSET) * 1000); }
function ltLabel(tsUTC) {
  const d = ltDate(tsUTC);
  const day = d.toISOString().slice(0, 10);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return { day, hm: `${hh}:${mm}` };
}
function seasonOf(month) {
  if (!CITY.seasonCode) return MONTHS[month - 1].slice(0, 3);
  return ['DJF', 'DJF', 'MAM', 'MAM', 'MAM', 'JJA', 'JJA', 'JJA', 'SON', 'SON', 'SON', 'DJF'][month - 1];
}
function daypart(h) {
  return h < 6 ? 'night' : h < 10 ? 'morning rush' : h < 16 ? 'midday'
       : h < 20 ? 'evening rush' : 'night';
}

async function boot() {
  await store.init();
  const bbox = store.meta.grid.bbox;

  // map stack — canvases live inside the transformed pan wrapper
  const pan = $('#mappan');
  for (const id of ['hill', 'field', 'wind', 'vec', 'stations']) {
    const cv = el('canvas', { id: `cv-${id}`, class: 'maplayer', width: MAP, height: MAP });
    pan.append(cv);
  }
  hillCtx = $('#cv-hill').getContext('2d');
  wind = new WindLayer($('#cv-wind'));
  overlay = new Overlay($('#cv-vec'), bbox);
  overlay.setData(store.static.layers, store.static.emission);

  // zoom / pan controller
  mapview = new MapView($('#mapstack'), pan, bbox, () => repositionCard());
  mapview.onClick((e) => onPixelClick(e));
  $('#zoom-in').addEventListener('click', () => mapview.zoomBy(1.4));
  $('#zoom-out').addEventListener('click', () => mapview.zoomBy(1 / 1.4));
  $('#zoom-reset').addEventListener('click', () => mapview.reset());
  $('#point-close').addEventListener('click', () => hidePointCard());

  timeline = new Timeline($('#timeline'), store.meta.years, (y, gi) => seek(y, gi));

  wireControls();
  wireDatetime();
  initPanels(store, (y, gi) => seek(y, gi), CITY);

  // preload all years' scalars for the strip (small, gzip over the wire)
  for (const y of store.meta.years) {
    const s = await store.getScalars(y);
    timeline.addYear(y, s);
  }

  $('#integrity-text').textContent = store.meta.integrity;
  buildEpisodes();
  buildCredits();

  // proving-ground extras (station reveal, forecast scoreboard, data-value slider)
  if (CITY.features.showcase) {
    showcase = await initShowcase({
      store, city: CITY, mapview,
      stationCanvas: $('#cv-stations'),
      getState: () => state,
      exitToHour: () => seek(state.year, state.gi),
      setTier,
    });
  }

  // blind-tier control only where the payload carries the zero-data tier
  const s0 = await store.getScalars(store.meta.years[0]);
  const tierSeg = $('#tier-seg');
  if (tierSeg && store.hasBlindTier(s0)) tierSeg.style.display = '';

  // initial view: a documented episode, else the city's default timestamp
  const ep = store.meta.episodes.find((e) => e.id === CITY.defaultEpisode)
          || store.meta.episodes[0];
  await seekToTs(ep ? ep.ts : CITY.defaultTs);
  wind.start();
  const load = $('#loading');
  load.classList.add('done');
  setTimeout(() => load.remove(), 450);
}

function drawHillshade() {
  const im = store.static.hillshade;
  hillCtx.clearRect(0, 0, MAP, MAP);
  hillCtx.globalAlpha = 1;
  hillCtx.drawImage(im, 0, 0, MAP, MAP);
  hillCtx.fillStyle = 'rgba(15,20,30,0.35)';
  hillCtx.fillRect(0, 0, MAP, MAP);
}

async function seek(year, gi) {
  if (showcase) showcase.exitDataValueMode(false);
  state.year = year;
  const s = await store.getScalars(year);
  state.gi = clamp(gi, 0, s.hours_utc.length - 1);
  const f = await store.field(year, state.gi, state.tier);
  state.cur = f;
  render(f);
  timeline.setCursor(year, state.gi);
  syncDatetime(f.tsUTC);
  const wf = await store.windField(year, state.gi);
  if (wf) wind.setField(wf);
  updatePanels(f);
}

async function setTier(tier) {
  state.tier = tier;
  for (const b of document.querySelectorAll('#tier-seg .seg-btn'))
    b.classList.toggle('active', b.dataset.tier === tier);
  if (state.year != null) await seek(state.year, state.gi);
}

async function seekToTs(tsStr) {
  // tsStr like "2022-12-07 08:00" interpreted as LT; find nearest hour that year
  const [datePart, timePart] = tsStr.split(' ');
  const y = +datePart.slice(0, 4);
  const ltSec = Date.parse(`${datePart}T${timePart}:00Z`) / 1000 - LT_OFFSET;
  const s = await store.getScalars(y);
  let best = 0, bd = 1e18;
  for (let i = 0; i < s.hours_utc.length; i++) {
    const d = Math.abs(s.hours_utc[i] - ltSec);
    if (d < bd) { bd = d; best = i; }
  }
  await seek(y, best);
}

function render(f) {
  drawHillshade();
  const q = state.showUQ ? f.q95 : f.q50;
  const cm = colourMode(f.q50, state.scaleMode);   // range keyed to the median field
  paintField($('#cv-field'), q, cm, store.meta.grid.n_lat);
  overlay.draw();
  if (showcase) showcase.drawStations();
  paintColourbar($('#colourbar'), cm);
  const cbT = $('#cb-ticks'); cbT.innerHTML = '';
  cm.ticks.forEach((t, i) => {
    const span = el('span', {}, `${t}`);
    span.style.left = `${((t - cm.lo) / (cm.hi - cm.lo)) * 100}%`;
    cbT.append(span);
  });
  $('#cb-tag').textContent = cm.tag;
  // title readout (all central values carry their 90% interval)
  const { day, hm } = ltLabel(f.tsUTC);
  const month = ltDate(f.tsUTC).getUTCMonth() + 1;
  const lh = ltDate(f.tsUTC).getUTCHours();
  // provenance flags: the blind (zero-ground-data) tier, and — for years past the
  // satellite anchor — the modelled extension tier (meta.tiers.extension).
  const extYears = (store.meta.tiers || {}).extension || [];
  const isExt = extYears.includes(f.year);
  const tierTag = (f.tier === 'vand'
      ? ' <span class="uqtag">zero-ground-data tier</span>' : '')
    + (isExt ? ' <span class="uqtag exttag" title="'
        + (store.meta.tier_note || '').replace(/"/g, '&quot;')
        + '">modelled extension year</span>' : '');
  $('#map-title').innerHTML =
    `<b>${day} ${hm}</b> · ${seasonOf(month)}, ${daypart(lh)}`
    + `<span class="readout">basin ${fmtCI(f.basin, f.basin05, f.basin95)} · `
    + `centre ${fmtCI(f.core, f.core05, f.core95)} · `
    + `peak ${fmtCI(f.peak.v, f.peak.lo, f.peak.hi)} µg/m³`
    + ` <span class="dim">near ${nearLandmark(f.peak.lat, f.peak.lon)}</span></span>`
    + tierTag
    + (state.showUQ ? ' <span class="uqtag">showing 90% upper bound</span>' : '');
  const tb = $('#tier-banner');
  if (tb) {
    tb.textContent = isExt ? (store.meta.tier_note || '') : '';
    tb.classList.toggle('show', isExt);
  }
}

function nearLandmark(lat, lon) {
  let best = null, bd = 1e18;
  for (const p of store.meta.landmarks) {
    const d = (p.c[1] - lat) ** 2 + (p.c[0] - lon) ** 2;
    if (d < bd) { bd = d; best = p.n; }
  }
  return best || 'the basin rim';
}

// ── date & time dropdowns ─────────────────────────────────────────────────────
function wireDatetime() {
  const ySel = $('#sel-year'), mSel = $('#sel-month'), dSel = $('#sel-day'), hSel = $('#sel-hour');
  for (const y of store.meta.years) ySel.append(el('option', { value: y }, String(y)));
  MONTHS.forEach((m, i) => mSel.append(el('option', { value: i + 1 }, m)));
  for (let h = 0; h < 24; h++)
    hSel.append(el('option', { value: h }, `${String(h).padStart(2, '0')}:${CITY.minuteLabel}`));
  const rebuildDays = () => {
    const y = +ySel.value, m = +mSel.value;
    const nd = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const cur = +dSel.value || 1;
    dSel.innerHTML = '';
    for (let d = 1; d <= nd; d++) dSel.append(el('option', { value: d }, String(d)));
    dSel.value = Math.min(cur, nd);
  };
  const go = () => {
    rebuildDays();
    const ts = `${ySel.value}-${String(mSel.value).padStart(2, '0')}-${String(dSel.value).padStart(2, '0')}`
             + ` ${String(hSel.value).padStart(2, '0')}:${CITY.minuteLabel}`;
    seekToTs(ts);
  };
  for (const s of [ySel, mSel, dSel, hSel]) s.addEventListener('change', go);
  rebuildDays();
}

let syncing = false;
function syncDatetime(tsUTC) {
  syncing = true;
  const d = ltDate(tsUTC);
  $('#sel-year').value = d.getUTCFullYear();
  $('#sel-month').value = d.getUTCMonth() + 1;
  const dSel = $('#sel-day');
  const nd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  if (dSel.options.length !== nd) {
    dSel.innerHTML = '';
    for (let dd = 1; dd <= nd; dd++) dSel.append(el('option', { value: dd }, String(dd)));
  }
  dSel.value = d.getUTCDate();
  $('#sel-hour').value = d.getUTCHours();
  syncing = false;
}

function wireControls() {
  $('#play').addEventListener('click', togglePlay);
  $('#prev').addEventListener('click', () => step(-1));
  $('#next').addEventListener('click', () => step(1));
  $('#uq').addEventListener('change', (e) => { state.showUQ = e.target.checked; if (state.cur) render(state.cur); });
  // scale mode segmented control
  for (const btn of document.querySelectorAll('.map-foot .seg-btn')) {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.map-foot .seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.scaleMode = btn.dataset.mode;
      if (state.cur) render(state.cur);
    });
  }
  // blind-tier segmented control (proving-ground cities)
  for (const btn of document.querySelectorAll('#tier-seg .seg-btn'))
    btn.addEventListener('click', () => setTier(btn.dataset.tier));
  for (const key of ['roads', 'water', 'emission', 'landmarks']) {
    const cb = $(`#layer-${key}`);
    if (cb) cb.addEventListener('change', (e) => { overlay.show[key] = e.target.checked; overlay.draw(); });
  }
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT') return;
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  });
  // refit charts + colourbar on viewport changes (rotation, window resize)
  let rsT = null;
  window.addEventListener('resize', () => {
    clearTimeout(rsT);
    rsT = setTimeout(() => { if (state.cur) { render(state.cur); updatePanels(state.cur); } }, 160);
  });
  $('#dl-png').addEventListener('click', () => state.cur && downloadPNG(store, state.cur, CITY));
  $('#dl-csv').addEventListener('click', () => state.cur && downloadFieldCSV(store, state.cur, CITY));
  $('#dl-point').addEventListener('click', () => {
    if (state.cur && state.pin) downloadPointCSV(store, state.cur, state.pin.lat, state.pin.lon, CITY);
  });
}

let playTimer = null;
function togglePlay() {
  state.playing = !state.playing;
  $('#play').innerHTML = state.playing ? '&#10073;&#10073;' : '&#9654;';
  if (state.playing) {
    playTimer = setInterval(() => step(1, true), 120);
  } else clearInterval(playTimer);
}
async function step(d, wrap = false) {
  const s = await store.getScalars(state.year);
  let gi = state.gi + d;
  if (gi < 0) gi = wrap ? s.hours_utc.length - 1 : 0;
  if (gi >= s.hours_utc.length) gi = wrap ? 0 : s.hours_utc.length - 1;
  seek(state.year, gi);
}

function buildEpisodes() {
  const row = $('#episodes-row');
  if (!row) return;
  if (!store.meta.episodes.length) { row.style.display = 'none'; return; }
  const box = $('#episodes'); box.innerHTML = '';
  for (const ep of store.meta.episodes) {
    const b = el('button', { class: 'episode-btn', title: ep.note,
      onclick: () => { showEpisodeCard(ep); seekToTs(ep.ts); } }, ep.title);
    box.append(b);
  }
}
function showEpisodeCard(ep) {
  $('#episode-card').innerHTML =
    `<h4>${ep.title}</h4><p>${ep.note}</p><p class="src">Source: ${ep.source}</p>`;
  $('#episode-card').classList.add('show');
}

function buildCredits() {
  const box = $('#credits'); box.innerHTML = '';
  for (const [what, who] of store.meta.credits)
    box.append(el('div', { class: 'credit' }, el('span', { class: 'c-what' }, what), `: ${who}`));
}

async function onPixelClick(e) {
  const [lon, lat] = mapview.screenToLatLon(e.clientX, e.clientY);
  const b = store.meta.grid.bbox;
  if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) return;
  // station dots take priority when the reveal layer is on
  if (showcase && showcase.hitStation(lat, lon)) return;
  state.pin = { lat, lon };
  $('#dl-point').disabled = false;
  pointQuery(lat, lon);                 // rail panel (fallback / full history)
  showPointCard(lat, lon);              // floating on-map card
}

// ── floating on-map point card ────────────────────────────────────────────────
function pointData(lat, lon) {
  const g = store.meta.grid, f = state.cur;
  const li = nearIdx(g.lats, lat), lj = nearIdx(g.lons, lon), px = li * g.n_lon + lj;
  const elev = store.static.fields.elev[li][lj];
  const B = f.B, val = f.q50[px], local = Math.max(val - B, 0);
  return { val, lo: f.q05[px], hi: f.q95[px], elev, B, local,
           slat: g.lats[li], slon: g.lons[lj] };
}
function showPointCard(lat, lon) {
  if (!state.cur) return;
  const d = pointData(lat, lon);
  $('#point-card-body').innerHTML =
    `<div class="pc-val">${fmtCI(d.val, d.lo, d.hi)} <span class="pc-unit">µg/m³</span></div>
     <div class="pc-rows">
       <span>Background</span><span>${fmt(d.B)}</span>
       <span>Local</span><span>${fmt(d.local)}</span>
       <span>Elevation</span><span>${fmt(d.elev, 0)} m</span>
       <span>Location</span><span>${d.slat.toFixed(3)}, ${d.slon.toFixed(3)}</span>
     </div>`;
  $('#point-card').hidden = false;
  repositionCard();
}
function repositionCard() {
  const card = $('#point-card');
  if (!card || card.hidden || !state.pin) return;
  const outer = $('#mapstack').getBoundingClientRect();
  const s = mapview.latLonToScreen(state.pin.lon, state.pin.lat);
  // position within the map viewport, clamped, flipping side near the right edge
  let x = s.x - outer.left + 12, y = s.y - outer.top + 12;
  const cw = card.offsetWidth || 190, ch = card.offsetHeight || 120;
  if (x + cw > outer.width) x = s.x - outer.left - cw - 12;
  y = Math.max(6, Math.min(y, outer.height - ch - 6));
  card.style.left = `${Math.max(6, x)}px`;
  card.style.top = `${y}px`;
  card.style.opacity = s.inside ? '1' : '0.35';
}
function hidePointCard() { $('#point-card').hidden = true; state.pin = null; clearPin(); }

function nearIdx(arr, v) {
  let bi = 0, bd = 1e18;
  for (let i = 0; i < arr.length; i++) { const d = Math.abs(arr[i] - v); if (d < bd) { bd = d; bi = i; } }
  return bi;
}

boot().catch((err) => {
  console.error(err);
  const l = $('#loading');
  if (l) l.innerHTML = `<div class="err">Could not load the dataset: ${err.message}</div>`;
});
