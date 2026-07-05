// util.js — helpers: fetch+gunzip, colour scales, DOM, math.

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

// ── colour scales ───────────────────────────────────────────────────────────
// Anchor stops (sampled from matplotlib YlOrRd and turbo) interpolated in sRGB.
const YLORRD = [
  [255, 255, 229], [255, 247, 188], [254, 227, 145], [254, 196, 79],
  [254, 153, 41], [236, 112, 20], [204, 76, 2], [153, 52, 4], [102, 37, 6],
];
const TURBO = [
  [48, 18, 59], [70, 107, 227], [40, 187, 204], [95, 234, 120],
  [216, 231, 43], [252, 167, 45], [227, 86, 20], [122, 4, 3],
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
