# Kandy Air — PM2.5 explorer (2019 → now)

A fully static web app showing fine-particle air pollution (PM2.5) over the Kandy valley, Sri Lanka, at 1 km and
hourly since 2019: the valley in 3-D with this hour's haze, the hour's answer on one card (valley average, 90 % range on
a WHO-anchored scale, regional background vs what the valley adds), detail in a drawer (Air mass · Where · Weather ·
Data) and time along the bottom (this day hour by hour, every day since 2019). Design "A / The Valley", 2026-10-29; the
previous design is kept as git tag `v2-valley-breathes`.

**No backend.** The production model is T-locked, `PM = B + max(T−B,0)·P + min(T−B,0) + ε(P−1)`, so the browser
rebuilds any hour exactly from a compact payload (month chunks loaded on demand; first visit ≈ 3 MB).

**Where in the valley.** The within-valley pattern is physics, not a measurement (Kandy has one regulatory station).
The *Where* tab therefore builds the family of patterns the evidence cannot tell apart (confinement strength
k = 0–0.45 × satellite surface or terrain only, every one with this hour's valley average) and colours only what they
all agree on. Town-to-town answers give a size from monitored valley cities (about 13 % for places 3–10 km apart),
never a direction.

## Run locally
```
python -m http.server 8099   # then open http://localhost:8099
```
Links: `#t=<UTC seconds>&tab=air|where|weather|data&p=<lat>,<lon>`.

## Regenerating the data payload
From the main ProjectCD repo (`kandy_pm25/`):
```
python scripts/webapp_export.py            # export + blocking QA gate (exact client-side reconstruction)
python scripts/webapp_export.py --qa-only  # re-verify an existing payload
python scripts/webapp_a_static.py          # daily.json (year ribbon) + pattern_parts.json (Where tab)
```
After any JS/CSS change, bump the `?v=` stamp on every first-party import.

## Structure
- `index.html`, `css/site.css`
- `js/store.js` — payload loading + exact field reconstruction (the engine; checked by the QA gate)
- `js/valley.js` — the 3-D basin (three.js 0.160, vendored under `js/vendor`, MIT)
- `js/where.js` — plausible-map envelope, verdicts, town-to-town answer
- `js/app.js` — card, drawer, time bar, links, downloads, 2-D fallback without WebGL
- `data/` — `meta.json`, `scalars_{year}.json`, `plocal_{year}_{MM}.bin.gz`, `static/`, `live.json`

## Credits & licence
Model & code: Kandy PM2.5 project (D. Alahakoon, U. Ranatunga, M. Dehideniya).
Data: Van Donkelaar/ACAG V6 · Central Environmental Authority Kandy AQMS · GHAP (Wei et al.) · ERA5/Copernicus ·
NASA GEOS-CF · GPM IMERG · WindNinja (USFS) · OpenStreetMap contributors (ODbL) · FECT PurpleAir ·
Senarathna et al. 2024. Research artefact — not a regulatory or health-advisory product.
