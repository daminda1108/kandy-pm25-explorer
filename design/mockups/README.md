# Redesign mock-ups — direction A "The Valley" (phase 0, 2026-10-27)

Static design mock-ups, not the live site. Plan: `D:/ProjectCD/kandy_pm25/docs/webapp_redesign_plan_2026-10-27.md`.

| file | what |
|---|---|
| `hero.html` | landing: full-bleed 3-D valley, haze day plays through 24 h, editorial headline |
| `explorer.html` | desktop explorer: scene full-bleed, this-hour card (interval as a band on the WHO scale, background/local split), right drawer (Air mass tab), bottom time bar (day ribbon + play, 2019–2026 year ribbon, extension marked) |
| `phone.html` (+ `phone_frame.html`) | 390 × 844 layout: reading on top, bottom sheet with scrubber and tabs |
| `valley.js` | shared three.js scene: real 100 m terrain (×2.4 relief), model q50 field draped as haze that pools in low ground; WHO-anchored colour scale |
| `tokens.css` | type (Fraunces + Inter), warm-ink palette, PM scale stops at WHO values |
| `assets/` | real data from `kandy_pm25/scripts/webapp_mockup_assets.py` (terrain, 7 Dec 2022 hours, years) |
| `screens/` | rendered PNGs (1440 × 900 desktop, 390 × 844 phone) |

Run: `python -m http.server 8099 --directory D:/ProjectCD/kandy_webapp`, open `/design/mockups/hero.html`.
Placeholders (not wired): tabs other than Air mass, play button, nav links. The drawer prose is illustrative copy.
