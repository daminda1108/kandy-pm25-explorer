// valley3d.js — the 3-D Kandy basin (redesign phase 3). Real 100 m terrain (relief ×2.4) with the model's
// field draped onto it. HONEST RENDERING: the haze colour and its strength depend only on the model's value in
// each place (fixed WHO-anchored scale), blended into the ground; there is no elevation pooling or emphasis.
// The scene's distance fog is tinted by the valley average. Engine-independent: callers pass the q50 array and
// the payload grid; nothing here changes a number.
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

const EXAG = 2.4, SIZE = 15;
// WHO-anchored stops (µg/m³ → rgb, blend weight); the weight grows with concentration so clean air shows terrain
const STOPS = [[0, [159, 195, 178], 0.10], [5, [159, 195, 178], 0.18], [15, [233, 225, 180], 0.34],
               [25, [239, 199, 122], 0.48], [35, [229, 154, 82], 0.60], [50, [201, 101, 58], 0.70],
               [75, [142, 58, 44], 0.78], [120, [100, 36, 30], 0.84]];
export function pmColour(v) {
  for (let i = 1; i < STOPS.length; i++) if (v <= STOPS[i][0]) {
    const [a, ca, wa] = STOPS[i - 1], [b, cb, wb] = STOPS[i], t = Math.max(0, (v - a) / (b - a));
    return [ca.map((c, k) => c + (cb[k] - c) * t), wa + (wb - wa) * t];
  }
  const s = STOPS[STOPS.length - 1]; return [s[1], s[2]];
}

export function webglOK() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); }
  catch { return false; }
}

const CAMS = {
  overview: { pos: [1.0, 8.2, 14.2], tgt: [0.6, 0, -0.9] },
  explorer: { pos: [-1.2, 8.6, 14.6], tgt: [-2.6, 0, -0.9] },   // valley sits right of the this-hour card
  close:    { pos: [1.6, 4.6, 6.4],  tgt: [0.9, 0.4, -0.6] },
  high:     { pos: [0.2, 15.5, 7.5], tgt: [0.3, 0, -0.4] },
  north:    { pos: [-1.0, 6.5, -12.5], tgt: [0.4, 0, 0.3] },
};

export class Valley3D {
  constructor(el, { terrain, meta, interactive = true, labels = true, camera = 'overview' } = {}) {
    this.el = el; this.t = terrain; this.meta = meta;
    const n = terrain.n, zr = terrain.zmax - terrain.zmin;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x0f0d0b, 1);
    this.renderer.domElement.className = 'v3d-canvas';
    el.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0f0d0b, 17, 44);
    this.cam = new THREE.PerspectiveCamera(34, 1, 0.1, 200);

    // ground: geometry rows run north (top) → south; terrain rows run south → north
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, n - 1, n - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    this.z01 = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const c = i % n, r = n - 1 - Math.floor(i / n);
      const z01 = (terrain.elev[r * n + c] - terrain.zmin) / zr;
      this.z01[i] = z01; pos.setY(i, z01 * zr / 1000 * EXAG);
    }
    geo.computeVertexNormals();
    // fixed terrain shading: low sun from the north-west, edge fade into the page
    const nrm = geo.attributes.normal, sun = new THREE.Vector3(-0.7, 0.42, -0.58).normalize();
    this.shade = new Float32Array(pos.count); this.base = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const c = i % n, r = Math.floor(i / n), d = Math.min(c, r, n - 1 - c, n - 1 - r) / (n * 0.14);
      const s = Math.min(1, Math.max(0, d)), edge = s * s * (3 - 2 * s);
      const lam = Math.max(0, nrm.getX(i) * sun.x + nrm.getY(i) * sun.y + nrm.getZ(i) * sun.z);
      this.shade[i] = (0.25 + 1.2 * lam) * (0.06 + 0.94 * edge);
      const z = this.z01[i], floor = [62, 74, 52], mid = [92, 102, 70], ridge = [128, 122, 104];
      const col = z < 0.5 ? floor.map((a, k) => a + (mid[k] - a) * (z / 0.5)) : mid.map((a, k) => a + (ridge[k] - a) * ((z - 0.5) / 0.5));
      this.base.set(col.map((x) => x / 255), i * 3);
    }
    this.colors = new Float32Array(pos.count * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geo = geo;
    this.ground = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true }));
    this.scene.add(this.ground);
    this._paint(null);

    // labels
    this.labelLayer = document.createElement('div'); this.labelLayer.className = 'v3d-labels';
    el.appendChild(this.labelLayer);
    this.marks = labels ? (meta.landmarks || []).filter((m) => m.k !== 'sensor').map((m) => {
      const p = this.lonLatToWorld(m.c[0], m.c[1], 0.25);
      const d = document.createElement('span'); d.className = 'v3d-lbl' + (m.k === 'city' ? ' city' : '');
      d.textContent = m.n; this.labelLayer.appendChild(d); return { p, d };
    }) : [];

    this.controls = new OrbitControls(this.cam, this.renderer.domElement);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.08, enablePan: false, minDistance: 5,
      maxDistance: 26, maxPolarAngle: Math.PI * 0.46, minPolarAngle: Math.PI * 0.08, rotateSpeed: 0.6,
      zoomSpeed: 0.7, enabled: interactive });
    this.controls.addEventListener('change', () => this.request());
    this.setCamera(camera, false);

    this._ro = new ResizeObserver(() => this.resize()); this._ro.observe(el); this.resize();
    this._raf = null; this._tween = null; this.running = true; this.request();
  }

  lonLatToWorld(lon, lat, lift = 0) {
    const t = this.t, n = t.n, zr = t.zmax - t.zmin;
    const u = (lon - t.lon0) / (t.lon1 - t.lon0), v = (lat - t.lat0) / (t.lat1 - t.lat0);
    const c = Math.min(n - 1, Math.max(0, Math.round(u * (n - 1)))), r = Math.min(n - 1, Math.max(0, Math.round(v * (n - 1))));
    const y = ((t.elev[r * n + c] - t.zmin) / zr) * zr / 1000 * EXAG + lift;
    return new THREE.Vector3((u - 0.5) * SIZE, y, (0.5 - v) * SIZE);
  }

  // field: q50 on the payload grid (row-major, lat ascending), grid = meta.grid
  setField(q, grid) { this._paint(q, grid); this.request(); }

  _paint(q, grid) {
    const t = this.t, n = t.n, cnt = n * n;
    let mean = 0;
    for (let i = 0; i < cnt; i++) {
      const c = i % n, r = n - 1 - Math.floor(i / n);
      let rgb = null, w = 0;
      if (q) {
        const lat = t.lat0 + (r / (n - 1)) * (t.lat1 - t.lat0), lon = t.lon0 + (c / (n - 1)) * (t.lon1 - t.lon0);
        const v = this._sample(q, grid, lat, lon);
        [rgb, w] = pmColour(v); mean += v;
      }
      const s = this.shade[i];
      for (let k = 0; k < 3; k++) {
        const g = this.base[i * 3 + k];
        const h = rgb ? rgb[k] / 255 : g;
        this.colors[i * 3 + k] = (g * (1 - w) + h * w) * s;
      }
    }
    this.geo.attributes.color.needsUpdate = true;
    if (q) {
      mean /= cnt;
      const [frgb] = pmColour(mean), k = Math.min(1, mean / 80);
      this.scene.fog.color.setRGB((15 + (frgb[0] - 15) * 0.3 * k) / 255, (13 + (frgb[1] - 13) * 0.3 * k) / 255,
                                  (11 + (frgb[2] - 11) * 0.3 * k) / 255);
      this.renderer.setClearColor(this.scene.fog.color, 1);
      this.scene.fog.near = 17 - 6 * k; this.scene.fog.far = 44 - 14 * k;
    }
  }

  _sample(q, g, lat, lon) {
    const N = g.n_lat, M = g.n_lon, la = g.lats, lo = g.lons;
    const fi = Math.min(N - 1, Math.max(0, (lat - la[0]) / (la[N - 1] - la[0]) * (N - 1)));
    const fj = Math.min(M - 1, Math.max(0, (lon - lo[0]) / (lo[M - 1] - lo[0]) * (M - 1)));
    const i0 = Math.floor(fi), j0 = Math.floor(fj), i1 = Math.min(i0 + 1, N - 1), j1 = Math.min(j0 + 1, M - 1);
    const a = fi - i0, b = fj - j0, at = (i, j) => Math.max(q[i * M + j], 0);
    return (at(i0, j0) * (1 - b) + at(i0, j1) * b) * (1 - a) + (at(i1, j0) * (1 - b) + at(i1, j1) * b) * a;
  }

  setCamera(name, animate = true, ms = 1600) {
    const c = CAMS[name] || CAMS.overview;
    const p1 = new THREE.Vector3(...c.pos), t1 = new THREE.Vector3(...c.tgt);
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.cam.position.copy(p1); this.controls.target.copy(t1); this.controls.update(); this.request(); return;
    }
    const p0 = this.cam.position.clone(), t0 = this.controls.target.clone(), start = performance.now();
    this._tween = (now) => {
      const x = Math.min(1, (now - start) / ms), e = x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
      this.cam.position.lerpVectors(p0, p1, e); this.controls.target.lerpVectors(t0, t1, e);
      if (x >= 1) this._tween = null;
    };
    this.request();
  }

  autoRotate(on, speed = 0.25) { this.controls.autoRotate = on; this.controls.autoRotateSpeed = speed; this.request(); }

  // screen point → [lon, lat] on the terrain, or null
  pick(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster(); rc.setFromCamera(ndc, this.cam);
    const hit = rc.intersectObject(this.ground)[0];
    if (!hit) return null;
    const t = this.t, u = hit.point.x / SIZE + 0.5, v = 0.5 - hit.point.z / SIZE;
    return [t.lon0 + u * (t.lon1 - t.lon0), t.lat0 + v * (t.lat1 - t.lat0)];
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px'; this.renderer.domElement.style.height = h + 'px';
    this.cam.aspect = w / h; this.cam.updateProjectionMatrix(); this.request();
  }

  request() { if (!this._raf && this.running) this._raf = requestAnimationFrame((t) => this._frame(t)); }

  _frame(now) {
    this._raf = null;
    if (this._tween) this._tween(now);
    const moving = this.controls.update() || this._tween || this.controls.autoRotate;
    this.renderer.render(this.scene, this.cam);
    const w = this.el.clientWidth, h = this.el.clientHeight;
    for (const m of this.marks) {
      const s = m.p.clone().project(this.cam);
      const vis = s.z < 1 && s.x > -1.05 && s.x < 1.05 && s.y > -1.05 && s.y < 1.05;
      m.d.style.transform = `translate(${(s.x * 0.5 + 0.5) * w}px, ${(-s.y * 0.5 + 0.5) * h}px)`;
      m.d.style.opacity = vis ? 1 : 0;
    }
    if (moving) this.request();
  }

  pause() { this.running = false; if (this._raf) cancelAnimationFrame(this._raf); this._raf = null; }
  resume() { this.running = true; this.resize(); this.request(); }
}
