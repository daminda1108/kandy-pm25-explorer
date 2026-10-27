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
