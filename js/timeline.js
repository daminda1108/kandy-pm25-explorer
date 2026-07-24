// timeline.js — 5-year daily heat-strip + scrubber. Each day is a coloured tick
// (basin-mean PM). Clicking/dragging selects an hour. Month separators + year
// labels; crisp at devicePixelRatio.

import { makeLUT, clamp, fitCanvas } from './util.js?v=1784851046';

const LUT = makeLUT('ylorrd', 1.1);
const STRIP_LO = 8, STRIP_HI = 45;   // fixed strip colour range across all years

export class Timeline {
  constructor(canvas, years, onSeek) {
    this.canvas = canvas;
    this.years = years;
    this.onSeek = onSeek;
    this.daily = new Map();          // year -> Float32Array(nDays) daily basin mean
    this.monthStart = new Map();     // year -> [day index of each month start]
    this.hoursByYear = new Map();    // year -> hours_utc array
    this.cursor = { year: years[0], gi: 0 };
    this._fit();
    window.addEventListener('resize', () => { this._fit(); this.draw(); });
    canvas.addEventListener('pointerdown', (e) => { this._drag = true; this._pick(e); });
    canvas.addEventListener('pointermove', (e) => { if (this._drag) this._pick(e); });
    window.addEventListener('pointerup', () => { this._drag = false; });
  }

  _fit() {
    const cssW = this.canvas.parentElement?.clientWidth || 1100;
    const r = fitCanvas(this.canvas, cssW, 72);
    this.ctx = r.ctx; this.W = r.w; this.H = r.h;
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
    const mstart = [];
    let prevM = -1;
    days.forEach((d, k) => {
      const a = byDay.get(d); arr[k] = a[0] / a[1];
      const m = new Date(d * 86400000).getUTCMonth();
      if (m !== prevM) { mstart.push(k); prevM = m; }
    });
    this.daily.set(year, arr);
    this.monthStart.set(year, mstart);
    this.hoursByYear.set(year, hrs);
    this.draw();
  }

  _yearSpans() {
    const W = this.W, n = this.years.length, pad = 3;
    return this.years.map((y, k) => ({
      year: y, x0: (k * W) / n + pad, x1: ((k + 1) * W) / n - pad,
    }));
  }

  draw() {
    const ctx = this.ctx, W = this.W, H = this.H;
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    const top = 7, bot = 18;
    for (const span of this._yearSpans()) {
      const arr = this.daily.get(span.year);
      if (!arr) continue;
      const w = (span.x1 - span.x0) / arr.length;
      for (let d = 0; d < arr.length; d++) {
        const t = clamp((arr[d] - STRIP_LO) / (STRIP_HI - STRIP_LO), 0, 1) * 255 | 0;
        const j = t * 4;
        ctx.fillStyle = `rgb(${LUT[j]},${LUT[j + 1]},${LUT[j + 2]})`;
        ctx.fillRect(span.x0 + d * w, top, w + 0.6, H - top - bot);
      }
      // month separators (subtle)
      ctx.strokeStyle = 'rgba(10,14,20,0.5)'; ctx.lineWidth = 1;
      for (const ms of (this.monthStart.get(span.year) || []).slice(1)) {
        const x = span.x0 + ms * w;
        ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, H - bot); ctx.stroke();
      }
      // year label
      ctx.fillStyle = 'rgba(210,220,235,0.75)';
      ctx.font = '600 11px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(span.year, (span.x0 + span.x1) / 2, H - 5);
    }
    // cursor marker
    const px = this._giToX(this.cursor.year, this.cursor.gi);
    if (px != null) {
      const ctx2 = ctx;
      ctx2.strokeStyle = 'rgba(86,200,255,0.95)'; ctx2.lineWidth = 1.8;
      ctx2.beginPath(); ctx2.moveTo(px, 3); ctx2.lineTo(px, H - bot + 3); ctx2.stroke();
      ctx2.fillStyle = '#56c8ff';
      ctx2.beginPath(); ctx2.moveTo(px - 4, 2); ctx2.lineTo(px + 4, 2); ctx2.lineTo(px, 8);
      ctx2.closePath(); ctx2.fill();
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
    const x = (e.clientX - r.left) * (this.W / r.width);
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
