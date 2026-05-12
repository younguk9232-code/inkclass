// Smooth ink canvas using Pointer Events with pressure & quadratic smoothing.
// Renders normalized strokes (0..1 coords) so it scales with the slide frame.
//
// Stroke: { tool: "pen"|"highlight"|"eraser", color, size, points: [{x,y,p}], ts }

export class InkCanvas {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.dpr = window.devicePixelRatio || 1;
    this.tool = "pen";
    this.color = "#1a1a1a";
    this.size = 2;
    this.strokes = [];           // committed
    this.current = null;         // in-progress
    this.readOnly = !!opts.readOnly;
    this.onCommit = opts.onCommit || (() => {});
    this.onLive = opts.onLive || (() => {});
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas);

    this._bind();
    this.resize();
  }
  setStrokes(arr) { this.strokes = arr ? arr.slice() : []; this.redraw(); }
  appendStroke(s) { this.strokes.push(s); this.redraw(); }
  setTool(t) { this.tool = t; }
  setColor(c) { this.color = c; }
  setSize(s) { this.size = s; }
  setReadOnly(v) { this.readOnly = v; }

  resize() {
    const { canvas } = this;
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, r.width * this.dpr);
    canvas.height = Math.max(1, r.height * this.dpr);
    this.redraw();
  }

  _toNorm(ev) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - r.left) / r.width,
      y: (ev.clientY - r.top) / r.height,
      p: ev.pressure && ev.pressure > 0 ? ev.pressure : 0.5,
    };
  }

  _bind() {
    const c = this.canvas;
    let pid = null;
    c.addEventListener("pointerdown", (e) => {
      if (this.readOnly) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      pid = e.pointerId;
      c.setPointerCapture(pid);
      const pt = this._toNorm(e);
      this.current = {
        tool: this.tool,
        color: this.color,
        size: this.size,
        points: [pt],
        ts: Date.now(),
      };
      this._drawIncremental();
      e.preventDefault();
    });
    c.addEventListener("pointermove", (e) => {
      if (!this.current || e.pointerId !== pid) return;
      const pt = this._toNorm(e);
      const last = this.current.points[this.current.points.length - 1];
      // skip if too close
      const dx = pt.x - last.x, dy = pt.y - last.y;
      if ((dx*dx + dy*dy) < 0.0000004) return;
      this.current.points.push(pt);
      this._drawIncremental();
    });
    const finish = (e) => {
      if (!this.current || e.pointerId !== pid) return;
      const s = this.current;
      this.current = null;
      pid = null;
      if (s.points.length >= 2 || s.tool === "eraser") {
        if (s.tool === "eraser") {
          // erase intersecting committed strokes
          const before = this.strokes.length;
          this.strokes = this.strokes.filter(stk => !this._intersects(stk, s));
          if (this.strokes.length !== before) {
            // emit a special "replace" via onCommit by sending negation? simplest: emit a "set" message
            this.onCommit({ type: "erase", removeIntersecting: s.points });
          }
        } else {
          this.strokes.push(s);
          this.onCommit({ type: "add", stroke: s });
        }
      }
      this.redraw();
    };
    c.addEventListener("pointerup", finish);
    c.addEventListener("pointercancel", finish);
    c.addEventListener("pointerleave", finish);
  }

  _intersects(stroke, eraser) {
    const r = (eraser.size || 12) / 1000 + 0.012;
    for (const ep of eraser.points) {
      for (const p of stroke.points) {
        const dx = p.x - ep.x, dy = p.y - ep.y;
        if (dx*dx + dy*dy < r*r) return true;
      }
    }
    return false;
  }

  _drawIncremental() {
    // re-render simply (cheap enough at this scale)
    this.redraw();
    if (this.current) {
      this._renderStroke(this.current);
      // live broadcast (lightly throttled)
      const now = performance.now();
      if (!this._lastLive || now - this._lastLive > 60) {
        this._lastLive = now;
        this.onLive({ type: "live", stroke: this.current });
      }
    }
  }

  redraw() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of this.strokes) this._renderStroke(s);
  }

  _renderStroke(s) {
    const { ctx, canvas } = this;
    if (!s.points || s.points.length === 0) return;
    ctx.save();
    if (s.tool === "highlight") {
      ctx.globalAlpha = 0.32;
      ctx.lineCap = "butt";
    } else {
      ctx.globalAlpha = 1;
      ctx.lineCap = "round";
    }
    ctx.lineJoin = "round";
    ctx.strokeStyle = s.color || "#1a1a1a";
    const baseW = (s.size || 2) * this.dpr;
    ctx.lineWidth = baseW;
    if (s.points.length === 1) {
      const p = s.points[0];
      ctx.beginPath();
      ctx.arc(p.x * canvas.width, p.y * canvas.height, baseW / 2, 0, Math.PI * 2);
      ctx.fillStyle = s.color || "#1a1a1a";
      ctx.fill();
      ctx.restore();
      return;
    }
    // smooth quadratic
    ctx.beginPath();
    const pts = s.points;
    ctx.moveTo(pts[0].x * canvas.width, pts[0].y * canvas.height);
    for (let i = 1; i < pts.length - 1; i++) {
      const cx = pts[i].x * canvas.width;
      const cy = pts[i].y * canvas.height;
      const nx = (pts[i].x + pts[i+1].x) / 2 * canvas.width;
      const ny = (pts[i].y + pts[i+1].y) / 2 * canvas.height;
      // pressure-modulated width
      const w = baseW * (0.6 + 0.8 * (pts[i].p || 0.5));
      ctx.lineWidth = w;
      ctx.quadraticCurveTo(cx, cy, nx, ny);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x * canvas.width, last.y * canvas.height);
    ctx.stroke();
    ctx.restore();
  }
}
