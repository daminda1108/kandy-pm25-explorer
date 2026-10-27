// shell.js — the Valley explorer shell (redesign phase 2): drawer tabs. Independent of the engine; panels keep
// their ids and are only shown/hidden. After a switch a resize event lets app.js refit the charts of the panel
// that just became visible (hidden canvases have no width to draw into).
const rail = document.querySelector('.v-drawer');
if (rail) {
  const tabs = [...rail.querySelectorAll('.v-tab')];
  const panels = [...rail.querySelectorAll('.panel[data-tab]')];
  const show = (name) => {
    tabs.forEach((t) => { const on = t.dataset.tab === name; t.classList.toggle('on', on); t.setAttribute('aria-selected', on); });
    panels.forEach((p) => p.classList.toggle('tab-off', p.dataset.tab !== name));
    try { localStorage.setItem('kandy.tab', name); } catch { /* storage may be blocked */ }
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  };
  tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.tab)));
  let first = 'day';
  try { first = localStorage.getItem('kandy.tab') || 'day'; } catch { /* default */ }
  if (!tabs.some((t) => t.dataset.tab === first)) first = 'day';
  show(first);
  // a click on the map answers in the Point tab
  document.getElementById('mapstack')?.addEventListener('click', (e) => {
    if (e.target.closest('.zoom-ctl, .point-card')) return;
    if (!document.querySelector('main.view-insights')) setTimeout(() => show('point'), 0);
  });
}
