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
    this.sources = null;           // measured: VIIRS night lights + OSM bus/market/rail points
    this.terrain = null;           // measured: 100 m contours + valley-floor outline
    // The traffic-emission contours are a MODELLED proxy, so they start off (honest-spatial rules, plan §6a).
    this.show = { roads: true, water: true, emission: false, landmarks: true, sources: false, terrain: true };
  }

  setData(layers, emission, extra = {}) {
    this.layers = layers; this.emission = emission;
    this.sources = extra.sources || null; this.terrain = extra.terrain || null;
  }

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

    // terrain (measured): valley floor wash, then 100 m contours, under everything else
    if (this.show.terrain && this.terrain) {
      ctx.fillStyle = 'rgba(143,179,168,0.10)';
      ctx.strokeStyle = 'rgba(143,179,168,0.35)'; ctx.lineWidth = 0.6 * k;
      for (const ring of this.terrain.floor) this._poly([ring], true);
      for (const c of this.terrain.contours) {
        const major = c.z % 200 === 0;
        ctx.strokeStyle = `rgba(242,233,220,${major ? 0.22 : 0.12})`;
        ctx.lineWidth = (major ? 0.9 : 0.5) * k;
        this._line(c.c);
      }
    }
    // sources (measured): night-time lights as light dots sized by brightness (log-scaled), readable on any
    // PM colour; one dot per ~460 m VIIRS pixel
    if (this.show.sources && this.sources && this.sources.ntl) {
      const n = this.sources.ntl, [x0, y0, x1, y1] = this.sources.bbox;
      const dx = (x1 - x0) / n.nlon, dy = (y1 - y0) / n.nlat, vmax = Math.max(...n.v);
      const cell = Math.abs(this._pt(x0 + dx, y0)[0] - this._pt(x0, y0)[0]);
      for (let r = 0; r < n.nlat; r++) for (let c = 0; c < n.nlon; c++) {
        const s = n.v[r * n.nlon + c] / vmax;
        if (s < 0.2) continue;                         // only meaningfully lit pixels (≥ 20 % of the brightest)
        const [x, y] = this._pt(x0 + (c + 0.5) * dx, y0 + (r + 0.5) * dy), rad = cell * 0.46 * Math.sqrt(s);
        ctx.fillStyle = 'rgba(15,13,11,0.5)';
        ctx.beginPath(); ctx.arc(x, y, rad + 1 * k, 0, 7); ctx.fill();
        ctx.fillStyle = `rgba(255,236,200,${(0.45 + 0.5 * s).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(x, y, rad, 0, 7); ctx.fill();
      }
    }

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
      // Road hierarchy (U2 basemap): draw minor roads first, then majors on top,
      // each wider + lighter by rank (r: 3 trunk/primary, 2 secondary, 1 tertiary).
      // Majors also get a subtle dark casing so they read as roads, not scribbles —
      // this is the single biggest "professional map" cue. Falls back to the old
      // flat style for payloads exported before the rank was added.
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const STYLE = { 1: [0.5, 'rgba(150,168,190,0.28)'],
                      2: [1.0, 'rgba(176,192,214,0.42)'],
                      3: [1.6, 'rgba(206,220,240,0.60)'] };
      const hasRank = L.roads.some((f) => f.r);
      if (hasRank) {
        // casing pass for majors
        ctx.strokeStyle = 'rgba(6,10,16,0.5)';
        for (const f of L.roads) {
          if (f.t !== 'ln' || (f.r || 1) < 3) continue;
          ctx.lineWidth = (STYLE[3][0] + 1.1) * k; this._line(f.c);
        }
        for (const rank of [1, 2, 3]) {
          const [w, col] = STYLE[rank];
          ctx.strokeStyle = col; ctx.lineWidth = w * k;
          for (const f of L.roads) if (f.t === 'ln' && (f.r || 1) === rank) this._line(f.c);
        }
      } else {
        ctx.strokeStyle = 'rgba(150,168,190,0.34)'; ctx.lineWidth = 0.7 * k;
        for (const f of L.roads) if (f.t === 'ln') this._line(f.c);
      }
    }
    if (this.show.emission && this.emission) {
      for (const c of this.emission.contours) {
        const a = 0.25 + c.level * 0.5;
        ctx.strokeStyle = `rgba(46,204,113,${a})`;
        ctx.lineWidth = (0.8 + c.level) * k;
        this._line(c.pts);
      }
    }
    // source points (measured, OSM): bus stations, markets, railway stations
    if (this.show.sources && this.sources && this.sources.poi) {
      const GLYPH = { bus: 'B', market: 'M', rail: 'R' };
      ctx.font = `600 ${8.5 * k}px Inter, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const p of this.sources.poi) {
        const [x, y] = this._pt(p.c[0], p.c[1]); const r = 6 * k;
        ctx.fillStyle = 'rgba(15,13,11,0.85)'; ctx.strokeStyle = 'rgba(255,214,140,0.95)'; ctx.lineWidth = 1.2 * k;
        ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); ctx.stroke();
        ctx.fillStyle = 'rgba(255,214,140,1)'; ctx.fillText(GLYPH[p.k] || '•', x, y + 0.5 * k);
      }
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
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
