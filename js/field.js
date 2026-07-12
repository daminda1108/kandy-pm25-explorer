// field.js — render the NxN PM field as a smooth heatmap over the hillshade,
// with WHO-scale colour. Scale mode: 'auto' switches to the fixed universal turbo
// scale when the hour is episode-grade (98th pct >= 35 ug/m3, WHO IT-1), matching
// the model's figure convention; 'universal' / 'adaptive' force either mode.
// Grid size comes from the caller (meta.grid) — Kandy 16x16, Medellín 24x24.

import { makeLUT, clamp } from './util.js?v=1783879241';

const LUT_YLORRD = makeLUT('ylorrd', 1.15);
const LUT_TURBO = makeLUT('turbo', 0.85);

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
  const universal = pref === 'universal' || (pref === 'auto' && hot >= 35);
  if (universal) {
    return { mode: 'turbo', lut: LUT_TURBO, lo: 8, hi: 90,
             tag: pref === 'auto' ? 'universal · auto' : 'universal',
             ticks: [15, 25, 35, 50, 70, 90] };
  }
  const lo = Math.floor(pct(0.03) / 5) * 5;
  const hi = Math.max(Math.ceil(pct(0.995) / 5) * 5, lo + 10);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(lo + t * (hi - lo)));
  return { mode: 'ylorrd', lut: LUT_YLORRD, lo, hi,
           tag: pref === 'auto' ? 'adaptive · auto' : 'adaptive', ticks };
}

// Paint the field. `canvas` is the PM layer; hillshade drawn beneath by caller.
// `n` is the (square) grid dimension from meta.grid.n_lat.
export function paintField(canvas, q50, cm, n) {
  const W = canvas.width, H = canvas.height;
  const N = n || Math.round(Math.sqrt(q50.length));
  const up = upsample(q50, N, W, H);
  const img = new ImageData(W, H);
  const { lut, lo, hi } = cm;
  const inv = 255 / (hi - lo);
  for (let i = 0; i < up.length; i++) {
    let t = clamp((up[i] - lo) * inv, 0, 255) | 0;
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
  for (let x = 0; x < W; x++) {
    const t = (x / (W - 1)) * 255 | 0, j = t * 4;
    ctx.fillStyle = `rgb(${cm.lut[j]},${cm.lut[j + 1]},${cm.lut[j + 2]})`;
    ctx.fillRect(x, 0, 1, H);
  }
}
