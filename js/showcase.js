// showcase.js — Medellín proving-ground panels (loaded only on the Medellín page):
//   1. Blind → reveal: overlay the real (withheld) monitoring network on the model
//      field, with per-station model-vs-measured readout + the act scorecard.
//   2. Forecast scoreboard: day-ahead forecast vs what stations recorded vs the
//      24 h persistence baseline (F-M2 backtest, 2023).
//   3. Data-value slider: "monitors used 0 → 18" — swaps the 2019–2023 mean field
//      between assimilation tiers and moves a live point on the data-value curve.
// All numbers come from the exported payloads (stations/showcase/forecast/datavalue).

import { $, el, fmt, fitCanvas, ylorrd, clamp } from './util.js?v=1784614153';
import { colourMode, paintField, paintColourbar } from './field.js?v=1784614153';

export async function initShowcase({ store, city, mapview, stationCanvas, getState, exitToHour }) {
  const [stations, showcase, forecast, dv] = await Promise.all([
    store.getExtra('stations'), store.getExtra('showcase'),
    store.getExtra('forecast'), store.getExtra('datavalue')]);
  const sctx = stationCanvas.getContext('2d');
  const W = stationCanvas.width, H = stationCanvas.height;
  const bbox = store.meta.grid.bbox;
  const S = { reveal: false, dvMode: false, dvIdx: 0, sel: null };
  const holdSet = new Set(stations.holdout6);

  const toXY = (lat, lon) => [
    ((lon - bbox[0]) / (bbox[2] - bbox[0])) * W,
    (1 - (lat - bbox[1]) / (bbox[3] - bbox[1])) * H];
  const inBox = (lat, lon) => lat >= bbox[1] && lat <= bbox[3] && lon >= bbox[0] && lon <= bbox[2];

  // fixed colour scale for long-term means (station dots + data-value fields), so
  // the slider shows real change rather than per-frame rescaling
  const allVals = [];
  for (const t of Object.values(dv.tiers)) allVals.push(...t.anchor, ...t.assim);
  for (const st of stations.stations) allVals.push(st.measured, st.model);
  const cmDv = colourMode(Float32Array.from(allVals), 'adaptive');
  const dotColor = (v) => {
    const [r, g, b] = ylorrd(clamp((v - cmDv.lo) / (cmDv.hi - cmDv.lo), 0, 1));
    return `rgb(${r | 0},${g | 0},${b | 0})`;
  };

  // ── station layer (rides the pan/zoom wrapper like every map canvas) ────────
  function drawDot(x, y, fill, ring, rr = 7) {
    sctx.beginPath(); sctx.arc(x, y, rr, 0, 7);
    sctx.fillStyle = fill; sctx.fill();
    sctx.lineWidth = 2.4; sctx.strokeStyle = ring; sctx.stroke();
  }

  function drawStations() {
    sctx.clearRect(0, 0, W, H);
    if (S.dvMode) { drawDvStations(); return; }
    if (!S.reveal) return;
    for (const st of stations.stations) {
      if (!inBox(st.lat, st.lon)) continue;
      const [x, y] = toXY(st.lat, st.lon);
      const hold = holdSet.has(st.id);
      const ring = st.role === 'anchor' ? 'rgba(255,255,255,0.95)'
                 : hold ? 'rgba(86,200,255,0.95)' : 'rgba(10,14,20,0.85)';
      drawDot(x, y, dotColor(st.measured), ring, st.role === 'anchor' ? 8 : 7);
      if (S.sel === st.id) {
        sctx.beginPath(); sctx.arc(x, y, 12, 0, 7);
        sctx.lineWidth = 2; sctx.strokeStyle = 'rgba(255,255,255,0.9)';
        sctx.setLineDash([4, 3]); sctx.stroke(); sctx.setLineDash([]);
      }
    }
  }

  function drawDvStations() {
    const tier = dv.tiers[String(dv.N[S.dvIdx])];
    // the N monitors feeding the model this rung (white)
    for (const st of tier.stations) {
      if (!inBox(st.lat, st.lon)) continue;
      const [x, y] = toXY(st.lat, st.lon);
      drawDot(x, y, 'rgba(255,255,255,0.95)', 'rgba(10,14,20,0.9)', 6);
    }
    // the fixed held-out test set (cyan rings — "scored here", never assimilated)
    for (const st of stations.stations) {
      if (!holdSet.has(st.id) || !inBox(st.lat, st.lon)) continue;
      const [x, y] = toXY(st.lat, st.lon);
      sctx.beginPath(); sctx.arc(x, y, 9, 0, 7);
      sctx.lineWidth = 2.6; sctx.strokeStyle = 'rgba(86,200,255,0.95)'; sctx.stroke();
    }
  }

  // click hit-test in lat/lon space (called from the app's map click handler)
  function hitStation(lat, lon) {
    if (!S.reveal || S.dvMode) return false;
    const tolLat = (bbox[3] - bbox[1]) * 0.02;
    let best = null, bd = 1e18;
    for (const st of stations.stations) {
      const d = ((st.lat - lat) / tolLat) ** 2 + ((st.lon - lon) / tolLat) ** 2;
      if (d < bd) { bd = d; best = st; }
    }
    if (!best || bd > 1.0) return false;
    S.sel = best.id;
    const dpc = 100 * (best.model - best.measured) / best.measured;
    const role = best.role === 'anchor'
      ? 'anchor — one of the 2 stations the sensor tier uses'
      : holdSet.has(best.id) ? 'held-out test station (never seen by the model)'
      : 'withheld station (scoring only)';
    $('#station-detail').innerHTML = `
      <div class="hrow"><span>Station</span><span class="hval"><b>${best.id}</b></span></div>
      <div class="hrow"><span>Role</span><span class="hval">${role}</span></div>
      <div class="hrow"><span>Measured mean</span><span class="hval"><b>${fmt(best.measured)}</b> µg/m³ (${best.n.toLocaleString()} h)</span></div>
      <div class="hrow"><span>Model (blind)</span><span class="hval"><b>${fmt(best.model)}</b> µg/m³ (${dpc >= 0 ? '+' : ''}${fmt(dpc, 0)}%)</span></div>`;
    drawStations();
    return true;
  }

  // ── reveal panel ────────────────────────────────────────────────────────────
  function buildRevealPanel() {
    $('#reveal-toggle').addEventListener('change', (e) => {
      S.reveal = e.target.checked;
      if (!S.reveal) { S.sel = null; $('#station-detail').innerHTML = ''; }
      drawStations();
    });
    const sc = showcase.scorecard.filter((r) => r.testset === 'vault_all');
    const row = (r, label) => `
      <tr><td>${label}</td><td>${fmt(r.seasonal, 2)}</td><td>${fmt(r.diurnal, 2)}</td>
      <td>${fmt(r.spatial, 2)}</td><td>${r.level >= 0 ? '+' : ''}${fmt(r.level, 1)}%</td>
      <td>${fmt(r.rmse, 1)}</td></tr>`;
    const a0 = sc.find((r) => r.tier === 'act0_vand');
    const a1 = sc.find((r) => r.tier === 'act1_sensor');
    $('#scorecard-body').innerHTML = `
      <table class="sc-table">
        <thead><tr><th>tier</th><th>seasonal r</th><th>diurnal r</th>
        <th>spatial ρ</th><th>level</th><th>RMSE</th></tr></thead>
        <tbody>${row(a0, '0 sensors (satellite)')}${row(a1, '2 sensors (Kandy-grade)')}</tbody>
      </table>
      <p class="note">Scored against ${stations.stations.filter((s) => s.role !== 'anchor').length}+
      withheld stations, 2019–2023. The zero-ground-data tier statistically ties the
      2-sensor tier — the level comes from the satellite anchor, the pattern from physics.</p>`;
  }

  // ── forecast scoreboard ─────────────────────────────────────────────────────
  function drawForecast() {
    const cv = $('#forecast-canvas');
    const { ctx, w: CW, h: CH } = fitCanvas(cv, panelW(cv), 190);
    ctx.clearRect(0, 0, CW, CH);
    const pad = { l: 34, r: 8, t: 8, b: 20 };
    const days = forecast.days;
    const series = [
      [forecast.persist, 'rgba(160,170,185,0.75)', 1.2, [4, 3]],
      [forecast.fcst, '#f0a35a', 2.0, []],
      [forecast.obs, '#38b76a', 1.6, []],
    ];
    const all = series.flatMap(([a]) => a).filter((v) => v != null);
    const ymax = Math.max(...all) * 1.1, ymin = 0;
    const X = (i) => pad.l + (i / (days.length - 1)) * (CW - pad.l - pad.r);
    const Y = (v) => CH - pad.b - ((v - ymin) / (ymax - ymin)) * (CH - pad.t - pad.b);
    ctx.font = '9.5px Inter'; ctx.fillStyle = 'rgba(210,220,235,0.55)';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of [0, 20, 40]) {
      if (v > ymax) continue;
      ctx.strokeStyle = 'rgba(200,210,225,0.07)';
      ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(CW - pad.r, Y(v)); ctx.stroke();
      ctx.fillText(String(v), pad.l - 5, Y(v));
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    for (let i = 0; i < days.length; i += 61)
      ctx.fillText(days[i].slice(5, 7), X(i), CH - 6);
    for (const [arr, colr, lw, dash] of series) {
      ctx.strokeStyle = colr; ctx.lineWidth = lw; ctx.setLineDash(dash);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] == null) { started = false; continue; }
        const x = X(i), y = Y(arr[i]);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const k = forecast.skill;
    $('#forecast-note').innerHTML =
      `<span class="dot" style="background:#38b76a"></span> stations recorded · `
      + `<span class="dot" style="background:#f0a35a"></span> day-ahead forecast · `
      + `<span class="dot" style="background:rgba(160,170,185,0.75)"></span> 24 h persistence`
      + `<br>RMSE <b>${fmt(k.rmse_forecast)}</b> vs persistence ${fmt(k.rmse_persistence)}`
      + (k.rmse_raw_geoscf ? ` vs raw GEOS-CF ${fmt(k.rmse_raw_geoscf)}` : '')
      + ` µg/m³ → skill <b>+${fmt(k.skill_vs_persistence, 2)}</b> `
      + `(${k.n_hours.toLocaleString()} held-out station-hours, ${forecast.year})`;
  }

  // ── data-value slider (the centrepiece) ─────────────────────────────────────
  const DV_LABELS = {
    0: 'zero ground data — what an unmonitored city like Kandy gets today',
    1: 'one arbitrary sensor is WORSE than none: an unrepresentative station drags the level',
    2: 'two sensors: placement matters more than count at this budget',
    18: 'the full training network — what monitoring investment buys',
  };

  function dvN() { return dv.N[S.dvIdx]; }

  function paintDv() {
    const tier = dv.tiers[String(dvN())];
    const field = Float32Array.from(dvN() === 0 ? tier.anchor : tier.assim);
    // hillshade under the mean field (same stack the hourly renderer uses)
    const hillCtx = $('#cv-hill').getContext('2d');
    hillCtx.clearRect(0, 0, W, H);
    hillCtx.drawImage(store.static.hillshade, 0, 0, W, H);
    hillCtx.fillStyle = 'rgba(15,20,30,0.35)';
    hillCtx.fillRect(0, 0, W, H);
    paintField($('#cv-field'), field, cmDv, store.meta.grid.n_lat);
    paintColourbar($('#colourbar'), cmDv);
    const cbT = $('#cb-ticks'); cbT.innerHTML = '';
    cmDv.ticks.forEach((t) => {
      const span = el('span', {}, `${t}`);
      span.style.left = `${((t - cmDv.lo) / (cmDv.hi - cmDv.lo)) * 100}%`;
      cbT.append(span);
    });
    $('#cb-tag').textContent = '2019–2023 mean';
    const nOut = tier.stations.filter((st) => !inBox(st.lat, st.lon)).length;
    $('#map-title').innerHTML =
      `<b>2019–2023 mean</b> · <b>${dvN()}</b> monitor${dvN() === 1 ? '' : 's'} used`
      + (dvN() > 0 ? ' (white dots' + (nOut ? `, ${nOut} outside frame` : '') + ')' : '')
      + ' · scored at the cyan-ringed held-out stations'
      + ' <span class="uqtag">data-value mode</span>';
    drawStations();
    drawDvCurve();
    const stats = dv.curve.find((r) => r.N === dvN()
      && r.assim === (dvN() === 0 ? 'none' : 'idw'));
    const lbl = DV_LABELS[dvN()] || `${dvN()} assimilated monitors`;
    $('#dv-note').innerHTML =
      `<b>${lbl}</b><br>RMSE at the 6 held-out stations: `
      + `<b>${fmt(stats.rmse[1])}</b> [${fmt(stats.rmse[0])}–${fmt(stats.rmse[2])}] µg/m³ · `
      + `level bias ${stats.level[1] >= 0 ? '+' : ''}${fmt(stats.level[1], 0)}%`;
  }

  function drawDvCurve() {
    const cv = $('#dv-curve');
    const { ctx, w: CW, h: CH } = fitCanvas(cv, panelW(cv), 150);
    ctx.clearRect(0, 0, CW, CH);
    const pad = { l: 34, r: 10, t: 8, b: 20 };
    const NN = dv.N;
    const idw = NN.map((n) => dv.curve.find((r) => r.N === n && r.assim === (n === 0 ? 'none' : 'idw')));
    const none = NN.map((n) => dv.curve.find((r) => r.N === n && r.assim === 'none'));
    const ally = idw.flatMap((r) => r.rmse).concat(none.filter(Boolean).flatMap((r) => r.rmse));
    const ymin = Math.floor(Math.min(...ally)) - 0.5, ymax = Math.ceil(Math.max(...ally)) + 0.5;
    const X = (i) => pad.l + (i / (NN.length - 1)) * (CW - pad.l - pad.r);
    const Y = (v) => CH - pad.b - ((v - ymin) / (ymax - ymin)) * (CH - pad.t - pad.b);
    ctx.font = '9.5px Inter'; ctx.fillStyle = 'rgba(210,220,235,0.55)';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let v = Math.ceil(ymin); v <= ymax; v += 2) {
      ctx.strokeStyle = 'rgba(200,210,225,0.07)';
      ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(CW - pad.r, Y(v)); ctx.stroke();
      ctx.fillText(String(v), pad.l - 5, Y(v));
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    NN.forEach((n, i) => ctx.fillText(String(n), X(i), CH - 6));
    // bootstrap band (assimilated tier)
    ctx.beginPath();
    idw.forEach((r, i) => (i ? ctx.lineTo(X(i), Y(r.rmse[2])) : ctx.moveTo(X(0), Y(r.rmse[2]))));
    for (let i = NN.length - 1; i >= 0; i--) ctx.lineTo(X(i), Y(idw[i].rmse[0]));
    ctx.closePath(); ctx.fillStyle = 'rgba(240,163,90,0.12)'; ctx.fill();
    // anchor-only (dashed) vs assimilated (solid)
    ctx.strokeStyle = 'rgba(160,170,185,0.8)'; ctx.lineWidth = 1.3; ctx.setLineDash([4, 3]);
    ctx.beginPath();
    none.forEach((r, i) => { if (r) (i ? ctx.lineTo(X(i), Y(r.rmse[1])) : ctx.moveTo(X(i), Y(r.rmse[1]))); });
    ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = '#f0a35a'; ctx.lineWidth = 2.2;
    ctx.beginPath();
    idw.forEach((r, i) => (i ? ctx.lineTo(X(i), Y(r.rmse[1])) : ctx.moveTo(X(0), Y(r.rmse[1]))));
    ctx.stroke();
    // live point
    const i = S.dvIdx;
    ctx.fillStyle = '#56c8ff'; ctx.strokeStyle = 'rgba(8,12,18,0.9)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(X(i), Y(idw[i].rmse[1]), 5, 0, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(210,220,235,0.65)'; ctx.textAlign = 'left';
    ctx.fillText('RMSE (µg/m³) vs monitors used', pad.l + 4, pad.t + 6);
  }

  function enterDvMode() {
    if (!S.dvMode) {
      S.dvMode = true;
      $('#dv-exit').style.display = '';
      const st = getState();
      if (st.playing) $('#play').click();          // pause the hourly animation
    }
    paintDv();
  }

  function exitDataValueMode(rerender = true) {
    if (!S.dvMode) return;
    S.dvMode = false;
    $('#dv-exit').style.display = 'none';
    $('#dv-note').innerHTML = 'Drag the slider to enter data-value mode.';
    drawDvCurve();
    if (rerender) exitToHour();
  }

  function buildDvPanel() {
    const slider = $('#dv-slider');
    slider.max = dv.N.length - 1;
    slider.value = 0;
    slider.addEventListener('input', () => {
      S.dvIdx = +slider.value;
      $('#dv-nlabel').textContent = String(dvN());
      enterDvMode();
    });
    $('#dv-exit').addEventListener('click', () => exitDataValueMode(true));
    drawDvCurve();
  }

  function panelW(cv) {
    return clamp(cv.parentElement.clientWidth - 34, 180, 620);
  }

  // ── live self-checking scoreboard (present once the daily Action has run) ──
  let liveData = null;
  async function drawLive() {
    if (!liveData) {
      try { liveData = await store.getExtra('live'); } catch { return; }
    }
    const live = liveData;
    if (!live || !live.issuances || !live.issuances.length) return;
    $('#live-wrap').style.display = '';
    const nowS = Date.now() / 1000;
    const from = nowS - 14 * 86400, to = nowS + 2 * 86400;
    // day-ahead prediction per hour: newest issuance at least 12 h old at issue
    const pred = new Map();
    for (const iss of live.issuances) {
      const t0 = iss.hours[0];
      iss.hours.forEach((h, i) => {
        const lead = (h - t0) / 3600;
        if (h < from || h > to) return;
        if (h <= nowS && lead < 12) return;      // matured hours: day-ahead only
        const cur = pred.get(h);
        if (!cur || lead < cur.lead) pred.set(h, { lead, v: iss.fcst[i] });
      });
    }
    const obs = (live.obs.hours || []).map((h, i) => [h, live.obs.values[i]])
      .filter(([h]) => h >= from);
    const cv = $('#live-canvas');
    const { ctx, w: CW, h: CH } = fitCanvas(cv, panelW(cv), 160);
    ctx.clearRect(0, 0, CW, CH);
    const pad = { l: 34, r: 8, t: 8, b: 20 };
    const ph = [...pred.keys()].sort((a, b) => a - b);
    const all = obs.map(([, v]) => v).concat(ph.map((h) => pred.get(h).v));
    if (!all.length) return;
    const ymax = Math.max(20, ...all) * 1.1;
    const X = (h) => pad.l + ((h - from) / (to - from)) * (CW - pad.l - pad.r);
    const Y = (v) => CH - pad.b - (v / ymax) * (CH - pad.t - pad.b);
    ctx.font = '9.5px Inter'; ctx.fillStyle = 'rgba(210,220,235,0.55)';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of [0, 15, 30, 45]) {
      if (v > ymax) continue;
      ctx.strokeStyle = 'rgba(200,210,225,0.07)';
      ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(CW - pad.r, Y(v)); ctx.stroke();
      ctx.fillText(String(v), pad.l - 5, Y(v));
    }
    // "now" marker
    ctx.strokeStyle = 'rgba(86,200,255,0.5)'; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(X(nowS), pad.t); ctx.lineTo(X(nowS), CH - pad.b); ctx.stroke();
    ctx.setLineDash([]);
    // observations
    ctx.strokeStyle = '#38b76a'; ctx.lineWidth = 1.3; ctx.beginPath();
    let started = false;
    for (const [h, v] of obs) {
      const x = X(h), y = Y(v);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // day-ahead prediction: solid for matured, dashed into the future
    for (const dash of [false, true]) {
      ctx.strokeStyle = '#f0a35a'; ctx.lineWidth = 1.7;
      ctx.setLineDash(dash ? [5, 3] : []);
      ctx.beginPath(); started = false;
      for (const h of ph) {
        if (dash !== (h > nowS)) { started = false; continue; }
        const x = X(h), y = Y(pred.get(h).v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const s = live.summary;
    $('#live-note').innerHTML =
      `<span class="dot" style="background:#38b76a"></span> SIATA stations ·
       <span class="dot" style="background:#f0a35a"></span> day-ahead forecast
       (dashed = upcoming) · updated ${String(live.updated || '').slice(0, 16)}Z<br>`
      + (s ? `rolling scoreboard: RMSE <b>${fmt(s.rmse_f)}</b> vs persistence `
           + `${fmt(s.rmse_p)} µg/m³ → skill <b>${s.skill_vs_persistence >= 0 ? '+' : ''}`
           + `${fmt(s.skill_vs_persistence, 2)}</b> over ${s.n_days} scored days`
           : 'scoreboard fills in as observations land');
  }

  buildRevealPanel();
  drawForecast();
  buildDvPanel();
  drawLive();
  window.addEventListener('resize', () => { drawForecast(); drawDvCurve(); drawLive(); });

  return { drawStations, hitStation, exitDataValueMode };
}
