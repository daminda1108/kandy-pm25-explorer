// panels.js — right-rail analytics: decomposition split, diurnal curve + FECT obs,
// exposure/health (CI always), and click-a-pixel point query.

import { $, el, fmt, clamp } from './util.js';

let store, seekCb, curField, curExtra;

export function initPanels(s, seek) {
  store = s; seekCb = seek;
  $('#uq2')?.addEventListener('change', (e) => {
    // mirror the map UQ toggle handled in app.js; nothing extra here
  });
}

export function updatePanels(f, extra) {
  curField = f; curExtra = extra;
  drawDecomp(f);
  drawDiurnal(f);
  drawHealth(f.year);
  // if a pixel is pinned, refresh its readout for the new hour
  if (pinned) pointQuery(pinned.lat, pinned.lon, true);
}

// ── decomposition split (regional B vs local increment) ──────────────────────
function drawDecomp(f) {
  const B = f.B, basin = f.basin, core = f.core;
  const localBasin = Math.max(basin - B, 0), localCore = Math.max(core - B, 0);
  const pctLocal = basin > 0 ? (localBasin / basin) * 100 : 0;
  const c = $('#decomp-canvas'), ctx = c.getContext('2d');
  const W = c.width, H = c.height; ctx.clearRect(0, 0, W, H);
  const bars = [['basin', B, localBasin], ['core', B, localCore]];
  const maxv = Math.max(core, basin, B + localCore) * 1.15 + 1;
  const bw = 46, gap = 60, x0 = 40;
  bars.forEach(([lab, bg, loc], i) => {
    const x = x0 + i * (bw + gap);
    const hb = (bg / maxv) * (H - 26), hl = (loc / maxv) * (H - 26);
    ctx.fillStyle = '#5b9bd5'; ctx.fillRect(x, H - 20 - hb, bw, hb);
    ctx.fillStyle = '#e6672a'; ctx.fillRect(x, H - 20 - hb - hl, bw, hl);
    ctx.fillStyle = 'rgba(230,235,245,0.85)'; ctx.font = '11px Inter'; ctx.textAlign = 'center';
    ctx.fillText(lab, x + bw / 2, H - 6);
    ctx.fillText(fmt(bg + loc, 0), x + bw / 2, H - 24 - hb - hl);
  });
  $('#decomp-note').innerHTML =
    `Regional background <b>${fmt(B)}</b> (${fmt(100 - pctLocal, 0)}%) · `
    + `local increment <b>${fmt(localBasin)}</b> (${fmt(pctLocal, 0)}%) µg m⁻³`;
}

// ── diurnal cycle for the current day (+ FECT obs where available) ────────────
async function drawDiurnal(f) {
  const s = await store.getScalars(f.year);
  const daySec = Math.floor((f.tsUTC + 5.5 * 3600) / 86400) * 86400 - 5.5 * 3600;
  const pts = [];
  for (let i = 0; i < s.hours_utc.length; i++) {
    const lt = s.hours_utc[i] + 5.5 * 3600;
    if (Math.floor((lt) / 86400) * 86400 - 5.5 * 3600 === daySec) {
      const h = new Date(lt * 1000).getUTCHours();
      pts.push([h, s.basin[i], i]);
    }
  }
  pts.sort((a, b) => a[0] - b[0]);
  // FECT obs for this day
  const dayStr = new Date((f.tsUTC + 5.5 * 3600) * 1000).toISOString().slice(0, 10);
  let obs = [];
  try {
    const fe = await store.getFect(f.year);
    obs = fe.obs.filter((o) => o.d === dayStr).map((o) => [o.h, o.v]);
  } catch { /* no fect */ }
  lineChart($('#diurnal-canvas'), pts.map((p) => [p[0], p[1]]), obs,
            new Date((f.tsUTC + 5.5 * 3600) * 1000).getUTCHours());
  $('#diurnal-note').textContent =
    obs.length ? `green squares = FECT Akurana ground obs (${obs.length} h)` : 'model basin mean';
}

function lineChart(canvas, series, obs, markHour) {
  const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const pad = { l: 30, r: 8, t: 8, b: 18 };
  const all = series.map((p) => p[1]).concat(obs.map((o) => o[1]));
  const ymax = Math.max(10, ...all) * 1.15, ymin = 0;
  const X = (h) => pad.l + (h / 23) * (W - pad.l - pad.r);
  const Y = (v) => H - pad.b - ((v - ymin) / (ymax - ymin)) * (H - pad.t - pad.b);
  // axes
  ctx.strokeStyle = 'rgba(200,210,225,0.25)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, H - pad.b); ctx.lineTo(W - pad.r, H - pad.b); ctx.stroke();
  ctx.fillStyle = 'rgba(210,220,235,0.7)'; ctx.font = '9px Inter'; ctx.textAlign = 'right';
  [0, ymax / 2, ymax].forEach((v) => ctx.fillText(v.toFixed(0), pad.l - 3, Y(v) + 3));
  ctx.textAlign = 'center';
  [0, 6, 12, 18].forEach((h) => ctx.fillText(h, X(h), H - 5));
  // marker
  if (markHour != null) {
    ctx.strokeStyle = 'rgba(77,208,255,0.6)'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(X(markHour), pad.t); ctx.lineTo(X(markHour), H - pad.b); ctx.stroke();
    ctx.setLineDash([]);
  }
  // model line
  ctx.strokeStyle = '#f0a35a'; ctx.lineWidth = 2; ctx.beginPath();
  series.forEach((p, i) => { const x = X(p[0]), y = Y(p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  // obs
  ctx.fillStyle = '#38b76a';
  for (const o of obs) { ctx.fillRect(X(o[0]) - 2, Y(o[1]) - 2, 4, 4); }
}

// ── exposure & health (always with CI) ───────────────────────────────────────
async function drawHealth(year) {
  const h = await store.getHealth();
  const d = h.per_year[year] || h.per_year[String(year)];
  const yl = $('#health-year'); if (yl) yl.textContent = year;
  if (!d) { $('#health-body').innerHTML = ''; return; }
  let html = `
    <div class="hrow"><span>Area mean</span><b>${fmt(d.area_mean)}</b> µg m⁻³</div>
    <div class="hrow"><span>Population-weighted</span><b>${fmt(d.pop_weighted)}</b> µg m⁻³</div>
    <div class="hrow"><span>Populated-core</span><b>${fmt(d.core)}</b> µg m⁻³</div>`;
  if (d.attributable_deaths != null && d.deaths_ci) {
    html += `
    <div class="hsep"></div>
    <div class="hrow"><span>Attributable deaths / yr</span>
      <b>${d.attributable_deaths}</b> <span class="ci">[${d.deaths_ci[0]}–${d.deaths_ci[1]}]</span></div>
    <div class="hrow"><span>Attributable fraction</span><b>${fmt(d.attributable_fraction_pct)}%</b></div>
    <div class="hrow"><span>Population</span><b>${d.population.toLocaleString()}</b></div>
    <p class="hnote">${h.burden_note}. Central estimate with 95% CI; do not cite the point value alone.</p>`;
  } else {
    html += `<p class="hnote">Full GEMM burden was computed for the 2023 headline year
      (select a 2023 hour to view: ≈${burdenHeadline(h)}). Exposure shown for all years.</p>`;
  }
  $('#health-body').innerHTML = html;
}

function burdenHeadline(h) {
  const d = h.per_year['2023'] || {};
  return d.attributable_deaths
    ? `${d.attributable_deaths} [${d.deaths_ci[0]}–${d.deaths_ci[1]}] deaths/yr` : 'n/a';
}

// ── click-a-pixel point query ────────────────────────────────────────────────
let pinned = null;
export async function pointQuery(lat, lon, silent = false) {
  if (!curField) return;
  pinned = { lat, lon };
  const g = store.meta.grid;
  const li = nearest(g.lats, lat), lj = nearest(g.lons, lon);
  const px = li * g.n_lon + lj;
  const f = curField;
  const val = f.q50[px], lo = f.q05[px], hi = f.q95[px];
  const elev = store.static.fields.elev[li][lj];
  const B = f.B, local = Math.max(val - B, 0);
  $('#point-body').innerHTML = `
    <div class="hrow"><span>Location</span><b>${lat.toFixed(4)}, ${lon.toFixed(4)}</b></div>
    <div class="hrow"><span>Elevation</span><b>${fmt(elev, 0)}</b> m</div>
    <div class="hrow"><span>PM₂.₅ (this hour)</span><b>${fmt(val)}</b> µg m⁻³</div>
    <div class="hrow"><span>90% interval</span><b>${fmt(lo)}–${fmt(hi)}</b></div>
    <div class="hrow"><span>Regional / local</span><b>${fmt(B)} / ${fmt(local)}</b></div>`;
  $('#point-panel').classList.add('show');
}

function nearest(arr, v) {
  let bi = 0, bd = 1e18;
  for (let i = 0; i < arr.length; i++) { const d = Math.abs(arr[i] - v); if (d < bd) { bd = d; bi = i; } }
  return bi;
}
