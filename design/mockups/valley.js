// valley.js — the shared 3-D Kandy basin for the direction-A mock-ups (phase 0).
// Real terrain (100 m grid) and real model fields (16x16 q50, lat ascending). The haze is a translucent sheet
// draped above the ground, thicker and warmer where PM2.5 is higher; colour follows the fixed WHO-anchored scale.
import * as THREE from 'three';

const EXAG = 2.4;              // vertical exaggeration (relief 430–1277 m over 15 km)
const SIZE = 15;               // scene units across the basin (≈ 1 km each)
const HAZE_LIFT = 0.10;        // haze sheet height above ground (scene units)

// WHO-anchored stops (µg/m³ → rgb, alpha); alpha grows with concentration so clean air is clear
const STOPS = [
  [0,  [159, 195, 178], 0.00],
  [5,  [159, 195, 178], 0.05],
  [15, [233, 225, 180], 0.22],
  [25, [239, 199, 122], 0.38],
  [35, [229, 154, 82],  0.52],
  [50, [201, 101, 58],  0.66],
  [75, [142, 58, 44],   0.78],
  [120,[100, 36, 30],   0.86],
];
export function pmColour(v) {
  for (let i = 1; i < STOPS.length; i++) {
    if (v <= STOPS[i][0]) {
      const [a, ca, aa] = STOPS[i - 1], [b, cb, ab] = STOPS[i], t = (v - a) / (b - a);
      return [ca.map((c, k) => c + (cb[k] - c) * t), aa + (ab - aa) * t];
    }
  }
  const s = STOPS[STOPS.length - 1]; return [s[1], s[2]];
}
export function pmCss(v) { const [c] = pmColour(v); return `rgb(${c.map(Math.round).join(',')})`; }

function bilinear16(q, u, v) {                      // u: west→east 0..1, v: south→north 0..1
  const N = 16, x = u * (N - 1), y = v * (N - 1), x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, N - 1), y1 = Math.min(y0 + 1, N - 1), fx = x - x0, fy = y - y0;
  const g = (r, c) => q[r * N + c];
  return (g(y0, x0) * (1 - fx) + g(y0, x1) * fx) * (1 - fy) + (g(y1, x0) * (1 - fx) + g(y1, x1) * fx) * fy;
}

// ground palette: valley floor → mid-slope → ridge, in muted tropical tones
function groundColour(z01, shade) {
  const floor = [62, 74, 52], mid = [92, 102, 70], ridge = [128, 122, 104];
  const c = z01 < 0.5 ? floor.map((a, k) => a + (mid[k] - a) * (z01 / 0.5))
                      : mid.map((a, k) => a + (ridge[k] - a) * ((z01 - 0.5) / 0.5));
  return c.map((x) => (x / 255) * shade);
}

export async function createValley(el, { base = 'assets', camera: camOpt = {}, labels = true } = {}) {
  const terrain = await fetch(`${base}/terrain.json`).then((r) => r.json());
  const meta = await fetch(`${base}/meta.json`).then((r) => r.json());
  const n = terrain.n, zr = terrain.zmax - terrain.zmin;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0f0d0b, 18, 42);
  const cam = new THREE.PerspectiveCamera(camOpt.fov ?? 34, 1, 0.1, 200);
  const target = new THREE.Vector3(camOpt.tx ?? 0.4, 0, camOpt.tz ?? -0.6);
  cam.position.set(camOpt.x ?? 1.5, camOpt.y ?? 7.2, camOpt.z ?? 13.5);
  cam.lookAt(target);

  // ground mesh
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, n - 1, n - 1);
  geo.rotateX(-Math.PI / 2);                          // x east, z south (+), y up
  const pos = geo.attributes.position, colours = new Float32Array(pos.count * 3);
  const height = (r, c) => terrain.elev[r * n + c];
  for (let i = 0; i < pos.count; i++) {
    const c = i % n, rowTop = Math.floor(i / n);      // PlaneGeometry rows run top (north, -z) → bottom (south)
    const r = n - 1 - rowTop;                         // terrain rows run south → north
    const z01 = (height(r, c) - terrain.zmin) / zr;
    pos.setY(i, z01 * zr / 1000 * EXAG);
  }
  geo.computeVertexNormals();
  // low sun from the north-west: long shadows give the relief its shape
  const nrm = geo.attributes.normal, sun = new THREE.Vector3(-0.7, 0.42, -0.58).normalize();
  // edge fade: the square block dissolves into the dark page instead of showing a cut edge
  const edge = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const c = i % n, r = Math.floor(i / n), d = Math.min(c, r, n - 1 - c, n - 1 - r) / (n * 0.16);
    const s = Math.min(1, Math.max(0, d)); edge[i] = s * s * (3 - 2 * s);
  }
  for (let i = 0; i < pos.count; i++) {
    const r = n - 1 - Math.floor(i / n), c = i % n;
    const z01 = (height(r, c) - terrain.zmin) / zr;
    const lam = Math.max(0, nrm.getX(i) * sun.x + nrm.getY(i) * sun.y + nrm.getZ(i) * sun.z);
    const [R, G, B] = groundColour(z01, (0.22 + 1.25 * lam) * (0.06 + 0.94 * edge[i]));
    colours.set([R, G, B], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  const ground = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true }));
  scene.add(ground);

  // haze sheet: same grid, lifted, per-vertex colour+alpha from the PM field
  const hgeo = geo.clone();
  const hp = hgeo.attributes.position;
  for (let i = 0; i < hp.count; i++) hp.setY(i, hp.getY(i) + HAZE_LIFT);
  const hcol = new Float32Array(hp.count * 4);
  hgeo.setAttribute('color', new THREE.BufferAttribute(hcol, 4));
  const hmat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });
  const haze = new THREE.Mesh(hgeo, hmat);
  scene.add(haze);
  // a second, higher and softer sheet gives the haze some depth
  const h2 = new THREE.Mesh(hgeo.clone(), hmat.clone());
  h2.position.y = 0.30; h2.material.opacity = 0.35;
  scene.add(h2);

  function setField(q50) {
    for (let i = 0; i < hp.count; i++) {
      const c = i % n, rowTop = Math.floor(i / n), r = n - 1 - rowTop;
      const v = bilinear16(q50, c / (n - 1), r / (n - 1));
      const [rgb, a] = pmColour(v);
      // haze pools in low ground: weight alpha by depth below the ridges
      // HONEST RENDERING (2026-10-27): colour and opacity come ONLY from the model's value in this cell. No
      // elevation-based pooling: the model's own floor-to-ridge contrast is ~5 %, and drawing more would show a
      // pattern the evidence does not support. The edge fade is cosmetic (the block's outer border), not data.
      hcol.set([rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 0.5 * a * edge[i]], i * 4);
    }
    hgeo.attributes.color.needsUpdate = true;
    h2.geometry.setAttribute('color', hgeo.attributes.color);
    const mean = q50.reduce((s, x) => s + x, 0) / q50.length;
    const [frgb] = pmColour(mean);
    const k = Math.min(1, mean / 80);
    scene.fog.color.setRGB((15 + (frgb[0] - 15) * 0.35 * k) / 255, (13 + (frgb[1] - 13) * 0.35 * k) / 255,
                           (11 + (frgb[2] - 11) * 0.35 * k) / 255);
    scene.fog.near = 16 - 6 * k; scene.fog.far = 42 - 14 * k;
  }

  // landmark labels (HTML, projected each frame)
  const labelLayer = document.createElement('div');
  labelLayer.className = 'labels';
  el.appendChild(labelLayer);
  const marks = labels ? meta.landmarks.filter((m) => m.k !== 'sensor').map((m) => {
    const u = (m.c[0] - terrain.lon0) / (terrain.lon1 - terrain.lon0);
    const v = (m.c[1] - terrain.lat0) / (terrain.lat1 - terrain.lat0);
    const c = Math.round(u * (n - 1)), r = Math.round(v * (n - 1));
    const y = ((height(r, c) - terrain.zmin) / zr) * zr / 1000 * EXAG + 0.25;
    const p = new THREE.Vector3((u - 0.5) * SIZE, y, (0.5 - v) * SIZE);
    const d = document.createElement('span');
    d.className = 'lbl' + (m.k === 'city' ? ' city' : '');
    d.textContent = m.n; labelLayer.appendChild(d);
    return { p, d };
  }) : [];

  function resize() {
    const w = el.clientWidth, h = el.clientHeight;
    renderer.setSize(w, h, false); renderer.domElement.style.width = w + 'px'; renderer.domElement.style.height = h + 'px';
    cam.aspect = w / h; cam.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(el); resize();

  let drift = 0;
  function frame(t) {
    drift = t * 0.00002;
    cam.position.x = (camOpt.x ?? 1.5) + Math.sin(drift) * 0.6;
    cam.lookAt(target);
    renderer.render(scene, cam);
    const w = el.clientWidth, h = el.clientHeight;
    for (const m of marks) {
      const s = m.p.clone().project(cam);
      m.d.style.transform = `translate(${(s.x * 0.5 + 0.5) * w}px, ${(-s.y * 0.5 + 0.5) * h}px)`;
      m.d.style.opacity = s.z < 1 ? 1 : 0;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return { setField };
}
