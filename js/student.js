// Student dashboard + live lesson view
import { el, mount, template, modal, fmtDate } from "./ui.js";
import { store, getActiveSession, findLesson, studentLabel } from "./store.js";
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

export function studentDashboard() {
  const root = template("tpl-student-dashboard");
  mount(root);
  const me = store.state.students.find(x => x.id === store.state.whoStudent);
  root.querySelector("#s-who").textContent = me ? studentLabel(me) : "—";
  root.querySelector("#s-logout").onclick = () => { store.set(s => s.whoStudent = null); go("/"); };
  const tabs = root.querySelectorAll(".nav-item");
  tabs.forEach(b => b.onclick = () => {
    tabs.forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    renderTab(root, b.dataset.tab, me);
  });
  renderTab(root, "join", me);
  return store.subscribe(() => {
    const a = root.querySelector(".nav-item.active");
    if (a) renderTab(root, a.dataset.tab, me);
  });
}

function renderTab(root, tab, me) {
  const slot = root.querySelector("#tab-content");
  slot.innerHTML = "";
  if (tab === "join") slot.appendChild(viewJoin(me));
  if (tab === "records") slot.appendChild(viewRecords(me));
}

function viewJoin(me) {
  const wrap = el("div", {});
  wrap.appendChild(el("div", { class: "main-header" }, [el("h1", {}, "수업 하기")]));

  // 코드 입력 카드 — 가장 직관적인 진입점
  const codeCard = el("div", { class: "card join-by-code" }, [
    el("h3", {}, "수업 코드로 입장"),
    el("p", { class: "meta" }, "선생님이 알려준 6자리 코드를 입력하세요."),
    el("div", { class: "row-flex", style: { gap: "6px" } }, [
      el("input", {
        id: "code-input",
        placeholder: "예) ABC123",
        autocapitalize: "characters",
        autocomplete: "off",
        spellcheck: "false",
        maxlength: "6",
        style: { flex: "1", padding: "10px 12px", border: "1px solid var(--line)", borderRadius: "10px", fontSize: "16px", letterSpacing: "0.15em", textAlign: "center", fontWeight: "600" },
        onInput: (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6); },
      }),
      el("button", { class: "btn btn-primary", onClick: () => {
        const code = (wrap.querySelector("#code-input").value || "").toUpperCase().trim();
        if (!code) return;
        const target = store.state.sessions.find(s => s.status === "live" && (s.joinCode || "").toUpperCase() === code);
        if (!target) { alert("해당 코드의 진행 중인 수업을 찾지 못했어요."); return; }
        joinSession(target, me);
      } }, "입장"),
    ]),
  ]);
  wrap.appendChild(codeCard);

  // 또한, 진행 중인 모든 수업 리스트도 함께 제공 (선생님이 코드 안 알려준 경우)
  const live = store.state.sessions.filter(s => s.status === "live");
  if (!live.length) {
    wrap.appendChild(el("div", { class: "empty-state" }, [
      el("h4", {}, "현재 진행 중인 수업이 없어요"),
      "선생님이 수업을 시작하면 여기 또는 위 코드 입력으로 참여할 수 있어요.",
    ]));
    return wrap;
  }
  wrap.appendChild(el("h4", { style: { margin: "20px 0 10px", fontSize: "12px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.08em" } }, "진행 중인 수업"));
  const grid = el("div", { class: "card-grid" });
  live.forEach(s => {
    const teacher = store.state.teachers.find(t => t.id === s.teacherId);
    const card = el("div", { class: "card" }, [
      el("h3", {}, s.title),
      el("div", { class: "meta" }, `${teacher?.name || "선생님"} · ${fmtDate(s.startedAt)}${s.joinCode ? ` · 코드 ${s.joinCode}` : ""}`),
      el("div", { class: "actions" }, [
        el("button", { class: "btn btn-tiny btn-primary", onClick: () => joinSession(s, me) }, "입장"),
      ]),
    ]);
    grid.appendChild(card);
  });
  wrap.appendChild(grid);
  return wrap;
}

function joinSession(session, me) {
  if (!session.participants.includes(me.id)) {
    session.participants.push(me.id);
    store.set(s => s);
    sync.emit({ type: "student-join" });
  }
  go("/student/live/" + session.id);
}

export function studentLive({ id }) {
  const session = store.state.sessions.find(x => x.id === id);
  if (!session) { go("/student"); return; }
  const me = store.state.students.find(x => x.id === store.state.whoStudent);
  if (!me) { go("/"); return; }

  const root = el("div", { class: "stu-shell" });
  const bar = el("div", { class: "stu-bar" });
  const stage = el("div", { class: "stu-stage" });
  root.appendChild(bar);
  root.appendChild(stage);
  mount(root);

  let activeTool = "pen";
  let activeColor = COLORS[0];
  let activeSize = 2;
  let viewer = null;
  let myIdx = session.currentSlide;

  const unsub = store.subscribe(() => {
    // server-pushed updates: react to flow/slide change
    if (session.flow === "teacher") myIdx = session.currentSlide;
    render();
  });
  const unsync = sync.on(() => render());

  function render() {
    const status = session.status;
    bar.innerHTML = "";
    bar.appendChild(el("div", { class: "brand small" }, [el("div", { class: "brand-mark" }), el("span", {}, "Inkclass")]));
    bar.appendChild(el("span", { class: "who" }, studentLabel(me)));
    bar.appendChild(el("span", { class: "muted" }, "·"));
    bar.appendChild(el("span", { class: "muted" }, session.title));
    if (status !== "live") {
      bar.appendChild(el("span", { class: "tag stopped" }, status === "completed" ? "수업 완료" : "수업 중지"));
    } else {
      bar.appendChild(el("span", { class: "tag live" }, "수업 중"));
    }
    bar.appendChild(el("span", { class: "spacer" }));
    bar.appendChild(el("span", { class: "mode" }, modeLabel(slideAt().mode)));
    bar.appendChild(el("button", { class: "btn btn-tiny", onClick: () => { unsub(); unsync(); go("/student"); } }, "나가기"));

    // Stage
    stage.innerHTML = "";
    if (status !== "live") {
      stage.appendChild(el("div", { class: "empty-state" }, [
        el("h4", {}, status === "completed" ? "수업이 종료되었습니다" : "수업이 중지되었습니다"),
        "기록은 [수업 기록]에서 다시 확인할 수 있어요.",
      ]));
      return;
    }
    const slide = slideAt();
    const flowNote = session.flow === "teacher" ? "교사 흐름 — 슬라이드는 교사가 넘깁니다." : "학생 흐름 — 자율적으로 이동할 수 있습니다.";
    stage.appendChild(el("div", { class: "muted", style: { fontSize: "12px" } }, flowNote));

    // Toolbar (only when student can write)
    const writable = slide.mode === "whole" || slide.mode === "individual" || slide.mode === "group";
    if (writable) {
      const tb = el("div", { class: "canvas-toolbar", style: { borderRadius: "12px", border: "1px solid var(--line)" } });
      TOOLS.forEach(t => {
        tb.appendChild(el("button", { class: "tool" + (activeTool === t.id ? " active" : ""), title: t.label, onClick: () => { activeTool = t.id; viewer && viewer.setTool(t.id); render(); } }, [
          el("span", { html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${t.icon}"/></svg>` }),
        ]));
      });
      tb.appendChild(el("div", { class: "toolbar-divider" }));
      COLORS.forEach(c => tb.appendChild(el("div", { class: "swatch" + (activeColor === c ? " active" : ""), style: { background: c }, onClick: () => { activeColor = c; viewer && viewer.setColor(c); render(); } })));
      tb.appendChild(el("div", { class: "toolbar-divider" }));
      [{id:1.5,label:"S"},{id:2.5,label:"M"},{id:4,label:"L"},{id:8,label:"XL"}].forEach(s =>
        tb.appendChild(el("button", { class: "tool" + (activeSize === s.id ? " active" : ""), style: { width: "auto", padding: "0 10px", fontSize: "12px" }, onClick: () => { activeSize = s.id; viewer && viewer.setSize(s.id); render(); } }, s.label))
      );
      stage.appendChild(tb);
    }

    const stageArea = el("div", { class: "canvas-stage" });
    stage.appendChild(stageArea);

    // Slide nav (student-flow only)
    if (session.flow === "student") {
      const nav = el("div", { class: "row-flex", style: { justifyContent: "center", gap: "12px", padding: "8px" } }, [
        el("button", { class: "btn btn-tiny", disabled: myIdx === 0, onClick: () => { myIdx = Math.max(0, myIdx - 1); render(); } }, "← 이전"),
        el("span", { class: "muted", style: { fontSize: "12px" } }, `슬라이드 ${myIdx + 1} / ${session.slidesSnapshot.length}`),
        el("button", { class: "btn btn-tiny", disabled: myIdx === session.slidesSnapshot.length - 1, onClick: () => { myIdx = Math.min(session.slidesSnapshot.length - 1, myIdx + 1); render(); } }, "다음 →"),
      ]);
      stage.appendChild(nav);
    } else {
      stage.appendChild(el("div", { class: "muted", style: { fontSize: "12px", textAlign: "center" } }, `슬라이드 ${myIdx + 1} / ${session.slidesSnapshot.length}`));
    }

    // mount viewer
    queueMicrotask(() => {
      // PPT 모드: 학생은 교사 필기('whole')를 시청만 (readOnly). 전체/개별/그룹은 학생도 작성 가능.
      const isPPT = slide.mode === "none";
      const scope = slide.mode === "individual" ? "individual"
        : slide.mode === "group" ? "group"
        : "whole"; // none(PPT) & whole 모두 whole 캔버스를 본다 (PPT는 readOnly)
      let scopeId = me.id;
      if (scope === "group") {
        const g = session.groups.find(g => g.memberIds.includes(me.id));
        scopeId = g?.id;
        if (!scopeId) {
          // not yet assigned to group
          stageArea.innerHTML = "";
          stageArea.appendChild(el("div", { class: "empty-state" }, [
            el("h4", {}, "모둠 배정을 기다리고 있어요"),
            "교사가 모둠에 배정하면 자동으로 표시됩니다.",
          ]));
          return;
        }
      }
      viewer = renderSlide({
        root: stageArea, slide, session, scope, scopeId,
        readOnly: isPPT,
      });
      viewer.setTool(activeTool); viewer.setColor(activeColor); viewer.setSize(activeSize);
    });
  }
  function slideAt() { return session.slidesSnapshot[session.flow === "teacher" ? session.currentSlide : myIdx]; }
  render();
}

function modeLabel(m) { return ({ none: "PPT 모드", whole: "전체 모드", individual: "개별 모드", group: "그룹 모드" })[m] || m; }

function viewRecords(me) {
  const wrap = el("div", {});
  wrap.appendChild(el("div", { class: "main-header" }, [el("h1", {}, "수업 기록")]));
  const sessions = store.state.sessions.filter(s => s.participants.includes(me.id) && s.status !== "live").sort((a,b) => b.startedAt - a.startedAt);
  if (!sessions.length) {
    wrap.appendChild(el("div", { class: "empty-state" }, [el("h4", {}, "수업 기록이 없습니다"), "수업이 끝나면 자동으로 보관됩니다."]));
    return wrap;
  }
  const list = el("div", { class: "record-list" });
  sessions.forEach(s => {
    const teacher = store.state.teachers.find(t => t.id === s.teacherId);
    const row = el("div", { class: "record-row", onClick: () => openMyRecord(s, me) }, [
      el("div", {}, [el("div", { style: { fontWeight: 600 } }, s.title), el("div", { class: "meta" }, `${teacher?.name || ""} · ${fmtDate(s.startedAt)}`)]),
      el("span", { class: `tag ${s.status}` }, ({ completed: "완료", stopped: "중지" })[s.status]),
    ]);
    list.appendChild(row);
  });
  wrap.appendChild(list);
  return wrap;
}

function openMyRecord(session, me) {
  const body = el("div", {});
  session.slidesSnapshot.forEach((slide, i) => {
    body.appendChild(el("h4", {}, `슬라이드 ${i+1} · ${modeLabel(slide.mode)}`));
    const stage = el("div", { class: "canvas-stage", style: { padding: 0, minHeight: "260px", marginBottom: "12px" } });
    body.appendChild(stage);
    const scope = slide.mode === "individual" ? "individual"
      : slide.mode === "group" ? "group"
      : slide.mode === "whole" ? "whole" : "ppt";
    let scopeId = me.id;
    if (scope === "group") {
      const g = session.groups.find(g => g.memberIds.includes(me.id));
      scopeId = g?.id;
    }
    setTimeout(() => renderSlide({ root: stage, slide, session, scope, scopeId, readOnly: true }), 30);
  });
  modal({ title: session.title, body, actions: [{ label: "닫기", primary: true, onClick: close => close() }] });
}
