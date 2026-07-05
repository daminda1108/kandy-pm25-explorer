// timeline.js — 5-year seasonal heat-strip + scrubber + play controls.
// Each day is a coloured tick (basin-mean PM). Clicking/dragging selects an hour.

import { makeLUT, clamp } from './util.js';

const LUT = makeLUT('ylorrd', 1.1);
const STRIP_LO = 8, STRIP_HI = 45;   // fixed strip colour range across all years

export class Timeline {
  constructor(canvas, years, onSeek) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.years = years;
    this.onSeek = onSeek;
    this.daily = new Map();          // year -> Float32Array(nDays) daily basin mean
    this.hoursByYear = new Map();    // year -> hours_utc array
    this.cursor = { year: years[0], gi: 0 };
    canvas.addEventListener('pointerdown', (e) => { this._drag = true; this._pick(e); });
    canvas.addEventListener('pointermove', (e) => { if (this._drag) this._pick(e); });
    window.addEventListener('pointerup', () => { this._drag = false; });
  }

  // Feed a year's scalars (hours_utc + basin) to build the daily strip.
  addYear(year, scalars) {
    const hrs = scalars.hours_utc, basin = scalars.basin;
    const byDay = new Map();
    for (let i = 0; i < hrs.length; i++) {
      const day = Math.floor(hrs[i] / 86400);
      const a = byDay.get(day) || [0, 0];
      a[0] += basin[i]; a[1]++; byDay.set(day, a);
    }
    const days = [...byDay.keys()].sort((a, b) => a - b);
    const arr = new Float32Array(days.length);
    days.forEach((d, k) => { const a = byDay.get(d); arr[k] = a[0] / a[1]; });
    this.daily.set(year, arr);
    this.hoursByYear.set(year, hrs);
    this.draw();
  }

  _yearSpans() {
    // horizontal layout: each year gets an equal slab
    const W = this.canvas.width, n = this.years.length, pad = 2;
    return this.years.map((y, k) => ({
      year: y, x0: (k * W) / n + pad, x1: ((k + 1) * W) / n - pad,
    }));
  }

  draw() {
    const c = this.canvas, ctx = this.ctx, W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    for (const span of this._yearSpans()) {
      const arr = this.daily.get(span.year);
      if (!arr) continue;
      const w = (span.x1 - span.x0) / arr.length;
      for (let d = 0; d < arr.length; d++) {
        const t = clamp((arr[d] - STRIP_LO) / (STRIP_HI - STRIP_LO), 0, 1) * 255 | 0;
        const j = t * 4;
        ctx.fillStyle = `rgb(${LUT[j]},${LUT[j + 1]},${LUT[j + 2]})`;
        ctx.fillRect(span.x0 + d * w, 6, Math.ceil(w) + 0.5, H - 20);
      }
      // year label
      ctx.fillStyle = 'rgba(230,235,245,0.85)';
      ctx.font = '11px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(span.year, (span.x0 + span.x1) / 2, H - 4);
    }
    // cursor marker
    const px = this._giToX(this.cursor.year, this.cursor.gi);
    if (px != null) {
      ctx.strokeStyle = '#4dd0ff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(px, 2); ctx.lineTo(px, H - 16); ctx.stroke();
      ctx.fillStyle = '#4dd0ff';
      ctx.beginPath(); ctx.arc(px, 4, 3, 0, 7); ctx.fill();
    }
  }

  _giToX(year, gi) {
    const span = this._yearSpans().find((s) => s.year === year);
    const hrs = this.hoursByYear.get(year);
    if (!span || !hrs) return null;
    return span.x0 + (gi / (hrs.length - 1)) * (span.x1 - span.x0);
  }

  _pick(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) * (this.canvas.width / r.width);
    const spans = this._yearSpans();
    let span = spans.find((s) => x >= s.x0 && x <= s.x1) || spans[0];
    const hrs = this.hoursByYear.get(span.year);
    if (!hrs) return;
    const frac = clamp((x - span.x0) / (span.x1 - span.x0), 0, 1);
    const gi = Math.round(frac * (hrs.length - 1));
    this.cursor = { year: span.year, gi };
    this.draw();
    this.onSeek(span.year, gi);
  }

  setCursor(year, gi) { this.cursor = { year, gi }; this.draw(); }
}
