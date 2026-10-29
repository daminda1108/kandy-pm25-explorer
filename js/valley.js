// valley.js — the 3-D Kandy basin (redesign A "The Valley", 2026-10-29; from the approved phase-0 mock-up).
// Real terrain (data/static/terrain3d.json, 100 m grid, relief x2.4) under a translucent haze sheet whose colour and
// opacity come ONLY from the model value in each 1 km cell (fixed WHO-anchored scale). No elevation-based pooling: the
// model's own floor-to-ridge contrast is a few per cent, and drawing more would show a pattern the evidence lacks.
// A second, optional sheet shows what every plausible within-valley map agrees on (Where tab).
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js?v=1793251900';

const EXAG = 2.4, SIZE = 15, HAZE_LIFT = 0.10;

// WHO 2021-anchored stops (µg/m³ -> rgb, alpha): a colour always means the same concentration
const STOPS = [
  [0, [159, 195, 178], 0.00], [5, [159, 195, 178], 0.05], [15, [233, 225, 180], 0.22],
  [25, [239, 199, 122], 0.38], [35, [229, 154, 82], 0.52], [50, [201, 101, 58], 0.66],
  [75, [142, 58, 44], 0.78], [120, [100, 36, 30], 0.86],
];
export function pmColour(v) {
  if (!(v > 0)) return [STOPS[0][1], 0];
  for (let i = 1; i < STOPS.length; i++) {
    if (v <= STOPS[i][0]) {
      const [a, ca, aa] = STOPS[i - 1], [b, cb, ab] = STOPS[i], t = (v - a) / (b - a);
      return [ca.map((c, k) => c + (cb[k] - c) * t), aa + (ab - aa) * t];
    }
  }
  const s = STOPS[STOPS.length - 1]; return [s[1], s[2]];
}
export const pmCss = (v) => `rgb(${pmColour(v)[0].map(Math.round).join(',')})`;

// PATTERN LENS (2026-10-29): colour by departure from this hour's valley average, on a fixed +-LENS_MAX % scale, so the
// model's within-valley pattern is visible at any level. Fixed (not per-hour) so a well-mixed hour honestly looks flat.
export const LENS_MAX = 20;
const LENS = [[-20, [110, 178, 160]], [-8, [143, 199, 178]], [0, [242, 233, 220]], [8, [232, 163, 90]], [20, [196, 88, 50]]];
export function lensColour(pct) {
  const x = Math.max(-LENS_MAX, Math.min(LENS_MAX, pct));
  for (let i = 1; i < LENS.length; i++) if (x <= LENS[i][0]) {
    const [a, ca] = LENS[i - 1], [b, cb] = LENS[i], t = (x - a) / (b - a);
    return [ca.map((c, k) => c + (cb[k] - c) * t), 0.06 + 0.74 * Math.min(1, Math.abs(x) / 15)];
  }
  return [LENS[LENS.length - 1][1], 0.8];
}
export const lensCss = (pct) => `rgb(${lensColour(pct)[0].map(Math.round).join(',')})`;

export function webglOK() {
  try {                                              // release the probe context: browsers cap live WebGL contexts
    const g = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
    if (!g) return false;
    const x = g.getExtension('WEBGL_lose_context'); if (x) x.loseContext();
    return true;
  } catch { return false; }
}

function bilinear(q, nla, nlo, u, v) {               // u: west->east 0..1, v: south->north 0..1, q row-major lat-ascending
  const x = u * (nlo - 1), y = v * (nla - 1), x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, nlo - 1), y1 = Math.min(y0 + 1, nla - 1), fx = x - x0, fy = y - y0;
  const g = (r, c) => q[r * nlo + c];
  return (g(y0, x0) * (1 - fx) + g(y0, x1) * fx) * (1 - fy) + (g(y1, x0) * (1 - fx) + g(y1, x1) * fx) * fy;
}

function groundColour(z01, shade) {
  const floor = [62, 74, 52], mid = [92, 102, 70], ridge = [128, 122, 104];
  const c = z01 < 0.5 ? floor.map((a, k) => a + (mid[k] - a) * (z01 / 0.5))
                      : mid.map((a, k) => a + (ridge[k] - a) * ((z01 - 0.5) / 0.5));
  return c.map((x) => (x / 255) * shade);
}

const CAMS = {
  wide: { x: 0.8, y: 12.5, z: 20.5, tx: 0.3, tz: 2.2, fov: 34 },
  phone: { x: 0.6, y: 13.0, z: 17.0, tx: 0.2, tz: 1.4, fov: 40 },
};

export class Valley {
  constructor(el, { terrain, meta, grid, onPick, camera = 'wide' }) {
    this.el = el; this.T = terrain; this.grid = grid; this.onPick = onPick;
    const n = terrain.n, zr = terrain.zmax - terrain.zmin;
    this.n = n; this.zr = zr;
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    el.appendChild(r.domElement);
    const scene = this.scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0f0d0b, 18, 42);
    const co = CAMS[camera] || CAMS.wide;
    const cam = this.cam = new THREE.PerspectiveCamera(co.fov, 1, 0.1, 200);
    cam.position.set(co.x, co.y, co.z);
    const ctl = this.ctl = new OrbitControls(cam, r.domElement);
    ctl.target.set(co.tx, 0, co.tz);
    ctl.enableDamping = true; ctl.dampingFactor = 0.08; ctl.enablePan = true; ctl.screenSpacePanning = false;
    ctl.zoomToCursor = true;                             // zoom into whatever part of the valley is under the cursor
    ctl.minDistance = 1.6; ctl.maxDistance = 30; ctl.maxPolarAngle = 1.3; ctl.minPolarAngle = 0.05;
    ctl.update();
    this.home = { pos: cam.position.clone(), target: ctl.target.clone() };

    const geo = new THREE.PlaneGeometry(SIZE, SIZE, n - 1, n - 1);
    geo.rotateX(-Math.PI / 2);                        // x east, z south (+), y up; plane rows run north -> south
    const pos = geo.attributes.position, colours = new Float32Array(pos.count * 3);
    const h = (rr, c) => terrain.elev[rr * n + c];
    this.height = h;
    for (let i = 0; i < pos.count; i++) {
      const c = i % n, rr = n - 1 - Math.floor(i / n);
      pos.setY(i, (h(rr, c) - terrain.zmin) / 1000 * EXAG);
    }
    geo.computeVertexNormals();
    const nrm = geo.attributes.normal, sun = new THREE.Vector3(-0.7, 0.42, -0.58).normalize();
    const edge = this.edge = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {             // edge fade: the block dissolves into the page (cosmetic, not data)
      const c = i % n, rr = Math.floor(i / n), d = Math.min(c, rr, n - 1 - c, n - 1 - rr) / (n * 0.16);
      const s = Math.min(1, Math.max(0, d)); edge[i] = s * s * (3 - 2 * s);
    }
    for (let i = 0; i < pos.count; i++) {
      const rr = n - 1 - Math.floor(i / n), c = i % n, z01 = (h(rr, c) - terrain.zmin) / zr;
      const lam = Math.max(0, nrm.getX(i) * sun.x + nrm.getY(i) * sun.y + nrm.getZ(i) * sun.z);
      colours.set(groundColour(z01, (0.22 + 1.25 * lam) * (0.06 + 0.94 * edge[i])), i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    this.ground = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true }));
    scene.add(this.ground);

    const sheet = (lift) => {
      const g = geo.clone(), p = g.attributes.position;
      for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) + lift);
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(p.count * 4), 4));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
      scene.add(m); return m;
    };
    this.haze = sheet(HAZE_LIFT);
    this.haze2 = sheet(0.30); this.haze2.material.opacity = 0.35;
    this.over = sheet(0.36); this.over.renderOrder = 10; this.over.visible = false;
    this.hazeK = 1; this.mode = 'haze'; this.roads = null;
    // CONTRAST STRETCH (2026-10-29): colour is drawn for mean + stretch*(value - mean). The valley average keeps its
    // true colour; differences across the valley are drawn `stretch` times stronger so the model's pattern can be
    // seen. Numbers are never stretched; the page labels the factor and offers true scale.
    this.stretch = 1; this.onPinMove = null;

    // labels (HTML, projected each frame) + one marker for the picked point
    this.labelLayer = Object.assign(document.createElement('div'), { className: 'labels' });
    el.appendChild(this.labelLayer);
    this.marks = (meta.landmarks || []).filter((m) => m.k !== 'sensor').map((m) => {
      const d = Object.assign(document.createElement('span'), { className: 'lbl' + (m.k === 'city' ? ' city' : ''),
                                                                 textContent: m.n });
      this.labelLayer.appendChild(d);
      return { p: this.lonLatToScene(m.c[0], m.c[1], 0.25), d, m };
    });
    this.pin = Object.assign(document.createElement('span'), { className: 'pin' });
    this.pin.style.display = 'none'; this.labelLayer.appendChild(this.pin); this.pinP = null;

    // pick: a click (not a drag) on the ground answers for that place
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    let down = null;
    r.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    r.domElement.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
      const b = r.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1);
      ray.setFromCamera(ndc, cam);
      const hit = ray.intersectObject(this.ground)[0];
      if (!hit) return;
      const u = hit.point.x / SIZE + 0.5, v = 0.5 - hit.point.z / SIZE;
      if (u < 0 || u > 1 || v < 0 || v > 1) return;
      const lon = terrain.lon0 + u * (terrain.lon1 - terrain.lon0), lat = terrain.lat0 + v * (terrain.lat1 - terrain.lat0);
      this.onPick && this.onPick(lat, lon);
    });

    this._resize = () => {
      const w = el.clientWidth, hh = el.clientHeight;
      r.setSize(w, hh, false); r.domElement.style.width = w + 'px'; r.domElement.style.height = hh + 'px';
      cam.aspect = w / Math.max(hh, 1); cam.updateProjectionMatrix();
    };
    new ResizeObserver(this._resize).observe(el); this._resize();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    ctl.autoRotate = !reduce; ctl.autoRotateSpeed = 0.12;
    r.domElement.addEventListener('pointerdown', () => { ctl.autoRotate = false; }, { once: true });
    const frame = (t) => {
      // keep panning on the block
      ctl.target.x = Math.max(-SIZE / 2, Math.min(SIZE / 2, ctl.target.x));
      ctl.target.z = Math.max(-SIZE / 2, Math.min(SIZE / 2, ctl.target.z));
      ctl.update(); this._animate(t); r.render(scene, cam); this._project(); requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  lonLatToScene(lon, lat, lift = 0) {
    const T = this.T, n = this.n;
    const u = (lon - T.lon0) / (T.lon1 - T.lon0), v = (lat - T.lat0) / (T.lat1 - T.lat0);
    const c = Math.round(Math.min(1, Math.max(0, u)) * (n - 1)), rr = Math.round(Math.min(1, Math.max(0, v)) * (n - 1));
    return new THREE.Vector3((u - 0.5) * SIZE, (this.height(rr, c) - T.zmin) / 1000 * EXAG + lift, (0.5 - v) * SIZE);
  }

  _project() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    const put = (p, d) => {
      const s = p.clone().project(this.cam);
      d.style.transform = `translate(${(s.x * 0.5 + 0.5) * w}px, ${(-s.y * 0.5 + 0.5) * h}px)`;
      d.style.opacity = s.z < 1 && Math.abs(s.x) < 1.05 && Math.abs(s.y) < 1.05 ? 1 : 0;
    };
    for (const m of this.marks) put(m.p, m.d);
    if (this.pinP) {
      put(this.pinP, this.pin);
      if (this.onPinMove) {                                // the point card follows its pin as the view turns
        const s = this.pinP.clone().project(this.cam);
        this.onPinMove((s.x * 0.5 + 0.5) * w, (-s.y * 0.5 + 0.5) * h);
      }
    }
  }

  setPin(lat, lon) {
    if (lat == null) { this.pinP = null; this.pin.style.display = 'none'; return; }
    this.pinP = this.lonLatToScene(lon, lat, 0.2); this.pin.style.display = '';
  }

  setHazeStrength(k) { this.hazeK = k; if (this._q) this.setField(this._q); }
  setMode(m) { this.mode = m; if (this._q) this.setField(this._q); }
  setStretch(k) { this.stretch = k; if (this._q) this.setField(this._q); }
  followPin(fn) { this.onPinMove = fn; }

  // OpenStreetMap roads draped on the ground, under the haze (rank 3 trunk/primary, 2 secondary, 1 the rest)
  setRoads(features) {
    const by = { 1: [], 2: [], 3: [] }, T = this.T, n = this.n;
    // keep segments on the terrain block, and drop them where the block fades into the page (edge < 0.5)
    const inside = (q) => {
      const u = (q[0] - T.lon0) / (T.lon1 - T.lon0), v = (q[1] - T.lat0) / (T.lat1 - T.lat0);
      if (u < 0 || u > 1 || v < 0 || v > 1) return false;
      const c = Math.round(u * (n - 1)), r = n - 1 - Math.round(v * (n - 1));
      return this.edge[r * n + c] > 0.5;
    };
    for (const f of features || []) {
      if (f.t !== 'ln') continue;
      const arr = by[f.r || 1] || by[1];
      for (let i = 1; i < f.c.length; i++) {
        if (!inside(f.c[i - 1]) || !inside(f.c[i])) continue;
        for (const q of [f.c[i - 1], f.c[i]]) { const v = this.lonLatToScene(q[0], q[1], 0.02); arr.push(v.x, v.y, v.z); }
      }
    }
    this.roads = new THREE.Group();
    for (const [r, op] of [[1, 0.35], [2, 0.55], [3, 0.85]]) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(by[r], 3));
      this.roads.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: r === 3 ? 0xf2e9dc : 0xd8cdbb,
        transparent: true, opacity: op, depthWrite: false })));
    }
    this.roads.renderOrder = 5; this.scene.add(this.roads);
  }
  showRoads(on) { if (this.roads) this.roads.visible = on; }

  // hydrology: OpenStreetMap rivers (lines) and lakes/reservoirs (filled), draped on the ground under the haze
  setWater(rivers, water) {
    const T = this.T, n = this.n, grp = new THREE.Group();
    const inside = (q) => {
      const u = (q[0] - T.lon0) / (T.lon1 - T.lon0), v = (q[1] - T.lat0) / (T.lat1 - T.lat0);
      if (u < 0 || u > 1 || v < 0 || v > 1) return false;
      return this.edge[(n - 1 - Math.round(v * (n - 1))) * n + Math.round(u * (n - 1))] > 0.5;
    };
    const pts = [];
    for (const f of rivers || []) for (let i = 1; i < f.c.length; i++) {
      if (!inside(f.c[i - 1]) || !inside(f.c[i])) continue;
      for (const q of [f.c[i - 1], f.c[i]]) { const v = this.lonLatToScene(q[0], q[1], 0.025); pts.push(v.x, v.y, v.z); }
    }
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    grp.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x7fb6d6, transparent: true, opacity: 0.95, depthWrite: false })));
    const mat = new THREE.MeshBasicMaterial({ color: 0x5f9fc4, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
    for (const f of water || []) {
      const ring = (f.c && f.c[0]) || [];
      if (ring.length < 3 || !ring.every(inside)) continue;
      const shape = new THREE.Shape(ring.map((q) => { const v = this.lonLatToScene(q[0], q[1]); return new THREE.Vector2(v.x, v.z); }));
      const g = new THREE.ShapeGeometry(shape), p = g.attributes.position, out = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), z = p.getY(i), u = x / SIZE + 0.5, v = 0.5 - z / SIZE;
        const y = this.lonLatToScene(T.lon0 + u * (T.lon1 - T.lon0), T.lat0 + v * (T.lat1 - T.lat0), 0.03).y;
        out.set([x, y, z], i * 3);
      }
      g.setAttribute('position', new THREE.BufferAttribute(out, 3));
      grp.add(new THREE.Mesh(g, mat));
    }
    grp.renderOrder = 6; this.water = grp; this.scene.add(grp);
  }
  showWater(on) { if (this.water) this.water.visible = on; }

  resetView() { this.cam.position.copy(this.home.pos); this.ctl.target.copy(this.home.target); this.ctl.update(); }

  // URBAN DEVELOPMENT: share of built-up land per terrain cell (ESA WorldCover 2021), a pale sheet on the ground
  setBuilt(b) {
    if (!b || b.n !== this.n) return;
    const g = this.ground.geometry.clone(), p = g.attributes.position, n = this.n;
    for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) + 0.33);   // above the haze sheets, so haze does not tint it
    const col = new Float32Array(p.count * 4);
    for (let i = 0; i < p.count; i++) {
      const c = i % n, r = n - 1 - Math.floor(i / n), x = b.pct[r * n + c] / 100;
      col.set([0.98, 0.96, 0.92, Math.min(0.9, 0.35 + 2.2 * x) * (x > 0.05 ? 1 : 0) * this.edge[i]], i * 4);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    this.built = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    this.built.renderOrder = 7; this.built.visible = false; this.scene.add(this.built);
  }
  showBuilt(on) { if (this.built) this.built.visible = on; }

  // WEATHER: terrain wind as arrows, rain as falling streaks (rate = the hour's valley rain), and the top of the mixed
  // layer as a translucent lid above the valley floor (below the ridges when the air is trapped)
  _ensureWeather() {
    if (this.wx) return;
    const grp = new THREE.Group();
    this.windLines = new THREE.LineSegments(new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xdfeef5, transparent: true, opacity: 0.9, depthWrite: false }));
    const NR = 2400, rp = new Float32Array(NR * 6);
    for (let i = 0; i < NR; i++) {
      const x = (Math.random() - 0.5) * SIZE * 0.92, z = (Math.random() - 0.5) * SIZE * 0.92, y = Math.random() * 6;
      rp.set([x, y, z, x, y - 0.18, z], i * 6);
    }
    const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0x9cc8e6, transparent: true, opacity: 0.55, depthWrite: false }));
    this.rainN = 0;
    this.lid = new THREE.Mesh(new THREE.PlaneGeometry(SIZE * 0.9, SIZE * 0.9).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xbfd9e8, transparent: true, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide }));
    const edgeLine = new THREE.LineSegments(new THREE.EdgesGeometry(this.lid.geometry),
      new THREE.LineBasicMaterial({ color: 0xbfd9e8, transparent: true, opacity: 0.6 }));
    this.lid.add(edgeLine);
    grp.add(this.windLines, this.rain, this.lid);
    for (const o of [this.windLines, this.rain, this.lid]) o.renderOrder = 8;
    this.wx = grp; this.wx.visible = false; this.scene.add(grp);
  }
  setWeather({ wind, rain, blh, floorElev }) {
    this._ensureWeather();
    const T = this.T, pts = [];
    if (wind) {
      const step = Math.max(1, Math.round(wind.gx / 18));
      let vmax = 0.5; for (let c = 0; c < wind.U.length; c++) vmax = Math.max(vmax, Math.hypot(wind.U[c], wind.V[c]));
      for (let r = step >> 1; r < wind.gy; r += step) for (let c = step >> 1; c < wind.gx; c += step) {
        const k = r * wind.gx + c, u = wind.U[k], v = wind.V[k], sp = Math.hypot(u, v);
        if (sp < 0.05) continue;
        const lat = wind.lats[r], lon = wind.lons[c];
        if (lat < T.lat0 || lat > T.lat1 || lon < T.lon0 || lon > T.lon1) continue;
        const p0 = this.lonLatToScene(lon, lat, 0.22), L = 0.15 + 0.5 * sp / vmax;
        const dx = u / sp * L, dz = -v / sp * L;                    // scene z points south
        const p1 = new THREE.Vector3(p0.x + dx, p0.y, p0.z + dz);
        pts.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
        const hx = -dx * 0.35, hz = -dz * 0.35;                      // arrowhead
        pts.push(p1.x, p1.y, p1.z, p1.x + hx - hz * 0.6, p1.y, p1.z + hz + hx * 0.6);
        pts.push(p1.x, p1.y, p1.z, p1.x + hx + hz * 0.6, p1.y, p1.z + hz - hx * 0.6);
      }
    }
    this.windLines.geometry.dispose();
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.windLines.geometry = g;
    // rain: drops in proportion to the rate (about 2,400 at 5 mm/h and above)
    this.rainN = Number.isFinite(rain) && rain >= 0.1 ? Math.round(2400 * Math.min(1, rain / 5)) : 0;
    this.rain.geometry.setDrawRange(0, this.rainN * 2);
    // lid at floor elevation + mixing height (vertical scale as the terrain)
    if (Number.isFinite(blh)) {
      this.lid.visible = true;
      this.lid.position.y = (Math.min(floorElev + blh, T.zmax + 1500) - T.zmin) / 1000 * EXAG;
    } else this.lid.visible = false;
  }
  showWeather(on) { this._ensureWeather(); this.wx.visible = on; }
  _animate() {
    if (!this.wx || !this.wx.visible || !this.rainN) return;
    const p = this.rain.geometry.attributes.position, a = p.array;
    for (let i = 0; i < this.rainN; i++) {
      let y = a[i * 6 + 1] - 0.09;
      if (y < 0) y += 6;
      a[i * 6 + 1] = y; a[i * 6 + 4] = y - 0.18;
    }
    p.needsUpdate = true;
  }

  _gridAt(q, i) {
    const n = this.n, c = i % n, rr = n - 1 - Math.floor(i / n), T = this.T, g = this.grid;
    const lon = T.lon0 + c / (n - 1) * (T.lon1 - T.lon0), lat = T.lat0 + rr / (n - 1) * (T.lat1 - T.lat0);
    const u = (lon - g.lons[0]) / (g.lons[g.n_lon - 1] - g.lons[0]), v = (lat - g.lats[0]) / (g.lats[g.n_lat - 1] - g.lats[0]);
    return bilinear(q, g.n_lat, g.n_lon, Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v)));
  }

  setField(q50) {
    this._q = q50;
    const col = this.haze.geometry.attributes.color, a4 = col.array;
    let mean = 0; for (const x of q50) mean += Math.max(x, 0); mean /= q50.length;
    const lens = this.mode === 'lens';
    for (let i = 0; i < col.count; i++) {
      const v = this._gridAt(q50, i);
      const [rgb, a] = lens ? lensColour(mean > 0.5 ? (Math.max(v, 0) / mean - 1) * 100 : 0)
        : pmColour(Math.max(0, mean + this.stretch * (Math.max(v, 0) - mean)));
      a4[i * 4] = rgb[0] / 255; a4[i * 4 + 1] = rgb[1] / 255; a4[i * 4 + 2] = rgb[2] / 255;
      // haze thickness follows the departure from the valley average (same stretch as the colour): dirtier cells
      // thicker, cleaner cells thinner, so pooled air reads as haze and clean ridges show through
      const rel = mean > 0.5 ? Math.max(v, 0) / mean - 1 : 0;
      const thick = lens ? 1 : Math.min(1.25, Math.max(0.08, 0.6 + 2.5 * this.stretch * rel));
      a4[i * 4 + 3] = Math.min(0.95, (lens ? 0.92 : 0.8 * this.hazeK) * a * thick) * this.edge[i];
    }
    col.needsUpdate = true;
    this.haze2.geometry.setAttribute('color', col);
    this.haze2.visible = !lens;                         // one crisp sheet for the lens, two soft ones for haze
    const [f] = pmColour(mean), k = Math.min(1, mean / 80), fog = this.scene.fog;
    fog.color.setRGB((15 + (f[0] - 15) * 0.35 * k) / 255, (13 + (f[1] - 13) * 0.35 * k) / 255, (11 + (f[2] - 11) * 0.35 * k) / 255);
    fog.near = 16 - 6 * k; fog.far = 42 - 14 * k;
  }

  // amber where every plausible map puts the cell above the valley average, cool where every one puts it below, clear
  // where they disagree; opacity also scales with the size of the departure (none below 3 %, full from 13 %)
  setConfidence(conf) {
    if (!conf) { this.over.visible = false; return; }
    const col = this.over.geometry.attributes.color, a4 = col.array;
    for (let i = 0; i < col.count; i++) {
      const u = Math.max(0, (this._gridAt(conf.up, i) - 0.85) / 0.15);
      const d = Math.max(0, (this._gridAt(conf.dn, i) - 0.85) / 0.15);
      const m = Math.min(1, Math.max(0, (Math.abs(this._gridAt(conf.mag, i)) - 3) / 10));
      const rgb = u >= d ? [232, 163, 90] : [143, 199, 178];
      a4[i * 4] = rgb[0] / 255; a4[i * 4 + 1] = rgb[1] / 255; a4[i * 4 + 2] = rgb[2] / 255;
      a4[i * 4 + 3] = 0.7 * Math.max(u, d) * m * this.edge[i];
    }
    col.needsUpdate = true; this.over.visible = true;
  }

  snapshot() { this.renderer.render(this.scene, this.cam); return this.renderer.domElement; }
}
