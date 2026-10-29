// zones.js — honest spatial readout (redesign phase 2, plan §6a). The map's within-valley pattern is an
// assumption, and its cell-to-cell differences sit inside the model's uncertainty, so the explorer reports
// three terrain zones (floor / slopes / ridges, by each 1 km cell's mean elevation) relative to the valley
// average, never a value for a single cell or street.

export const ZONES = [
  { id: 'floor', name: 'Valley floor', range: 'below 520 m', max: 520 },
  { id: 'slope', name: 'Slopes', range: '520–700 m', max: 700 },
  { id: 'ridge', name: 'Ridges', range: 'above 700 m', max: Infinity },
];

// zone index per grid cell; elev is the payload's [lat][lon] cell-mean elevation (row 0 = south)
export function zoneGrid(elev) {
  const n = elev.length, m = elev[0].length, z = new Int8Array(n * m);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    const e = elev[i][j];
    z[i * m + j] = ZONES.findIndex((Z) => e <= Z.max);
  }
  return z;
}

// mean of the field in each zone, as a % difference from the valley average
export function zoneStats(q50, zg, basin) {
  const s = ZONES.map(() => 0), c = ZONES.map(() => 0);
  for (let i = 0; i < q50.length; i++) { s[zg[i]] += Math.max(q50[i], 0); c[zg[i]] += 1; }
  return ZONES.map((Z, k) => {
    const mean = c[k] ? s[k] / c[k] : NaN;
    return { ...Z, cells: c[k], mean, pct: basin > 0.5 ? (mean / basin - 1) * 100 : NaN };
  });
}

// words, not decimals: differences this small are inside the model's uncertainty
export function relWords(pct) {
  if (!isFinite(pct)) return 'about the valley average';
  const a = Math.abs(pct);
  if (a < 2) return 'about the valley average';
  return `${a < 6 ? 'slightly' : 'about ' + Math.round(a) + '%'} ${pct > 0 ? 'above' : 'below'} average`;
}

// ── town to town (ledger F.158) ─────────────────────────────────────────────────────────────────────────
// Kandy has no monitors in its towns, so the map cannot say which of two towns is dirtier. What CAN be said is how
// large such differences usually are: in valley cities that do have monitors, two reference monitors 3–10 km apart
// differ by about 13 % in long-run PM2.5 (data/static/spatial_spread.json). A size, never a direction.
export function townKm(a, b) {
  const p = Math.PI / 180, [lo1, la1] = a.c, [lo2, la2] = b.c;
  const h = Math.sin((la2 - la1) * p / 2) ** 2 + Math.cos(la1 * p) * Math.cos(la2 * p) * Math.sin((lo2 - lo1) * p / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

export function townAnswer(a, b, q50, grid, basin, spread) {
  const near = (arr, v) => arr.reduce((bi, x, i) => (Math.abs(x - v) < Math.abs(arr[bi] - v) ? i : bi), 0);
  const cell = (t) => q50[near(grid.lats, t.c[1]) * grid.n_lon + near(grid.lons, t.c[0])];
  const km = townKm(a, b), va = Math.max(cell(a), 0), vb = Math.max(cell(b), 0);
  const gap = Math.abs(va / Math.max(vb, 1e-6) - 1) * 100;
  const pct = (r) => Math.round((r - 1) * 100);
  const lines = [`<b>${a.n}</b> and <b>${b.n}</b> are ${km.toFixed(1)} km apart.`];
  if (!spread) {
    lines.push('The map cannot say which of the two is higher.');
  } else if (km < spread.km[0]) {
    lines.push(`That is just closer than the comparison data reach (${spread.km[0]}–${spread.km[1]} km). Across that`
      + ` range the usual difference hardly changes with distance (about ${Math.round((spread.median_ratio - 1) * 100)} %),`
      + ' so expect something similar here, perhaps a little less. <b>Which one is higher cannot be told.</b> Inside'
      + ' each town, street-level differences are far larger: in a Kandy survey, air at a garden gate and 300 m'
      + ' inside the same garden differed many times over.');
  } else {
    const [lo, hi] = spread.median_ratio_ci95;
    lines.push(`In valley cities that have monitors, two places ${km > spread.km[1] ? 'this far apart and more' : 'this far apart'}`
      + ` usually differ by <b>about ${pct(spread.median_ratio)} %</b> in their long-run PM<sub>2.5</sub>`
      + ` (${pct(lo)}–${pct(hi)} %), and one pair in ${Math.round(1 / spread.share_over_1_25)} by more than a quarter`
      + ` (${spread.pairs} monitor pairs in ${spread.cities} cities; Kathmandu, the closest match to Kandy:`
      + ` about ${pct(spread.kathmandu.median_ratio)} %).`);
    const r = Math.sqrt(spread.median_ratio);
    lines.push(`So at a valley average of ${Math.round(basin)} µg/m³, one town might sit near ${Math.round(basin / r)}`
      + ` and the other near ${Math.round(basin * r)}. <b>Which one is higher cannot be told</b>: the valley has one`
      + ' regulatory station, not a network, so no measurement compares the two towns.');
  }
  lines.push(`<span class="fine">This hour the map puts them ${gap < 2 ? 'within 2 % of each other' : 'about ' + Math.round(gap) + ' % apart'};`
    + ' that gap comes from the map\'s assumed pattern, which is weaker than real valleys show, not from a measurement.</span>');
  return lines.map((s) => `<p>${s}</p>`).join('');
}
