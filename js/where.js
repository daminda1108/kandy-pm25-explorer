// where.js — "where in the valley, and how sure" (redesign A, 2026-10-29; mock-up A4, plan §6b).
// The delivered within-valley pattern P = S_emit x M, M = 1 + k.w(BLH).c, is a physical assumption, not a measured map.
// Its strength k is not identified by any Kandy data (F.142 tested k 0-0.45: no CEA metric moves), and the satellite
// surface S_emit may or may not carry real structure. So instead of one map we build the family of maps the evidence
// cannot tell apart — k in {0, .15, .30, .45} x {satellite surface, terrain only} — each with the SAME valley mean this
// hour (same B, T, increment split and eps-floor as the delivered field), and report only what they agree on.
// The perfectly even valley (terrain only, k = 0) is a legitimate member; it is stated in words, not used to veto.
// Inputs: data/static/pattern_parts.json (kandy_pm25/scripts/webapp_a_static.py). For 2019-2023 the (satellite, 0.15)
// member reproduces the shipped P to 1e-4; 2024-26 ship the 2019-23 climatological pattern instead.

export function envelope(parts, f, eps) {
  const S = parts.S, c = parts.c, H = parts.H_ridge_m, n = S.length;
  const blh = Number.isFinite(f.blh) ? f.blh : H;
  const w = Math.min(1, Math.max(0, (H - blh) / H));
  const inc = f.T - f.B, cf = Math.max(Math.max(inc, 0), eps), k0 = Math.min(inc, 0) - Math.max(0, eps - Math.max(inc, 0));
  const rels = [];
  for (const sat of [true, false]) for (const k of parts.kappas) {
    if (!sat && k === 0) continue;                       // the flat member: no pattern at all
    const P = new Float64Array(n); let m = 0;
    for (let i = 0; i < n; i++) { P[i] = (sat ? S[i] : 1) * (1 + k * w * c[i]); m += P[i]; }
    m /= n;
    const V = new Float64Array(n); let vm = 0;
    for (let i = 0; i < n; i++) { V[i] = Math.max(f.B + cf * P[i] / m + k0, 0); vm += V[i]; }
    vm /= n;
    const rel = new Float32Array(n);
    for (let i = 0; i < n; i++) rel[i] = vm > 0.5 ? (V[i] / vm - 1) * 100 : 0;
    rels.push(rel);
  }
  const up = new Float32Array(n), dn = new Float32Array(n), lo = new Float32Array(n), hi = new Float32Array(n),
        mag = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let u = 0, d = 0, a = Infinity, b = -Infinity, s = 0;
    for (const r of rels) { const x = r[i]; if (x > 1) u++; if (x < -1) d++; a = Math.min(a, x); b = Math.max(b, x); s += x; }
    up[i] = u / rels.length; dn[i] = d / rels.length; lo[i] = a; hi[i] = b; mag[i] = s / rels.length;
  }
  return { up, dn, lo, hi, mag, w, blh, members: rels.length };
}

// a verdict only where every patterned map agrees; otherwise the honest answer is the range
export function verdict(env, i) {
  const lo = env.lo[i], hi = env.hi[i];
  if (Math.max(Math.abs(lo), Math.abs(hi)) < 6) return ['q', 'About the valley average'];
  if (env.up[i] >= 0.999) return ['up', 'Above the valley average in every map'];
  if (env.dn[i] >= 0.999) return ['dn', 'Below the valley average in every map'];
  if (lo >= -1) return ['up', 'Probably above average (no map puts it lower)'];
  if (hi <= 1) return ['dn', 'Probably below average (no map puts it higher)'];
  return ['q', "Can't tell: the maps disagree"];
}

export const cellOf = (grid, lat, lon) => {
  const near = (arr, v) => arr.reduce((bi, x, i) => (Math.abs(x - v) < Math.abs(arr[bi] - v) ? i : bi), 0);
  return near(grid.lats, lat) * grid.n_lon + near(grid.lons, lon);
};

export function km(a, b) {           // a, b: [lon, lat]
  const p = Math.PI / 180, [lo1, la1] = a, [lo2, la2] = b;
  const h = Math.sin((la2 - la1) * p / 2) ** 2 + Math.cos(la1 * p) * Math.cos(la2 * p) * Math.sin((lo2 - lo1) * p / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// town to town (ledger F.158/F.159/F.160): a SIZE from monitored valleys, never a direction. Learned models do not
// order places 3-10 km apart better than a coin (0.51), and activity layers do not gauge which places depart more.
export function townAnswer(a, b, basin, spread) {
  const d = km(a.c, b.c), pct = (r) => Math.round((r - 1) * 100);
  const L = [`<b>${a.n}</b> and <b>${b.n}</b> are ${d.toFixed(1)} km apart.`];
  if (!spread) { L.push('Which of the two is higher cannot be told from this model.'); return L.map((s) => `<p>${s}</p>`).join(''); }
  if (d < spread.km[0]) {
    L.push(`That is closer than the comparison data reach (${spread.km[0]}–${spread.km[1]} km); across that range the usual`
      + ` difference hardly changes with distance (about ${pct(spread.median_ratio)} %), so expect something similar, perhaps`
      + ' less. <b>Which one is higher cannot be told.</b>');
  } else {
    const [lo, hi] = spread.median_ratio_ci95, r = Math.sqrt(spread.median_ratio);
    L.push(`In valley cities with monitoring networks, two places ${d > spread.km[1] ? 'this far apart or more' : 'this far apart'}`
      + ` usually differ by <b>about ${pct(spread.median_ratio)} %</b> in long-run PM<sub>2.5</sub> (${pct(lo)}–${pct(hi)} %),`
      + ` and one pair in ${Math.round(1 / spread.share_over_1_25)} by more than a quarter (${spread.pairs} monitor pairs,`
      + ` ${spread.cities} cities; Kathmandu, the closest match to Kandy: ${pct(spread.kathmandu.median_ratio)} %).`);
    L.push(`At this hour's valley average of ${Math.round(basin)} µg/m³ that is one town near ${Math.round(basin / r)} and the`
      + ` other near ${Math.round(basin * r)}. <b>Which one is higher cannot be told</b>: Kandy has one regulatory station,`
      + ' and models learned in the monitored cities pick the dirtier of two such places no better than a coin toss.');
  }
  return L.map((s) => `<p>${s}</p>`).join('');
}
