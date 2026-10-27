// story3d.js — the scroll-driven story (redesign phase 3). A sticky 3-D valley sits behind the existing story text;
// each step sets the camera and what the scene shows. Every frame is a real engine field (store.field), so the
// story never shows a number the explorer would not. Honest-spatial rules hold: the haze is the model value only.
import { Valley3D, webglOK } from './valley3d.js?v=1793121195';

const LT_OFFSET = 5.5 * 3600;
const HAZE_DAY = '2022-12-07';
const BEATS = {
  hero: { cam: 'overview', play: HAZE_DAY },
  1: { cam: 'close', frames: [{ at: `${HAZE_DAY} 07:30`, cap: 'The morning peak · 7 Dec 2022, 07:30' }] },
  2: { cam: 'high', rotate: true, frames: [{ at: `${HAZE_DAY} 07:30`, cap: 'The same hour, from above' }] },
  3: { cam: 'overview', frames: [
    { at: `${HAZE_DAY} 07:30`, mode: 'background', cap: 'Arrived from outside: the regional background alone' },
    { at: `${HAZE_DAY} 07:30`, cap: 'Plus what the valley makes: the local increment on top' }] },
  4: { cam: 'overview', frames: [
    { at: '2023-07-12 13:30', cap: 'A south-west monsoon afternoon, July 2023' },
    { at: `${HAZE_DAY} 07:30`, cap: 'A haze morning, December 2022' }] },
  5: { cam: 'north', frames: [
    { at: `${HAZE_DAY} 18:30`, mode: 'flat', cap: 'Pattern off: only the anchored valley level' },
    { at: `${HAZE_DAY} 18:30`, cap: 'Pattern on: the assumed within-valley shape, a few per cent' }] },
};

export async function initStory(store, terrain) {
  const story = document.getElementById('story'), host = document.getElementById('story-scene');
  if (!story || !host || !webglOK()) return null;
  story.classList.add('has-3d');
  const v = new Valley3D(host, { terrain, meta: store.meta, interactive: false });
  const cap = document.getElementById('story-caption');
  const grid = store.meta.grid;

  async function fieldAt(localStr) {
    const [d, t] = localStr.split(' '), y = +d.slice(0, 4);
    const s = await store.getScalars(y), want = Date.parse(`${d}T${t}:00Z`) / 1000 - LT_OFFSET;
    let gi = 0, bd = Infinity;
    for (let i = 0; i < s.hours_utc.length; i++) { const x = Math.abs(s.hours_utc[i] - want); if (x < bd) { bd = x; gi = i; } }
    return store.field(y, gi);
  }
  function show(f, mode, text) {
    let q = f.q50, avg = f.basin;
    if (mode === 'background') { q = new Float32Array(q.length).fill(f.B); avg = f.B; }
    if (mode === 'flat') q = new Float32Array(q.length).fill(f.basin);
    v.setField(q, grid);
    if (cap) cap.innerHTML = `<span>${text}</span><b class="num">${avg.toFixed(1)}<small> µg/m³ valley average</small></b>`;
  }

  let timer = null, token = 0;
  async function beat(key) {
    const b = BEATS[key]; if (!b) return;
    const my = ++token; clearInterval(timer); timer = null;
    v.setCamera(b.cam, true); v.autoRotate(!!b.rotate, 0.35);
    if (b.play) {                                   // play the haze day hour by hour
      const hours = [];
      for (let h = 0; h < 24; h++) hours.push(`${b.play} ${String(h).padStart(2, '0')}:30`);
      const fs = await Promise.all(hours.map(fieldAt));
      if (my !== token) return;
      let i = 6;
      const step = () => { show(fs[i], null, `7 December 2022 · ${hours[i].slice(11)}`); i = (i + 1) % fs.length; };
      step(); timer = setInterval(step, 1400);
      return;
    }
    const fs = await Promise.all(b.frames.map((fr) => fieldAt(fr.at)));
    if (my !== token) return;
    let i = 0;
    const step = () => { const fr = b.frames[i]; show(fs[i], fr.mode, fr.cap); i = (i + 1) % fs.length; };
    step();
    if (b.frames.length > 1) timer = setInterval(step, 2600);
  }

  const steps = [...story.querySelectorAll('.story-hero, .story-step')];
  const io = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) beat(e.target.dataset.step || 'hero');
  }, { rootMargin: '-45% 0px -45% 0px' });
  steps.forEach((s) => io.observe(s));
  beat('hero');
  return {
    pause() { clearInterval(timer); timer = null; v.pause(); },
    resume() { v.resume(); beat('hero'); },
  };
}
