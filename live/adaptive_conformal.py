"""adaptive_conformal.py — per-lead, online-updating interval widening for the Kandy
forecast tier (2026-08-06).

WHAT THIS REPLACES
------------------
The shipped forecast widens every interval by a single static factor k = 1.35, derived
once from the sensorless anchor's measured 70.7% coverage
(`scripts/kandy_forecast_ood_widening.py`). That factor is defensible but it is wrong in
two ways that matter:

  1. it is the SAME at +1 h and +120 h, although forecast error grows with lead;
  2. it never updates, so a drift in the driver stream cannot be detected or absorbed.

This module implements Adaptive Conformal Inference (Gibbs & Candes 2021; the ACI family,
with the online-quantile form of Zaffran et al. 2022) in the per-lead-bucket form: one
adapted factor per lead bucket, updated every run from what actually verified.

WHAT IT VERIFIES AGAINST, AND THE LIMIT OF THAT
-----------------------------------------------
Kandy has no live observation stream, which is the whole premise of the project, so
there is nothing to score a forecast against in the usual sense. What DOES exist is the
runner's own NOWCAST tier: the rolling analysis window, driven by analysed rather than
forecast meteorology, for hours that have since occurred. Scoring forecast(lead L, valid
t) against the analysis at the same valid t measures the **driver-shift** component of
forecast error -- the part that grows with lead and the part a static k cannot see.

It does NOT measure the anchor's error against reality; that is bounded separately by the
sensorless coverage figure, and the static k remains the FLOOR here for exactly that
reason. So the adapted factor can widen beyond 1.35 but never below it. This is stated in
the payload so the interval's provenance is never ambiguous.

CONTRACT
--------
`update(state, records)` folds newly verifiable pairs into the state and returns the
per-bucket factors; `factor(state, lead_h)` returns the factor to apply. State is a plain
dict, JSON-round-trippable, stored beside the payload.
"""
from __future__ import annotations

import bisect
from typing import Iterable

# lead buckets in hours: [lo, hi)
BUCKETS = [(0, 6), (6, 12), (12, 24), (24, 48), (48, 72), (72, 96), (96, 121)]
ALPHA = 0.10                 # nominal 90% interval
GAMMA = 0.02                 # ACI learning rate
WINDOW = 600                 # scores retained per bucket
K_FLOOR = 1.35               # the measured OOD factor; never go below it
K_CEIL = 4.0                 # refuse to widen without limit; flag instead
MIN_N = 30                   # below this, stay on the floor


def bucket_of(lead_h: float) -> str:
    for lo, hi in BUCKETS:
        if lo <= lead_h < hi:
            return f"{lo}-{hi}"
    return f"{BUCKETS[-1][0]}-{BUCKETS[-1][1]}"


def new_state() -> dict:
    return {"version": 1, "alpha": {}, "scores": {}, "n_seen": 0,
            "k_floor": K_FLOOR, "note": (
                "Per-lead adaptive conformal factors. Verified against the runner's own "
                "analysis (nowcast) tier, which measures driver shift, NOT against "
                "observations -- Kandy has none. The static measured factor is a floor.")}


def _quantile(sorted_vals: list, q: float) -> float:
    if not sorted_vals:
        return K_FLOOR
    i = min(len(sorted_vals) - 1, max(0, int(round(q * (len(sorted_vals) - 1)))))
    return float(sorted_vals[i])


def update(state: dict, pairs: Iterable[tuple]) -> dict:
    """Fold in (lead_h, median, lo_raw, hi_raw, verifying_value) tuples.

    lo_raw/hi_raw are the UNWIDENED quantile heads, so the score is expressed in units
    of the raw half-width and the resulting factor is directly the multiplier to apply.
    """
    state = dict(state or new_state())
    state.setdefault("alpha", {}); state.setdefault("scores", {})
    n_new = 0
    for lead_h, med, lo_raw, hi_raw, obs in pairs:
        if obs is None or med is None:
            continue
        half = (hi_raw - lo_raw) / 2.0
        if not (half > 1e-6):
            continue
        b = bucket_of(lead_h)
        # nonconformity in units of the raw half-width: the factor that WOULD have been
        # needed for this hour to fall inside the interval
        score = abs(float(obs) - float(med)) / half
        arr = state["scores"].setdefault(b, [])
        bisect.insort(arr, round(float(score), 4))
        if len(arr) > WINDOW:
            arr.pop(0 if score > arr[0] else -1)
        # ACI step on the effective level for this bucket
        a = float(state["alpha"].get(b, ALPHA))
        covered = 1.0 if score <= _quantile(arr, 1 - a) else 0.0
        state["alpha"][b] = float(min(0.5, max(0.005, a + GAMMA * (ALPHA - (1 - covered)))))
        n_new += 1
    state["n_seen"] = int(state.get("n_seen", 0)) + n_new
    state["factors"] = {b: _factor_for(state, b) for b in state["scores"]}
    return state


def _factor_for(state: dict, b: str) -> float:
    arr = state["scores"].get(b, [])
    if len(arr) < MIN_N:
        return K_FLOOR
    a = float(state["alpha"].get(b, ALPHA))
    k = _quantile(arr, 1.0 - a)
    return float(min(K_CEIL, max(K_FLOOR, k)))


def factor(state: dict, lead_h: float) -> float:
    """The widening factor to apply at this lead. Never below the measured floor."""
    if not state:
        return K_FLOOR
    return float((state.get("factors") or {}).get(bucket_of(lead_h), K_FLOOR))


def summary(state: dict) -> dict:
    """Compact, payload-safe description for the evidence panel."""
    if not state or not state.get("scores"):
        return {"status": "warming up", "k_static": K_FLOOR, "n": 0}
    return {"status": "adaptive",
            "k_static": K_FLOOR,
            "n": int(state.get("n_seen", 0)),
            "by_lead": {b: {"k": round(_factor_for(state, b), 3),
                            "n": len(state["scores"].get(b, []))}
                        for b in sorted(state["scores"])},
            "verified_against": "analysis (nowcast) tier, not observations",
            "floor_note": ("the measured out-of-distribution factor 1.35 is a floor; "
                           "adaptation can widen but never narrow below it")}
