// scene.js — the 3-D Kandy valley for redesign v2 ("the valley breathes", plan
// kandy_pm25/docs/webapp_redesign_v2_plan_2026-10-27.md). What each element is, and where it comes from:
//   terrain  100 m DEM, relief x2.4 (measured)
//   haze     particles filling the air from the ground up to the top of the mixing layer. Their density per unit
//            volume and their colour follow ONLY the model's PM2.5 value at that place and hour (WHO-anchored
//            colours); nothing is pooled or emphasised by elevation. The well-mixed layer is the standard picture.
//   lid      the top of the mixing layer: ERA5 boundary-layer height, drawn as a level sheet above the valley floor,
//            with the line where it meets the hillsides. Weather of the hour, not part of the model's map.
//   wind     streaks carried by the valley-wind field for the hour (indicative, not calibrated in Kandy)
//   rain     streaks when the satellite rain estimate says it is raining
//   traffic  movers on the OpenStreetMap roads; how many follow the typical road-traffic timing for the hour, thinned
//            on Sundays by the drop the station measures. Activity, not pollution.
// Engine-independent: callers hand in the hour's numbers; nothing here changes a number.
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

const EXAG = 2.4, SIZE = 15;                   // world units: 1 = 1 km horizontally; vertical x2.4
const N_HAZE = 9000, N_WIND = 1400, N_TRAF = 1100, N_RAIN = 1600;

// WHO 2021-anchored colours (µg/m³): guideline 15; interim targets 25, 35, 50, 75
const STOPS = [[0, [169, 189, 178]], [5, [169, 189, 178]], [15, [216, 207, 159]], [25, [217, 174, 107]],
               [35, [201, 125, 70]], [50, [165, 80, 47]], [75, [116, 48, 42]], [120, [80, 30, 28]]];
export function pmColour(v) {
  for (let i = 1; i < STOPS.length; i++) if (v <= STOPS[i][0]) {
    const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i], t = Math.max(0, (v - a) / (b - a));
    return ca.map((c, k) => c + (cb[k] - c) * t);
  }
  return STOPS[STOPS.length - 1][1];
}
export function pmCss(v) { const c = pmColour(v); return `rgb(${c.map(Math.round).join(',')})`; }

export function webglOK() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); }
  catch { return false; }
}

// sky by local hour (Kandy: sunrise ~06:00, sunset ~18:15 all year)
const SKY = [  // hour, top, horizon, ground light, ground tint
  [0, '#0e1a2e', '#24324a', 0.34, [0.75, 0.85, 1.1]],
  [4.8, '#0e1a2e', '#24324a', 0.34, [0.75, 0.85, 1.1]],
  [5.8, '#3c4a6a', '#c9a796', 0.55, [0.95, 0.9, 1.0]],
  [6.6, '#9fb3c4', '#ecd8bf', 0.85, [1.05, 0.98, 0.92]],
  [8, '#a9c0d0', '#e6e8e3', 1.0, [1, 1, 1]],
  [16, '#a9c0d0', '#e6e8e3', 1.0, [1, 1, 1]],
  [17.6, '#a2b2bf', '#ead8bb', 0.88, [1.06, 0.97, 0.88]],
  [18.4, '#4c5a7a', '#c79a82', 0.6, [1.0, 0.88, 0.9]],
  [19.3, '#162238', '#33405c', 0.38, [0.78, 0.86, 1.08]],
  [24, '#0e1a2e', '#24324a', 0.34, [0.75, 0.85, 1.1]],
];
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function skyAt(h) {
  let k = 1; while (k < SKY.length - 1 && h > SKY[k][0]) k++;
  const a = SKY[k - 1], b = SKY[k], t = b[0] > a[0] ? Math.min(1, Math.max(0, (h - a[0]) / (b[0] - a[0]))) : 0;
  const mix = (x, y) => x.map((v, i) => v + (y[i] - v) * t);
  return { top: mix(hex(a[1]), hex(b[1])), hor: mix(hex(a[2]), hex(b[2])), light: a[3] + (b[3] - a[3]) * t,
           tint: mix(a[4], b[4]), night: (a[3] + (b[3] - a[3]) * t) < 0.5 };
}

const CAMS = {
  overview: { pos: [4.5, 9.0, 14.5], tgt: [0.6, 0.4, -0.6] },
  explore:  { pos: [7.2, 7.4, -10.6], tgt: [-0.2, 0.2, 0.9] },  // from the north-east, over the city toward Hantana
  close:    { pos: [2.6, 3.4, 5.6],  tgt: [0.9, 0.5, -0.6] },
  side:     { pos: [13.5, 3.2, 2.0], tgt: [0.2, 0.9, -0.4] },   // looking along the layer, from the east
  high:     { pos: [0.2, 16.5, 6.5], tgt: [0.3, 0, -0.4] },
  north:    { pos: [-1.0, 6.5, -13.0], tgt: [0.4, 0.4, 0.3] },
  phone:    { pos: [5.5, 12.5, 17.5], tgt: [0.6, 0.2, -0.4] },
};

function discTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.45, 'rgba(255,255,255,.55)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class ValleyScene {
  constructor(host, { terrain, meta, roads = [], interactive = true, camera = 'overview' } = {}) {
    this.host = host; this.t = terrain; this.meta = meta;
    const n = terrain.n;
    this.zr = terrain.zmax - terrain.zmin;
    const fl = [...terrain.elev].filter((e) => e < 520).sort((a, b) => a - b);
    this.floorElev = fl.length ? fl[Math.floor(fl.length / 2)] : terrain.zmin + 60;   // median valley-floor elevation

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    host.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0xdfe5e8, 0.02);
    this.cam = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
    this.sky = skyAt(12);
    this.layers = { haze: true, lid: true, wind: true, traffic: true };
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

    this._buildGround(n);
    this._buildRoadsOnGround(roads);
    this._buildHaze();
    this._buildLid();
    this._buildWind();
    this._buildRain();
    this._buildTraffic(roads);
    this._buildLabels(meta);

    this.controls = new OrbitControls(this.cam, this.renderer.domElement);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.08, enablePan: false, minDistance: 4,
      maxDistance: 30, maxPolarAngle: Math.PI * 0.48, minPolarAngle: Math.PI * 0.06, rotateSpeed: 0.55,
      zoomSpeed: 0.7, enabled: interactive });
    this.setCamera(camera, false);

    this._ro = new ResizeObserver(() => this.resize()); this._ro.observe(host); this.resize();
    this.running = true; this._last = performance.now(); this._raf = requestAnimationFrame((t) => this._frame(t));
  }

  // ── geometry helpers ──────────────────────────────────────────────────
  elevAt(lon, lat) {
    const t = this.t, n = t.n;
    const fu = Math.min(n - 1, Math.max(0, (lon - t.lon0) / (t.lon1 - t.lon0) * (n - 1)));
    const fv = Math.min(n - 1, Math.max(0, (lat - t.lat0) / (t.lat1 - t.lat0) * (n - 1)));
    const c0 = Math.floor(fu), r0 = Math.floor(fv), c1 = Math.min(c0 + 1, n - 1), r1 = Math.min(r0 + 1, n - 1);
    const a = fu - c0, b = fv - r0, E = t.elev;
    return (E[r0 * n + c0] * (1 - a) + E[r0 * n + c1] * a) * (1 - b) + (E[r1 * n + c0] * (1 - a) + E[r1 * n + c1] * a) * b;
  }
  yOf(elev) { return (elev - this.t.zmin) / 1000 * EXAG; }
  // world x,z ↔ lon,lat
  xz(lon, lat) { const t = this.t; return [((lon - t.lon0) / (t.lon1 - t.lon0) - 0.5) * SIZE, (0.5 - (lat - t.lat0) / (t.lat1 - t.lat0)) * SIZE]; }
  ll(x, z) { const t = this.t; return [t.lon0 + (x / SIZE + 0.5) * (t.lon1 - t.lon0), t.lat0 + (0.5 - z / SIZE) * (t.lat1 - t.lat0)]; }
  groundY(x, z) { const [lon, lat] = this.ll(x, z); return this.yOf(this.elevAt(lon, lat)); }

  _buildGround(n) {
    const t = this.t, geo = new THREE.PlaneGeometry(SIZE, SIZE, n - 1, n - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    this.z01 = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const c = i % n, r = n - 1 - Math.floor(i / n), e = t.elev[r * n + c];
      this.z01[i] = (e - t.zmin) / this.zr; pos.setY(i, this.yOf(e));
    }
    geo.computeVertexNormals();
    const nrm = geo.attributes.normal, sun = new THREE.Vector3(-0.6, 0.55, -0.55).normalize();
    this.gShade = new Float32Array(pos.count); this.gBase = new Float32Array(pos.count * 3);
    this.gElev = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const c = i % n, r = Math.floor(i / n), d = Math.min(c, r, n - 1 - c, n - 1 - r) / (n * 0.10);
      const s = Math.min(1, Math.max(0, d)), edge = s * s * (3 - 2 * s);
      const lam = Math.max(0, nrm.getX(i) * sun.x + nrm.getY(i) * sun.y + nrm.getZ(i) * sun.z);
      this.gShade[i] = (0.42 + 0.85 * lam) * (0.25 + 0.75 * edge);
      const z = this.z01[i];
      const floor = [176, 172, 150], mid = [128, 146, 112], ridge = [92, 116, 88];   // settled floor → forest ridges
      const col = z < 0.18 ? floor.map((a, k) => a + (mid[k] - a) * (z / 0.18))
                           : mid.map((a, k) => a + (ridge[k] - a) * Math.min(1, (z - 0.18) / 0.5));
      this.gBase.set(col.map((x) => x / 255), i * 3);
      this.gElev[i] = t.zmin + z * this.zr;
    }
    this.gCol = new Float32Array(pos.count * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(this.gCol, 3));
    this.ground = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true }));
    this.scene.add(this.ground);
  }

  _buildRoadsOnGround(roads) {
    const pts = [];
    for (const f of roads) {
      if (f.t !== 'ln' || (f.r || 1) < 2) continue;
      for (let i = 1; i < f.c.length; i++) for (const p of [f.c[i - 1], f.c[i]]) {
        const [x, z] = this.xz(p[0], p[1]); pts.push(x, this.yOf(this.elevAt(p[0], p[1])) + 0.012, z);
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.roadMat = new THREE.LineBasicMaterial({ color: 0x6d6a62, transparent: true, opacity: 0.5 });
    this.scene.add(new THREE.LineSegments(g, this.roadMat));
  }

  _pointsMaterial(tex) {
    return new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 400 }, uMap: { value: tex } },
      vertexShader: `attribute vec4 col; attribute float sz; uniform float uScale; varying vec4 vCol;
        void main(){ vCol = col; vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = sz * uScale / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D uMap; varying vec4 vCol;
        void main(){ float a = texture2D(uMap, gl_PointCoord).a; if (a * vCol.a < 0.004) discard;
          gl_FragColor = vec4(vCol.rgb, vCol.a * a); }`,
      transparent: true, depthWrite: false,
    });
  }

  _buildHaze() {
    const g = new THREE.BufferGeometry();
    this.hPos = new Float32Array(N_HAZE * 3); this.hCol = new Float32Array(N_HAZE * 4);
    this.hSz = new Float32Array(N_HAZE); this.hF = new Float32Array(N_HAZE);   // fraction of the layer depth
    for (let i = 0; i < N_HAZE; i++) { this.hF[i] = Math.random(); this.hSz[i] = 0.035 + Math.random() * 0.05; }
    g.setAttribute('position', new THREE.BufferAttribute(this.hPos, 3));
    g.setAttribute('col', new THREE.BufferAttribute(this.hCol, 4));
    g.setAttribute('sz', new THREE.BufferAttribute(this.hSz, 1));
    this.hazeMat = this._pointsMaterial(discTexture());
    this.haze = new THREE.Points(g, this.hazeMat); this.haze.frustumCulled = false;
    this.haze.renderOrder = 3;
    this.scene.add(this.haze);
    this.hN = 0;
  }

  _buildLid() {
    // the sheet fades out toward the edges of the box, so it never shows a hard floating edge
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'), im = g.createImageData(128, 128);
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
      const d = Math.min(x, y, 127 - x, 127 - y) / 14, a = Math.max(0, Math.min(1, d));
      im.data.set([255, 255, 255, Math.round(255 * a * a * (3 - 2 * a))], (y * 128 + x) * 4);
    }
    g.putImageData(im, 0, 0);
    this.lidMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, depthWrite: false,
                                                side: THREE.DoubleSide, alphaMap: new THREE.CanvasTexture(c) });
    this.lid = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE).rotateX(-Math.PI / 2), this.lidMat);
    this.lid.renderOrder = 2;
    this.scene.add(this.lid);
    this.shoreMat = new THREE.LineBasicMaterial({ color: 0x8fa3b3, transparent: true, opacity: 0.55 });
    this.shore = new THREE.LineSegments(new THREE.BufferGeometry(), this.shoreMat);
    this.shore.renderOrder = 4;
    this.scene.add(this.shore);
  }

  _buildWind() {
    const g = new THREE.BufferGeometry();
    this.wPos = new Float32Array(N_WIND * 6); this.wP = new Float32Array(N_WIND * 4);   // x, z, height off ground, age
    for (let i = 0; i < N_WIND; i++) this._seedWind(i);
    g.setAttribute('position', new THREE.BufferAttribute(this.wPos, 3));
    this.windMat = new THREE.LineBasicMaterial({ color: 0x2f4a5e, transparent: true, opacity: 0.55 });
    this.wind = new THREE.LineSegments(g, this.windMat); this.wind.frustumCulled = false; this.wind.renderOrder = 5;
    this.scene.add(this.wind);
    this.wf = null; this.wN = 0;
  }
  _seedWind(i) {
    this.wP[i * 4] = (Math.random() - 0.5) * SIZE * 0.96; this.wP[i * 4 + 1] = (Math.random() - 0.5) * SIZE * 0.96;
    this.wP[i * 4 + 2] = 0.06 + Math.random() * 0.22; this.wP[i * 4 + 3] = Math.random() * 4;
  }

  _buildRain() {
    const g = new THREE.BufferGeometry();
    this.rPos = new Float32Array(N_RAIN * 6); this.rP = new Float32Array(N_RAIN * 3);
    for (let i = 0; i < N_RAIN; i++) {
      this.rP[i * 3] = (Math.random() - 0.5) * SIZE; this.rP[i * 3 + 1] = (Math.random() - 0.5) * SIZE;
      this.rP[i * 3 + 2] = Math.random() * 5;
    }
    g.setAttribute('position', new THREE.BufferAttribute(this.rPos, 3));
    this.rainMat = new THREE.LineBasicMaterial({ color: 0x8aa0b4, transparent: true, opacity: 0.5 });
    this.rain = new THREE.LineSegments(g, this.rainMat); this.rain.frustumCulled = false;
    this.scene.add(this.rain);
    this.rN = 0;
  }

  _buildTraffic(roads) {
    // world-space polylines with cumulative length; choice weighted by length and road class
    this.paths = [];
    let wsum = 0;
    for (const f of roads) {
      if (f.t !== 'ln' || f.c.length < 2) continue;
      const P = [], L = [0];
      for (const p of f.c) { const [x, z] = this.xz(p[0], p[1]); P.push([x, this.yOf(this.elevAt(p[0], p[1])) + 0.035, z]); }
      for (let i = 1; i < P.length; i++) L.push(L[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][2] - P[i - 1][2]));
      const len = L[L.length - 1];
      if (len < 0.15) continue;
      const w = len * ({ 3: 3, 2: 1.5, 1: 0.6 }[f.r || 1]);
      wsum += w; this.paths.push({ P, L, len, cw: wsum });
    }
    this.pathW = wsum;
    const g = new THREE.BufferGeometry();
    this.tPos = new Float32Array(N_TRAF * 6); this.tP = [];
    for (let i = 0; i < N_TRAF; i++) this.tP.push(this._seedCar());
    g.setAttribute('position', new THREE.BufferAttribute(this.tPos, 3));
    this.trafMat = new THREE.LineBasicMaterial({ color: 0xc46a1d, transparent: true, opacity: 0.9 });
    this.traf = new THREE.LineSegments(g, this.trafMat); this.traf.frustumCulled = false; this.traf.renderOrder = 6;
    this.scene.add(this.traf);
    this.tN = 0;
  }
  _seedCar() {
    if (!this.paths.length) return null;
    const r = Math.random() * this.pathW;
    let lo = 0, hi = this.paths.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.paths[m].cw < r) lo = m + 1; else hi = m; }
    const p = this.paths[lo];
    return { p, s: Math.random() * p.len, dir: Math.random() < 0.5 ? 1 : -1, v: 0.35 + Math.random() * 0.35 };
  }
  _along(p, s) {
    s = Math.max(0, Math.min(p.len, s));
    let lo = 1, hi = p.L.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (p.L[m] < s) lo = m + 1; else hi = m; }
    const a = p.P[lo - 1], b = p.P[lo], seg = p.L[lo] - p.L[lo - 1] || 1, t = (s - p.L[lo - 1]) / seg;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  _buildLabels(meta) {
    this.labelLayer = document.createElement('div'); this.labelLayer.className = 's-labels';
    this.host.appendChild(this.labelLayer);
    this.marks = (meta.landmarks || []).filter((m) => m.k !== 'sensor').map((m) => {
      const [x, z] = this.xz(m.c[0], m.c[1]);
      const d = document.createElement('span'); d.className = 's-lbl' + (m.k === 'city' ? ' city' : '');
      d.textContent = m.n; this.labelLayer.appendChild(d);
      return { p: new THREE.Vector3(x, this.yOf(this.elevAt(m.c[0], m.c[1])) + 0.25, z), d };
    });
  }

  // ── per-hour state ───────────────────────────────────────────────────
  // h: { q (PM2.5 on the payload grid), grid, avg, blh (m), wind ({U,V,gx,gy}|null), rain (mm/h), hour (local, float),
  //      traffic (0..1 share of the busiest hour) }
  setHour(h) {
    this.h = h;
    this._applySky(h.hour, h.avg);
    this._placeLid(h.blh);
    this._paintGround(h.avg);
    this._placeHaze(h);
    this._setWind(h.wind);
    this.rN = Number.isFinite(h.rain) && h.rain > 0.1 ? Math.round(N_RAIN * Math.min(1, 0.15 + h.rain / 6)) : 0;
    this.tN = Math.round(N_TRAF * Math.max(0, Math.min(1, h.traffic ?? 0)));
  }

  setLayers(l) { Object.assign(this.layers, l); this._vis(); }
  _vis() {
    this.haze.visible = this.layers.haze;
    this.lid.visible = this.shore.visible = this.layers.lid && this.lidY != null;
    this.wind.visible = this.layers.wind && !!this.wf;
    this.traf.visible = this.layers.traffic;
    this.rain.visible = this.rN > 0;
  }

  _applySky(hour, avg) {
    const s = skyAt(hour); this.sky = s;
    const pc = pmColour(avg), k = Math.min(1, avg / 70);
    // background: a vertical gradient, horizon tinted by the hour's haze
    const hor = s.hor.map((v, i) => v + (pc[i] - v) * 0.35 * k);
    const c = document.createElement('canvas'); c.width = 2; c.height = 256;
    const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, `rgb(${s.top.map(Math.round)})`); gr.addColorStop(0.62, `rgb(${hor.map(Math.round)})`);
    gr.addColorStop(1, `rgb(${hor.map(Math.round)})`);
    g.fillStyle = gr; g.fillRect(0, 0, 2, 256);
    if (this.scene.background) this.scene.background.dispose();
    this.scene.background = new THREE.CanvasTexture(c);
    // distance haze: its colour and thickness follow the valley average (clean ≈ clear air, 50 µg/m³ ≈ the far
    // side of the valley a third veiled)
    const fc = s.hor.map((v, i) => v + (pc[i] - v) * 0.55 * k);
    this.scene.fog.color.setRGB(fc[0] / 255, fc[1] / 255, fc[2] / 255);
    this.scene.fog.density = 0.008 + 0.0007 * Math.min(avg, 120);
    this.roadMat.color.set(s.night ? 0x4a4f58 : 0x6d6a62);
    this.windMat.color.set(s.night ? 0xcfdbe6 : 0x2f4a5e);
    this.trafMat.color.set(s.night ? 0xffd27a : 0xb8601a);
    this.shoreMat.color.set(s.night ? 0xb9c8d6 : 0x5f7688);
    (this.host.closest('.stage, .story-stage') || this.host).dataset.sky = s.night ? 'night' : 'day';
  }

  _placeLid(blh) {
    if (!Number.isFinite(blh) || blh <= 0) { this.lidY = null; this.shore.geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3)); this._vis(); return; }
    const top = this.floorElev + blh;
    this.lidElev = top;
    this.lidY = this.yOf(top);
    this.lid.position.y = this.lidY;
    // the "shoreline": where the lid meets the hillsides (marching squares on the 100 m DEM)
    const t = this.t, n = t.n, E = t.elev, pts = [];
    const X = (c) => (c / (n - 1) - 0.5) * SIZE, Z = (r) => (0.5 - r / (n - 1)) * SIZE;
    for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
      const v = [E[r * n + c], E[r * n + c + 1], E[(r + 1) * n + c + 1], E[(r + 1) * n + c]];
      const cr = [[c, r], [c + 1, r], [c + 1, r + 1], [c, r + 1]];
      const hits = [];
      for (let k = 0; k < 4; k++) {
        const a = v[k], b = v[(k + 1) % 4];
        if ((a < top) !== (b < top)) {
          const f = (top - a) / (b - a), p = cr[k], q = cr[(k + 1) % 4];
          hits.push([X(p[0] + (q[0] - p[0]) * f), Z(p[1] + (q[1] - p[1]) * f)]);
        }
      }
      for (let k = 0; k + 1 < hits.length; k += 2) pts.push(hits[k][0], this.lidY + 0.01, hits[k][1], hits[k + 1][0], this.lidY + 0.01, hits[k + 1][1]);
    }
    this.shore.geometry.dispose();
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.shore.geometry = g;
    this._vis();
  }

  // ground: daylight and tint; below the top of the mixing layer the ground is seen through the hour's haze, more
  // strongly the deeper it lies under it and the higher the valley average (colour from the model value only)
  _paintGround(avg) {
    const s = this.sky, pc = pmColour(avg).map((x) => x / 255), k = Math.min(1, avg / 60);
    const top = this.lidElev ?? -Infinity, wmax = 0.1 + 0.38 * k;
    for (let i = 0; i < this.gShade.length; i++) {
      const sh = this.gShade[i] * s.light, depth = top - this.gElev[i];
      const w = depth > 0 ? wmax * Math.min(1, 0.35 + depth / 220) : 0;
      for (let j = 0; j < 3; j++) {
        const g = this.gBase[i * 3 + j] * sh * s.tint[j];
        this.gCol[i * 3 + j] = Math.min(1, g * (1 - w) + pc[j] * Math.max(0.45, s.light) * w);
      }
    }
    this.ground.geometry.attributes.color.needsUpdate = true;
  }

  _sampleQ(lon, lat) {
    const g = this.h.grid, q = this.h.q, N = g.n_lat, M = g.n_lon, la = g.lats, lo = g.lons;
    const fi = Math.min(N - 1, Math.max(0, (lat - la[0]) / (la[N - 1] - la[0]) * (N - 1)));
    const fj = Math.min(M - 1, Math.max(0, (lon - lo[0]) / (lo[M - 1] - lo[0]) * (M - 1)));
    const i0 = Math.floor(fi), j0 = Math.floor(fj), i1 = Math.min(i0 + 1, N - 1), j1 = Math.min(j0 + 1, M - 1);
    const a = fi - i0, b = fj - j0, at = (i, j) => Math.max(q[i * M + j], 0);
    return (at(i0, j0) * (1 - b) + at(i0, j1) * b) * (1 - a) + (at(i1, j0) * (1 - b) + at(i1, j1) * b) * a;
  }

  // Haze. The concentration is carried by what the eye reads as haze: the ground tint under the layer, the sheet at
  // its top and the scene's distance fog, all from the hour's model value. The particles are fine specks spread
  // through the mixed layer (uniform in volume, local value sets local density) for movement and depth; their number
  // follows the valley average, not the layer's volume, so a deep layer does not turn into a wall.
  _placeHaze(h) {
    const top = this.lidY ?? this.yOf(this.floorElev + 400);
    const n = Math.min(N_HAZE, Math.round(110 * h.avg));
    this.hTop = top;
    let i = 0, guard = 0;
    while (i < n && guard < n * 40) {
      guard++;
      const x = (Math.random() - 0.5) * SIZE * 0.98, z = (Math.random() - 0.5) * SIZE * 0.98, gy = this.groundY(x, z);
      if (gy >= top) continue;
      const [lon, lat] = this.ll(x, z), v = this._sampleQ(lon, lat);
      if (Math.random() > Math.min(1, v / Math.max(1, h.avg * 1.25))) continue;   // local value sets local density
      const y = gy + 0.02 + this.hF[i] * (top - gy - 0.02);
      this.hPos.set([x, y, z], i * 3);
      const edge = Math.min(1, (SIZE / 2 - Math.max(Math.abs(x), Math.abs(z))) / 1.2);   // fade at the box edges
      const c = pmColour(v).map((x, j) => x + ([246, 240, 230][j] - x) * 0.15);
      const a = (0.22 + 0.3 * Math.min(1, v / 60)) * edge * (this.sky.night ? 0.85 : 1);
      this.hCol.set([c[0] / 255, c[1] / 255, c[2] / 255, a], i * 4);
      i++;
    }
    this.hN = i;
    this.haze.geometry.setDrawRange(0, this.hN);
    this.haze.geometry.attributes.position.needsUpdate = true;
    this.haze.geometry.attributes.col.needsUpdate = true;
    // lid sheet colour: the hour's haze mixed with the sky
    const pc = pmColour(h.avg), k = Math.min(1, h.avg / 60);
    this.lidMat.color.setRGB(...pc.map((v, j) => (v + (this.sky.hor[j] - v) * 0.3) / 255));
    this.lidMat.opacity = 0.1 + 0.2 * k;
  }

  _setWind(wf) {
    this.wf = wf;
    let s = 0;
    if (wf) { for (let i = 0; i < wf.U.length; i++) s += Math.hypot(wf.U[i], wf.V[i]); s /= wf.U.length; }
    this.wMean = s;
    this.wN = wf ? Math.round(N_WIND * Math.min(1, 0.15 + s / 2.5)) : 0;
    this._vis();
  }
  _windAt(x, z) {
    const f = this.wf; if (!f) return [0, 0];
    const gx = (x / SIZE + 0.5) * (f.gx - 1), gy = (0.5 - z / SIZE) * (f.gy - 1);
    const x0 = Math.min(f.gx - 2, Math.max(0, Math.floor(gx))), y0 = Math.min(f.gy - 2, Math.max(0, Math.floor(gy)));
    const fx = Math.min(1, Math.max(0, gx - x0)), fy = Math.min(1, Math.max(0, gy - y0)), i = (yy, xx) => yy * f.gx + xx;
    const u = (f.U[i(y0, x0)] * (1 - fx) + f.U[i(y0, x0 + 1)] * fx) * (1 - fy) + (f.U[i(y0 + 1, x0)] * (1 - fx) + f.U[i(y0 + 1, x0 + 1)] * fx) * fy;
    const v = (f.V[i(y0, x0)] * (1 - fx) + f.V[i(y0, x0 + 1)] * fx) * (1 - fy) + (f.V[i(y0 + 1, x0)] * (1 - fx) + f.V[i(y0 + 1, x0 + 1)] * fx) * fy;
    return [u, -v];                                  // north (+v) is −z in world
  }

  // ── camera, picking, lifecycle ──────────────────────────────────────
  setCamera(name, animate = true, ms = 1600) {
    const c = CAMS[name] || CAMS.overview;
    const p1 = new THREE.Vector3(...c.pos), t1 = new THREE.Vector3(...c.tgt);
    if (!animate || this.reduced) { this.cam.position.copy(p1); this.controls.target.copy(t1); this.controls.update(); return; }
    const p0 = this.cam.position.clone(), t0 = this.controls.target.clone(), start = performance.now();
    this._tween = (now) => {
      const x = Math.min(1, (now - start) / ms), e = x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
      this.cam.position.lerpVectors(p0, p1, e); this.controls.target.lerpVectors(t0, t1, e);
      if (x >= 1) this._tween = null;
    };
  }
  autoRotate(on, speed = 0.3) { this.controls.autoRotate = on && !this.reduced; this.controls.autoRotateSpeed = speed; }

  pick(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster(); rc.setFromCamera(ndc, this.cam);
    const hit = rc.intersectObject(this.ground)[0];
    return hit ? this.ll(hit.point.x, hit.point.z) : null;
  }

  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px'; this.renderer.domElement.style.height = h + 'px';
    this.cam.aspect = w / h; this.cam.updateProjectionMatrix();
    this.hazeMat.uniforms.uScale.value = (h * this.renderer.getPixelRatio()) / 2 / Math.tan(this.cam.fov * Math.PI / 360);
  }

  _frame(now) {
    this._raf = null;
    if (!this.running) return;
    const dt = Math.min(0.05, (now - this._last) / 1000) * (this.reduced ? 0 : 1); this._last = now;
    if (this._tween) this._tween(now);
    this.controls.update();
    if (this.h) this._animate(dt);
    this.renderer.render(this.scene, this.cam);
    const w = this.host.clientWidth, hh = this.host.clientHeight;
    for (const m of this.marks) {
      const s = m.p.clone().project(this.cam);
      const vis = s.z < 1 && Math.abs(s.x) < 1.02 && Math.abs(s.y) < 1.02;
      m.d.style.transform = `translate(${(s.x * 0.5 + 0.5) * w}px, ${(-s.y * 0.5 + 0.5) * hh}px)`;
      m.d.style.opacity = vis ? 1 : 0;
    }
    this._raf = requestAnimationFrame((t) => this._frame(t));
  }

  _animate(dt) {
    // haze drifts with the valley wind (slowly); respawned where it leaves the box
    if (this.layers.haze && this.wf && dt > 0) {
      const P = this.hPos, top = this.hTop, k = 0.05 * dt;
      for (let i = 0; i < this.hN; i += 1) {
        const x = P[i * 3], z = P[i * 3 + 2], [u, v] = this._windAt(x, z);
        let nx = x + u * k, nz = z + v * k;
        if (Math.abs(nx) > SIZE / 2 || Math.abs(nz) > SIZE / 2) { nx = -x * 0.98; nz = -z * 0.98; }
        const gy = this.groundY(nx, nz);
        if (gy >= top) continue;                       // would enter a hillside: stay
        P[i * 3] = nx; P[i * 3 + 2] = nz;
        if (P[i * 3 + 1] < gy + 0.02) P[i * 3 + 1] = gy + 0.02 + this.hF[i] * (top - gy - 0.02);
      }
      this.haze.geometry.attributes.position.needsUpdate = true;
    }
    // wind streaks
    if (this.wind.visible) {
      const W = this.wP, A = this.wPos, sp = 0.45 * dt, tail = 0.16;
      for (let i = 0; i < this.wN; i++) {
        let x = W[i * 4], z = W[i * 4 + 1];
        const [u, v] = this._windAt(x, z), spd = Math.hypot(u, v);
        x += u * sp; z += v * sp; W[i * 4 + 3] += dt;
        if (W[i * 4 + 3] > 4 || Math.abs(x) > SIZE / 2 || Math.abs(z) > SIZE / 2) { this._seedWind(i); W[i * 4 + 3] = 0; x = W[i * 4]; z = W[i * 4 + 1]; }
        W[i * 4] = x; W[i * 4 + 1] = z;
        const y = this.groundY(x, z) + W[i * 4 + 2], l = tail * Math.min(1.6, 0.4 + spd) / Math.max(spd, 1e-3);
        A.set([x, y, z, x - u * l, y, z - v * l], i * 6);
      }
      this.wind.geometry.setDrawRange(0, this.wN * 2);
      this.wind.geometry.attributes.position.needsUpdate = true;
    }
    // traffic
    if (this.traf.visible) {
      const A = this.tPos;
      for (let i = 0; i < this.tN; i++) {
        const c = this.tP[i]; if (!c) continue;
        c.s += c.dir * c.v * dt;
        if (c.s < 0 || c.s > c.p.len) { this.tP[i] = this._seedCar(); continue; }
        const a = this._along(c.p, c.s), b = this._along(c.p, c.s - c.dir * 0.16);
        A.set([a[0], a[1], a[2], b[0], b[1], b[2]], i * 6);
      }
      this.traf.geometry.setDrawRange(0, this.tN * 2);
      this.traf.geometry.attributes.position.needsUpdate = true;
    }
    // rain
    if (this.rN > 0) {
      const R = this.rP, A = this.rPos;
      for (let i = 0; i < this.rN; i++) {
        R[i * 3 + 2] -= 7 * dt;
        const x = R[i * 3], z = R[i * 3 + 1], g = this.groundY(x, z);
        if (R[i * 3 + 2] < g) R[i * 3 + 2] = g + 3 + Math.random() * 2.5;
        A.set([x, R[i * 3 + 2], z, x + 0.02, R[i * 3 + 2] + 0.22, z], i * 6);
      }
      this.rain.geometry.setDrawRange(0, this.rN * 2);
      this.rain.geometry.attributes.position.needsUpdate = true;
    }
    this._vis();
  }

  pause() { this.running = false; if (this._raf) cancelAnimationFrame(this._raf); this._raf = null; }
  resume() { if (this.running) return; this.running = true; this._last = performance.now(); this.resize(); this._raf = requestAnimationFrame((t) => this._frame(t)); }
}
