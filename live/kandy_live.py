"""kandy_live.py — the live Kandy PM2.5 forecast (Phase 5.3, 2026-07-20;
DEMONSTRATION tier, 2026-07-27).

Runs HOURLY (GitHub Action), mirroring the Medellin runner whose recipe is
ground-truth-validated (F-M2, clean temporal split trained <=2022 and scored on
2023: forecast RMSE 5.71 vs 24 h persistence 6.49, skill +0.120 against 15
withheld stations).

  NUMBERS NOTE, read before editing any string in this file: an earlier F-M2 run
  reported skill +0.223 / RMSE 5.04 and a 12-36 h lead sweep of +0.22...+0.44.
  That run trained on hours inside its own 2023 evaluation year while giving the
  persistence baseline no look-ahead. The clean split roughly halves the headline.
  All pre-registered FG2 gates still pass. NEVER display +0.22 or the lead sweep.
  Equally: the clean run has the forecast anchor edging the ANALYSIS anchor
  (5.71 vs 5.96). That is amplitude calibration, not skill -- correlation is
  identical (0.590 vs 0.592) and the analysis anchor simply carries more
  unskillful hour-to-hour variance. Never phrase it as beating reanalysis.

The one honest difference from Medellin: Kandy has NO public in-basin monitoring
station, so this forecast CANNOT self-check locally. It ships labelled as a
demonstration, with borrowed evidence and OOD-widened intervals. Steps:

1. ISSUE (when a new GEOS-CF run is available): pull forecast drivers from the NASA
   GMAO CFAPI (keyless; chm v1 PM25 -> c_prior, met x1 U/V/T/ZPBL), mean of the two
   0.25-deg cells covering the basin, and drive the frozen area-anchored T(t) GBM
   (model/anchor_gbm*.txt, trained on the locked 2019-2023 T(t)) -> 120 h forecast
   of the basin-area-mean PM2.5, with 90% interval.
2. REGIONAL CONTEXT (needs WAQI_TOKEN): log the three Sri Lankan stations that DO
   report near-real-time (Nuwara Eliya, Kegalle, Kurunegala — all 25-40 km outside
   the basin). They sample the regional/transboundary background that is ~76% of
   Kandy's PM2.5 (f_local = 0.24), so they are context for B(t) and a sanity signal
   on the regional airmass — explicitly NOT a check on the Kandy field, and never
   scored as such.
3. EVIDENCE: carry the borrowed pedigree into the payload (the F-M2 held-out
   backtest, plus Medellin's live self-checking scoreboard once it has matured
   enough hours to score -- it had scored none as of 2026-07-27).
4. No local skill scoring, because there is nothing to score against. NBRO
   "Kandy 1" (7.2939 N, 80.6414 E) exists but has logged 2 observations and is
   silent; the hourly NBRO_AQ_snapshot task captures it automatically, so if it
   starts reporting this becomes a real scoreboard with no code change here.

State lives in ../data/live.json (committed by the Action).
"""
from __future__ import annotations
import datetime as dt
import json
import os
from pathlib import Path

import numpy as np
import pandas as pd
import requests

HERE = Path(__file__).resolve().parent
LIVE_JSON = HERE.parent / "data" / "live.json"
CFAPI = "https://fluid.nccs.nasa.gov/cf/api/fcast/"
ASSIM = "https://fluid.nccs.nasa.gov/cf/api/assim/"   # rolling 25 h analysis window
NOWCAST_WINDOW_D = 40
# Liveness thresholds. GEOS-CF issues ~daily and the Action runs hourly, so ~30 quiet
# runs (or a newest issuance older than ~2 days) means something is broken, not idle.
STALE_RUNS = 30
STALE_H = 48
NOWCAST_FIELDS = ("fcst", "lo", "hi", "B", "u10", "v10", "wspd", "wdir_from",
                  "blh", "t2m", "i0", "wd0", "cs0", "wn")
WAQI_BOUNDS = "https://api.waqi.info/v2/map/bounds"
WAQI_FEED = "https://api.waqi.info/feed/@{uid}/"
MEDELLIN_LIVE = "https://daminda1108.github.io/medellin-pm25/data/live.json"
REGION_BOX = (6.9, 80.3, 7.7, 81.0)      # lat1, lon1, lat2, lon2 (regional, not basin)
MAX_ISSUANCES = 60
OBS_WINDOW_D = 45

AQI_BP = [(0.0, 9.0, 0, 50), (9.1, 35.4, 51, 100), (35.5, 55.4, 101, 150),
          (55.5, 125.4, 151, 200), (125.5, 225.4, 201, 300), (225.5, 325.4, 301, 500)]


try:
    from adaptive_conformal import (factor as ac_factor, new_state as ac_new,
                                    summary as ac_summary, update as ac_update)
except ImportError:                                    # keep the runner standalone
    from live.adaptive_conformal import (factor as ac_factor, new_state as ac_new,
                                         summary as ac_summary, update as ac_update)


def log(*a):
    print(*a, flush=True)


def aqi_to_ugm3(aqi):
    for c_lo, c_hi, a_lo, a_hi in AQI_BP:
        if a_lo <= aqi <= a_hi:
            return c_lo + (aqi - a_lo) * (c_hi - c_lo) / (a_hi - a_lo)
    return None


def cfapi_get(params, endpoint=CFAPI):
    r = requests.get(endpoint, params=params, timeout=600)
    r.raise_for_status()
    return r.json()


def fetch_drivers(cells, endpoint=CFAPI):
    """Area-mean drivers from the CFAPI. `endpoint` selects FORECAST (default) or
    the ASSIM analysis window — identical schema, so one fetcher serves both."""
    frames, init = [], None
    for lat, lon in cells:
        chm = cfapi_get({"start_date": "latest", "dataset": "chm", "level": "v1",
                         "products": "PM25", "lat": lat, "lon": lon}, endpoint)
        met = cfapi_get({"start_date": "latest", "dataset": "met", "level": "x1",
                         "products": "MET", "lat": lat, "lon": lon}, endpoint)
        t = pd.to_datetime(chm["time"], utc=True)
        f = pd.DataFrame({"c_prior": chm["values"]["PM25_RH35"]}, index=t)
        tm = pd.to_datetime(met["time"], utc=True)
        m = pd.DataFrame({"u10": met["values"]["U"], "v10": met["values"]["V"],
                          "t2m": met["values"]["T"], "blh": met["values"]["ZPBL"]},
                         index=tm)
        frames.append(f.join(m, how="inner"))
        init = chm["schema"].get("forecast initialization time")
    d = sum(frames[1:], frames[0]) / len(frames)
    d.attrs["init"] = str(init)
    return d


def apply_wind_calib(pack, idx, u, v):
    """B2 thermal valley-circulation wind input — a straight port of
    webapp_export._apply_wind_calib so the forecast wind matches the shipped wind.
    At Kandy these parameters are a disclosed METHOD-TRANSFER PRIOR (DEM drainage
    axis + relief-scaled amplitude from two fitted valleys), not a local fit."""
    p = pack.get("wind_calib")
    if not p:
        return u, v
    lh = (idx + pd.Timedelta(hours=5, minutes=30)).hour.to_numpy()   # Asia/Colombo
    w_ = 2 * np.pi / 24.0
    A = (p["a0"] + p["a1"] * np.cos(w_ * lh) + p["b1"] * np.sin(w_ * lh)
         + p["a2"] * np.cos(2 * w_ * lh) + p["b2"] * np.sin(2 * w_ * lh))
    th = np.deg2rad(p["theta_deg"])
    return (p["gain_era5"] * u - A * np.sin(th),
            p["gain_era5"] * v - A * np.cos(th))


def wind_blend_params(pack, u, v, blh):
    """Port of webapp_export._wind_blend_params (parity-critical: the browser
    blends the shipped WindNinja library with exactly these weights)."""
    lib = pack.get("wind_lib")
    if not lib:
        return {"i0": 0, "wd0": 1.0, "cs0": 1.0, "wn": 0.0}
    dirs, speeds = lib["dirs"], lib["speeds"]
    spd = float(np.clip(np.hypot(u, v), 0.2, 8.0))
    dfrom = float(np.degrees(np.arctan2(-u, -v)) % 360.0)
    nd = len(dirs); step = 360.0 / nd
    i0 = int(np.floor(dfrom / step)) % nd
    wd0 = 1.0 - ((dfrom - dirs[i0]) % 360.0) / step
    s0, s1 = float(speeds[0]), float(speeds[1])
    cs0 = 1.0 - (spd - s0) / (s1 - s0)
    wn = float(np.clip((600.0 - blh) / 600.0, 0, 1))
    return {"i0": i0, "wd0": round(wd0, 5), "cs0": round(cs0, 5), "wn": round(wn, 5)}


def issue_forecast(pack, state):
    import lightgbm as lgb
    drv = fetch_drivers([tuple(c) for c in pack["cells"]])
    init = drv.attrs["init"]
    if any(i.get("issued") == init for i in state["issuances"]):
        log(f"ISSUE: init {init} already issued — skip")
        return False
    d = drv.copy()
    d["wspd"] = np.hypot(d.u10, d.v10)
    idx = d.index
    d["sin_h"] = np.sin(2 * np.pi * idx.hour / 24)
    d["cos_h"] = np.cos(2 * np.pi * idx.hour / 24)
    doy = idx.dayofyear
    d["sin_doy"] = np.sin(2 * np.pi * doy / 365.25)
    d["cos_doy"] = np.cos(2 * np.pi * doy / 365.25)
    d["dow"] = idx.dayofweek
    X = d[pack["features"]].astype(float)
    q50 = np.clip(lgb.Booster(model_file=str(HERE / "model" / "anchor_gbm.txt"))
                  .predict(X), 0, None)
    q05 = np.clip(lgb.Booster(model_file=str(HERE / "model" / "anchor_gbm_q05.txt"))
                  .predict(X), 0, None)
    q95 = np.clip(lgb.Booster(model_file=str(HERE / "model" / "anchor_gbm_q95.txt"))
                  .predict(X), 0, None)
    # OOD widening. The quantile heads were fitted IN-REGIME on the locked Kandy
    # anchor; Kandy is out-of-regime vs every city this method was validated on,
    # and the one place that shows up measurably is the sensorless anchor, whose
    # nominal 90% interval covers 70.7% of the local record. k restores nominal
    # coverage there (scripts/kandy_forecast_ood_widening.py). Disclosed transfer:
    # measured daily, applied hourly. The raw interval stays recoverable as
    # med +/- (shown - med)/k, so nothing is lost by shipping only the widened one.
    # Static measured factor, and the per-lead ADAPTIVE factor that can only widen
    # beyond it (live/adaptive_conformal.py). The adapted factor is learned from what
    # verified against the analysis tier, so it captures the growth of driver-shift
    # error with lead that a single scalar cannot. It falls back to the static factor
    # cold, so a fresh deployment ships exactly the previously validated interval.
    k = float(pack.get("ood_widen", {}).get("k", 1.0))
    # lead = valid - initialisation. `init` comes from the CFAPI schema as a string of
    # unspecified format, so parse defensively and fall back to the first valid hour
    # (the earliest forecast step is at or just after initialisation).
    try:
        t_init = pd.to_datetime(init, utc=True)
        if pd.isna(t_init):
            raise ValueError(init)
    except Exception:
        t_init = idx[0]
    lead_h = np.clip((idx - t_init).total_seconds().to_numpy() / 3600.0, 0.0, None)
    kv = np.array([max(k, ac_factor(state.get("conformal"), float(L)))
                   for L in lead_h], float)
    lo = np.clip(q50 - kv * (q50 - q05), 0, None)
    hi = q50 + kv * (q95 - q50)

    # Background for the forecast hours: B = T * (locked monthly B/T ratio), the
    # same seasonal partition the 2024-2026 extension tier inherits. A flat B would
    # leave the monsoon months with T < B and flatten the local field (gotcha #61).
    ratio = pack.get("bt_ratio_month")
    B = q50 * np.array([ratio[m - 1] for m in idx.month], float) if ratio else None

    # Wind: apply the B2 valley-circulation prior, then compute the SAME blend
    # indices the exporter ships, so a forecast hour drives the browser's terrain
    # wind through one implementation rather than two.
    u, v = drv.u10.to_numpy(float), drv.v10.to_numpy(float)
    u, v = apply_wind_calib(pack, idx, u, v)
    blend = [wind_blend_params(pack, ui, vi, bi)
             for ui, vi, bi in zip(u, v, drv.blh.to_numpy(float))]

    rec = {"issued": init,
           "hours": [int(t.value // 10**9) for t in idx],
           "fcst": [round(float(x), 2) for x in q50],
           "lo": [round(float(x), 2) for x in lo],
           "hi": [round(float(x), 2) for x in hi],
           "ood_k": k,
           "ood_k_lead": [round(float(x), 3) for x in kv],
           "lead_h": [round(float(x), 1) for x in lead_h],
           # raw (unwidened) heads retained so any factor can be re-derived later and
           # so the conformal update has something to score against
           "q05_raw": [round(float(x), 2) for x in q05],
           "q95_raw": [round(float(x), 2) for x in q95]}
    if B is not None:
        rec["B"] = [round(float(x), 2) for x in B]
    rec["met"] = {
        "u10": [round(float(x), 3) for x in u],
        "v10": [round(float(x), 3) for x in v],
        "wspd": [round(float(x), 3) for x in np.hypot(u, v)],
        "wdir_from": [round(float(x), 1)
                      for x in np.degrees(np.arctan2(-u, -v)) % 360.0],
        "blh": [round(float(x), 1) for x in drv.blh],
        # CFAPI met x1 reports T in kelvin; the payload's t2m is degrees C.
        "t2m": [round(float(x) - 273.15, 2) for x in drv.t2m],
        "i0": [b["i0"] for b in blend],
        "wd0": [b["wd0"] for b in blend],
        "cs0": [b["cs0"] for b in blend],
        "wn": [b["wn"] for b in blend],
        # no humidity or rain in the forecast driver set — the panel omits the rows
        # rather than substituting a value from somewhere else.
        "rh": None, "rain": None}
    state["issuances"] = (state["issuances"] + [rec])[-MAX_ISSUANCES:]
    log(f"ISSUE: init {init}, {len(q50)} h, range {q50.min():.1f}-{q50.max():.1f} ug/m3")
    return True


def snapshot_regional(pack, state):
    """Log the regional (non-basin) stations as CONTEXT for the background."""
    token = os.environ.get("WAQI_TOKEN", "").strip()
    if not token:
        log("REGIONAL skipped: WAQI_TOKEN not set")
        return False
    la1, lo1, la2, lo2 = REGION_BOX
    r = requests.get(WAQI_BOUNDS, params={
        "latlng": f"{la1},{lo1},{la2},{lo2}", "networks": "all", "token": token},
        timeout=120)
    r.raise_for_status()
    doc = r.json()
    if doc.get("status") != "ok":
        raise RuntimeError(f"WAQI bounds: {doc}")
    vals = []
    for st in doc.get("data", []):
        fr = requests.get(WAQI_FEED.format(uid=st["uid"]),
                          params={"token": token}, timeout=60).json()
        if fr.get("status") != "ok":
            continue
        dd = fr["data"]
        pm = ((dd.get("iaqi") or {}).get("pm25") or {}).get("v")
        ts = (dd.get("time") or {}).get("v")
        if pm is None or ts is None:
            continue
        if (dt.datetime.now(dt.timezone.utc).timestamp() - ts) / 3600 > 3:
            continue
        ug = aqi_to_ugm3(float(pm))
        if ug is not None and 0 < ug < 800:
            vals.append((int(ts // 3600 * 3600), ug))
    if not vals:
        log("REGIONAL: no fresh stations")
        return False
    hours = pd.Series([v[0] for v in vals])
    h = int(hours.mode().iloc[0])
    mean = float(np.mean([v for t, v in vals if t == h]))
    obs = dict(zip(state["regional"]["hours"], state["regional"]["values"]))
    obs[h] = round(mean, 2)
    cut = dt.datetime.now(dt.timezone.utc).timestamp() - OBS_WINDOW_D * 86400
    keep = sorted(k for k in obs if k >= cut)
    state["regional"] = {
        "hours": keep, "values": [obs[k] for k in keep],
        "source": "WAQI regional stations 25-40 km outside the basin "
                  "(Nuwara Eliya / Kegalle / Kurunegala), AQI back-converted",
        "note": pack.get("regional_note", "")}
    log(f"REGIONAL: {len(vals)} stations -> mean {mean:.1f} ug/m3 ({len(keep)} h logged)")
    return True


def migrate_issuances(pack, state):
    """Bring older issuance records up to the current schema.

    Two migrations, both exact rather than approximate:
      - WIDENING: records written before the OOD factor existed stored the RAW
        q05/q95 in lo/hi, so lo_widened = med - k*(med - q05) reproduces exactly
        what a fresh issuance would have written.
      - BACKGROUND: B = T * (locked monthly B/T ratio) is a deterministic function
        of the hour and the forecast median, so it can be filled after the fact.
        Without it the browser cannot rebuild a field at all.
    Meteorology is NOT recoverable — GEOS-CF serves only a rolling 25 h analysis
    window and the replay archive lags by months — so such hours are tagged
    `level_only` and the client hides wind and weather for them rather than
    substituting a different met product.
    """
    k = float(pack.get("ood_widen", {}).get("k", 1.0))
    ratio = pack.get("bt_ratio_month")
    widened = filled = lvl = 0
    for iss in state.get("issuances", []):
        med = np.array(iss["fcst"], float)
        if "ood_k" not in iss:
            iss["lo"] = [round(float(v), 2) for v in
                         np.clip(med - k * (med - np.array(iss["lo"], float)), 0, None)]
            iss["hi"] = [round(float(v), 2) for v in
                         med + k * (np.array(iss["hi"], float) - med)]
            iss["ood_k"] = k
            widened += 1
        if "B" not in iss and ratio:
            months = pd.to_datetime(iss["hours"], unit="s", utc=True).month
            iss["B"] = [round(float(t * ratio[m - 1]), 2) for t, m in zip(med, months)]
            filled += 1
        if "met" not in iss:
            iss["level_only"] = True
            lvl += 1
    if widened or filled:
        log(f"MIGRATE: widened {widened}, filled B on {filled}, "
            f"{lvl} level-only (no recoverable met)")


def snapshot_assim(pack, state):
    """NOWCAST — drive the anchor with GEOS-CF's near-real-time ANALYSIS.

    This is what keeps the record and the forecast joined up. The reconstructed
    record can only ever reach about now-5d (ERA5-Land latency), while the forecast
    starts at the newest model run, so without this step a multi-day band opens
    between them that no dataset can fill after the fact: the CFAPI serves analysis
    for a rolling 25 h window ONLY (dated requests are rejected), and the OPeNDAP
    replay archive lags by months. Logged hourly, that rolling window accumulates
    into continuous coverage and the seam never forms.

    Identical machinery to the forecast — same anchor, same drivers, same widening —
    at zero lead instead of positive lead.
    """
    import lightgbm as lgb
    drv = fetch_drivers([tuple(c) for c in pack["cells"]], endpoint=ASSIM)
    d = drv.copy()
    d["wspd"] = np.hypot(d.u10, d.v10)
    idx = d.index
    d["sin_h"] = np.sin(2 * np.pi * idx.hour / 24)
    d["cos_h"] = np.cos(2 * np.pi * idx.hour / 24)
    doy = idx.dayofyear
    d["sin_doy"] = np.sin(2 * np.pi * doy / 365.25)
    d["cos_doy"] = np.cos(2 * np.pi * doy / 365.25)
    d["dow"] = idx.dayofweek
    X = d[pack["features"]].astype(float)
    q50, q05, q95 = (np.clip(lgb.Booster(model_file=str(HERE / "model" / m)).predict(X), 0, None)
                     for m in ("anchor_gbm.txt", "anchor_gbm_q05.txt", "anchor_gbm_q95.txt"))
    k = float(pack.get("ood_widen", {}).get("k", 1.0))
    lo = np.clip(q50 - k * (q50 - q05), 0, None)
    hi = q50 + k * (q95 - q50)
    ratio = pack.get("bt_ratio_month")
    B = q50 * np.array([ratio[m - 1] for m in idx.month], float)
    u, v = apply_wind_calib(pack, idx, drv.u10.to_numpy(float), drv.v10.to_numpy(float))
    blend = [wind_blend_params(pack, ui, vi, bi)
             for ui, vi, bi in zip(u, v, drv.blh.to_numpy(float))]

    prev = state.get("nowcast") or {"hours": []}
    keep = {h: i for i, h in enumerate(prev["hours"])}
    rows = {}
    for h in prev["hours"]:                       # existing hours, unchanged
        i = keep[h]
        rows[h] = {f: prev[f][i] for f in NOWCAST_FIELDS}
    for j, t in enumerate(idx):                   # this window overwrites/extends
        rows[int(t.value // 10**9)] = {
            "fcst": round(float(q50[j]), 2), "lo": round(float(lo[j]), 2),
            "hi": round(float(hi[j]), 2), "B": round(float(B[j]), 2),
            "u10": round(float(u[j]), 3), "v10": round(float(v[j]), 3),
            "wspd": round(float(np.hypot(u[j], v[j])), 3),
            "wdir_from": round(float(np.degrees(np.arctan2(-u[j], -v[j])) % 360.0), 1),
            "blh": round(float(drv.blh.iloc[j]), 1),
            "t2m": round(float(drv.t2m.iloc[j]) - 273.15, 2),
            "i0": blend[j]["i0"], "wd0": blend[j]["wd0"],
            "cs0": blend[j]["cs0"], "wn": blend[j]["wn"]}
    cut = dt.datetime.now(dt.timezone.utc).timestamp() - NOWCAST_WINDOW_D * 86400
    hrs = sorted(h for h in rows if h >= cut)
    state["nowcast"] = {"hours": hrs, "ood_k": k,
                        **{f: [rows[h][f] for h in hrs] for f in NOWCAST_FIELDS}}
    log(f"NOWCAST: {len(idx)} analysis hours fetched, {len(hrs)} logged "
        f"({dt.datetime.fromtimestamp(hrs[0], dt.timezone.utc):%Y-%m-%d %H:%M} -> "
        f"{dt.datetime.fromtimestamp(hrs[-1], dt.timezone.utc):%Y-%m-%d %H:%M})")
    return True


def verify_against_analysis(state):
    """Fold every forecast hour that the analysis tier has since covered into the
    adaptive-conformal state.

    This is the only verification available at Kandy: there is no live observation
    stream, by the premise of the project. Scoring a forecast against the analysis
    measures the DRIVER-SHIFT component of its error -- the part that grows with lead --
    and not its error against reality, which is bounded separately by the sensorless
    coverage figure and is why the static factor remains a floor. Stated in the payload
    so the provenance of the interval is never ambiguous.
    """
    now = state.get("nowcast") or {}
    truth = dict(zip(now.get("hours", []), now.get("fcst", [])))
    if not truth:
        return 0
    seen = set(map(tuple, state.get("conformal_seen", [])))
    pairs, fresh = [], []
    for iss in state.get("issuances", []):
        if "q05_raw" not in iss:                      # pre-adaptive issuance
            continue
        t0 = iss.get("issued")
        for j, h in enumerate(iss["hours"]):
            if h not in truth or (t0, h) in seen:
                continue
            lead = iss.get("lead_h", [None] * len(iss["hours"]))[j]
            if lead is None:
                continue
            pairs.append((float(lead), iss["fcst"][j],
                          iss["q05_raw"][j], iss["q95_raw"][j], truth[h]))
            fresh.append((t0, h))
    if not pairs:
        return 0
    state["conformal"] = ac_update(state.get("conformal") or ac_new(), pairs)
    state["conformal_seen"] = [list(x) for x in (seen | set(fresh))][-20000:]
    s = ac_summary(state["conformal"])
    by = s.get("by_lead", {})
    log(f"CONFORMAL: +{len(pairs)} verified pairs (n={s.get('n', 0)}); k by lead " +
        ", ".join(f"{b}:{d['k']:.2f}" for b, d in sorted(by.items())) if by
        else f"CONFORMAL: +{len(pairs)} pairs, warming up")
    return len(pairs)


def borrowed_evidence(pack, state):
    """The evidence this panel stands on — none of it measured at Kandy.

    Primary = the F-M2 held-out backtest at Medellin (clean temporal split), which
    is baked into pack.json. Secondary = Medellin's LIVE self-checking scoreboard,
    fetched here so it appears automatically once it has matured enough hours to
    score. As of 2026-07-27 it has logged issuances and observations but scored
    zero days, so it is omitted rather than shown empty.
    """
    ev = dict(pack.get("evidence", {}))
    try:
        r = requests.get(MEDELLIN_LIVE, timeout=60)
        r.raise_for_status()
        med = r.json()
        s = med.get("summary")
        if s and s.get("n_hours"):
            ev["live"] = {"summary": s, "per_lead": med.get("per_lead"),
                          "updated": med.get("updated"),
                          "url": "https://daminda1108.github.io/medellin-pm25/"}
            log(f"EVIDENCE: Medellin live scoreboard has {s['n_hours']} scored hours")
        else:
            log("EVIDENCE: Medellin live scoreboard not yet matured — omitted")
    except Exception as e:
        log(f"EVIDENCE: Medellin live fetch failed ({e!r}) — backtest only")
    state["evidence"] = ev


def main():
    pack = json.loads((HERE / "model" / "pack.json").read_text(encoding="utf-8"))
    state = {"issuances": [], "regional": {"hours": [], "values": []}}
    if LIVE_JSON.exists():
        state = json.loads(LIVE_JSON.read_text(encoding="utf-8"))
        state.setdefault("regional", {"hours": [], "values": []})
    migrate_issuances(pack, state)

    ok_issue = False
    try:
        ok_issue = bool(issue_forecast(pack, state))
    except Exception as e:
        log(f"ISSUE step failed: {e!r}")
    try:
        snapshot_assim(pack, state)
    except Exception as e:
        log(f"NOWCAST step failed: {e!r}")
    try:
        snapshot_regional(pack, state)
    except Exception as e:
        log(f"REGIONAL step failed: {e!r}")

    # verify what the analysis tier has caught up with, and adapt the per-lead
    # widening. Runs AFTER the nowcast step so it sees this run's analysis hours.
    try:
        verify_against_analysis(state)
    except Exception as e:
        log(f"CONFORMAL step failed: {e!r}")

    try:
        borrowed_evidence(pack, state)
    except Exception as e:
        log(f"EVIDENCE step failed: {e!r}")

    # ── liveness (2026-08-01) ────────────────────────────────────────────────
    # A scheduled ingest that goes quiet looks exactly like "no data yet" — that is
    # how the Medellin obs log sat empty for a week (gotcha #62). Track consecutive
    # runs without a new issuance and FAIL the job past a threshold, so GitHub's own
    # workflow-failure notification becomes the alarm. The payload also carries the
    # ages so the page can show staleness instead of silently serving an old forecast.
    now = dt.datetime.now(dt.timezone.utc)
    hrs = sorted({h for i in state["issuances"] for h in i["hours"]})
    last_issue = max((i["issued"] for i in state["issuances"]), default=None)
    age_h = None
    if last_issue:
        age_h = round((now - pd.Timestamp(last_issue).tz_localize("UTC")).total_seconds() / 3600, 1)
    state["conformal_summary"] = ac_summary(state.get("conformal"))
    health = state.get("health") or {}
    health = {"runs_without_issue": 0 if ok_issue else int(health.get("runs_without_issue", 0)) + 1,
              "last_issue_utc": last_issue,
              "issue_age_h": age_h,
              "last_run_utc": now.isoformat(timespec="seconds"),
              "nowcast_hours": len((state.get("nowcast") or {}).get("hours", [])),
              "horizon_end_utc": (dt.datetime.fromtimestamp(hrs[-1], dt.timezone.utc)
                                  .isoformat(timespec="seconds") if hrs else None)}
    state["health"] = health
    log(f"HEALTH: runs_without_issue={health['runs_without_issue']} "
        f"issue_age={age_h}h nowcast_hours={health['nowcast_hours']}")

    state["updated"] = now.isoformat(timespec="seconds")
    state["self_check"] = False
    state["tier"] = "demonstration"
    state["ood_widen"] = pack.get("ood_widen", {})
    state["about"] = (
        "DEMONSTRATION. The frozen area-anchored Kandy model (trained on 2019-2023) "
        "driven by NASA GEOS-CF forecast fields. Kandy has no public in-basin "
        "monitoring station, so this forecast is NOT scored locally and nobody here "
        "can check it. What stands behind it is the same recipe scored at Medellin "
        "against 15 withheld stations, where it beat 24 h persistence by +0.120 "
        "(RMSE 5.71 vs 6.49) on a year it was not trained on. That is a Medellin "
        "number in a different pollution regime, so it bounds the method, not this "
        "city. Intervals are widened by 1.35x because Kandy is out-of-regime: the "
        "sensorless anchor's nominal 90% interval covers only 70.7% of the local "
        "record, and the widening restores 90% there. The regional series shown "
        "alongside comes from stations 25-40 km OUTSIDE the basin: it tracks the "
        "transboundary background (~76% of Kandy's PM2.5), not the city field, and "
        "is never scored against the forecast.")
    LIVE_JSON.parent.mkdir(parents=True, exist_ok=True)
    LIVE_JSON.write_text(json.dumps(state, separators=(",", ":")), encoding="utf-8")
    log(f"wrote {LIVE_JSON.name} ({LIVE_JSON.stat().st_size/1e3:.0f} kB)")

    # Alarm AFTER the write, so the state is always persisted and the next run can
    # recover: a failing job must not also lose the payload.
    if health["runs_without_issue"] >= STALE_RUNS or (age_h is not None and age_h > STALE_H):
        raise SystemExit(
            f"STALE FORECAST: {health['runs_without_issue']} consecutive runs without a new "
            f"issuance, newest is {age_h} h old (thresholds {STALE_RUNS} runs / {STALE_H} h). "
            "GEOS-CF issues roughly daily, so this means the CFAPI fetch or the schedule is "
            "broken — not that there is no new run yet.")


if __name__ == "__main__":
    main()
