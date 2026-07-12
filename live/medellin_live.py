"""medellin_live.py — the self-checking live Medellín forecast (S5, 2026-07-12).

Runs HOURLY (GitHub Action). Steps, each independently fault-tolerant:

1. OBSERVE (every run, needs WAQI_TOKEN): snapshot the live Aburrá-valley
   stations from WAQI (aqicn.org — the only surviving public near-real-time
   mirror of the SIATA/AMVA network; SIATA's own public JSON export and the
   OpenAQ feed both froze in Aug/Sep 2024). Station PM2.5 AQI values are
   back-converted to ug/m3 with the US-EPA 2024 breakpoints, matched to the
   model's station registry by coordinates, and appended to the obs log
   (network mean, anchor stations excluded).
2. ISSUE (when a new GEOS-CF run is available): pull forecast drivers from the
   GMAO CFAPI (keyless; chm v1 PM25 -> scaled prior, met x1 U/V/T/ZPBL), mean
   of the two 0.25-deg cells covering the box (lat 6.25, lon -75.75/-75.5 —
   the same cells as the archived F-M0 pull), and drive the frozen 2-anchor
   T(t) GBM (model/anchor_gbm.txt, F-M2-validated recipe, trained 2018-2024)
   -> 120 h forecast of the network-mean PM2.5.
3. SCORE: for every matured hour, compare the day-ahead prediction (newest
   issuance with lead >= 12 h) against the logged observations, next to the
   24 h persistence baseline. Update the rolling scoreboard.

State lives in ../data/medellin/live.json (committed by the Action).
Honest notes baked into the payload: the model is frozen on 2018-2024 data
(true forward test); live obs are AQI-back-converted (approximate, ±1 ug/m3
class rounding) unlike the raw-ug/m3 SIATA record used for the 2023 backtest.
"""
from __future__ import annotations
import json
import os
import sys
import datetime as dt
from pathlib import Path

import numpy as np
import pandas as pd
import requests

HERE = Path(__file__).resolve().parent
LIVE_JSON = HERE.parent / "data" / "medellin" / "live.json"
CFAPI = "https://fluid.nccs.nasa.gov/cf/api/fcast/"
WAQI_BOUNDS = "https://api.waqi.info/v2/map/bounds"
WAQI_FEED = "https://api.waqi.info/feed/@{uid}/"
BBOX = (6.15, -75.68, 6.39, -75.46)          # lat_min, lon_min, lat_max, lon_max
CELLS = [(6.25, -75.75), (6.25, -75.5)]
MIN_LEAD_H = 12            # "day-ahead": use the newest issuance at least this old
MAX_ISSUANCES = 60
OBS_WINDOW_D = 45
MATCH_DEG = 0.01           # ~1 km coordinate match (WAQI coords are approximate)
MIN_STATIONS = 3

# US-EPA PM2.5 AQI breakpoints, May-2024 revision: (C_lo, C_hi, AQI_lo, AQI_hi)
AQI_BP = [(0.0, 9.0, 0, 50), (9.1, 35.4, 51, 100), (35.5, 55.4, 101, 150),
          (55.5, 125.4, 151, 200), (125.5, 225.4, 201, 300), (225.5, 325.4, 301, 500)]


def log(*a):
    print(*a, flush=True)


def aqi_to_ugm3(aqi: float):
    for c_lo, c_hi, a_lo, a_hi in AQI_BP:
        if a_lo <= aqi <= a_hi:
            return c_lo + (aqi - a_lo) * (c_hi - c_lo) / (a_hi - a_lo)
    return None


# ── step 1: observations (WAQI hourly snapshot) ──────────────────────────────
def snapshot_obs(pack, state):
    token = os.environ.get("WAQI_TOKEN", "").strip()
    if not token:
        log("OBS skipped: WAQI_TOKEN not set (add it as a repo secret)")
        return False
    reg = [s for s in pack["stations"] if s["role"] != "anchor"]
    la1, lo1, la2, lo2 = BBOX
    r = requests.get(WAQI_BOUNDS, params={
        "latlng": f"{la1},{lo1},{la2},{lo2}", "networks": "all", "token": token},
        timeout=120)
    r.raise_for_status()
    doc = r.json()
    if doc.get("status") != "ok":
        raise RuntimeError(f"WAQI bounds: {doc}")
    vals = []
    for st in doc.get("data", []):
        la, lo = float(st["lat"]), float(st["lon"])
        if not any(abs(p["lat"] - la) < MATCH_DEG and abs(p["lon"] - lo) < MATCH_DEG
                   for p in reg):
            continue
        fr = requests.get(WAQI_FEED.format(uid=st["uid"]), params={"token": token},
                          timeout=60)
        fd = fr.json()
        if fd.get("status") != "ok":
            continue
        d = fd["data"]
        pm = ((d.get("iaqi") or {}).get("pm25") or {}).get("v")
        ts = (d.get("time") or {}).get("v")
        if pm is None or ts is None:
            continue
        age_h = (dt.datetime.now(dt.timezone.utc).timestamp() - ts) / 3600
        if age_h > 3:                          # stale station
            continue
        ug = aqi_to_ugm3(float(pm))
        if ug is not None and 0 < ug < 800:
            vals.append((int(ts // 3600 * 3600), ug))
    if len(vals) < MIN_STATIONS:
        log(f"OBS: only {len(vals)} fresh matched stations — snapshot skipped")
        return False
    # one network-mean sample at the (mode) station hour
    hours = pd.Series([v[0] for v in vals])
    h = int(hours.mode().iloc[0])
    mean = float(np.mean([v for t, v in vals if t == h]))
    obs = dict(zip(state["obs"]["hours"], state["obs"]["values"]))
    obs[h] = round(mean, 2)
    cut = dt.datetime.now(dt.timezone.utc).timestamp() - OBS_WINDOW_D * 86400
    keep = sorted(k for k in obs if k >= cut)
    state["obs"] = {"hours": keep, "values": [obs[k] for k in keep],
                    "source": "WAQI (SIATA/AMVA network), AQI back-converted "
                              "US-EPA-2024, network mean, anchors excluded"}
    log(f"OBS: {len(vals)} stations -> network mean {mean:.1f} ug/m3 at "
        f"{dt.datetime.fromtimestamp(h, dt.timezone.utc)} ({len(keep)} h logged)")
    return True


# ── step 2: issue a forecast when a new GEOS-CF run is out ───────────────────
def cfapi_get(params):
    r = requests.get(CFAPI, params=params, timeout=600)
    r.raise_for_status()
    return r.json()


def fetch_drivers():
    """Mean of the two forecast cells; returns DataFrame indexed by UTC hour."""
    frames, init = [], None
    for lat, lon in CELLS:
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
    d = (frames[0] + frames[1]) / 2.0
    d.attrs["init"] = str(init)
    return d


def issue_forecast(pack, state):
    import lightgbm as lgb
    # probe the latest init cheaply via one chm call? full fetch is the probe.
    drv = fetch_drivers()
    init = drv.attrs["init"]
    if any(i.get("issued") == init for i in state["issuances"]):
        log(f"ISSUE: init {init} already issued — skip")
        return False
    booster = lgb.Booster(model_file=str(HERE / "model" / "anchor_gbm.txt"))
    d = drv.copy()
    d["c_prior_scaled"] = d.c_prior * pack["ratio"]
    d["wspd"] = np.hypot(d.u10, d.v10)
    idx = d.index
    d["sin_h"] = np.sin(2 * np.pi * idx.hour / 24)
    d["cos_h"] = np.cos(2 * np.pi * idx.hour / 24)
    doy = idx.dayofyear
    d["sin_doy"] = np.sin(2 * np.pi * doy / 365.25)
    d["cos_doy"] = np.cos(2 * np.pi * doy / 365.25)
    d["dow"] = idx.dayofweek
    X = d[pack["features"]].astype(float)
    tn = np.clip(d.c_prior_scaled.to_numpy() + booster.predict(X), 0, None)
    rec = {"issued": init,
           "hours": [int(t.value // 10**9) for t in idx],
           "fcst": [round(float(v), 2) for v in tn]}
    state["issuances"] = (state["issuances"] + [rec])[-MAX_ISSUANCES:]
    log(f"ISSUE: init {init}, {len(tn)} h, range {tn.min():.1f}-{tn.max():.1f} ug/m3")
    return True


# ── step 3: score matured forecasts ──────────────────────────────────────────
def score(state):
    obs = dict(zip(state["obs"]["hours"], state["obs"]["values"]))
    best = {}                                    # valid hour -> (lead_h, fcst)
    for iss in state["issuances"]:
        t0 = iss["hours"][0]
        for h, f in zip(iss["hours"], iss["fcst"]):
            lead = (h - t0) / 3600.0
            if lead < MIN_LEAD_H or h not in obs:
                continue
            cur = best.get(h)
            if cur is None or lead < cur[0]:     # newest usable issuance wins
                best[h] = (lead, f)
    rows = [(h, f, obs[h], obs.get(h - 86400))
            for h, (lead, f) in best.items() if obs.get(h - 86400) is not None]
    if not rows:
        state["scores"] = []
        state["summary"] = None
        return
    df = pd.DataFrame(rows, columns=["h", "f", "o", "p"])
    df["day"] = pd.to_datetime(df.h, unit="s", utc=True).dt.strftime("%Y-%m-%d")
    rmse = lambda a, b: float(np.sqrt(np.mean((a - b) ** 2)))
    daily = []
    for day, g in df.groupby("day"):
        if len(g) < 6:
            continue
        daily.append({"date": day, "n": int(len(g)),
                      "obs": round(float(g.o.mean()), 2),
                      "fcst": round(float(g.f.mean()), 2),
                      "rmse_f": round(rmse(g.f, g.o), 2),
                      "rmse_p": round(rmse(g.p, g.o), 2)})
    r_f, r_p = rmse(df.f, df.o), rmse(df.p, df.o)
    state["scores"] = daily[-45:]
    state["summary"] = {"n_hours": int(len(df)), "n_days": len(daily),
                        "rmse_f": round(r_f, 2), "rmse_p": round(r_p, 2),
                        "skill_vs_persistence": round(1 - r_f / r_p, 2) if r_p > 0 else None}
    log(f"SCORE: {len(df)} matured hours / {len(daily)} days, "
        f"RMSE fcst {r_f:.2f} vs persistence {r_p:.2f}")


def main():
    pack = json.loads((HERE / "model" / "pack.json").read_text(encoding="utf-8"))
    state = {"issuances": [], "obs": {"hours": [], "values": []},
             "scores": [], "summary": None}
    if LIVE_JSON.exists():
        state = json.loads(LIVE_JSON.read_text(encoding="utf-8"))

    ok_obs = ok_issue = False
    try:
        ok_obs = snapshot_obs(pack, state)
    except Exception as e:
        log(f"OBS step failed: {e!r}")
    try:
        ok_issue = issue_forecast(pack, state)
    except Exception as e:
        log(f"ISSUE step failed: {e!r}")
    score(state)
    state["updated"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    state["about"] = ("Self-checking live forecast: the frozen 2018-2024 anchor model "
                      "driven by GEOS-CF forecast fields (CFAPI), scored as live "
                      "observations land. Day-ahead = newest issuance >= 12 h old. "
                      "Live obs are AQI-back-converted (approximate); the 2023 "
                      "backtest used raw ug/m3 station data.")
    LIVE_JSON.parent.mkdir(parents=True, exist_ok=True)
    LIVE_JSON.write_text(json.dumps(state, separators=(",", ":")), encoding="utf-8")
    log(f"wrote {LIVE_JSON.name} ({LIVE_JSON.stat().st_size/1e3:.0f} kB) "
        f"obs={'ok' if ok_obs else 'skip/fail'} issue={'new' if ok_issue else 'none'}")


if __name__ == "__main__":
    main()
