// store.js — payload loading + exact client-side field/wind reconstruction.
//
//   PM(x,y,t) = B(t) + [Tq(t) - B(t)] * P_local(x,y,t)
//   P_local quantised per hour as uint16 over [pmin,pmax]; anchors T,T05,T95 shipped.
// Mirrors scripts/webapp_export.py (QA-gate-verified to 0.0014 ug/m3).

import { getJSON, getGzip } from './util.js';

const BASE = 'data';
const CORE_LAT = 7.2906, CORE_LON = 80.6337;

export class Store {
  constructor() {
    this.meta = null;
    this.scalars = new Map();     // year -> scalars json
    this.months = new Map();      // `${year}-${mm}` -> {rows, npx}
    this.wind = null;             // {U,V float32 [nfields][64*64], meta}
    this.static = {};             // fields, layers, emission, hillshade img
    this.health = null;
    this.fect = new Map();
    this._monthIndex = new Map(); // year -> Int32Array(gi -> local_i) + starts
    this.corePix = 0;
  }

  async init() {
    this.meta = await getJSON(`${BASE}/meta.json`);
    this.npx = this.meta.grid.n_lat * this.meta.grid.n_lon;
    const g = this.meta.grid;
    this.corePix = nearest(g.lats, CORE_LAT) * g.n_lon + nearest(g.lons, CORE_LON);
    await this._loadWind();
    this.static.fields = await getJSON(`${BASE}/static/fields.json`);
    this.static.layers = await getJSON(`${BASE}/static/layers.json`);
    this.static.emission = await getJSON(`${BASE}/static/emission.json`);
    this.static.hillshade = await this._loadImage(`${BASE}/static/hillshade.png`);
    return this;
  }

  _loadImage(url) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = url;
    });
  }

  async _loadWind() {
    const buf = await getGzip(`${BASE}/wind_library.bin.gz`);
    const q = new Int16Array(buf);
    const sh = this.meta.wind.shape;            // [16,2,2,64,64]
    const nf = sh[0] * sh[1] * sh[2];           // 64 fields
    const cells = sh[3] * sh[4];                // 4096
    const scale = this.meta.wind.scale;
    const U = new Float32Array(nf * cells), V = new Float32Array(nf * cells);
    const half = q.length / 2;
    for (let i = 0; i < half; i++) { U[i] = q[i] * scale; V[i] = q[half + i] * scale; }
    this.wind = { U, V, nDir: sh[0], nSpd: sh[1], nReg: sh[2],
                  gy: sh[3], gx: sh[4], cells,
                  lats: this.meta.wind.lats, lons: this.meta.wind.lons };
  }

  async getScalars(year) {
    if (this.scalars.has(year)) return this.scalars.get(year);
    const s = await getJSON(`${BASE}/scalars_${year}.json`);
    this.scalars.set(year, s);
    // month index: local position of each global hour within its month file
    const hrs = s.hours_utc;
    const li = new Int32Array(hrs.length);
    const counts = {};
    const mmOf = new Int8Array(hrs.length);
    for (let gi = 0; gi < hrs.length; gi++) {
      const mm = new Date(hrs[gi] * 1000).getUTCMonth() + 1;
      counts[mm] = counts[mm] ?? 0;
      li[gi] = counts[mm]++;
      mmOf[gi] = mm;
    }
    this._monthIndex.set(year, { li, mmOf });
    return s;
  }

  async getMonth(year, mm) {
    const key = `${year}-${mm}`;
    if (this.months.has(key)) return this.months.get(key);
    const buf = await getGzip(`${BASE}/plocal_${year}_${String(mm).padStart(2, '0')}.bin.gz`);
    const rows = new Uint16Array(buf);          // (nhours*npx) row-major
    const rec = { rows, npx: this.npx };
    this.months.set(key, rec);
    return rec;
  }

  // Reconstruct the three-quantile field for a given (year, global hour index).
  async field(year, gi) {
    const s = await this.getScalars(year);
    const { li, mmOf } = this._monthIndex.get(year);
    const mm = mmOf[gi];
    const month = await this.getMonth(year, mm);
    const npx = this.npx, off = li[gi] * npx;
    const pmin = s.pmin[gi], pmax = s.pmax[gi], span = pmax - pmin;
    const B = s.B[gi], T = s.T[gi], T05 = s.T05[gi], T95 = s.T95[gi];
    const q50 = new Float32Array(npx), q05 = new Float32Array(npx),
          q95 = new Float32Array(npx), P = new Float32Array(npx);
    // Increment-SPLIT reconstruction (matches build_additive_field_v2 + webapp_export,
    // 2026-07-09): q = B + max(Tq-B,0)*P + min(Tq-B,0). The local pattern structures only
    // the accumulation above background; ventilation below background is spatially uniform,
    // so the core never renders cleaner than the rural edge (fixes the inversion).
    const inc50 = T - B, inc05 = T05 - B, inc95 = T95 - B;
    const a50 = Math.max(inc50, 0), u50 = Math.min(inc50, 0);
    const a05 = Math.max(inc05, 0), u05 = Math.min(inc05, 0);
    const a95 = Math.max(inc95, 0), u95 = Math.min(inc95, 0);
    let s50 = 0, s05 = 0, s95 = 0, pkI = 0;
    for (let i = 0; i < npx; i++) {
      const p = pmin + month.rows[off + i] / 65535 * span;
      P[i] = p;
      q50[i] = Math.max(B + a50 * p + u50, 0);
      q05[i] = Math.max(B + a05 * p + u05, 0);
      q95[i] = Math.max(B + a95 * p + u95, 0);
      s50 += q50[i]; s05 += q05[i]; s95 += q95[i];
      if (q50[i] > q50[pkI]) pkI = i;
    }
    const cp = this.corePix;
    const g = this.meta.grid;
    const peak = { v: q50[pkI], lo: q05[pkI], hi: q95[pkI],
                   lat: g.lats[Math.floor(pkI / g.n_lon)], lon: g.lons[pkI % g.n_lon] };
    // basin/core readouts come from the CLAMPED field (mean of what the map
    // shows), not the raw anchors: on the cleanest deep-night hours the raw
    // T-anchor can dip slightly negative and the model's convention is a
    // physical floor at 0 — readouts must match the rendered field.
    return { q50, q05, q95, P, B, T, T05, T95, gi, year, peak,
             bLo: s.B_lo[gi], bHi: s.B_hi[gi],
             basin: s50 / npx, core: q50[cp],
             basin05: Math.min(s05, s50) / npx, basin95: Math.max(s95, s50) / npx,
             core05: Math.min(q05[cp], q50[cp]), core95: Math.max(q95[cp], q50[cp]),
             u10: s.u10[gi], v10: s.v10[gi], blh: s.blh[gi],
             wspd: s.wspd[gi], wdir: s.wdir_from[gi],
             t2m: s.t2m ? s.t2m[gi] : NaN,
             rh: s.rh ? s.rh[gi] : NaN,
             rain: s.rain ? s.rain[gi] : NaN,
             tsUTC: s.hours_utc[gi] };
  }

  // Reconstruct the 64x64 terrain wind field via the shipped blend (parity-verified).
  async windField(year, gi) {
    const s = await this.getScalars(year);
    const w = this.wind, cells = w.cells;
    const i0 = s.i0[gi], i1 = (i0 + 1) % w.nDir;
    const wd0 = s.wd0[gi], wd1 = 1 - wd0, cs0 = s.cs0[gi], cs1 = 1 - cs0;
    const wn = s.wn[gi], wday = 1 - wn;
    const U = new Float32Array(cells), V = new Float32Array(cells);
    const idx = (di, si, ri) => ((di * w.nSpd + si) * w.nReg + ri) * cells;
    const terms = [[i0, wd0], [i1, wd1]];
    const sterms = [[0, cs0], [1, cs1]];
    for (const [di, wdv] of terms)
      for (const [si, csv] of sterms) {
        const wgt = wdv * csv;
        const b0 = idx(di, si, 0), b1 = idx(di, si, 1);
        for (let c = 0; c < cells; c++) {
          const uu = wn * w.U[b0 + c] + wday * w.U[b1 + c];
          const vv = wn * w.V[b0 + c] + wday * w.V[b1 + c];
          U[c] += wgt * uu; V[c] += wgt * vv;
        }
      }
    return { U, V, gy: w.gy, gx: w.gx, lats: w.lats, lons: w.lons };
  }

  async getHealth() {
    if (!this.health) this.health = await getJSON(`${BASE}/health.json`);
    return this.health;
  }
  async getFect(year) {
    if (!this.fect.has(year))
      this.fect.set(year, await getJSON(`${BASE}/fect_${year}.json`));
    return this.fect.get(year);
  }
}

function nearest(arr, v) {
  let bi = 0, bd = 1e18;
  for (let i = 0; i < arr.length; i++) { const d = Math.abs(arr[i] - v); if (d < bd) { bd = d; bi = i; } }
  return bi;
}
