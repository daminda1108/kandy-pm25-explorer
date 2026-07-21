// panels.js — analytics beside the map: smooth diurnal curve with 90% band +
// ground obs, seasonal context strip, weather conditions (ERA5, historical),
// decomposition split, exposure/health, click-a-pixel point query.
// Every numeric estimate carries its interval.

import { $, el, fmt, fmtCI, clamp, fitCanvas, smoothPath, compass } from './util.js?v=1784612562';

let store, seekCb, curField, city;
let LT = 5.5 * 3600;

export function initPanels(s, seek, c) { store = s; seekCb = seek; city = c; LT = c.tzOffsetH * 3600; }

// Panel inner width for chart canvases: clamp so a wide layout (or a transient
// mis-measure) can never feed back into the canvas size.
function panelW(cv) {
  return clamp(cv.parentElement.clientWidth - 34, 180, 620);
}

export function updatePanels(f) {
  curField = f;
  drawDiurnal(f);
  drawSeason(f);
  drawWeather(f);
  drawDecomp(f);
  drawHealth(f.year);
  if (pinned) pointQuery(pinned.lat, pinned.lon, true);
}

// ── diurnal cycle: 90% band + smooth median + FECT obs + hour marker ─────────
async function drawDiurnal(f) {
  const s = await store.getScalars(f.year);
  const blind = f.tier === 'vand' && Array.isArray(s.Tv);
  const daySec = Math.floor((f.tsUTC + LT) / 86400) * 86400 - LT;
  const hfrac = city.minuteLabel === '30' ? 0.5 : 0.0;   // native LT sub-hour grid
  const pts = [];                                  // [hour, T, T05, T95]
  const dayGis = [];                               // gi for each hour of the day
  for (let i = 0; i < s.hours_utc.length; i++) {
    const lt = s.hours_utc[i] + LT;
    if (Math.floor(lt / 86400) * 86400 - LT === daySec) {
      const h = new Date(lt * 1000).getUTCHours() + hfrac;
      if (blind) pts.push([h, Math.max(s.Tv[i], 0), Math.max(s.Tv05[i], 0), Math.max(s.Tv95[i], 0)]);
      else pts.push([h, s.basin[i], s.T05[i], s.T95[i]]);
      dayGis.push([h, i]);
    }
  }
  pts.sort((a, b) => a[0] - b[0]);
  const dayStr = new Date((f.tsUTC + LT) * 1000).toISOString().slice(0, 10);
  let obs = [];
  if (city.features.fect) {
    try {
      const fe = await store.getFect(f.year);
      obs = fe.obs.filter((o) => o.d === dayStr).map((o) => [o.h + hfrac, o.v]);
    } catch { /* no obs */ }
  }
  // clicked-location diurnal: reconstruct that pixel across the day's hours so the
  // viewer SEES how the local diurnal amplitude differs from the basin mean.
  let pixLine = null;
  if (pinnedPx != null) {
    pixLine = [];
    for (const [h, gi] of dayGis.sort((a, b) => a[0] - b[0])) {
      const fld = await store.field(f.year, gi, f.tier);
      pixLine.push([h, fld.q50[pinnedPx]]);
    }
  }
  const markHour = new Date((f.tsUTC + LT) * 1000).getUTCHours() + hfrac;
  diurnalChart($('#diurnal-canvas'), pts, obs, markHour, pixLine);
  const loc = pinnedPx != null
    ? ` · <span class="dot dot-loc"></span> clicked location` : '';
  $('#diurnal-note').innerHTML = (obs.length
    ? `<span class="dot dot-line"></span> basin mean · <span class="dot dot-band"></span> 90% band · `
      + `<span class="dot dot-obs"></span> ${city.obsLabel} (${obs.length} h)`
    : `<span class="dot dot-line"></span> basin mean · <span class="dot dot-band"></span> 90% band`) + loc;
}

function diurnalChart(canvas, pts, obs, markHour, pixLine) {
  const { ctx, w: W, h: H } = fitCanvas(canvas, panelW(canvas), 168);
  ctx.clearRect(0, 0, W, H);
  if (!pts.length) return;
  const pad = { l: 34, r: 10, t: 10, b: 20 };
  const all = pts.flatMap((p) => [p[3]]).concat(obs.map((o) => o[1]), pts.map((p) => p[1]),
    (pixLine || []).map((p) => p[1]));
  const ymax = Math.max(10, ...all) * 1.12, ymin = 0;
  const X = (h) => pad.l + (h / 24) * (W - pad.l - pad.r);
  const Y = (v) => H - pad.b - ((v - ymin) / (ymax - ymin)) * (H - pad.t - pad.b);

  // gridlines + axis labels
  ctx.font = '9.5px Inter'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const step = niceStep(ymax);
  for (let v = 0; v <= ymax; v += step) {
    ctx.strokeStyle = 'rgba(200,210,225,0.07)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(W - pad.r, Y(v)); ctx.stroke();
    ctx.fillStyle = 'rgba(210,220,235,0.55)';
    ctx.fillText(v.toFixed(0), pad.l - 5, Y(v));
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  for (const h of [0, 6, 12, 18, 24]) {
    ctx.fillStyle = 'rgba(210,220,235,0.55)';
    ctx.fillText(String(h).padStart(2, '0'), X(h), H - 6);
  }

  // 90% band (T05..T95)
  const up = pts.map((p) => [X(p[0]), Y(p[3])]);
  const dn = pts.map((p) => [X(p[0]), Y(p[2])]).reverse();
  ctx.beginPath(); smoothPath(ctx, up);
  const first = dn[0]; ctx.lineTo(first[0], first[1]);
  smoothPath(ctx, dn); ctx.closePath();
  ctx.fillStyle = 'rgba(86,200,255,0.10)';
  ctx.fill();

  // area under the median (soft gradient)
  const line = pts.map((p) => [X(p[0]), Y(p[1])]);
  const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
  grad.addColorStop(0, 'rgba(240,163,90,0.28)');
  grad.addColorStop(1, 'rgba(240,163,90,0.02)');
  ctx.beginPath(); smoothPath(ctx, line);
  ctx.lineTo(line[line.length - 1][0], Y(0)); ctx.lineTo(line[0][0], Y(0)); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // median line
  ctx.beginPath(); smoothPath(ctx, line);
  ctx.strokeStyle = '#f0a35a'; ctx.lineWidth = 2.2; ctx.lineJoin = 'round';
  ctx.stroke();

  // clicked-location line (dashed cyan) — shows the local diurnal amplitude
  if (pixLine && pixLine.length) {
    const pl = pixLine.map((p) => [X(p[0]), Y(p[1])]);
    ctx.beginPath(); smoothPath(ctx, pl);
    ctx.strokeStyle = '#56c8ff'; ctx.lineWidth = 1.8; ctx.lineJoin = 'round';
    ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
  }

  // hour marker: vertical guide + dot on the curve
  if (markHour != null) {
    ctx.strokeStyle = 'rgba(86,200,255,0.5)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(X(markHour), pad.t); ctx.lineTo(X(markHour), H - pad.b); ctx.stroke();
    ctx.setLineDash([]);
    const near = pts.reduce((a, p) => (Math.abs(p[0] - markHour) < Math.abs(a[0] - markHour) ? p : a));
    ctx.fillStyle = '#56c8ff'; ctx.strokeStyle = 'rgba(8,12,18,0.9)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(X(near[0]), Y(near[1]), 4.2, 0, 7); ctx.fill(); ctx.stroke();
  }

  // ground obs
  ctx.fillStyle = '#38b76a'; ctx.strokeStyle = 'rgba(8,12,18,0.8)'; ctx.lineWidth = 1.2;
  for (const o of obs) {
    ctx.beginPath(); ctx.arc(X(o[0]), Y(o[1]), 2.8, 0, 7); ctx.fill(); ctx.stroke();
  }
}

function niceStep(ymax) {
  const raw = ymax / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}

// ── seasonal context: monthly means for the year, current month highlighted ──
const seasonCache = new Map();
async function drawSeason(f) {
  const year = f.year;
  if (!seasonCache.has(year)) {
    const s = await store.getScalars(year);
    const sums = new Array(12).fill(0), n = new Array(12).fill(0);
    for (let i = 0; i < s.hours_utc.length; i++) {
      const m = new Date((s.hours_utc[i] + LT) * 1000).getUTCMonth();
      sums[m] += s.basin[i]; n[m]++;
    }
    seasonCache.set(year, sums.map((v, i) => (n[i] ? v / n[i] : 0)));
  }
  const monthly = seasonCache.get(year);
  const yl = $('#season-year'); if (yl) yl.textContent = year;
  const curM = new Date((f.tsUTC + LT) * 1000).getUTCMonth();
  const { ctx, w: W, h: H } = fitCanvas($('#season-canvas'), panelW($('#season-canvas')), 74);
  ctx.clearRect(0, 0, W, H);
  const pad = { l: 34, r: 10, t: 6, b: 16 };
  const ymax = Math.max(...monthly) * 1.15;
  const bw = (W - pad.l - pad.r) / 12;
  const names = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  for (let m = 0; m < 12; m++) {
    const x = pad.l + m * bw, hgt = (monthly[m] / ymax) * (H - pad.t - pad.b);
    const y = H - pad.b - hgt;
    ctx.fillStyle = m === curM ? '#f0a35a' : 'rgba(240,163,90,0.28)';
    roundRect(ctx, x + 1.5, y, bw - 3, hgt, 2.5); ctx.fill();
    ctx.fillStyle = m === curM ? 'rgba(240,220,200,0.95)' : 'rgba(210,220,235,0.45)';
    ctx.font = m === curM ? '600 9px Inter' : '9px Inter';
    ctx.textAlign = 'center';
    ctx.fillText(names[m], x + bw / 2, H - 5);
  }
  ctx.fillStyle = 'rgba(210,220,235,0.55)'; ctx.font = '9.5px Inter'; ctx.textAlign = 'right';
  ctx.fillText(ymax.toFixed(0), pad.l - 5, pad.t + 8);
  ctx.fillText('0', pad.l - 5, H - pad.b);
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, Math.max(h / 2, 0.1));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, 0);
  ctx.arcTo(x, y + h, x, y, 0);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ── weather conditions (ERA5 reanalysis for the selected hour) ───────────────
function drawWeather(f) {
  const rows = [];
  const arrow = `<span class="warrow" style="transform:rotate(${(f.wdir + 180) % 360}deg)">↑</span>`;
  if (Number.isFinite(f.t2m)) rows.push([city.t2mLabel || 'Temperature', `<b>${fmt(f.t2m)}</b> °C`]);
  if (Number.isFinite(f.rh)) rows.push(['Humidity', `<b>${fmt(f.rh, 0)}</b> %`]);
  if (Number.isFinite(f.rain))
    rows.push([city.rainLabel || 'Rain (this hour)',
               f.rain > 0.04 ? `<b>${fmt(f.rain, 1)}</b> mm` : '<b>0</b> mm']);
  rows.push(['Wind', `<b>${fmt(f.wspd)}</b> m/s ${arrow} from ${compass(f.wdir)} (${fmt(f.wdir, 0)}°)`]);
  const mix = f.blh < 400 ? ['shallow', 'limited mixing'] : f.blh < 800
    ? ['moderate', 'partial mixing'] : ['deep', 'well mixed'];
  rows.push(['Boundary layer', `<b>${fmt(f.blh, 0)}</b> m <span class="chip chip-${mix[0]}">${mix[1]}</span>`]);
  $('#weather-body').innerHTML = rows.map(([k, v]) =>
    `<div class="hrow"><span>${k}</span><span class="hval">${v}</span></div>`).join('');
  const wn = $('#weather-note');
  if (wn) wn.textContent = [city.windCaveat, city.rainCaveat].filter(Boolean).join(' ');
}

// ── decomposition split (regional background vs local increment) ─────────────
function drawDecomp(f) {
  const B = f.B, basin = f.basin, core = f.core;
  const localBasin = Math.max(basin - B, 0), localCore = Math.max(core - B, 0);
  const pctLocal = basin > 0 ? (localBasin / basin) * 100 : 0;
  const cv = $('#decomp-canvas');
  const { ctx, w: W, h: H } = fitCanvas(cv, panelW(cv), 108);
  ctx.clearRect(0, 0, W, H);
  const rows = [['basin mean', B, localBasin], ['city centre', B, localCore]];
  const maxv = Math.max(basin, core) * 1.18 + 1;
  const x0 = 78, bw = W - x0 - 46, bh = 20;
  rows.forEach(([lab, bg, loc], i) => {
    const y = 14 + i * 44;
    ctx.fillStyle = 'rgba(210,220,235,0.75)'; ctx.font = '10.5px Inter'; ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(lab, x0 - 8, y + bh / 2);
    const wB = (bg / maxv) * bw, wL = (loc / maxv) * bw;
    ctx.fillStyle = '#4b8fd4'; roundRect(ctx, x0, y, wB, bh, 4); ctx.fill();
    ctx.fillStyle = '#e6672a';
    if (wL > 0.5) { roundRect(ctx, x0 + wB, y, wL, bh, 4); ctx.fill(); }
    // B uncertainty whisker (background bracket)
    const xlo = x0 + (f.bLo / maxv) * bw, xhi = x0 + (f.bHi / maxv) * bw;
    ctx.strokeStyle = 'rgba(240,246,255,0.65)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(xlo, y + bh / 2); ctx.lineTo(xhi, y + bh / 2); ctx.stroke();
    for (const xx of [xlo, xhi]) {
      ctx.beginPath(); ctx.moveTo(xx, y + bh / 2 - 3.5); ctx.lineTo(xx, y + bh / 2 + 3.5); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(235,240,248,0.9)'; ctx.font = '600 10.5px Inter'; ctx.textAlign = 'left';
    ctx.fillText(fmt(bg + loc, 1), x0 + wB + wL + 7, y + bh / 2);
  });
  ctx.textBaseline = 'alphabetic';
  $('#decomp-note').innerHTML =
    `Regional background ${fmtCI(B, f.bLo, f.bHi)} µg/m³ (${fmt(100 - pctLocal, 0)}%) · `
    + `local increment <b>${fmt(localBasin)}</b> µg/m³ (${fmt(pctLocal, 0)}%)`;
}

// ── exposure & health (intervals always shown) ────────────────────────────────
async function drawHealth(year) {
  if (!city.features.health || !$('#health-body')) return;
  const h = await store.getHealth();
  const d = h.per_year[year] || h.per_year[String(year)];
  const yl = $('#health-year'); if (yl) yl.textContent = year;
  if (!d) { $('#health-body').innerHTML = ''; return; }
  let html = `
    <div class="hrow"><span>Area mean (annual)</span><span class="hval"><b>${fmt(d.area_mean)}</b> µg/m³</span></div>
    <div class="hrow"><span>Population-weighted</span><span class="hval"><b>${fmt(d.pop_weighted)}</b> µg/m³</span></div>
    <div class="hrow"><span>Populated core</span><span class="hval"><b>${fmt(d.core)}</b> µg/m³</span></div>`;
  if (d.attributable_deaths != null && d.deaths_ci) {
    html += `
    <div class="hsep"></div>
    <div class="hrow"><span>Attributable deaths / yr</span>
      <span class="hval"><b>${d.attributable_deaths}</b> <span class="iv">[${d.deaths_ci[0]}–${d.deaths_ci[1]}]</span></span></div>
    <div class="hrow"><span>Attributable fraction</span><span class="hval"><b>${fmt(d.attributable_fraction_pct)}</b> %</span></div>
    <div class="hrow"><span>Population</span><span class="hval"><b>${d.population.toLocaleString()}</b></span></div>
    <p class="hnote">GEMM exposure-response (${h.burden_note}). The interval reflects the
      exposure-response uncertainty; read the range, not only the central value.</p>`;
  } else {
    html += `<p class="hnote">The full burden calculation uses the 2023 headline year
      (${burdenHeadline(h)}). Exposure metrics are shown for every year.</p>`;
  }
  $('#health-body').innerHTML = html;
}

function burdenHeadline(h) {
  const d = h.per_year['2023'] || {};
  return d.attributable_deaths
    ? `${d.attributable_deaths} [${d.deaths_ci[0]}–${d.deaths_ci[1]}] deaths/yr` : 'n/a';
}

// ── click-a-pixel point query ────────────────────────────────────────────────
let pinned = null, pinnedPx = null;
export async function pointQuery(lat, lon, silent = false) {
  if (!curField) return;
  pinned = { lat, lon };
  const g = store.meta.grid;
  const li = nearest(g.lats, lat), lj = nearest(g.lons, lon);
  const px = li * g.n_lon + lj;
  pinnedPx = px;
  const f = curField;
  const val = f.q50[px], lo = f.q05[px], hi = f.q95[px];
  const elev = store.static.fields.elev[li][lj];
  const B = f.B, local = Math.max(val - B, 0);
  $('#point-body').innerHTML = `
    <div class="hrow"><span>Location</span><span class="hval"><b>${lat.toFixed(4)}, ${lon.toFixed(4)}</b></span></div>
    <div class="hrow"><span>Elevation</span><span class="hval"><b>${fmt(elev, 0)}</b> m</span></div>
    <div class="hrow"><span>PM₂.₅ (this hour)</span><span class="hval">${fmtCI(val, lo, hi)} µg/m³</span></div>
    <div class="hrow"><span>Background / local</span><span class="hval"><b>${fmt(B)}</b> / <b>${fmt(local)}</b> µg/m³</span></div>`;
  $('#point-panel').classList.add('show');
  drawDiurnal(curField);              // overlay this location's own diurnal curve
}

// Clear the pinned-location overlay (called when the point card is dismissed).
export function clearPin() { pinned = null; pinnedPx = null; if (curField) drawDiurnal(curField); }

function nearest(arr, v) {
  let bi = 0, bd = 1e18;
  for (let i = 0; i < arr.length; i++) { const d = Math.abs(arr[i] - v); if (d < bd) { bd = d; bi = i; } }
  return bi;
}
