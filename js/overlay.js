// overlay.js — static vector layers (OSM roads/river/water, emission contours,
// landmarks) drawn on a canvas aligned to the same bbox as the field.

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
    ctx.clearRect(0, 0, W, H);
    if (!this.layers) return;
    const L = this.layers;

    if (this.show.water && L.water) {
      ctx.fillStyle = 'rgba(90,160,220,0.35)';
      ctx.strokeStyle = 'rgba(120,190,240,0.6)'; ctx.lineWidth = 0.8;
      for (const f of L.water) if (f.t === 'pg') this._poly(f.c, true);
    }
    if (this.show.water && L.rivers) {
      ctx.strokeStyle = 'rgba(120,190,240,0.7)'; ctx.lineWidth = 1.3;
      for (const f of L.rivers) if (f.t === 'ln') this._line(f.c);
    }
    if (this.show.roads && L.roads) {
      ctx.strokeStyle = 'rgba(20,25,35,0.35)'; ctx.lineWidth = 0.6;
      for (const f of L.roads) if (f.t === 'ln') this._line(f.c);
    }
    if (this.show.emission && this.emission) {
      for (const c of this.emission.contours) {
        const a = 0.25 + c.level * 0.5;
        ctx.strokeStyle = `rgba(46,204,113,${a})`;
        ctx.lineWidth = 0.8 + c.level;
        this._line(c.pts);
      }
    }
    if (this.show.landmarks && L.landmarks) {
      ctx.font = '11px Inter, sans-serif';
      for (const p of L.landmarks) {
        const [x, y] = this._pt(p.c[0], p.c[1]);
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
        ctx.lineWidth = 3; ctx.strokeText(p.n, x + 6, y + 3);
        ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.fillText(p.n, x + 6, y + 3);
      }
    }
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
