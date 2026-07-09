// mapview.js — zoom/pan for the canvas map stack + lat/lon<->screen mapping.
//
// All four layers (hillshade, field, wind, vectors) live inside an inner wrapper
// (#mappan) that receives a single CSS transform (translate + scale, origin 0 0).
// Zooming/panning the wrapper moves every layer together and keeps the running
// wind animation registered — no per-layer re-projection needed. The outer
// element (#mapstack) is the fixed, untransformed viewport we measure against.

import { clamp } from './util.js?v=1783633970';

export class MapView {
  constructor(outer, inner, bbox, onChange) {
    this.outer = outer;            // #mapstack (fixed viewport, overflow hidden)
    this.inner = inner;            // #mappan  (transformed)
    this.bbox = bbox;              // [lon0, lat0, lon1, lat1]
    this.onChange = onChange || (() => {});
    this.s = 1; this.tx = 0; this.ty = 0;
    this.minS = 1; this.maxS = 6;
    this._drag = null;
    inner.style.transformOrigin = '0 0';

    // Wheel zoom intentionally NOT bound (user 2026-07-10: hijacks page scroll).
    // Zoom is via the on-map +/- buttons and touch pinch only.
    outer.addEventListener('pointerdown', (e) => this._down(e));
    window.addEventListener('pointermove', (e) => this._move(e));
    window.addEventListener('pointerup', (e) => this._up(e));
    // pinch (two-pointer) support
    this._pts = new Map();
  }

  _apply() {
    this.inner.style.transform = `translate(${this.tx}px,${this.ty}px) scale(${this.s})`;
    this.onChange();
  }

  reset() { this.s = 1; this.tx = 0; this.ty = 0; this._apply(); }

  zoomBy(factor, cx, cy) {
    const r = this.outer.getBoundingClientRect();
    // anchor point in outer-local coords (default: centre)
    const lx = (cx ?? r.left + r.width / 2) - r.left;
    const ly = (cy ?? r.top + r.height / 2) - r.top;
    const ns = clamp(this.s * factor, this.minS, this.maxS);
    // keep the stack point under (lx,ly) fixed: stack = (l - t)/s = (l - t')/ns
    this.tx = lx - ((lx - this.tx) / this.s) * ns;
    this.ty = ly - ((ly - this.ty) / this.s) * ns;
    this.s = ns;
    this._clamp(r);
    this._apply();
  }

  _clamp(r) {
    const W = r.width, H = r.height;
    // content must cover the viewport: t in [W(1-s), 0]
    this.tx = clamp(this.tx, W * (1 - this.s), 0);
    this.ty = clamp(this.ty, H * (1 - this.s), 0);
  }

  _wheel(e) {
    e.preventDefault();
    this.zoomBy(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX, e.clientY);
  }

  _down(e) {
    if (!this.outer.contains(e.target)) return;
    if (e.target.closest('.zoom-ctl, .point-card')) return;   // don't drag on controls
    this._pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._pts.size === 1) {
      this._drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty, moved: 0 };
    }
  }

  _move(e) {
    if (this._pts.has(e.pointerId)) this._pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._pts.size === 2) { this._pinch(); return; }
    if (!this._drag || this.s <= 1.001) return;
    const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
    this._drag.moved += Math.abs(dx) + Math.abs(dy);
    this.tx = this._drag.tx + dx; this.ty = this._drag.ty + dy;
    this._clamp(this.outer.getBoundingClientRect());
    this._apply();
  }

  _pinch() {
    const [a, b] = [...this._pts.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    if (this._lastPinch) this.zoomBy(dist / this._lastPinch, cx, cy);
    this._lastPinch = dist;
  }

  _up(e) {
    this._pts.delete(e.pointerId);
    if (this._pts.size < 2) this._lastPinch = null;
    if (this._pts.size === 0) {
      // treat as a click only if the pointer barely moved
      const wasClick = this._drag && this._drag.moved < 6;
      this._drag = null;
      if (wasClick && this._onClick) this._onClick(e);
    }
  }

  onClick(fn) { this._onClick = fn; }

  // screen (clientX,clientY) -> [lon, lat], accounting for the transform
  screenToLatLon(cx, cy) {
    const r = this.outer.getBoundingClientRect();
    const lx = cx - r.left, ly = cy - r.top;
    const sx = (lx - this.tx) / this.s, sy = (ly - this.ty) / this.s;   // stack-local px
    const [x0, y0, x1, y1] = this.bbox;
    return [x0 + (sx / r.width) * (x1 - x0), y0 + (1 - sy / r.height) * (y1 - y0)];
  }

  // [lon,lat] -> screen {x,y} (client coords), for anchoring the point card
  latLonToScreen(lon, lat) {
    const r = this.outer.getBoundingClientRect();
    const [x0, y0, x1, y1] = this.bbox;
    const sx = ((lon - x0) / (x1 - x0)) * r.width;
    const sy = (1 - (lat - y0) / (y1 - y0)) * r.height;
    return { x: r.left + sx * this.s + this.tx, y: r.top + sy * this.s + this.ty,
             inside: sx >= 0 && sx <= r.width && sy >= 0 && sy <= r.height };
  }
}
