// overlay.js — static vector layers (OSM roads/river/water, emission contours,
// landmarks) drawn on a canvas aligned to the same bbox as the field.
// Landmarks carry a kind: "city" | "town" | "sensor" and are drawn with halos;
// labels near the frame edges are flipped inward so nothing clips.

export class Overlay {
  constructor(canvas, bbox) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bbox = bbox;              // [lonMin, latMin, lonMax, latMax]
    this.layers = null;
    this.emission = null;
    this.show = { roads: true, water: true, emission: true, landmarks: true };
  }

  setData(layers, emission) { this.layers = layers; this.emission = emission; }

  _pt(lon, lat) {
    const [x0, y0, x1, y1] = this.bbox, W = this.canvas.width, H = this.canvas.height;
    return [((lon - x0) / (x1 - x0)) * W, (1 - (lat - y0) / (y1 - y0)) * H];
  }

  draw() {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    // Scale strokes/labels by the DISPLAYED size, not the internal resolution, so
    // text stays readable when the map renders small (phones).
    const rect = this.canvas.getBoundingClientRect();
    const k = rect.width > 40 ? W / rect.width : W / 620;
    ctx.clearRect(0, 0, W, H);
    if (!this.layers) return;
    const L = this.layers;

    if (this.show.water && L.water) {
      ctx.fillStyle = 'rgba(90,160,220,0.35)';
      ctx.strokeStyle = 'rgba(120,190,240,0.6)'; ctx.lineWidth = 0.8 * k;
      for (const f of L.water) if (f.t === 'pg') this._poly(f.c, true);
    }
    if (this.show.water && L.rivers) {
      ctx.strokeStyle = 'rgba(120,190,240,0.7)'; ctx.lineWidth = 1.3 * k;
      for (const f of L.rivers) if (f.t === 'ln') this._line(f.c);
    }
    if (this.show.roads && L.roads) {
      ctx.strokeStyle = 'rgba(20,25,35,0.35)'; ctx.lineWidth = 0.6 * k;
      for (const f of L.roads) if (f.t === 'ln') this._line(f.c);
    }
    if (this.show.emission && this.emission) {
      for (const c of this.emission.contours) {
        const a = 0.25 + c.level * 0.5;
        ctx.strokeStyle = `rgba(46,204,113,${a})`;
        ctx.lineWidth = (0.8 + c.level) * k;
        this._line(c.pts);
      }
    }
    if (this.show.landmarks && L.landmarks) this._labels(L.landmarks, k, W, H);
  }

  _labels(marks, k, W, H) {
    const ctx = this.ctx;
    for (const p of marks) {
      const [x, y] = this._pt(p.c[0], p.c[1]);
      if (x < -4 || x > W + 4 || y < -4 || y > H + 4) continue;   // out of frame
      const kind = p.k || 'town';
      const city = kind === 'city', sensor = kind === 'sensor';
      const fs = (city ? 13 : sensor ? 10.5 : 10.5) * k;
      ctx.font = `${city ? '600 ' : ''}${sensor ? 'italic ' : ''}${fs}px Inter, sans-serif`;

      // marker
      if (sensor) {
        const r = 4.2 * k;
        ctx.fillStyle = 'rgba(86,200,255,0.95)';
        ctx.strokeStyle = 'rgba(5,8,12,0.8)'; ctx.lineWidth = 1.6 * k;
        ctx.beginPath();
        ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
        ctx.closePath(); ctx.fill(); ctx.stroke();
      } else {
        ctx.fillStyle = city ? 'rgba(255,255,255,0.98)' : 'rgba(255,255,255,0.82)';
        ctx.strokeStyle = 'rgba(5,8,12,0.7)'; ctx.lineWidth = 1.4 * k;
        ctx.beginPath(); ctx.arc(x, y, (city ? 3.4 : 2.4) * k, 0, 7); ctx.fill(); ctx.stroke();
      }

      // label placement: flip inward near edges so text never clips
      let dx = 7 * k, align = 'left', dy = 3.5 * k;
      if (x > W * 0.82) { dx = -7 * k; align = 'right'; }
      if (y < 18 * k) dy = 14 * k;
      if (y > H - 12 * k) dy = -8 * k;
      ctx.textAlign = align;
      ctx.lineWidth = 3.2 * k; ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(5,8,12,0.85)';
      ctx.strokeText(p.n, x + dx, y + dy);
      ctx.fillStyle = sensor ? 'rgba(160,220,250,0.95)'
                    : city ? 'rgba(255,255,255,0.98)' : 'rgba(235,240,248,0.88)';
      ctx.fillText(p.n, x + dx, y + dy);
    }
    ctx.textAlign = 'left';
  }

  _line(pts) {
    const ctx = this.ctx; ctx.beginPath();
    pts.forEach((p, i) => { const [x, y] = this._pt(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  }
  _poly(rings, fill) {
    const ctx = this.ctx; ctx.beginPath();
    for (const ring of rings)
      ring.forEach((p, i) => { const [x, y] = this._pt(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    if (fill) ctx.fill();
    ctx.stroke();
  }
}
