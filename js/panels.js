// panels.js — analytics beside the map: smooth diurnal curve with 90% band +
// ground obs, seasonal context strip, weather conditions (ERA5, historical),
// decomposition split, exposure/health, click-a-pixel point query.
// Every numeric estimate carries its interval.

import { $, el, fmt, fmtCI, clamp, fitCanvas, smoothPath, compass } from './util.js?v=1786387871';

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
  drawConditions(f);
  drawDiurnal(f);
  drawSeason(f);
  drawWeather(f);
  drawDecomp(f);
  drawHealth(f.year);
  if (pinned) pointQuery(pinned.lat, pinned.lon, true);
}

// ── conditions chip: one-line causal state for the selected hour ─────────────
// Thresholds documented on the method page. The rain-washed state is backed by
// the measured Medellín ground-truth response (rain onset → −3.4 µg/m³ within
// 3 h, 77% of 204 events vs SIATA network; 2026-07-21 analysis).
function classifyConditions(f) {
  const inc = f.T - f.B;                       // local accumulation amplitude
  const bShare = f.T > 0 ? f.B / f.T : 0;
  const rainy = Number.isFinite(f.rain) && f.rain > 0.3;
  const calmShallow = f.wspd < 1.0 && f.blh < 400;
  const lh = Math.floor(((f.tsUTC + LT) % 86400) / 3600);
  const rush = (lh >= 6 && lh <= 9) || (lh >= 17 && lh <= 20);
  if (rainy) return ['rain', 'Rain-washed', 'rain is scavenging particles; levels fall within hours'];
  if (inc <= 0.5 && (f.wspd >= 1.0 || f.blh >= 700))
    return ['vent', 'Well-ventilated', 'deep mixing dilutes local emissions across the basin'];
  if (calmShallow && inc > 0.5)
    return ['stag', 'Stagnant, accumulating', 'calm air under a shallow boundary layer traps emissions'];
  if (bShare > 0.75 && f.T > 15)
    return ['reg', 'Regional transport', 'most of this hour arrives with the regional background'];
  if (rush && inc > 0.5)
    return ['rush', 'Rush-hour build-up', 'traffic emissions accumulating above the background'];
  return ['mild', 'Mixed conditions', 'no single process dominates this hour'];
}

function drawConditions(f) {
  const elc = $('#cond-chip');
  if (!elc) return;
  const [cls, label, why] = classifyConditions(f);
  elc.className = `cond-chip cond-${cls}`;
  elc.innerHTML = `<span class="cond-dot"></span><b>${label}</b><span class="cond-why">${why}</span>`;
}

// ── diurnal cycle: 90% band + smooth median + FECT obs + hour marker ─────────
async function drawDiurnal(f) {
  const s = await store.getScalars(f.year);
  const blind = f.tier === 'vand' && Array.isArray(s.Tv);
  const daySec = Math.floor((f.tsUTC + LT) / 86400) * 86400 - LT;
  const hfrac = city.minuteLabel === '30' ? 0.5 : 0.0;   // native LT sub-hour grid
  const pts = [];                                  // [hour, T, T05, T95]
  const rain = [];                                 // [hour, mm] for the washout bars
  const dayGis = [];                               // gi for each hour of the day
  for (let i = 0; i < s.hours_utc.length; i++) {
    const lt = s.hours_utc[i] + LT;
    if (Math.floor(lt / 86400) * 86400 - LT === daySec) {
      const h = new Date(lt * 1000).getUTCHours() + hfrac;
      if (blind) pts.push([h, Math.max(s.Tv[i], 0), Math.max(s.Tv05[i], 0), Math.max(s.Tv95[i], 0)]);
      else pts.push([h, s.basin[i], s.T05[i], s.T95[i]]);
      // hourly rain (mm) for the washout bars — the removal process made visible, so a
      // clean day explains itself. Absent rain (IMERG gap) ships null and is skipped.
      if (s.rain && s.rain[i] != null && s.rain[i] > 0.04) rain.push([h, s.rain[i]]);
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
  const fcst = store.isForecast(f.year);
  diurnalChart($('#diurnal-canvas'), pts, obs, markHour, pixLine, rain, { fcst });
  if (fcst) {
    // Band-first on a forecast day: the interval is the claim, the median is a
    // hairline through it. Nothing here can be checked against a Kandy station.
    const lo = Math.min(...pts.map((p) => p[2])), hi = Math.max(...pts.map((p) => p[3]));
    $('#diurnal-note').innerHTML =
      `<span class="dot dot-band"></span> <b>90% range ${fmt(lo)} – ${fmt(hi)} µg/m³</b>`
      + ` (widened for out-of-regime use) · <span class="dot dot-line"></span> most likely`
      + ` · <span class="fc-flag">forecast, no local verification</span>`;
    return;
  }
  const loc = pinnedPx != null
    ? ` · <span class="dot dot-loc"></span> clicked location` : '';
  const rainLeg = rain.length
    ? ` · <span class="dot dot-rain"></span> rain (${rain.reduce((a, r) => a + r[1], 0).toFixed(1)} mm)`
    : '';
  $('#diurnal-note').innerHTML = (obs.length
    ? `<span class="dot dot-line"></span> basin mean · <span class="dot dot-band"></span> 90% band · `
      + `<span class="dot dot-obs"></span> ${city.obsLabel} (${obs.length} h)`
    : `<span class="dot dot-line"></span> basin mean · <span class="dot dot-band"></span> 90% band`)
    + rainLeg + loc;
}

function diurnalChart(canvas, pts, obs, markHour, pixLine, rain = [], opts = {}) {
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

  // rain bars, drawn from the baseline upward BEHIND the PM curve. Scaled against a
  // 10 mm/h reference and capped at a third of the plot so heavy rain never hides the
  // pollution trace; this is the removal process the user asked to see, and it makes
  // "why was today clean" answerable at a glance.
  if (rain.length) {
    const bw = Math.max(3, (W - pad.l - pad.r) / 26);
    for (const [h, mm] of rain) {
      const frac = Math.min(1, mm / 10);
      const bh = frac * (H - pad.t - pad.b) * 0.34;
      const grd = ctx.createLinearGradient(0, H - pad.b - bh, 0, H - pad.b);
      grd.addColorStop(0, 'rgba(74,163,255,0.42)');
      grd.addColorStop(1, 'rgba(74,163,255,0.10)');
      ctx.fillStyle = grd;
      ctx.fillRect(X(h) - bw / 2, H - pad.b - bh, bw, bh);
    }
  }

  // 90% band (T05..T95)
  const up = pts.map((p) => [X(p[0]), Y(p[3])]);
  const dn = pts.map((p) => [X(p[0]), Y(p[2])]).reverse();
  ctx.beginPath(); smoothPath(ctx, up);
  const first = dn[0]; ctx.lineTo(first[0], first[1]);
  smoothPath(ctx, dn); ctx.closePath();
  // forecast days show the band as the primary object (opaque fill + an outline);
  // historical days keep it as context behind a validated median.
  ctx.fillStyle = opts.fcst ? 'rgba(197,138,249,0.26)' : 'rgba(86,200,255,0.10)';
  ctx.fill();
  if (opts.fcst) {
    ctx.strokeStyle = 'rgba(197,138,249,0.75)'; ctx.lineWidth = 1.2; ctx.stroke();
  }

  // area under the median (soft gradient) — omitted on a forecast day so the filled
  // area cannot read as the answer
  const line = pts.map((p) => [X(p[0]), Y(p[1])]);
  if (!opts.fcst) {
    const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
    grad.addColorStop(0, 'rgba(240,163,90,0.28)');
    grad.addColorStop(1, 'rgba(240,163,90,0.02)');
    ctx.beginPath(); smoothPath(ctx, line);
    ctx.lineTo(line[line.length - 1][0], Y(0)); ctx.lineTo(line[0][0], Y(0)); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
  }

  // median line — a thin dashed hairline when forecasting, a solid line otherwise
  ctx.beginPath(); smoothPath(ctx, line);
  if (opts.fcst) {
    ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(245,240,255,0.8)'; ctx.lineWidth = 1.1;
  } else {
    ctx.strokeStyle = '#f0a35a'; ctx.lineWidth = 2.2;
  }
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.setLineDash([]);

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
  // A forecast covers a few days, so its "monthly means" would be one bar; show the
  // most recent complete record year instead and say which year that is.
  const year = store.isForecast(f.year)
    ? store.meta.years[store.meta.years.length - 1] : f.year;
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
  // level-only hours: the modelled level exists but no meteorology does. Say that,
  // rather than rendering an empty panel that reads like a loading failure.
  if (store.isForecast(f.year) && !store.hasMet(f.year, f.gi)) {
    $('#weather-body').innerHTML =
      `<p class="hnote">Weather is not available for these hours. They sit between the
       end of the reconstructed record and the current analysis window, so only a
       modelled PM<sub>2.5</sub> level survives; wind and temperature are withheld
       rather than taken from a different source.</p>`;
    const wn0 = $('#weather-note'); if (wn0) wn0.textContent = '';
    return;
  }
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
// Annual background/local split for a year, computed from the shipped scalars.
// This is the resolution the split is IDENTIFIED at: a daily-resolution background
// against an hourly total imposes an arithmetic floor on the local share, and the
// hourly split sits below that floor in most months (model reference F.17). The
// annual figure is coherent and is what the paper claims, so the panel leads with it
// and treats the per-hour numbers as secondary.
const annualSplitCache = new Map();
async function annualSplit(year) {
  if (annualSplitCache.has(year)) return annualSplitCache.get(year);
  let out = null;
  try {
    const s = await store.getScalars(year);
    let sT = 0, sB = 0, n = 0;
    for (let i = 0; i < s.T.length; i++) {
      const T = s.T[i], B = s.B[i];
      if (Number.isFinite(T) && Number.isFinite(B)) { sT += T; sB += B; n++; }
    }
    if (n) out = { T: sT / n, B: sB / n, fLocal: 1 - (sB / n) / (sT / n) };
  } catch { /* forecast tier or missing year: no annual figure */ }
  annualSplitCache.set(year, out);
  return out;
}

async function drawDecomp(f) {
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
  // UNRESOLVED HOURS. The background is estimated at daily resolution against an
  // hourly total, and on ventilated hours the estimate lands at or above the total —
  // 28.5% of the record, concentrated April to December. On those hours the model
  // cannot separate local from regional: the increment is zero or negative and the
  // field is spatially uniform by construction. Saying so is more truthful than
  // printing "0%" beside a flat map, which reads as "there is no local emission".
  // Five reformulations of the background were built and rejected on measurement
  // (model reference F.13, F.15, F.17, F.18); the resolution needs a local monitor,
  // so the honest interim is to label the limitation where the viewer meets it.
  const unresolved = (basin - B) <= 0.05;
  const ann = await annualSplit(f.year);
  // The ANNUAL split leads: it is the quantity the model identifies and the paper
  // claims. The per-hour split follows as secondary, and is withheld entirely on the
  // hours where the background estimate meets or exceeds the total.
  const annLine = ann
    ? `<b>Annual average ${f.year}:</b> ${fmt(100 * ann.fLocal, 0)}% local · `
      + `${fmt(100 * (1 - ann.fLocal), 0)}% regional background `
      + `<span class="dim">(${fmt(ann.B)} of ${fmt(ann.T)} µg/m³)</span>`
    : '';
  // On these hours the background estimate meets or exceeds the modelled total. That is
  // NOT a statement that local emissions stopped — traffic, cooking and waste burning
  // continue every hour of every day, so the local increment at an emitting location is
  // strictly positive at all times, including in rain. It means the BACKGROUND ESTIMATE IS
  // TOO HIGH for this hour. We therefore refuse to print a percentage rather than print a
  // zero, and we say which quantity is at fault. (The map still carries structure: the
  // shipped tier applies a ventilated-hour pattern floor, so it is not flat — earlier
  // wording here said "uniform by construction", which described the locked tier and was
  // stale for the tier actually served.)
  const hourLine = unresolved
    ? `<span class="unres">This hour: the split cannot be computed.</span> The estimated `
      + `background (${fmtCI(B, f.bLo, f.bHi)} µg/m³) is at or above the modelled total, `
      + `which means <b>the background is over-estimated for this hour</b>, not that local `
      + `emissions stopped. Local sources emit continuously, so the true local share here is `
      + `above zero; the model cannot say by how much. The map still shows the local `
      + `pattern. Most common April–December.`
    : `This hour: background ${fmtCI(B, f.bLo, f.bHi)} µg/m³ (${fmt(100 - pctLocal, 0)}%) · `
      + `local <b>${fmt(localBasin)}</b> µg/m³ (${fmt(pctLocal, 0)}%). Indicative; the `
      + `split is identified annually, not hourly.`;
  $('#decomp-note').innerHTML =
    (annLine ? annLine + '<br>' : '') + hourLine
    + ` <a href="method.html#split" target="_blank">why</a>`;
}

// ── exposure & health (intervals always shown) ────────────────────────────────
async function drawHealth(year) {
  if (!city.features.health || !$('#health-body')) return;
  if (store.isForecast(year)) {
    // Exposure and burden are annual quantities from the completed record. A
    // 5-day forecast cannot contribute to them, and showing the last year's
    // numbers beside a forecast hour would imply it had.
    const yl = $('#health-year'); if (yl) yl.textContent = 'annual record';
    $('#health-body').innerHTML =
      `<p class="hnote">Exposure and health burden are annual figures from the
       reconstructed record. They are not computed for forecast hours — pick a date
       inside the record to see them.</p>`;
    return;
  }
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
