"""kandy_live.py — the live Kandy PM2.5 forecast (Phase 5.3, 2026-07-20).

Runs HOURLY (GitHub Action), mirroring the Medellin runner whose recipe is
ground-truth-validated (F-M2: forecast RMSE 5.04 vs 24 h persistence 6.49, skill
+0.22 against 15 withheld stations; live self-checking scoreboard since 2026-07).

The one honest difference: Kandy has NO public in-basin monitoring station, so this
forecast CANNOT self-check locally. Steps:

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
3. No local skill scoring: the panel reports the Medellin pedigree instead. If a
   Kandy station ever appears (NBRO/FECT public feed), step 3 becomes a real
   scoreboard with no other change.

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
WAQI_BOUNDS = "https://api.waqi.info/v2/map/bounds"
WAQI_FEED = "https://api.waqi.info/feed/@{uid}/"
REGION_BOX = (6.9, 80.3, 7.7, 81.0)      # lat1, lon1, lat2, lon2 (regional, not basin)
MAX_ISSUANCES = 60
OBS_WINDOW_D = 45

AQI_BP = [(0.0, 9.0, 0, 50), (9.1, 35.4, 51, 100), (35.5, 55.4, 101, 150),
          (55.5, 125.4, 151, 200), (125.5, 225.4, 201, 300), (225.5, 325.4, 301, 500)]


def log(*a):
    print(*a, flush=True)


def aqi_to_ugm3(aqi):
    for c_lo, c_hi, a_lo, a_hi in AQI_BP:
        if a_lo <= aqi <= a_hi:
            return c_lo + (aqi - a_lo) * (c_hi - c_lo) / (a_hi - a_lo)
    return None


def cfapi_get(params):
    r = requests.get(CFAPI, params=params, timeout=600)
    r.raise_for_status()
    return r.json()


def fetch_drivers(cells):
    frames, init = [], None
    for lat, lon in cells:
        chm = cfapi_get({"start_date": "latest", "dataset": "chm", "level": "v1",
                         "products": "PM25", "lat": lat, "lon": lon})
        met = cfapi_get({"start_date": "latest", "dataset": "met", "level": "x1",
                         "products": "MET", "lat": lat, "lon": lon})
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
    rec = {"issued": init,
           "hours": [int(t.value // 10**9) for t in idx],
           "fcst": [round(float(v), 2) for v in q50],
           "lo": [round(float(v), 2) for v in q05],
           "hi": [round(float(v), 2) for v in q95]}
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


def main():
    pack = json.loads((HERE / "model" / "pack.json").read_text(encoding="utf-8"))
    state = {"issuances": [], "regional": {"hours": [], "values": []}}
    if LIVE_JSON.exists():
        state = json.loads(LIVE_JSON.read_text(encoding="utf-8"))
        state.setdefault("regional", {"hours": [], "values": []})

    try:
        issue_forecast(pack, state)
    except Exception as e:
        log(f"ISSUE step failed: {e!r}")
    try:
        snapshot_regional(pack, state)
    except Exception as e:
        log(f"REGIONAL step failed: {e!r}")

    state["updated"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    state["self_check"] = False
    state["about"] = (
        "Live Kandy forecast: the frozen area-anchored model (trained on 2019-2023) "
        "driven by NASA GEOS-CF forecast fields. Kandy has no public in-basin "
        "monitoring station, so this forecast is NOT scored locally. Its pedigree is "
        "the same recipe validated at Medellin against withheld stations (beat 24 h "
        "persistence by +0.22). The regional series shown alongside comes from "
        "stations 25-40 km outside the basin: it tracks the transboundary background "
        "(~76% of Kandy's PM2.5), not the city field.")
    LIVE_JSON.parent.mkdir(parents=True, exist_ok=True)
    LIVE_JSON.write_text(json.dumps(state, separators=(",", ":")), encoding="utf-8")
    log(f"wrote {LIVE_JSON.name} ({LIVE_JSON.stat().st_size/1e3:.0f} kB)")


if __name__ == "__main__":
    main()
