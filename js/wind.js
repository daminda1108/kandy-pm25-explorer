// wind.js — animated terrain-wind particle layer over the field.
// Advects ~2000 particles on the 64x64 WindNinja field (the model's actual
// mass-consistent flow: channelling, night katabatic drainage, day anabatic).

const NP = 2600;
const FADE = 0.90;          // trail persistence
const LIFE = 90;            // frames before respawn
const SPEED = 1.15;         // px per (m/s) per frame scale (840px internal canvas)

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

  setField(f) { this.field = f; }

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
      ctx.lineWidth = 1.4;
      for (const p of this.parts) {
        const [u, v] = this._sample(p.x, p.y);
        const spd = Math.hypot(u, v);
        const nx = p.x + u * SPEED, ny = p.y - v * SPEED;   // v north -> up
        const a = Math.min(0.85, 0.25 + spd * 0.12);
        ctx.strokeStyle = `rgba(255,255,255,${a})`;
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
