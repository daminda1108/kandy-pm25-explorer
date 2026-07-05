// util.js — helpers: fetch+gunzip, colour scales, DOM, canvas, math.

export async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
  return r.json();
}

// Fetch a gzip-compressed binary and inflate it to an ArrayBuffer.
// GitHub Pages serves .gz as opaque bytes (no Content-Encoding), so we inflate
// client-side via the streams API.
export async function getGzip(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
  const ds = new DecompressionStream('gzip');
  const stream = r.body.pipeThrough(ds);
  return new Response(stream).arrayBuffer();
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids) n.append(kid?.nodeType ? kid : document.createTextNode(kid));
  return n;
};

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const lerp = (a, b, t) => a + (b - a) * t;

// Size a canvas for crisp rendering at devicePixelRatio; returns a ctx already
// scaled so drawing code works in CSS pixels. Pass cssW/cssH or measure the element.
export function fitCanvas(cv, cssW, cssH) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const w = cssW ?? (cv.clientWidth || cv.width);
  const h = cssH ?? (cv.clientHeight || cv.height);
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.width = `${w}px`;
  cv.style.height = `${h}px`;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h, dpr };
}

// Monotone-friendly smooth path through points [[x,y],...] (Catmull-Rom -> Bezier).
export function smoothPath(ctx, pts, tension = 0.5) {
  if (pts.length < 2) return;
  ctx.moveTo(pts[0][0], pts[0][1]);
  if (pts.length === 2) { ctx.lineTo(pts[1][0], pts[1][1]); return; }
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i];
    const p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1[0] + ((p2[0] - p0[0]) / 6) * tension;
    const c1y = p1[1] + ((p2[1] - p0[1]) / 6) * tension;
    const c2x = p2[0] - ((p3[0] - p1[0]) / 6) * tension;
    const c2y = p2[1] - ((p3[1] - p1[1]) / 6) * tension;
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2[0], p2[1]);
  }
}

export function compass(deg) {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(((deg % 360) / 22.5)) % 16];
}

// ── colour scales ───────────────────────────────────────────────────────────
// Anchor stops (sampled from matplotlib YlOrRd and turbo) interpolated in sRGB.
const YLORRD = [
  [255, 255, 229], [255, 247, 188], [254, 227, 145], [254, 196, 79],
  [254, 153, 41], [236, 112, 20], [204, 76, 2], [153, 52, 4], [102, 37, 6],
];
const TURBO = [
  [48, 18, 59], [62, 73, 190], [70, 107, 227], [56, 154, 224], [40, 187, 204],
  [56, 214, 163], [95, 234, 120], [151, 245, 74], [216, 231, 43], [244, 200, 40],
  [252, 167, 45], [248, 129, 33], [227, 86, 20], [188, 48, 8], [122, 4, 3],
];

function rampColor(ramp, t) {
  t = clamp(t, 0, 1) * (ramp.length - 1);
  const i = Math.floor(t), f = t - i;
  const a = ramp[i], b = ramp[Math.min(i + 1, ramp.length - 1)];
  return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
}
export const ylorrd = (t) => rampColor(YLORRD, t);
export const turbo = (t) => rampColor(TURBO, t);

// Precompute a 256-entry LUT (Uint8 RGBA) for fast field painting.
export function makeLUT(kind, gamma = 1.0) {
  const fn = kind === 'turbo' ? turbo : ylorrd;
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = Math.pow(i / 255, gamma);
    const [r, g, b] = fn(t);
    lut[i * 4] = r; lut[i * 4 + 1] = g; lut[i * 4 + 2] = b; lut[i * 4 + 3] = 255;
  }
  return lut;
}

export function fmt(x, d = 1) {
  return Number.isFinite(x) ? x.toFixed(d) : '–';
}

// "21.4 [15.1–29.3]" interval formatter used across all numeric readouts.
export function fmtCI(v, lo, hi, d = 1) {
  return `${fmt(v, d)} <span class="iv">[${fmt(lo, d)}–${fmt(hi, d)}]</span>`;
}
