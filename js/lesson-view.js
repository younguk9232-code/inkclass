// Shared slide-frame rendering used by editor, live (teacher), live (student),
// and the read-only record viewer.
//
// scope is one of:
//   "ppt"        — read-only background (no participation; PPT mode)
//   "whole"      — shared canvas layer (everyone reads & writes)
//   "individual" — per-student canvas layer
//   "group"      — per-group canvas layer
//   "edit"       — teacher editor (writes to slide.strokes/texts directly)

import { el } from "./ui.js";
import { InkCanvas } from "./canvas.js";
import { store } from "./store.js";
import { sync } from "./sync.js";
import { cloudWriteRecord } from "./cloud.js";

export function renderSlide({ root, slide, lesson, session, scope, scopeId, readOnly, onChange }) {
  root.innerHTML = "";
  const frame = el("div", { class: "slide-frame" });
  if (slide.bg) {
    const img = el("img", { class: "bg", src: slide.bg, alt: "" });
    frame.appendChild(img);
  }
  const canvas = el("canvas", {});
  frame.appendChild(canvas);
  const textLayer = el("div", { class: "text-layer" });
  frame.appendChild(textLayer);
  root.appendChild(frame);

  const ink = new InkCanvas(canvas, {
    readOnly,
    onCommit: (e) => {
      writeStroke(e);
    },
    onLive: () => {},
  });

  loadStrokes();
  renderTexts();

  function pathFor() {
    // returns: { container, key } indicating where to read/write from in store
    if (scope === "edit") {
      // Editor: write straight into lesson.slides[i].strokes / texts (a flat array)
      slide.strokes ||= [];
      slide.texts ||= [];
      return { strokes: slide.strokes, texts: slide.texts };
    }
    if (!session) return { strokes: [], texts: [] };
    session.records ||= {};
    if (scope === "ppt") return { strokes: [], texts: [] };
    if (scope === "whole") {
      session.records.__whole ||= {};
      session.records.__whole[slide.id] ||= { strokes: [], texts: [] };
      return session.records.__whole[slide.id];
    }
    if (scope === "individual") {
      session.records[scopeId] ||= {};
      session.records[scopeId][slide.id] ||= { strokes: [], texts: [] };
      return session.records[scopeId][slide.id];
    }
    if (scope === "group") {
      session.records.__groups ||= {};
      session.records.__groups[scopeId] ||= {};
      session.records.__groups[scopeId][slide.id] ||= { strokes: [], texts: [] };
      return session.records.__groups[scopeId][slide.id];
    }
    return { strokes: [], texts: [] };
  }

  function loadStrokes() {
    const { strokes } = pathFor();
    ink.setStrokes(strokes);
  }
  function writeStroke(ev) {
    const target = pathFor();
    if (ev.type === "add") target.strokes.push(ev.stroke);
    else if (ev.type === "erase") {
      // recompute by intersect
      target.strokes = ink.strokes.slice();
      // Sync canvas state back into store
      const path = pathFor();
      path.strokes.length = 0;
      path.strokes.push(...ink.strokes);
    }
    persist();
  }

  function renderTexts() {
    const { texts } = pathFor();
    textLayer.innerHTML = "";
    (texts || []).forEach(t => addTextEl(t));
  }
  function addTextEl(t) {
    const tb = el("div", {
      class: "text-block",
      contenteditable: readOnly ? "false" : "true",
      style: { left: (t.x*100)+"%", top: (t.y*100)+"%", fontSize: (t.size||16)+"px", color: t.color || "#1a1a1a" }
    });
    tb.textContent = t.value || "";
    tb.addEventListener("input", () => {
      t.value = tb.textContent;
      persist();
    });
    tb.addEventListener("blur", () => {
      if (!tb.textContent.trim()) {
        const arr = pathFor().texts;
        const i = arr.indexOf(t);
        if (i >= 0) arr.splice(i, 1);
        tb.remove();
        persist();
      }
    });
    textLayer.appendChild(tb);
  }

  // Click to add text when text tool is active
  let textMode = false;
  frame.addEventListener("click", (e) => {
    if (!textMode || readOnly) return;
    if (e.target !== frame && e.target.tagName !== "IMG" && e.target.tagName !== "CANVAS") return;
    const r = frame.getBoundingClientRect();
    const t = {
      x: (e.clientX - r.left) / r.width,
      y: (e.clientY - r.top) / r.height,
      value: "",
      size: 16,
      color: ink.color,
    };
    pathFor().texts.push(t);
    addTextEl(t);
    persist();
    setTimeout(() => textLayer.lastChild?.focus(), 10);
  });

  function persist() {
    store.set(s => s);
    sync.emit({ type: "render-tick" });
    onChange && onChange();
    // Cloud (best-effort, no-op if Supabase 비활성)
    if (session && scope !== "edit" && scope !== "ppt") {
      const payload = pathFor();
      cloudWriteRecord(session.id, slide.id, scope, scope === "whole" ? null : scopeId, {
        strokes: payload.strokes || [],
        texts: payload.texts || [],
      }).catch(() => {});
    }
  }

  // expose to caller
  return {
    ink,
    setTool(t) {
      textMode = (t === "text");
      ink.setTool(t === "text" ? "pen" : t);
      ink.setReadOnly(readOnly || t === "text");
      // re-enable canvas pointer when not text
      canvas.style.pointerEvents = (t === "text") ? "none" : "auto";
    },
    setColor(c) { ink.setColor(c); },
    setSize(s) { ink.setSize(s); },
    refresh() { loadStrokes(); renderTexts(); },
    frame,
  };
}
