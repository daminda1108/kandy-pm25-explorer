// wind.js — animated terrain-wind particle layer over the field.
// Advects ~2000 particles on the 64x64 WindNinja field (the model's actual
// mass-consistent flow: channelling, night katabatic drainage, day anabatic).

const NP = 2600;
const FADE = 0.90;          // trail persistence
const LIFE = 90;            // frames before respawn
const SPEED = 1.15;         // px per (m/s) per frame scale (840px internal canvas)

// Speed-true rendering (U1, 2026-07-21). The animation used a fixed particle count
// and one colour, so a 0.5 m/s hour looked as busy as a 3 m/s one and only moved
// slower — which reads as "strong wind through the valley" even when the model is
// showing near-calm. Density AND colour now follow the actual speed, and a legend
// chip states it in m/s, so calm reads as calm. The underlying vectors are unchanged.
const CALM = 0.5;           // m/s — below this the basin is effectively still
// perceptual ramp: slate (calm) -> white (light) -> amber (brisk)
const RAMP = [[0.0, [120, 150, 180]], [0.8, [200, 218, 235]],
              [2.0, [255, 255, 255]], [4.0, [245, 196, 120]], [7.0, [240, 150, 70]]];

function speedColour(s) {
  let a = RAMP[0], b = RAMP[RAMP.length - 1];
  for (let i = 0; i < RAMP.length - 1; i++) {
    if (s >= RAMP[i][0] && s <= RAMP[i + 1][0]) { a = RAMP[i]; b = RAMP[i + 1]; break; }
    if (s > RAMP[RAMP.length - 1][0]) { a = b = RAMP[RAMP.length - 1]; }
  }
  const t = b[0] === a[0] ? 0 : (s - a[0]) / (b[0] - a[0]);
  return [0, 1, 2].map((k) => Math.round(a[1][k] + t * (b[1][k] - a[1][k])));
}

// Plain-language descriptor for the legend (Beaufort-aligned at the low end).
export function windWords(s) {
  if (s < 0.3) return 'calm';
  if (s < 1.6) return 'light air';
  if (s < 3.4) return 'light breeze';
  if (s < 5.5) return 'gentle breeze';
  return 'moderate breeze';
}

export class WindLayer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.field = null;       // {U,V,gy,gx}
    this.parts = [];
    this.raf = null;
    this._seed();
  }

  _seed() {
    const W = this.canvas.width, H = this.canvas.height;
    this.parts = Array.from({ length: NP }, () => ({
      x: Math.random() * W, y: Math.random() * H, age: Math.random() * LIFE,
    }));
  }

  setField(f) {
    this.field = f;
    // mean field speed drives how many particles are alive: a near-calm hour should
    // LOOK sparse and sluggish, not merely slower than a windy one.
    let s = 0;
    if (f) { for (let i = 0; i < f.U.length; i++) s += Math.hypot(f.U[i], f.V[i]);
             s /= f.U.length; }
    this.meanSpd = s;
    // 12% of particles at dead calm, full density from ~3 m/s up
    this.active = Math.round(NP * Math.min(1, 0.12 + s / 3));
  }

  _sample(px, py) {
    // px,py in canvas pixels -> bilinear sample of the 64x64 field.
    // canvas y=0 is top (north); field row 0 is south (lat ascending) -> flip y.
    const W = this.canvas.width, H = this.canvas.height, f = this.field;
    const gx = (px / W) * (f.gx - 1);
    const gy = ((H - py) / H) * (f.gy - 1);
    const x0 = Math.min(f.gx - 1, Math.max(0, Math.floor(gx))), x1 = Math.min(x0 + 1, f.gx - 1);
    const y0 = Math.min(f.gy - 1, Math.max(0, Math.floor(gy))), y1 = Math.min(y0 + 1, f.gy - 1);
    const fx = gx - x0, fy = gy - y0;
    const i = (yy, xx) => yy * f.gx + xx;
    const u = (f.U[i(y0, x0)] * (1 - fx) + f.U[i(y0, x1)] * fx) * (1 - fy)
            + (f.U[i(y1, x0)] * (1 - fx) + f.U[i(y1, x1)] * fx) * fy;
    const v = (f.V[i(y0, x0)] * (1 - fx) + f.V[i(y0, x1)] * fx) * (1 - fy)
            + (f.V[i(y1, x0)] * (1 - fx) + f.V[i(y1, x1)] * fx) * fy;
    return [u, v];
  }

  start() { if (!this.raf) this._tick(); }
  stop() { if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; } }

  resize() {
    const c = this.canvas;
    this._seed();
    this.ctx.clearRect(0, 0, c.width, c.height);
  }

  _tick() {
    const c = this.canvas, ctx = this.ctx, W = c.width, H = c.height;
    // fade previous frame (trails)
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0,0,0,${1 - FADE})`;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    if (this.field) {
      // thinner strokes when the air is nearly still — a calm hour should whisper
      ctx.lineWidth = this.meanSpd < CALM ? 1.0 : 1.4;
      const n = this.active ?? this.parts.length;
      for (let k = 0; k < n; k++) {
        const p = this.parts[k];
        const [u, v] = this._sample(p.x, p.y);
        const spd = Math.hypot(u, v);
        const nx = p.x + u * SPEED, ny = p.y - v * SPEED;   // v north -> up
        const a = Math.min(0.85, 0.18 + spd * 0.14);
        const [r, g, b] = speedColour(spd);
        ctx.strokeStyle = `rgba(${r},${g},${b},${a})`;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny); ctx.stroke();
        p.x = nx; p.y = ny; p.age++;
        if (p.age > LIFE || p.x < 0 || p.x > W || p.y < 0 || p.y > H) {
          p.x = Math.random() * W; p.y = Math.random() * H; p.age = 0;
        }
      }
    }
    this.raf = requestAnimationFrame(() => this._tick());
  }
}
