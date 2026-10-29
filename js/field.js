// field.js — render the NxN PM field as a smooth heatmap over the hillshade,
// with WHO-scale colour. Scale mode: 'auto' switches to the fixed universal turbo
// scale when the hour is episode-grade (98th pct >= 35 ug/m3, WHO IT-1), matching
// the model's figure convention; 'universal' / 'adaptive' force either mode.
// Grid size comes from the caller (meta.grid) — Kandy 16x16, Medellín 24x24.

import { makeLUT, clamp } from './util.js?v=1793238063';

const LUT_YLORRD = makeLUT('ylorrd', 1.15);
const LUT_TURBO = makeLUT('turbo', 0.85);

// WHO-anchored scale (redesign phase 2, plan §6): FIXED 0–90 µg/m³ so a colour always means the same
// concentration, with stops at the WHO 2021 values (AQG 5 annual / 15 24-h, interim targets 25, 35, 50, 75).
const WHO_LO = 0, WHO_HI = 90;
const WHO_STOPS = [[0, [159, 195, 178]], [5, [159, 195, 178]], [15, [233, 225, 180]], [25, [239, 199, 122]],
                   [35, [229, 154, 82]], [50, [201, 101, 58]], [75, [142, 58, 44]], [90, [100, 36, 30]]];
const LUT_WHO = (() => {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const v = WHO_LO + (i / 255) * (WHO_HI - WHO_LO);
    let k = 1; while (k < WHO_STOPS.length - 1 && v > WHO_STOPS[k][0]) k++;
    const [a, ca] = WHO_STOPS[k - 1], [b, cb] = WHO_STOPS[k], t = b > a ? (v - a) / (b - a) : 0;
    for (let c = 0; c < 3; c++) lut[i * 4 + c] = ca[c] + (cb[c] - ca[c]) * Math.max(0, Math.min(1, t));
    lut[i * 4 + 3] = 255;
  }
  return lut;
})();

// Bilinear-upsample a NxN grid into a WxH Float32 buffer, north-up.
// Grid pixel order is row-major lat-ASCENDING (index 0 = south); canvas y=0 is
// north, so sample from the top row downward with an inverted latitude index.
function upsample(grid, N, W, H) {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const gy = (1 - y / (H - 1)) * (N - 1), y0 = Math.floor(gy), fy = gy - y0;
    const y1 = Math.min(y0 + 1, N - 1);
    for (let x = 0; x < W; x++) {
      const gx = (x / (W - 1)) * (N - 1), x0 = Math.floor(gx), fx = gx - x0;
      const x1 = Math.min(x0 + 1, N - 1);
      const a = grid[y0 * N + x0], b = grid[y0 * N + x1];
      const c = grid[y1 * N + x0], d = grid[y1 * N + x1];
      out[y * W + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
}

// Decide colour mode + range for a field. pref: 'auto' | 'universal' | 'adaptive'.
export function colourMode(q50, pref = 'auto') {
  const sorted = Float32Array.from(q50).sort();
  const pct = (p) => sorted[Math.floor(clamp(p, 0, 1) * (sorted.length - 1))];
  const hot = pct(0.98);
  // default ('auto'): the fixed WHO-anchored scale
  if (pref === 'auto' || pref === 'who') {
    return { mode: 'who', lut: LUT_WHO, lo: WHO_LO, hi: WHO_HI, gamma: 1, tag: 'fixed WHO scale',
             ticks: [5, 15, 25, 35, 50, 75] };
  }
  const universal = pref === 'universal' || (pref === 'auto' && hot >= 35);
  if (universal) {
    return { mode: 'turbo', lut: LUT_TURBO, lo: 8, hi: 90, gamma: 1,
             tag: pref === 'auto' ? 'universal · auto' : 'universal',
             ticks: [15, 25, 35, 50, 70, 90] };
  }
  // Adaptive: frame the ACTUAL data (p2..p98) tightly instead of flooring to 5 and
  // forcing a >=10 span — a low-contrast hour spanning <1 ug/m3 was using ~7% of the
  // ramp and reading as false uniformity. A 4 ug/m3 minimum span keeps near-noise
  // hours from being blown up (honesty), and a perceptual gamma <1 expands the
  // lower-mid range where most pixels sit so real structure becomes visible. The
  // colourbar ticks show the true (narrow) range, so magnitude stays honest.
  let lo = pct(0.02), hi = pct(0.98);
  if (hi - lo < 4) { const m = (hi + lo) / 2; lo = m - 2; hi = m + 2; }
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round((lo + t * (hi - lo)) * 10) / 10);
  return { mode: 'ylorrd', lut: LUT_YLORRD, lo, hi, gamma: 0.72,
           tag: pref === 'auto' ? 'adaptive · auto' : 'adaptive', ticks };
}

// Paint the field. `canvas` is the PM layer; hillshade drawn beneath by caller.
// `n` is the (square) grid dimension from meta.grid.n_lat.
export function paintField(canvas, q50, cm, n) {
  const W = canvas.width, H = canvas.height;
  const N = n || Math.round(Math.sqrt(q50.length));
  const up = upsample(q50, N, W, H);
  const img = new ImageData(W, H);
  const { lut, lo, hi, gamma = 1 } = cm;
  const span = hi - lo;
  for (let i = 0; i < up.length; i++) {
    let f = clamp((up[i] - lo) / span, 0, 1);
    if (gamma !== 1) f = Math.pow(f, gamma);      // perceptual mid-range expansion
    const t = (f * 255) | 0;
    const j = t * 4, k = i * 4;
    img.data[k] = lut[j]; img.data[k + 1] = lut[j + 1];
    img.data[k + 2] = lut[j + 2];
    img.data[k + 3] = 205;             // translucent so hillshade reads through
  }
  canvas.getContext('2d').putImageData(img, 0, 0);
}

// Draw the colourbar gradient into a small canvas.
export function paintColourbar(canvas, cm) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const g = cm.gamma || 1;
  for (let x = 0; x < W; x++) {
    // the bar shows the SAME gamma the field uses, so a colour on the map maps back
    // to the same value on the bar (positions are linear in value; colour follows gamma)
    const t = (Math.pow(x / (W - 1), g) * 255) | 0, j = t * 4;
    ctx.fillStyle = `rgb(${cm.lut[j]},${cm.lut[j + 1]},${cm.lut[j + 2]})`;
    ctx.fillRect(x, 0, 1, H);
  }
}
