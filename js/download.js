// download.js — export the current map as PNG and the current field / point series as CSV.

function trigger(blobOrUrl, name) {
  const a = document.createElement('a');
  a.href = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
  a.download = name; document.body.append(a); a.click(); a.remove();
  if (typeof blobOrUrl !== 'string') setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function downloadPNG(store, field, city) {
  const layers = ['cv-hill', 'cv-field', 'cv-wind', 'cv-vec', 'cv-stations']
    .map((id) => document.getElementById(id)).filter(Boolean);
  const W = layers[0].width, H = layers[0].height;
  const out = document.createElement('canvas');
  out.width = W; out.height = H + 40;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#0c1017'; ctx.fillRect(0, 0, out.width, out.height);
  for (const l of layers) ctx.drawImage(l, 0, 0);
  // caption strip
  ctx.fillStyle = 'rgba(12,16,23,0.85)'; ctx.fillRect(0, H, W, 40);
  ctx.fillStyle = '#e7edf6'; ctx.font = '13px Inter, sans-serif';
  const off = city.tzOffsetH * 3600;
  const d = new Date((field.tsUTC + off) * 1000);
  const lt = d.toISOString().slice(0, 16).replace('T', ' ');
  ctx.fillText(`${city.captionName} · ${lt} LT · basin ${field.basin.toFixed(1)}, centre ${field.core.toFixed(1)} µg/m³`, 10, H + 17);
  ctx.fillStyle = '#9aa8bd'; ctx.font = '10px Inter, sans-serif';
  ctx.fillText('Research reconstruction · anchored level · indicative spatial pattern. Van Donkelaar V6 · ERA5 · WindNinja · OSM.', 10, H + 33);
  trigger(out.toDataURL('image/png'), `${city.downloadPrefix}_${lt.replace(/[: ]/g, '')}.png`);
}

export function downloadFieldCSV(store, field, city) {
  const g = store.meta.grid;
  const rows = ['lat,lon,pm25_q50,pm25_q05,pm25_q95'];
  for (let i = 0; i < g.n_lat; i++)
    for (let j = 0; j < g.n_lon; j++) {
      const px = i * g.n_lon + j;
      rows.push(`${g.lats[i].toFixed(5)},${g.lons[j].toFixed(5)},`
        + `${field.q50[px].toFixed(2)},${field.q05[px].toFixed(2)},${field.q95[px].toFixed(2)}`);
    }
  const off = city.tzOffsetH * 3600;
  const lt = new Date((field.tsUTC + off) * 1000).toISOString().slice(0, 13);
  trigger(new Blob([rows.join('\n')], { type: 'text/csv' }), `${city.downloadPrefix}_field_${lt}.csv`);
}

// Reconstruct one pixel's 24-hour series for the current day (month already cached).
export async function downloadPointCSV(store, field, lat, lon, city) {
  const g = store.meta.grid;
  const li = nearest(g.lats, lat), lj = nearest(g.lons, lon), px = li * g.n_lon + lj;
  const s = await store.getScalars(field.year);
  const off = city.tzOffsetH * 3600;
  const daySec = Math.floor((field.tsUTC + off) / 86400) * 86400 - off;
  const rows = ['datetime_lt,pm25_q50,pm25_q05,pm25_q95'];
  for (let i = 0; i < s.hours_utc.length; i++) {
    if (Math.floor((s.hours_utc[i] + off) / 86400) * 86400 - off !== daySec) continue;
    const f = await store.field(field.year, i, field.tier);
    const lt = new Date((s.hours_utc[i] + off) * 1000).toISOString().slice(0, 16).replace('T', ' ');
    rows.push(`${lt},${f.q50[px].toFixed(2)},${f.q05[px].toFixed(2)},${f.q95[px].toFixed(2)}`);
  }
  trigger(new Blob([rows.join('\n')], { type: 'text/csv' }),
    `${city.downloadPrefix}_point_${lat.toFixed(4)}_${lon.toFixed(4)}.csv`);
}

function nearest(arr, v) {
  let bi = 0, bd = 1e18;
  for (let i = 0; i < arr.length; i++) { const d = Math.abs(arr[i] - v); if (d < bd) { bd = d; bi = i; } }
  return bi;
}
