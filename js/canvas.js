// Smooth ink canvas (Goodnotes-style)
//
// 핵심 설계:
// 1) Committed strokes 는 별도의 offscreen 캔버스에 캐시. 매 pointermove마다
//    재렌더하지 않는다 → 100개+ 스트로크가 있어도 끊김 없음.
// 2) Pointermove 는 rAF(60Hz)로 throttle. 60Hz tablet에서 부드럽게 작동.
// 3) Catmull-Rom 으로 부드러운 곡선 + 압력에 비례하는 가변 굵기.
// 4) setStrokes() 가 in-progress current stroke 를 보존 → 외부 동기화로
//    그리던 글씨가 사라지지 않음.

export class InkCanvas {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
    this.dpr = window.devicePixelRatio || 1;
    this.tool = "pen";
    this.color = "#1a1a1a";
    this.size = 2;
    this.strokes = [];           // committed
    this.current = null;         // in-progress
    this.readOnly = !!opts.readOnly;
    this.onCommit = opts.onCommit || (() => {});
    this.onLive = opts.onLive || (() => {});

    // committed 스트로크 캐시 (offscreen)
    this.cache = document.createElement("canvas");
    this.cacheCtx = this.cache.getContext("2d");
    this.cacheValid = false;

    this._raf = 0;

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas);

    this._bind();
    this.resize();
  }

  setStrokes(arr) {
    this.strokes = arr ? arr.slice() : [];
    this.cacheValid = false;
    this._scheduleDraw();
  }
  appendStroke(s) {
    this.strokes.push(s);
    this._appendToCache(s);
    this._scheduleDraw();
  }
  setTool(t) { this.tool = t; }
  setColor(c) { this.color = c; }
  setSize(s) { this.size = s; }
  setReadOnly(v) { this.readOnly = v; }

  resize() {
    const { canvas } = this;
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * this.dpr));
    const h = Math.max(1, Math.round(r.height * this.dpr));
    canvas.width = w; canvas.height = h;
    this.cache.width = w; this.cache.height = h;
    this.cacheValid = false;
    this._scheduleDraw();
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
    // Pointer 이벤트 외에 touch-action: none 처리 (스크롤 차단)
    c.style.touchAction = "none";

    c.addEventListener("pointerdown", (e) => {
      if (this.readOnly) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      pid = e.pointerId;
      try { c.setPointerCapture(pid); } catch (_) {}
      const pt = this._toNorm(e);
      this.current = {
        tool: this.tool,
        color: this.color,
        size: this.size,
        points: [pt],
        ts: Date.now(),
      };
      this._scheduleDraw();
      e.preventDefault();
    }, { passive: false });

    c.addEventListener("pointermove", (e) => {
      if (!this.current || e.pointerId !== pid) return;
      // coalesce: 일부 브라우저는 누락된 중간 이벤트를 모아줌 → 부드러운 선
      const events = (typeof e.getCoalescedEvents === "function") ? e.getCoalescedEvents() : [e];
      for (const ev of events) {
        const pt = this._toNorm(ev);
        const pts = this.current.points;
        const last = pts[pts.length - 1];
        const dx = pt.x - last.x, dy = pt.y - last.y;
        // 더 촘촘한 임계값으로 자연스러운 곡선 확보
        if ((dx*dx + dy*dy) < 0.0000001) continue;
        pts.push(pt);
      }
      this._scheduleDraw();
      this._maybeBroadcastLive();
    }, { passive: true });

    const finish = (e) => {
      if (!this.current || e.pointerId !== pid) return;
      const s = this.current;
      this.current = null;
      try { c.releasePointerCapture(pid); } catch (_) {}
      pid = null;
      if (s.points.length >= 2 || s.tool === "eraser") {
        if (s.tool === "eraser") {
          const before = this.strokes.length;
          this.strokes = this.strokes.filter(stk => !this._intersects(stk, s));
          if (this.strokes.length !== before) {
            this.cacheValid = false;
            this.onCommit({ type: "erase", removeIntersecting: s.points });
          }
        } else {
          this.strokes.push(s);
          this._appendToCache(s);
          this.onCommit({ type: "add", stroke: s });
        }
      }
      this._scheduleDraw();
    };
    c.addEventListener("pointerup", finish);
    c.addEventListener("pointercancel", finish);
    c.addEventListener("pointerleave", finish);
  }

  _maybeBroadcastLive() {
    const now = performance.now();
    if (!this._lastLive || now - this._lastLive > 80) {
      this._lastLive = now;
      this.onLive && this.onLive({ type: "live", stroke: this.current });
    }
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

  // 매 pointermove마다 동기 redraw 대신 rAF로 묶음 → 60Hz 이상에서도 끊김 없음
  _scheduleDraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._render();
    });
  }

  _render() {
    const { ctx, canvas } = this;
    // 1) committed strokes 는 캐시에서 가져옴 — 매번 다시 그리지 않음
    if (!this.cacheValid) this._rebuildCache();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(this.cache, 0, 0);
    // 2) in-progress current stroke 만 매 프레임 그림
    if (this.current) this._renderStroke(ctx, this.current);
  }

  _rebuildCache() {
    const { cache, cacheCtx } = this;
    cacheCtx.clearRect(0, 0, cache.width, cache.height);
    for (const s of this.strokes) this._renderStroke(cacheCtx, s);
    this.cacheValid = true;
  }

  _appendToCache(stroke) {
    if (!this.cacheValid) return; // 다음 _render에서 통째로 rebuild
    this._renderStroke(this.cacheCtx, stroke);
  }

  // 외부에서 강제로 다시 그리고 싶을 때
  redraw() { this.cacheValid = false; this._scheduleDraw(); }

  _renderStroke(ctx, s) {
    if (!s.points || s.points.length === 0) return;
    const W = this.canvas.width, H = this.canvas.height;
    const baseW = (s.size || 2) * this.dpr;
    ctx.save();
    if (s.tool === "highlight") {
      ctx.globalAlpha = 0.32;
      ctx.lineCap = "butt";
      ctx.globalCompositeOperation = "multiply";
    } else {
      ctx.globalAlpha = 1;
      ctx.lineCap = "round";
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.lineJoin = "round";
    ctx.strokeStyle = s.color || "#1a1a1a";
    ctx.fillStyle = s.color || "#1a1a1a";

    const pts = s.points;

    // 점 하나: 동그라미
    if (pts.length === 1) {
      const p = pts[0];
      ctx.beginPath();
      ctx.arc(p.x * W, p.y * H, baseW / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    // 두 점: 직선
    if (pts.length === 2) {
      ctx.lineWidth = baseW;
      ctx.beginPath();
      ctx.moveTo(pts[0].x * W, pts[0].y * H);
      ctx.lineTo(pts[1].x * W, pts[1].y * H);
      ctx.stroke();
      ctx.restore();
      return;
    }

    // 가변 굵기를 위한 segment-by-segment 렌더링.
    // Catmull-Rom 보간으로 부드러운 곡선.
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(pts.length - 1, i + 2)];
      // 압력에 따른 굵기 (인접 점 평균으로 매끄럽게)
      const pr = ((p1.p || 0.5) + (p2.p || 0.5)) / 2;
      ctx.lineWidth = baseW * (0.55 + 0.9 * pr);

      // 8 단계로 보간된 점들을 잇기
      ctx.beginPath();
      ctx.moveTo(p1.x * W, p1.y * H);
      const N = 8;
      for (let t = 1; t <= N; t++) {
        const u = t / N;
        const u2 = u * u, u3 = u2 * u;
        const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * u + (2*p0.x - 5*p1.x + 4*p2.x - p3.x) * u2 + (-p0.x + 3*p1.x - 3*p2.x + p3.x) * u3);
        const y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * u + (2*p0.y - 5*p1.y + 4*p2.y - p3.y) * u2 + (-p0.y + 3*p1.y - 3*p2.y + p3.y) * u3);
        ctx.lineTo(x * W, y * H);
      }
      ctx.stroke();
    }

    ctx.restore();
  }
}
