// app.js — Kandy PM2.5 Explorer orchestrator.

import { $, el, fmt, fmtCI, clamp } from './util.js';
import { Store } from './store.js';
import { colourMode, paintField, paintColourbar } from './field.js';
import { WindLayer } from './wind.js';
import { Timeline } from './timeline.js';
import { Overlay } from './overlay.js';
import { initPanels, updatePanels } from './panels.js';
import { downloadPNG, downloadFieldCSV, downloadPointCSV } from './download.js';

const MAP = 840;                    // internal map canvas resolution (square)
const LT_OFFSET = 5.5 * 3600;       // Asia/Colombo = UTC+5:30

const state = { year: null, gi: 0, playing: false, showUQ: false,
                scaleMode: 'auto', cur: null, pin: null };

const store = new Store();
let timeline, wind, overlay, hillCtx;

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
  return ['DJF', 'DJF', 'MAM', 'MAM', 'MAM', 'JJA', 'JJA', 'JJA', 'SON', 'SON', 'SON', 'DJF'][month - 1];
}
function daypart(h) {
  return h < 6 ? 'night' : h < 10 ? 'morning rush' : h < 16 ? 'midday'
       : h < 20 ? 'evening rush' : 'night';
}

async function boot() {
  await store.init();
  const bbox = store.meta.grid.bbox;

  // map stack
  const stack = $('#mapstack');
  for (const id of ['hill', 'field', 'wind', 'vec']) {
    const cv = el('canvas', { id: `cv-${id}`, class: 'maplayer', width: MAP, height: MAP });
    stack.append(cv);
  }
  hillCtx = $('#cv-hill').getContext('2d');
  wind = new WindLayer($('#cv-wind'));
  overlay = new Overlay($('#cv-vec'), bbox);
  overlay.setData(store.static.layers, store.static.emission);

  $('#cv-vec').addEventListener('click', (e) => onPixelClick(e));

  timeline = new Timeline($('#timeline'), store.meta.years, (y, gi) => seek(y, gi));

  wireControls();
  wireDatetime();
  initPanels(store, (y, gi) => seek(y, gi));

  // preload all years' scalars for the strip (small, gzip over the wire)
  for (const y of store.meta.years) {
    const s = await store.getScalars(y);
    timeline.addYear(y, s);
  }

  $('#integrity-text').textContent = store.meta.integrity;
  buildEpisodes();
  buildCredits();

  // initial view: a documented episode
  const ep = store.meta.episodes.find((e) => e.id === 'dec2022') || store.meta.episodes[0];
  await seekToTs(ep.ts);
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
  state.year = year;
  const s = await store.getScalars(year);
  state.gi = clamp(gi, 0, s.hours_utc.length - 1);
  const f = await store.field(year, state.gi);
  state.cur = f;
  render(f);
  timeline.setCursor(year, state.gi);
  syncDatetime(f.tsUTC);
  const wf = await store.windField(year, state.gi);
  wind.setField(wf);
  updatePanels(f);
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
  paintField($('#cv-field'), q, cm);
  overlay.draw();
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
  $('#map-title').innerHTML =
    `<b>${day} ${hm}</b> <span class="dim">Sri Lanka time</span> · ${seasonOf(month)}, ${daypart(lh)}`
    + `<span class="readout">basin ${fmtCI(f.basin, f.basin05, f.basin95)} · `
    + `core ${fmtCI(f.core, f.core05, f.core95)} µg/m³</span>`
    + (state.showUQ ? ' <span class="uqtag">showing 90% upper bound</span>' : '');
}

// ── date & time dropdowns ─────────────────────────────────────────────────────
function wireDatetime() {
  const ySel = $('#sel-year'), mSel = $('#sel-month'), dSel = $('#sel-day'), hSel = $('#sel-hour');
  for (const y of store.meta.years) ySel.append(el('option', { value: y }, String(y)));
  MONTHS.forEach((m, i) => mSel.append(el('option', { value: i + 1 }, m)));
  for (let h = 0; h < 24; h++)
    hSel.append(el('option', { value: h }, `${String(h).padStart(2, '0')}:30`));
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
             + ` ${String(hSel.value).padStart(2, '0')}:30`;
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
  for (const btn of document.querySelectorAll('.seg-btn')) {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.scaleMode = btn.dataset.mode;
      if (state.cur) render(state.cur);
    });
  }
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
  $('#dl-png').addEventListener('click', () => state.cur && downloadPNG(store, state.cur));
  $('#dl-csv').addEventListener('click', () => state.cur && downloadFieldCSV(store, state.cur));
  $('#dl-point').addEventListener('click', () => {
    if (state.cur && state.pin) downloadPointCSV(store, state.cur, state.pin.lat, state.pin.lon);
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
  const r = e.target.getBoundingClientRect();
  const bbox = store.meta.grid.bbox;
  const lon = bbox[0] + (e.clientX - r.left) / r.width * (bbox[2] - bbox[0]);
  const lat = bbox[1] + (1 - (e.clientY - r.top) / r.height) * (bbox[3] - bbox[1]);
  state.pin = { lat, lon };
  $('#dl-point').disabled = false;
  const { pointQuery } = await import('./panels.js');
  pointQuery(lat, lon);
}

boot().catch((err) => {
  console.error(err);
  const l = $('#loading');
  if (l) l.innerHTML = `<div class="err">Could not load the dataset: ${err.message}</div>`;
});
