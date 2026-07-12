// cities.js — per-city configuration. Every module reads the active city's entry;
// nothing else in the app may hardcode a city. The two cities are SEPARATE PAGES
// (Kandy product at /, Medellín proving ground at /medellin/) sharing these modules;
// each page declares itself with window.CITY_ID before loading app.js.

export const CITIES = {
  kandy: {
    id: 'kandy',
    base: 'data',
    name: 'Kandy',
    title: 'Kandy PM<sub>2.5</sub> Explorer',
    docTitle: 'Kandy PM2.5 Explorer · 2019–2023',
    subtitle: 'Research reconstruction · annual level anchored to satellite data · '
      + 'street-scale pattern is physics-based and indicative',
    yearsLabel: '2019 – 2023',
    tzOffsetH: 5.5,
    tzHint: 'Sri Lanka time · hourly grid at :30',
    minuteLabel: '30',
    core: { lat: 7.2906, lon: 80.6337 },
    seasonCode: true,            // show DJF/MAM/JJA/SON monsoon-season codes
    features: { fect: true, health: true, showcase: false, weatherFull: true },
    obsLabel: 'Akurana sensor',
    defaultEpisode: 'dec2022',
    downloadPrefix: 'kandy_pm25',
    captionName: 'Kandy PM2.5',
    regime: null,
  },
  medellin: {
    id: 'medellin',
    base: '../data/medellin',      // page lives at /medellin/
    name: 'Medellín',
    title: 'Medellín PM<sub>2.5</sub> · proving ground',
    docTitle: 'Medellín PM2.5 · proving ground · 2019–2023',
    subtitle: 'The Kandy method run blind against a city that has monitors: '
      + 'fields built from 0–2 sensors, then scored against the withheld network',
    yearsLabel: '2019 – 2023',
    tzOffsetH: -5,
    tzHint: 'Colombia time · hourly grid at :00',
    minuteLabel: '00',
    core: { lat: 6.24434, lon: -75.57355 },
    seasonCode: false,           // equatorial: monsoon-season codes are meaningless
    features: { fect: false, health: false, showcase: true, weatherFull: false },
    // displayed t2m is lapse-adjusted from the basin-area mean to the valley floor
    // (validated vs SKMD airport: r 0.88, residual -1.5 C) — label it as such
    t2mLabel: 'Temperature (valley floor)',
    windCaveat: 'Wind animation shows the model’s diagnostic terrain flow; hourly '
      + 'agreement with valley-floor airport winds is weak (r≈0.2) — read it as '
      + 'illustrative. The PM2.5 field itself does not depend on it.',
    obsLabel: null,
    defaultTs: '2019-03-12 08:00',
    downloadPrefix: 'medellin_pm25',
    captionName: 'Medellín PM2.5 (proving ground)',
    regime: 'Honest framing: Medellín is local-emission-dominated (f≈0.6–0.85); '
      + 'Kandy is regional-episodic (f≈0.25). This proving ground demonstrates the '
      + 'machinery, the spatial skill and the value of monitoring data — not that '
      + 'Kandy’s transboundary episodes are equally predictable.',
  },
};

export function activeCity() {
  const id = (window.CITY_ID && CITIES[window.CITY_ID]) ? window.CITY_ID : 'kandy';
  return CITIES[id];
}
