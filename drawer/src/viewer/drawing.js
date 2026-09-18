// Per-page freehand drawing layer.
//
// Strokes are stored with NORMALIZED coordinates (x,y in [0,1] relative to the
// page's CSS size). That makes them resolution-independent: they survive zoom,
// re-render and different devicePixelRatios, and can be re-painted at any size
// for export. Each point also carries `pw`, a pressure-derived width factor.
//
// Eraser uses whole-stroke deletion (hit-test → remove), which is simple and
// trivially undoable. Completed user actions are reported via `onAction` so the
// orchestrator (viewer.js) can keep a global undo/redo history and autosave.

let strokeSeq = 0;
function nextStrokeId() {
  return ++strokeSeq;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Paint a list of strokes onto a 2D context.
 * Shared by the on-screen layer and the PDF/PNG exporter so rendering never
 * diverges between preview and output.
 * @param widthScale multiply stroke widths (1 when ctx is already DPR-scaled).
 */
export function paintStrokes(ctx, strokes, targetW, targetH, widthScale = 1) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of strokes) {
    const pts = s.points;
    if (!pts.length) continue;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    if (pts.length === 1) {
      const p = pts[0];
      ctx.beginPath();
      ctx.arc(p.x * targetW, p.y * targetH, (s.width * widthScale) / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      ctx.lineWidth = s.width * widthScale * (b.pw || 1);
      ctx.beginPath();
      ctx.moveTo(a.x * targetW, a.y * targetH);
      ctx.lineTo(b.x * targetW, b.y * targetH);
      ctx.stroke();
    }
  }
}

export class DrawingLayer {
  /**
   * @param {object} o
   * @param {HTMLElement} o.container  the .page element
   * @param {number} o.pageIndex
   * @param {{tool:string,color:string,width:number}} o.toolState shared tool state
   * @param {(action:object)=>void} o.onAction called when a draw/erase completes
   */
  constructor({ container, pageIndex, toolState, onAction }) {
    this.pageIndex = pageIndex;
    this.toolState = toolState;
    this.onAction = onAction;
    this.strokes = [];
    this.cssW = 0;
    this.cssH = 0;
    this.dpr = 1;

    this.canvas = document.createElement("canvas");
    this.canvas.className = "draw-canvas";
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");

    // live input state
    this._active = false;
    this._mode = null; // 'pen' | 'eraser'
    this._current = null;
    this._erased = null;
    this._rect = null;
    this._last = null;

    this.canvas.addEventListener("pointerdown", this._onDown);
    this.canvas.addEventListener("pointermove", this._onMove);
    this.canvas.addEventListener("pointerup", this._onUp);
    this.canvas.addEventListener("pointercancel", this._onUp);
  }

  resize(cssW, cssH, dpr) {
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    this.canvas.width = Math.floor(cssW * dpr);
    this.canvas.height = Math.floor(cssH * dpr);
    this.canvas.style.width = cssW + "px";
    this.canvas.style.height = cssH + "px";
    this.redraw();
  }

  setStrokes(strokes) {
    this.strokes = Array.isArray(strokes) ? strokes : [];
    for (const s of this.strokes) {
      if (s.id == null) s.id = nextStrokeId();
      else if (s.id > strokeSeq) strokeSeq = s.id;
    }
    this.redraw();
  }

  getStrokes() {
    return this.strokes;
  }

  /** Remove the canvas + listeners (used when a page scrolls far off-screen). */
  destroy() {
    this.canvas.removeEventListener("pointerdown", this._onDown);
    this.canvas.removeEventListener("pointermove", this._onMove);
    this.canvas.removeEventListener("pointerup", this._onUp);
    this.canvas.removeEventListener("pointercancel", this._onUp);
    this.canvas.remove();
  }

  redraw() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); // draw in CSS-pixel space
    paintStrokes(ctx, this.strokes, this.cssW, this.cssH, 1);
  }

  // ---- undo/redo hooks driven by viewer.js ----
  applyAction(action) {
    if (action.type === "add") this.strokes.push(action.stroke);
    else if (action.type === "remove") {
      const ids = new Set(action.strokes.map((s) => s.id));
      this.strokes = this.strokes.filter((s) => !ids.has(s.id));
    }
    this.redraw();
  }

  revertAction(action) {
    if (action.type === "add") {
      this.strokes = this.strokes.filter((s) => s.id !== action.stroke.id);
    } else if (action.type === "remove") {
      this.strokes.push(...action.strokes);
    }
    this.redraw();
  }

  /** Clear this page; returns a 'remove' action (or null if nothing to clear). */
  clear() {
    if (!this.strokes.length) return null;
    const removed = this.strokes.slice();
    this.strokes = [];
    this.redraw();
    return { type: "remove", pageIndex: this.pageIndex, strokes: removed };
  }

  // ---- pointer input ----
  _point(e) {
    const x = (e.clientX - this._rect.left) / this.cssW;
    const y = (e.clientY - this._rect.top) / this.cssH;
    let pw = 1;
    if (e.pointerType === "pen" && e.pressure > 0) pw = 0.4 + e.pressure * 0.9;
    return { x, y, pw };
  }

  _onDown = (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return; // primary only
    this.canvas.setPointerCapture(e.pointerId);
    this._rect = this.canvas.getBoundingClientRect();
    this._active = true;
    this._mode = this.toolState.tool === "eraser" ? "eraser" : "pen";

    if (this._mode === "pen") {
      const p = this._point(e);
      this._current = {
        id: nextStrokeId(),
        tool: "pen",
        color: this.toolState.color,
        width: this.toolState.width,
        points: [p],
      };
      this._last = p;
      this._paintDot(p, this._current);
    } else {
      this._erased = [];
      this._eraseAt(this._point(e));
    }
  };

  _onMove = (e) => {
    if (!this._active) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) {
      const p = this._point(ev);
      if (this._mode === "pen") this._extend(p);
      else this._eraseAt(p);
    }
  };

  _onUp = (e) => {
    if (!this._active) return;
    this._active = false;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch (_) {}

    if (this._mode === "pen" && this._current) {
      this.strokes.push(this._current);
      this.onAction({ type: "add", pageIndex: this.pageIndex, stroke: this._current });
      this._current = null;
      this._last = null;
    } else if (this._mode === "eraser" && this._erased && this._erased.length) {
      this.onAction({ type: "remove", pageIndex: this.pageIndex, strokes: this._erased });
      this._erased = null;
    }
  };

  _extend(p) {
    const last = this._last;
    // drop points that are too close (CSS px) to keep strokes light & smooth
    if (last) {
      const dx = (p.x - last.x) * this.cssW;
      const dy = (p.y - last.y) * this.cssH;
      if (dx * dx + dy * dy < 1.2 * 1.2) return;
    }
    this._current.points.push(p);
    // incremental live segment (avoid full redraw per move)
    const ctx = this.ctx;
    ctx.strokeStyle = this._current.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = this._current.width * (p.pw || 1);
    ctx.beginPath();
    ctx.moveTo(last.x * this.cssW, last.y * this.cssH);
    ctx.lineTo(p.x * this.cssW, p.y * this.cssH);
    ctx.stroke();
    this._last = p;
  }

  _paintDot(p, stroke) {
    const ctx = this.ctx;
    ctx.fillStyle = stroke.color;
    ctx.beginPath();
    ctx.arc(p.x * this.cssW, p.y * this.cssH, stroke.width / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  _eraseAt(pt) {
    const ex = pt.x * this.cssW;
    const ey = pt.y * this.cssH;
    const radius = this.toolState.width / 2 + 6; // CSS px
    let hit = false;
    this.strokes = this.strokes.filter((s) => {
      if (this._strokeHit(s, ex, ey, radius)) {
        if (!this._erased.some((r) => r.id === s.id)) this._erased.push(s);
        hit = true;
        return false;
      }
      return true;
    });
    if (hit) this.redraw();
  }

  _strokeHit(stroke, ex, ey, radius) {
    const pts = stroke.points;
    const thr = radius + stroke.width / 2;
    if (pts.length === 1) {
      return Math.hypot(pts[0].x * this.cssW - ex, pts[0].y * this.cssH - ey) <= thr;
    }
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1].x * this.cssW;
      const ay = pts[i - 1].y * this.cssH;
      const bx = pts[i].x * this.cssW;
      const by = pts[i].y * this.cssH;
      if (distToSegment(ex, ey, ax, ay, bx, by) <= thr) return true;
    }
    return false;
  }
}
