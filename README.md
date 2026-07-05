# Kandy PM2.5 Explorer (2019–2023)

An interactive, fully static web app that reconstructs the 1 km, hourly PM2.5 field over the
Kandy valley (Sri Lanka) for **2019–2023** — heatmap, animated terrain wind, uncertainty,
regional/local decomposition, exposure & health, documented haze episodes, and point queries.

**No backend.** The additive production model is *T-locked*
(`PM = B + [T−B]·P_local`), so the browser reconstructs any hour exactly from a compact
payload (~29 MB total, month chunks lazy-loaded). See [`method.html`](method.html) for the
integrity framing — anchored level, validated temporal structure, scenario-grade fine spatial
pattern. Coverage ends in 2023 with the satellite level anchor (by design; not extrapolated).

## Run locally
```
python -m http.server 8099   # then open http://localhost:8099
```

## Regenerating the data payload
The `data/` directory is produced from the locked `additive_v2` production model by
`kandy_pm25/scripts/webapp_export.py` (in the main ProjectCD repo). It ships a blocking QA gate
that verifies exact client-side reconstruction (< 0.0015 µg/m³) and wind-blend parity
(< 0.001 m/s) against the source parquets:
```
python scripts/webapp_export.py            # export + QA
python scripts/webapp_export.py --qa-only  # re-verify an existing payload
```

## Structure
- `index.html` / `method.html` — app + method page
- `css/style.css` — dark theme
- `js/` — ES modules: `store` (load + reconstruct), `field`, `wind`, `overlay`, `timeline`,
  `panels`, `download`, `app`
- `data/` — payload: `meta.json`, `scalars_{year}.json`, `plocal_{year}_{MM}.bin.gz`,
  `wind_library.bin.gz`, `static/`, `health.json`, `fect_{year}.json`

## Credits & licence
Model & code: Kandy PM2.5 project (D. Alahakoon, U. Ranathunge, M. Dehideniya).
Data: Van Donkelaar/ACAG V6 · GHAP (Wei et al.) · ERA5/Copernicus · NASA GEOS-CF ·
WindNinja (USFS) · OpenStreetMap contributors (ODbL) · FECT PurpleAir · Senarathna et al. 2024.
Research artefact — not a regulatory or health-advisory product.
