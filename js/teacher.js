// Teacher dashboard: lessons list, editor, live class, sessions, students, QR
import { el, mount, template, modal, fmtDate } from "./ui.js";
import { store, getActiveSession, findLesson, findSession, studentLabel } from "./store.js";
import { sync } from "./sync.js";
import { go } from "./router.js";
import { renderSlide } from "./lesson-view.js";

const TOOLS = [
  { id: "pen", label: "펜", icon: "M3 17l3.6-1 9.5-9.5a2 2 0 0 0-2.8-2.8L3.8 13.2 3 17z" },
  { id: "highlight", label: "형광", icon: "M3 17l3.6-1L17 5.6 13.4 2 3 12.4 3 17z" },
  { id: "eraser", label: "지우개", icon: "M16 4l4 4-9 9H4v-7l12-6z" },
  { id: "text", label: "텍스트", icon: "M5 5h14M12 5v14" },
];
const COLORS = ["#1a1a1a", "#2b6cb0", "#c53030", "#2f7a4d", "#b6612d", "#7c3aed"];

export function teacherDashboard() {
  const root = template("tpl-teacher-dashboard");
  mount(root);
  const t = store.state.teachers.find(x => x.id === store.state.whoTeacher);
  root.querySelector("#t-who").textContent = t?.name || "—";
  root.querySelector("#t-logout").onclick = () => { store.set(s => s.whoTeacher = null); go("/"); };
  const tabs = root.querySelectorAll(".nav-item");
  tabs.forEach(b => b.onclick = () => {
    tabs.forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    renderTab(root, b.dataset.tab, t);
  });
  renderTab(root, "lessons", t);
  return store.subscribe(() => {
    const active = root.querySelector(".nav-item.active");
    if (active) renderTab(root, active.dataset.tab, t);
  });
}

function renderTab(root, tab, teacher) {
  const slot = root.querySelector("#tab-content");
  slot.innerHTML = "";
  if (tab === "lessons") slot.appendChild(viewLessons(teacher));
  if (tab === "live") slot.appendChild(viewLive(teacher));
  if (tab === "sessions") slot.appendChild(viewSessions(teacher));
  if (tab === "students") slot.appendChild(viewStudents(teacher));
  if (tab === "qr") slot.appendChild(viewQR(teacher));
}

/* ── Lessons ─────────────────────────────────────────── */

function viewLessons(teacher) {
  const wrap = el("div", {});
  const head = el("div", { class: "main-header" }, [
    el("h1", {}, "수업 자료"),
    el("div", { class: "actions" }, [
      el("button", { class: "btn", onClick: () => importDialog(teacher) }, "파일 업로드"),
      el("button", { class: "btn btn-primary", onClick: () => createLesson(teacher) }, "+ 새 수업"),
    ]),
  ]);
  wrap.appendChild(head);

  const lessons = store.state.lessons.filter(l => l.teacherId === teacher.id);
  if (lessons.length === 0) {
    wrap.appendChild(el("div", { class: "empty-state" }, [
      el("h4", {}, "아직 수업 자료가 없습니다"),
      "+ 새 수업으로 슬라이드를 만들거나, 파일 업로드로 PPT/PDF/이미지를 가져와 시작해 보세요.",
    ]));
    return wrap;
  }

  const grid = el("div", { class: "card-grid" });
  for (const l of lessons.sort((a,b) => b.createdAt - a.createdAt)) {
    const card = el("div", { class: "card" }, [
      el("h3", {}, l.title),
      el("div", { class: "meta" }, `${l.slides.length}장 · ${fmtDate(l.createdAt)}`),
      el("div", { class: "actions" }, [
        el("button", { class: "btn btn-tiny btn-primary", onClick: () => openEditor(l.id) }, "편집"),
        el("button", { class: "btn btn-tiny", onClick: () => startLessonDialog(l, teacher) }, "수업 시작"),
        el("button", { class: "btn btn-tiny btn-danger", onClick: () => deleteLesson(l.id) }, "삭제"),
      ]),
    ]);
    grid.appendChild(card);
  }
  wrap.appendChild(grid);
  return wrap;
}

function createLesson(teacher) {
  const title = prompt("수업 자료 이름을 입력하세요", "새 수업");
  if (!title) return;
  const id = store.newId("lesson");
  store.set(s => {
    s.lessons.push({
      id, teacherId: teacher.id, title, createdAt: Date.now(),
      slides: [makeBlankSlide()],
    });
  });
  openEditor(id);
}
function makeBlankSlide(bg = null) {
  return { id: store.newId("slide"), bg, mode: "none", strokes: [], texts: [] };
}
function deleteLesson(id) {
  if (!confirm("정말 삭제하시겠어요?")) return;
  store.set(s => { s.lessons = s.lessons.filter(l => l.id !== id); });
}

function importDialog(teacher) {
  const body = el("div", { class: "field" }, [
    el("p", { class: "muted" }, "PDF, PNG/JPG 이미지, 또는 PPTX(이미지로 변환)를 업로드해 즉시 슬라이드로 사용할 수 있습니다."),
    el("input", { type: "file", id: "imp-file", accept: ".pdf,.png,.jpg,.jpeg,.webp,.pptx" }),
    el("p", { class: "muted" }, "또는 Google Slides 공유 링크를 붙여넣으세요. (게시 모드 임베드)"),
    el("input", { id: "imp-gs", placeholder: "https://docs.google.com/presentation/.../pub?start=false&loop=false" }),
  ]);
  const m = modal({
    title: "자료 가져오기",
    body,
    actions: [
      { label: "취소", onClick: (close) => close() },
      { label: "가져오기", primary: true, onClick: async (close) => {
          const f = body.querySelector("#imp-file").files[0];
          const gs = body.querySelector("#imp-gs").value.trim();
          if (gs) {
            const id = store.newId("lesson");
            store.set(s => {
              s.lessons.push({
                id, teacherId: teacher.id,
                title: "Google Slides 연동",
                createdAt: Date.now(),
                slides: [{ id: store.newId("slide"), bg: null, gsEmbed: gs, mode: "none", strokes: [], texts: [] }],
              });
            });
            close(); openEditor(id); return;
          }
          if (!f) { close(); return; }
          const slides = await fileToSlides(f);
          if (!slides) { alert("이 파일 형식은 데모에서 지원되지 않습니다. 이미지 또는 PDF를 사용해 주세요."); close(); return; }
          const id = store.newId("lesson");
          store.set(s => {
            s.lessons.push({
              id, teacherId: teacher.id,
              title: f.name.replace(/\.[^.]+$/, ""),
              createdAt: Date.now(),
              slides,
            });
          });
          close();
          openEditor(id);
        } },
    ],
  });
}

async function fileToSlides(file) {
  const ext = file.name.toLowerCase().split(".").pop();
  if (["png","jpg","jpeg","webp"].includes(ext)) {
    const url = await fileToDataUrl(file);
    return [{ id: store.newId("slide"), bg: url, mode: "none", strokes: [], texts: [] }];
  }
  if (ext === "pdf") {
    return await pdfToSlides(file);
  }
  if (ext === "pptx") {
    // Lightweight: ask user to export as PDF/images. (Full PPTX render needs heavy deps.)
    return null;
  }
  return null;
}
function fileToDataUrl(f) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(f);
  });
}

async function pdfToSlides(file) {
  const buf = await file.arrayBuffer();
  // Lazy-load pdf.js
  const pdfjs = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.worker.min.mjs";
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const slides = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1.6 });
    const cv = document.createElement("canvas");
    cv.width = vp.width; cv.height = vp.height;
    await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
    slides.push({ id: store.newId("slide"), bg: cv.toDataURL("image/jpeg", 0.85), mode: "none", strokes: [], texts: [] });
  }
  return slides;
}

/* ── Editor ──────────────────────────────────────────── */

function openEditor(lessonId) {
  go("/editor/" + lessonId);
}

export function editorView({ id }) {
  const lesson = findLesson(id);
  if (!lesson) { go("/teacher"); return; }
  const teacher = store.state.teachers.find(t => t.id === lesson.teacherId);
  const root = template("tpl-teacher-dashboard");
  mount(root);
  root.querySelector("#t-who").textContent = teacher?.name || "—";
  root.querySelector("#t-logout").onclick = () => { store.set(s => s.whoTeacher = null); go("/"); };
  const tabs = root.querySelectorAll(".nav-item");
  tabs.forEach(b => b.classList.remove("active"));
  tabs.forEach(b => b.onclick = () => { go("/teacher"); });

  const slot = root.querySelector("#tab-content");
  let activeIndex = 0;
  let activeTool = "pen";
  let activeColor = COLORS[0];
  let activeSize = 2;
  let viewer = null;

  function render() {
    slot.innerHTML = "";
    const head = el("div", { class: "main-header" }, [
      el("div", { class: "row-flex" }, [
        el("button", { class: "btn", onClick: () => go("/teacher") }, "← 목록"),
        el("input", {
          id: "title-input",
          value: lesson.title,
          style: { fontSize: "20px", fontWeight: "600", border: "none", background: "transparent", outline: "none", letterSpacing: "-0.02em", minWidth: "200px" },
          onInput: (e) => { lesson.title = e.target.value; store.set(s => s); },
        }),
      ]),
      el("div", { class: "actions" }, [
        el("button", { class: "btn btn-primary", onClick: () => startLessonDialog(lesson, teacher) }, "수업 시작"),
      ]),
    ]);
    slot.appendChild(head);

    const shell = el("div", { class: "editor-shell" });
    // rail
    const rail = el("div", { class: "slide-rail" });
    lesson.slides.forEach((s, i) => {
      const t = el("div", { class: "thumb" + (i === activeIndex ? " active" : ""), onClick: () => { activeIndex = i; render(); } }, [
        el("span", { class: "num" }, String(i + 1)),
        s.bg ? el("img", { src: s.bg }) : el("div", { style: { padding: "8px", fontSize: "11px", color: "#999" } }, "빈 슬라이드"),
        el("button", { class: "del", onClick: (e) => { e.stopPropagation(); if (lesson.slides.length === 1) return; lesson.slides.splice(i, 1); activeIndex = Math.max(0, activeIndex - 1); store.set(s => s); render(); } }, "삭제"),
      ]);
      rail.appendChild(t);
    });
    rail.appendChild(el("button", {
      class: "add-slide",
      onClick: () => { lesson.slides.push(makeBlankSlide()); activeIndex = lesson.slides.length - 1; store.set(s => s); render(); },
    }, "+ 슬라이드 추가"));
    shell.appendChild(rail);

    // canvas
    const canvasArea = el("div", { class: "canvas-area" });
    const toolbar = el("div", { class: "canvas-toolbar" });
    TOOLS.forEach(t => {
      const b = el("button", { class: "tool" + (activeTool === t.id ? " active" : ""), title: t.label, onClick: () => { activeTool = t.id; viewer && viewer.setTool(t.id); render(); } }, [
        svgIcon(t.icon),
      ]);
      toolbar.appendChild(b);
    });
    toolbar.appendChild(el("div", { class: "toolbar-divider" }));
    COLORS.forEach(c => {
      toolbar.appendChild(el("div", { class: "swatch" + (activeColor === c ? " active" : ""), style: { background: c }, onClick: () => { activeColor = c; viewer && viewer.setColor(c); render(); } }));
    });
    toolbar.appendChild(el("div", { class: "toolbar-divider" }));
    const sizes = [{ id: 1.5, label: "S" }, { id: 2.5, label: "M" }, { id: 4, label: "L" }, { id: 8, label: "XL" }];
    const sizePick = el("div", { class: "size-pick" });
    sizes.forEach(s => sizePick.appendChild(el("button", { class: activeSize === s.id ? "active" : "", onClick: () => { activeSize = s.id; viewer && viewer.setSize(s.id); render(); } }, s.label)));
    toolbar.appendChild(sizePick);
    toolbar.appendChild(el("div", { class: "toolbar-spacer" }));
    toolbar.appendChild(el("button", { class: "btn btn-tiny", onClick: () => { lesson.slides[activeIndex].strokes = []; lesson.slides[activeIndex].texts = []; store.set(s => s); render(); } }, "이 슬라이드 지우기"));
    canvasArea.appendChild(toolbar);

    const stage = el("div", { class: "canvas-stage" });
    canvasArea.appendChild(stage);
    shell.appendChild(canvasArea);

    // inspector
    const inspector = el("div", { class: "inspector" }, [
      el("h4", {}, "슬라이드"),
      el("div", { class: "field" }, [
        el("label", {}, "배경 이미지"),
        el("button", { class: "btn", onClick: () => replaceBg(lesson.slides[activeIndex], render) }, "이미지 교체"),
      ]),
      el("h4", {}, "참여 모드"),
      modePicker(lesson.slides[activeIndex], render),
      el("p", { class: "muted" }, "수업 중에도 변경할 수 있습니다."),
    ]);
    shell.appendChild(inspector);

    slot.appendChild(shell);

    // mount slide
    queueMicrotask(() => {
      viewer = renderSlide({ root: stage, slide: lesson.slides[activeIndex], lesson, session: null, scope: "edit", readOnly: false });
      viewer.setTool(activeTool);
      viewer.setColor(activeColor);
      viewer.setSize(activeSize);
    });
  }
  render();
}

function modePicker(slide, rerender) {
  const opts = [
    { id: "none", t: "PPT 모드", d: "교사 발표만" },
    { id: "whole", t: "전체", d: "함께 필기" },
    { id: "individual", t: "개별", d: "각자 학습지" },
    { id: "group", t: "그룹", d: "모둠 협업" },
  ];
  const wrap = el("div", { class: "mode-pick" });
  opts.forEach(o => wrap.appendChild(
    el("button", { class: slide.mode === o.id ? "active" : "", onClick: () => { slide.mode = o.id; store.set(s => s); rerender(); } }, [
      el("strong", {}, o.t),
      el("span", { class: "desc" }, o.d),
    ])
  ));
  return wrap;
}

function replaceBg(slide, rerender) {
  const inp = el("input", { type: "file", accept: ".png,.jpg,.jpeg,.webp,.pdf" });
  inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    const ext = f.name.toLowerCase().split(".").pop();
    if (ext === "pdf") {
      const slides = await pdfToSlides(f);
      if (slides) slide.bg = slides[0].bg;
    } else {
      slide.bg = await fileToDataUrl(f);
    }
    store.set(s => s); rerender();
  };
  inp.click();
}

function svgIcon(d) {
  return el("span", { html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>` });
}

/* ── Start lesson / Live class ──────────────────────── */

function startLessonDialog(lesson, teacher) {
  const body = el("div", {}, [
    el("p", { class: "muted" }, "수업 흐름을 선택하세요. 시작 후에도 언제든 변경할 수 있습니다."),
    el("div", { class: "mode-pick" }, [
      el("button", { class: "active", id: "flow-teacher", onClick: (e) => pick(e, "teacher") }, [
        el("strong", {}, "교사 흐름"),
        el("span", { class: "desc" }, "교사가 슬라이드를 넘기면 학생도 함께 이동"),
      ]),
      el("button", { id: "flow-student", onClick: (e) => pick(e, "student") }, [
        el("strong", {}, "학생 흐름"),
        el("span", { class: "desc" }, "학생이 자율적으로 앞뒤로 이동"),
      ]),
    ]),
  ]);
  let flow = "teacher";
  function pick(e, f) {
    flow = f;
    body.querySelectorAll(".mode-pick button").forEach(b => b.classList.remove("active"));
    e.currentTarget.classList.add("active");
  }
  modal({
    title: lesson.title + " 시작",
    body,
    actions: [
      { label: "취소", onClick: (close) => close() },
      { label: "수업 시작", primary: true, onClick: (close) => {
          // close any other live session for this teacher
          store.set(s => {
            s.sessions.forEach(ss => { if (ss.teacherId === teacher.id && ss.status === "live") ss.status = "stopped"; });
            const session = {
              id: store.newId("sess"),
              lessonId: lesson.id,
              teacherId: teacher.id,
              title: lesson.title,
              status: "live",
              flow,
              currentSlide: 0,
              startedAt: Date.now(),
              endedAt: null,
              participants: [],
              groups: [],
              records: {},
              slidesSnapshot: JSON.parse(JSON.stringify(lesson.slides)), // freeze slide content
            };
            s.sessions.push(session);
          });
          sync.emit({ type: "session-start" });
          close();
          go("/teacher/live");
        } },
    ],
  });
}

function viewLive(teacher) {
  const wrap = el("div", {});
  const session = store.state.sessions.find(s => s.teacherId === teacher.id && s.status === "live");
  if (!session) {
    wrap.appendChild(el("div", { class: "main-header" }, [el("h1", {}, "진행 중")]));
    wrap.appendChild(el("div", { class: "empty-state" }, [
      el("h4", {}, "현재 진행 중인 수업이 없습니다"),
      "수업 자료에서 [수업 시작]을 눌러 학생 참여를 시작하세요.",
    ]));
    return wrap;
  }
  return liveClass(wrap, session, teacher);
}

function liveClass(wrap, session, teacher) {
  const slide = session.slidesSnapshot[session.currentSlide];
  const lesson = findLesson(session.lessonId);
  const head = el("div", { class: "main-header" }, [
    el("div", { class: "row-flex" }, [
      el("h1", {}, session.title),
      el("span", { class: "tag live" }, "LIVE"),
      el("span", { class: "muted" }, `슬라이드 ${session.currentSlide + 1} / ${session.slidesSnapshot.length}`),
    ]),
    el("div", { class: "actions" }, [
      el("button", { class: "btn", onClick: () => completeSession(session, "stopped") }, "수업 중지"),
      el("button", { class: "btn btn-primary", onClick: () => completeSession(session, "completed") }, "수업 완료"),
    ]),
  ]);
  wrap.appendChild(head);

  const shell = el("div", { class: "live-shell" });
  // stage
  const stage = el("div", { class: "live-stage" });
  const lh = el("div", { class: "live-header" }, [
    el("span", { class: "pill live" }, "수업 중"),
    el("span", { class: "muted", style: { fontSize: "13px" } }, `흐름: ${session.flow === "teacher" ? "교사 주도" : "학생 자율"}`),
    el("span", { class: "muted", style: { fontSize: "13px" } }, `모드: ${modeLabel(slide.mode)}`),
    el("span", { class: "spacer" }),
    el("span", { class: "muted", style: { fontSize: "12px" } }, `참여 ${session.participants.length}명`),
  ]);
  stage.appendChild(lh);

  const stageArea = el("div", { class: "canvas-stage", style: { background: "#f4f3f0" } });
  stage.appendChild(stageArea);

  // bottom controls
  const controls = el("div", { class: "live-controls" }, [
    el("button", { class: "btn btn-tiny", disabled: session.currentSlide === 0, onClick: () => navigate(-1) }, "← 이전"),
    el("button", { class: "btn btn-tiny", disabled: session.currentSlide === session.slidesSnapshot.length - 1, onClick: () => navigate(1) }, "다음 →"),
    el("span", { class: "toolbar-divider" }),
    el("span", { class: "muted", style: { fontSize: "12px" } }, "흐름:"),
    el("button", { class: "btn btn-tiny" + (session.flow === "teacher" ? " btn-primary" : ""), onClick: () => switchFlow("teacher") }, "교사"),
    el("button", { class: "btn btn-tiny" + (session.flow === "student" ? " btn-primary" : ""), onClick: () => switchFlow("student") }, "학생"),
    el("span", { class: "toolbar-divider" }),
    el("span", { class: "muted", style: { fontSize: "12px" } }, "모드:"),
    ...["none","whole","individual","group"].map(m =>
      el("button", { class: "btn btn-tiny" + (slide.mode === m ? " btn-primary" : ""), onClick: () => switchMode(m) }, modeLabel(m))
    ),
  ]);
  stage.appendChild(controls);

  shell.appendChild(stage);

  // progress panel
  const panel = el("div", { class: "progress-panel" });
  shell.appendChild(panel);

  wrap.appendChild(shell);

  // mount stage canvas (teacher writes to "whole" by default; for individual/group, show shared overlay placeholder)
  let viewer;
  function mountStage() {
    const scope = slide.mode === "whole" ? "whole" : (slide.mode === "none" ? "ppt" : "whole");
    // Teacher always writes to "whole" overlay (not into student records)
    viewer = renderSlide({ root: stageArea, slide, session, scope, readOnly: false });
    viewer.setTool("pen");
    viewer.setColor("#1a1a1a");
    viewer.setSize(2);
  }
  mountStage();

  // progress panel
  renderProgress();
  function renderProgress() {
    panel.innerHTML = "";
    panel.appendChild(el("h4", {}, "진행 상황"));
    if (slide.mode === "individual") {
      panel.appendChild(individualProgress(session, slide));
    } else if (slide.mode === "group") {
      panel.appendChild(groupProgress(session, slide));
    } else if (slide.mode === "whole") {
      panel.appendChild(el("p", { class: "muted" }, "전체 모드: 교사·학생이 동일 캔버스를 공유합니다."));
    } else {
      panel.appendChild(el("p", { class: "muted" }, "PPT 모드: 학생은 슬라이드를 시청합니다."));
    }
    panel.appendChild(el("h4", {}, "참여자"));
    if (session.participants.length === 0) {
      panel.appendChild(el("p", { class: "muted" }, "아직 입장한 학생이 없습니다."));
    } else {
      const list = el("div", { style: { display: "grid", gap: "4px" } });
      session.participants.forEach(sid => {
        const stu = store.state.students.find(x => x.id === sid);
        list.appendChild(el("div", { style: { fontSize: "12px" } }, studentLabel(stu)));
      });
      panel.appendChild(list);
    }
  }

  function navigate(d) {
    session.currentSlide = Math.max(0, Math.min(session.slidesSnapshot.length - 1, session.currentSlide + d));
    store.set(s => s);
    sync.emit({ type: "slide-change" });
    rerender();
  }
  function switchFlow(f) {
    session.flow = f;
    store.set(s => s);
    sync.emit({ type: "flow-change" });
    rerender();
  }
  function switchMode(m) {
    slide.mode = m;
    store.set(s => s);
    sync.emit({ type: "mode-change" });
    rerender();
  }
  function rerender() {
    wrap.innerHTML = "";
    liveClass(wrap, session, teacher);
  }

  // re-render progress every 1.5s while live
  const t = setInterval(() => renderProgress(), 1500);
  // Cleanup on next render
  setTimeout(() => clearTimeout(t), 60_000_000);

  return wrap;
}

function modeLabel(m) {
  return ({ none: "PPT", whole: "전체", individual: "개별", group: "그룹" })[m] || m;
}

function individualProgress(session, slide) {
  const wrap = el("div", { class: "gallery" });
  const list = session.participants.length ? session.participants : [];
  if (list.length === 0) {
    return el("p", { class: "muted" }, "참여자가 없습니다.");
  }
  list.forEach(sid => {
    const stu = store.state.students.find(x => x.id === sid);
    const tile = el("div", { class: "tile" });
    tile.appendChild(el("div", { class: "name" }, [
      el("span", {}, stu ? stu.name : "—"),
      el("span", { class: "dot online" }),
    ]));
    const prev = el("div", { class: "preview" });
    if (slide.bg) prev.appendChild(el("img", { src: slide.bg }));
    const cv = el("canvas", {});
    prev.appendChild(cv);
    tile.appendChild(prev);
    wrap.appendChild(tile);
    queueMicrotask(() => paintMini(cv, session, slide.id, "individual", sid));
    tile.onclick = () => openLearnerView(session, slide, sid);
  });
  return wrap;
}

function groupProgress(session, slide) {
  const wrap = el("div", {});
  wrap.appendChild(el("button", {
    class: "btn btn-tiny",
    onClick: () => groupBuilderModal(session),
    style: { marginBottom: "8px" },
  }, "모둠 편성"));
  if (!session.groups.length) {
    wrap.appendChild(el("p", { class: "muted" }, "아직 모둠이 없습니다."));
    return wrap;
  }
  const gal = el("div", { class: "gallery" });
  session.groups.forEach(g => {
    const tile = el("div", { class: "tile" });
    tile.appendChild(el("div", { class: "name" }, [
      el("span", {}, g.name + ` (${g.memberIds.length})`),
    ]));
    const prev = el("div", { class: "preview" });
    if (slide.bg) prev.appendChild(el("img", { src: slide.bg }));
    const cv = el("canvas", {});
    prev.appendChild(cv);
    tile.appendChild(prev);
    gal.appendChild(tile);
    queueMicrotask(() => paintMini(cv, session, slide.id, "group", g.id));
  });
  wrap.appendChild(gal);
  return wrap;
}

function paintMini(canvas, session, slideId, scope, scopeId) {
  const r = canvas.parentElement.getBoundingClientRect();
  canvas.width = r.width * (window.devicePixelRatio||1);
  canvas.height = r.height * (window.devicePixelRatio||1);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const path = scope === "individual"
    ? session.records?.[scopeId]?.[slideId]
    : session.records?.__groups?.[scopeId]?.[slideId];
  if (!path) return;
  for (const s of path.strokes || []) {
    ctx.save();
    ctx.globalAlpha = s.tool === "highlight" ? .32 : 1;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = s.color || "#1a1a1a";
    ctx.lineWidth = (s.size||2);
    ctx.beginPath();
    s.points.forEach((p, i) => {
      const x = p.x * canvas.width, y = p.y * canvas.height;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }
}

function openLearnerView(session, slide, sid) {
  const stu = store.state.students.find(x => x.id === sid);
  const body = el("div", {});
  const stage = el("div", { class: "canvas-stage", style: { padding: 0, height: "60vh" } });
  body.appendChild(stage);
  modal({
    title: `${studentLabel(stu)} · ${session.title}`,
    body,
    actions: [{ label: "닫기", primary: true, onClick: (close) => close() }],
  });
  setTimeout(() => {
    renderSlide({ root: stage, slide, session, scope: "individual", scopeId: sid, readOnly: true });
  }, 30);
}

function groupBuilderModal(session) {
  const body = el("div", {});
  const top = el("div", { class: "row-flex" }, [
    el("button", { class: "btn btn-tiny", onClick: () => addGroup() }, "+ 모둠 추가"),
    el("button", { class: "btn btn-tiny", onClick: () => randomize() }, "랜덤 배정"),
    el("input", { id: "ng", type: "number", min: "2", max: "10", value: "4", placeholder: "모둠 수", style: { width: "70px" } }),
  ]);
  body.appendChild(top);
  const pool = el("div", { class: "group-builder" });
  body.appendChild(pool);

  function render() {
    pool.innerHTML = "";
    // Unassigned
    const assigned = new Set(session.groups.flatMap(g => g.memberIds));
    const unassigned = session.participants.filter(p => !assigned.has(p));
    const un = el("div", { class: "group", style: { background: "#fff", border: "1px dashed var(--line)" } }, [
      el("div", { class: "gname" }, "미배정"),
      ...buildChips(unassigned, null),
    ]);
    pool.appendChild(un);
    session.groups.forEach(g => {
      const gd = el("div", { class: "group" }, [
        el("div", { class: "gname" }, [
          el("span", {}, g.name),
          el("button", { class: "btn-link", onClick: () => { session.groups = session.groups.filter(x => x.id !== g.id); store.set(s => s); render(); } }, "삭제"),
        ]),
        ...buildChips(g.memberIds, g.id),
      ]);
      pool.appendChild(gd);
    });
  }
  function buildChips(ids, gid) {
    const wrap = el("div", { class: "chips" });
    ids.forEach(id => {
      const stu = store.state.students.find(x => x.id === id);
      const chip = el("div", { class: "chip", draggable: "true" }, [stu?.name || id, el("span", { class: "x", onClick: () => { moveTo(id, null); } }, "×")]);
      chip.ondragstart = (e) => { e.dataTransfer.setData("text/plain", JSON.stringify({ id, from: gid })); };
      wrap.appendChild(chip);
    });
    wrap.ondragover = (e) => e.preventDefault();
    wrap.ondrop = (e) => {
      e.preventDefault();
      const { id, from } = JSON.parse(e.dataTransfer.getData("text/plain"));
      moveTo(id, gid);
    };
    return [wrap];
  }
  function moveTo(studentId, groupId) {
    session.groups.forEach(g => g.memberIds = g.memberIds.filter(x => x !== studentId));
    if (groupId) {
      const g = session.groups.find(x => x.id === groupId);
      if (g) g.memberIds.push(studentId);
    }
    store.set(s => s); render();
  }
  function addGroup() {
    const n = session.groups.length + 1;
    session.groups.push({ id: store.newId("g"), name: `${n}모둠`, memberIds: [] });
    store.set(s => s); render();
  }
  function randomize() {
    const n = parseInt(body.querySelector("#ng").value || "4");
    session.groups = Array.from({ length: n }, (_, i) => ({ id: store.newId("g"), name: `${i+1}모둠`, memberIds: [] }));
    const ids = [...session.participants];
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    ids.forEach((id, i) => session.groups[i % n].memberIds.push(id));
    store.set(s => s); render();
  }
  render();
  modal({
    title: "모둠 편성",
    body,
    actions: [{ label: "완료", primary: true, onClick: (close) => close() }],
  });
}

function completeSession(session, status) {
  if (!confirm(status === "completed" ? "수업을 완료하고 세션으로 저장할까요?" : "수업을 중지할까요?")) return;
  session.status = status;
  session.endedAt = Date.now();
  store.set(s => s);
  sync.emit({ type: "session-end" });
}

/* ── Sessions archive ────────────────────────────────── */

function viewSessions(teacher) {
  const wrap = el("div", {});
  wrap.appendChild(el("div", { class: "main-header" }, [el("h1", {}, "수업 세션")]));
  const sessions = store.state.sessions.filter(s => s.teacherId === teacher.id).sort((a,b) => (b.startedAt - a.startedAt));
  if (!sessions.length) {
    wrap.appendChild(el("div", { class: "empty-state" }, [el("h4", {}, "아직 수업 세션이 없습니다"), "수업이 끝나면 자동으로 보관됩니다."]));
    return wrap;
  }
  const list = el("div", { class: "record-list" });
  sessions.forEach(s => {
    const row = el("div", { class: "record-row", onClick: () => openSessionDetail(s) }, [
      el("div", {}, [
        el("div", { style: { fontWeight: 600 } }, s.title),
        el("div", { class: "meta" }, `${fmtDate(s.startedAt)} · 참여 ${s.participants.length}명`),
      ]),
      el("span", { class: `tag ${s.status}` }, ({ live: "LIVE", completed: "완료", stopped: "중지" })[s.status]),
    ]);
    list.appendChild(row);
  });
  wrap.appendChild(list);
  return wrap;
}

function openSessionDetail(session) {
  const body = el("div", {});
  const head = el("div", { class: "row-flex", style: { marginBottom: "10px" } }, [
    el("span", { class: "muted" }, `${fmtDate(session.startedAt)} ~ ${fmtDate(session.endedAt)}`),
    el("span", { class: "spacer" }),
    el("button", { class: "btn btn-tiny", onClick: () => printRecords(session, [...selected]) }, "선택 출력"),
    el("button", { class: "btn btn-tiny btn-primary", onClick: () => printRecords(session, session.participants) }, "전체 출력"),
  ]);
  body.appendChild(head);
  const list = el("div", { class: "record-list" });
  const selected = new Set();
  session.participants.forEach(sid => {
    const stu = store.state.students.find(x => x.id === sid);
    const row = el("label", { class: "record-row" }, [
      el("div", { class: "row-flex" }, [
        el("input", { type: "checkbox", onChange: (e) => { e.target.checked ? selected.add(sid) : selected.delete(sid); } }),
        el("div", {}, [
          el("div", { style: { fontWeight: 600 } }, studentLabel(stu)),
          el("div", { class: "meta" }, `슬라이드 ${session.slidesSnapshot.length}장 기록`),
        ]),
      ]),
      el("button", { class: "btn btn-tiny", onClick: (e) => { e.preventDefault(); openStudentSession(session, sid); } }, "기록 보기"),
    ]);
    list.appendChild(row);
  });
  body.appendChild(list);
  modal({ title: session.title, body, actions: [{ label: "닫기", primary: true, onClick: (close) => close() }] });
}

function openStudentSession(session, sid) {
  const stu = store.state.students.find(x => x.id === sid);
  const body = el("div", {});
  session.slidesSnapshot.forEach((slide, i) => {
    body.appendChild(el("h4", {}, `슬라이드 ${i+1} · ${modeLabel(slide.mode)}`));
    const stage = el("div", { class: "canvas-stage", style: { padding: 0, minHeight: "300px", marginBottom: "12px" } });
    body.appendChild(stage);
    const scope = slide.mode === "individual" ? "individual" :
                  slide.mode === "group" ? "group" :
                  slide.mode === "whole" ? "whole" : "ppt";
    let scopeId = sid;
    if (scope === "group") {
      const g = session.groups.find(g => g.memberIds.includes(sid));
      scopeId = g?.id;
    }
    setTimeout(() => renderSlide({ root: stage, slide, session, scope, scopeId, readOnly: true }), 30);
  });
  modal({
    title: `${studentLabel(stu)} · ${session.title}`,
    body,
    actions: [{ label: "닫기", primary: true, onClick: (close) => close() }],
  });
}

function printRecords(session, sids) {
  if (!sids.length) { alert("출력할 학생을 선택하세요."); return; }
  const w = window.open("", "_blank");
  w.document.write(`<!doctype html><html><head><title>${session.title} 기록</title>
    <link rel="stylesheet" href="${location.origin}${location.pathname.replace(/[^/]*$/, "")}styles.css"></head><body>`);
  sids.forEach(sid => {
    const stu = store.state.students.find(x => x.id === sid);
    w.document.write(`<div class="print-slide"><h2>${session.title}</h2><h3>${studentLabel(stu)}</h3>`);
    session.slidesSnapshot.forEach((slide, i) => {
      const path = slide.mode === "individual" ? session.records?.[sid]?.[slide.id]
                  : slide.mode === "group" ? session.records?.__groups?.[(session.groups.find(g => g.memberIds.includes(sid))||{}).id]?.[slide.id]
                  : session.records?.__whole?.[slide.id];
      w.document.write(`<div style="margin-bottom:24px"><h4>슬라이드 ${i+1}</h4>`);
      if (slide.bg) w.document.write(`<img src="${slide.bg}" style="max-width:100%;border:1px solid #ccc"/>`);
      if (path?.texts?.length) {
        w.document.write(`<p><b>입력:</b> ${path.texts.map(t => t.value).join(" / ")}</p>`);
      }
      w.document.write(`</div>`);
    });
    w.document.write(`</div>`);
  });
  w.document.write("</body></html>");
  w.document.close();
  setTimeout(() => w.print(), 600);
}

/* ── Students archive ────────────────────────────────── */

function viewStudents(teacher) {
  const wrap = el("div", {});
  wrap.appendChild(el("div", { class: "main-header" }, [el("h1", {}, "학생 명단")]));
  const all = store.state.students;
  if (!all.length) {
    wrap.appendChild(el("div", { class: "empty-state" }, [el("h4", {}, "등록된 학생이 없습니다"), "학생이 수업에 입장하면 자동으로 추가됩니다."]));
    return wrap;
  }
  const tbl = el("table", { class: "table" });
  tbl.innerHTML = `<thead><tr><th>학생</th><th>참여 세션</th><th></th></tr></thead>`;
  const tb = el("tbody");
  all.forEach(stu => {
    const sessions = store.state.sessions.filter(s => s.teacherId === teacher.id && s.participants.includes(stu.id));
    const tr = el("tr", { onClick: () => openStudentArchive(stu, teacher) }, []);
    tr.innerHTML = `<td><b>${studentLabel(stu)}</b></td><td>${sessions.length}회</td><td style="text-align:right"><span class="muted">기록 보기 →</span></td>`;
    tb.appendChild(tr);
  });
  tbl.appendChild(tb);
  wrap.appendChild(tbl);
  return wrap;
}

function openStudentArchive(stu, teacher) {
  const sessions = store.state.sessions.filter(s => s.teacherId === teacher.id && s.participants.includes(stu.id));
  const body = el("div", {});
  if (!sessions.length) body.appendChild(el("p", { class: "muted" }, "참여한 세션이 없습니다."));
  sessions.forEach(s => {
    const row = el("div", { class: "record-row", onClick: () => openStudentSession(s, stu.id) }, [
      el("div", {}, [el("div", { style: { fontWeight: 600 } }, s.title), el("div", { class: "meta" }, fmtDate(s.startedAt))]),
      el("span", { class: `tag ${s.status}` }, ({ completed: "완료", stopped: "중지", live: "LIVE" })[s.status]),
    ]);
    body.appendChild(row);
  });
  modal({ title: studentLabel(stu), body, actions: [{ label: "닫기", primary: true, onClick: close => close() }] });
}

/* ── QR ─────────────────────────────────────────────── */

function viewQR(teacher) {
  const wrap = el("div", {});
  wrap.appendChild(el("div", { class: "main-header" }, [el("h1", {}, "접속 QR")]));
  const url = `${location.origin}${location.pathname}#/student/join?t=${encodeURIComponent(teacher.id)}`;
  const card = el("div", { class: "qr-card" }, [
    el("div", { style: { fontSize: "13px", color: "var(--muted)" } }, `${teacher.name} 선생님의 수업방`),
    el("canvas", { id: "qr" }),
    el("div", { class: "url" }, url),
    el("button", { class: "btn", onClick: () => { navigator.clipboard.writeText(url); } }, "URL 복사"),
  ]);
  wrap.appendChild(card);
  setTimeout(() => {
    if (window.QRCode) QRCode.toCanvas(card.querySelector("#qr"), url, { width: 240, margin: 1, color: { dark: "#1a1a1a", light: "#ffffff" } });
  }, 30);
  return wrap;
}
