// daystrip.js — the chosen day in three aligned lanes (redesign v2): PM2.5 (the model's valley average with its
// 90 % range), the top of the mixing layer (ERA5) and traffic timing (typical activity). The station's measured
// typical shape for a weekday or a Sunday can be laid over the PM lane (shape only, scaled to the day's mean).
// Drag or click to move through the day.
import { pmCss } from './scene.js?v=1793237379';

const INK = '#1c1d1f', INK2 = '#4b4f54', INK3 = '#7a7d80', RULE = '#d3cdbf', SLATE = '#3d5568', AMBER = '#c9862e';

export class DayStrip {
  constructor(canvas, onPick) {
    this.cv = canvas; this.onPick = onPick; this.d = null;
    const pick = (e) => {
      if (!this.d) return;
      const r = this.cv.getBoundingClientRect(), x = e.clientX - r.left;
      const i = Math.round((x - this.x0) / this.dx);
      const k = Math.max(0, Math.min(this.d.hours.length - 1, i));
      if (k !== this.d.cur) this.onPick(k);
    };
    let drag = false;
    canvas.addEventListener('pointerdown', (e) => { drag = true; canvas.setPointerCapture(e.pointerId); pick(e); });
    canvas.addEventListener('pointermove', (e) => { if (drag) pick(e); });
    canvas.addEventListener('pointerup', () => { drag = false; });
    new ResizeObserver(() => this.draw()).observe(canvas.parentElement);
  }

  // d: { hours: [{label, pm, lo, hi, blh, traffic}], cur, station: [24] | null, stationLabel, hour0 (local hour of index 0) }
  set(d) { this.d = d; this.draw(); }

  draw() {
    const d = this.d, cv = this.cv, W = cv.parentElement.clientWidth, H = cv.parentElement.clientHeight;
    if (!d || !W || !H) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const n = d.hours.length, L = 132, R = 16;
    this.x0 = L; this.dx = (W - L - R) / Math.max(1, n - 1);
    const X = (i) => L + i * this.dx;
    const narrow = W < 560;
    const lanes = narrow ? [0.5, 0.27, 0.23] : [0.5, 0.28, 0.22];
    const top = 4, axisH = 16, avail = H - top - axisH;
    const y0 = top, h0 = avail * lanes[0] - 6, y1 = y0 + avail * lanes[0], h1 = avail * lanes[1] - 6,
          y2 = y1 + avail * lanes[1], h2 = avail * lanes[2] - 4;
    g.font = '500 11px "Schibsted Grotesk", Arial, sans-serif'; g.textBaseline = 'middle';

    // lane labels
    const label = (txt, sub, y, h, col) => {
      g.fillStyle = col; g.font = '600 11px "Schibsted Grotesk", Arial, sans-serif';
      g.fillText(txt, 0, y + Math.min(10, h / 2));
      if (sub && h > 26) { g.fillStyle = INK3; g.font = '400 11px "Schibsted Grotesk", Arial, sans-serif'; g.fillText(sub, 0, y + 24); }
    };
    label('Fine particles', 'µg/m³, valley average', y0, h0, INK);
    label('Mixing layer', 'height, m (ERA5)', y1, h1, SLATE);
    label('Traffic', 'typical timing', y2, h2, AMBER);

    // ── PM lane
    const pmMax = Math.max(40, ...d.hours.map((h) => h.hi || h.pm)) * 1.08;
    const Yp = (v) => y0 + h0 - (Math.max(0, v) / pmMax) * h0;
    g.strokeStyle = RULE; g.lineWidth = 1;
    g.beginPath(); g.moveTo(L, y0 + h0 + 0.5); g.lineTo(W - R, y0 + h0 + 0.5); g.stroke();
    // WHO daily guideline
    g.setLineDash([3, 3]); g.strokeStyle = '#8b8f86';
    g.beginPath(); g.moveTo(L, Yp(15)); g.lineTo(W - R, Yp(15)); g.stroke(); g.setLineDash([]);
    g.fillStyle = INK3; g.font = '400 10px "Schibsted Grotesk", Arial, sans-serif';
    g.fillText('WHO day guideline 15', L + 4, Yp(15) + 8);
    // 90 % range
    g.fillStyle = 'rgba(168, 72, 42, 0.12)'; g.beginPath();
    d.hours.forEach((h, i) => (i ? g.lineTo(X(i), Yp(h.hi)) : g.moveTo(X(i), Yp(h.hi))));
    for (let i = n - 1; i >= 0; i--) g.lineTo(X(i), Yp(d.hours[i].lo));
    g.closePath(); g.fill();
    // station typical shape (measured), scaled to this day's mean: shape only
    if (d.station) {
      const mean = d.hours.reduce((a, h) => a + h.pm, 0) / n;
      const sm = d.station.reduce((a, v) => a + v, 0) / 24;
      g.strokeStyle = INK2; g.setLineDash([2, 3]); g.lineWidth = 1.4; g.beginPath();
      d.hours.forEach((h, i) => {
        const v = d.station[(d.hour0 + i) % 24] / sm * mean;
        i ? g.lineTo(X(i), Yp(v)) : g.moveTo(X(i), Yp(v));
      });
      g.stroke(); g.setLineDash([]);
    }
    // the day's line, dots in WHO colours
    g.strokeStyle = INK; g.lineWidth = 1.8; g.beginPath();
    d.hours.forEach((h, i) => (i ? g.lineTo(X(i), Yp(h.pm)) : g.moveTo(X(i), Yp(h.pm)))); g.stroke();
    d.hours.forEach((h, i) => { g.fillStyle = pmCss(h.pm); g.beginPath(); g.arc(X(i), Yp(h.pm), 3.2, 0, 7); g.fill();
      g.strokeStyle = INK; g.lineWidth = 0.8; g.stroke(); });

    // ── mixing-layer lane (area)
    const bMax = Math.max(400, ...d.hours.map((h) => h.blh || 0)) * 1.15;
    const Yb = (v) => y1 + h1 - (Math.max(0, v) / bMax) * h1;
    g.fillStyle = 'rgba(61, 85, 104, 0.18)'; g.strokeStyle = SLATE; g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(X(0), y1 + h1);
    d.hours.forEach((h, i) => g.lineTo(X(i), Yb(h.blh ?? 0))); g.lineTo(X(n - 1), y1 + h1); g.closePath(); g.fill();
    g.beginPath(); d.hours.forEach((h, i) => (i ? g.lineTo(X(i), Yb(h.blh ?? 0)) : g.moveTo(X(i), Yb(h.blh ?? 0)))); g.stroke();

    // ── traffic lane (bars)
    const bw = Math.max(2, this.dx * 0.55);
    d.hours.forEach((h, i) => {
      const v = Math.max(0, h.traffic || 0), bh = v * h2;
      g.fillStyle = AMBER; g.globalAlpha = 0.85; g.fillRect(X(i) - bw / 2, y2 + h2 - bh, bw, bh); g.globalAlpha = 1;
    });

    // ── axis
    g.fillStyle = INK3; g.font = '400 10px "Schibsted Grotesk", Arial, sans-serif'; g.textAlign = 'center';
    const step = narrow ? 6 : 3;
    d.hours.forEach((h, i) => { if (((d.hour0 + i) % 24) % step === 0) g.fillText(h.label.slice(0, 2), X(i), H - 7); });
    g.textAlign = 'left';

    // ── cursor
    const c = d.cur, cx = X(c), hc = d.hours[c];
    g.strokeStyle = INK; g.lineWidth = 1; g.beginPath(); g.moveTo(cx + 0.5, top); g.lineTo(cx + 0.5, H - axisH); g.stroke();
    const tag = (txt, y, col) => {
      g.font = '600 11px "Schibsted Grotesk", Arial, sans-serif';
      const w = g.measureText(txt).width + 10, x = Math.min(W - R - w, cx + 6);
      g.fillStyle = '#f4f1ea'; g.fillRect(x, y - 8, w, 16); g.fillStyle = col; g.fillText(txt, x + 5, y);
    };
    tag(`${hc.label}  ${hc.pm.toFixed(0)} µg/m³`, Math.max(y0 + 8, Yp(hc.pm) - 14), INK);
    if (Number.isFinite(hc.blh)) tag(`${Math.round(hc.blh / 10) * 10} m`, Math.max(y1 + 8, Yb(hc.blh) - 10), SLATE);
  }
}
