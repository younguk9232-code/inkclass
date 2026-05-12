// Bootstrap: routes, auth, dispatch.
import { route, start, go } from "./router.js";
import { mount, template, $, $$ } from "./ui.js";
import { store } from "./store.js";
import { teacherDashboard, editorView } from "./teacher.js";
import { studentDashboard, studentLive } from "./student.js";
import { initCloud, cloudEnabled } from "./cloud.js";

// Kick off cloud sync (no-op if env not configured)
initCloud().then(ok => {
  if (ok) console.info("Inkclass: cloud sync via Supabase enabled");
  else console.info("Inkclass: local mode (Supabase not configured)");
});

// Landing
route("/", () => {
  const v = template("tpl-landing");
  mount(v);
  v.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => go("/" + b.dataset.go)));
});

// Teacher login
route("/teacher-login", () => {
  const v = template("tpl-teacher-login");
  mount(v);
  v.querySelector(".back").onclick = () => go("/");
  v.querySelector("#t-submit").onclick = () => {
    const name = v.querySelector("#t-name").value.trim();
    const pw = v.querySelector("#t-pw").value;
    const err = v.querySelector("#t-err");
    err.textContent = "";
    if (!name || !pw) { err.textContent = "이름과 비밀번호를 입력해 주세요."; return; }
    let t = store.state.teachers.find(x => x.name === name);
    if (!t) {
      t = { id: store.newId("t"), name, password: pw };
      store.set(s => s.teachers.push(t));
    } else if (t.password !== pw) {
      err.textContent = "비밀번호가 일치하지 않습니다.";
      return;
    }
    store.set(s => s.whoTeacher = t.id);
    go("/teacher");
  };
});

// Student login (with optional 'c' = join code prefill from QR)
route("/student-login", (params) => {
  const v = template("tpl-student-login");
  mount(v);
  v.querySelector(".back").onclick = () => go("/");

  const codeInput = v.querySelector("#s-code");
  // QR로 진입 시 코드 자동 채움 (URL 파라미터 c 또는 sessionStorage 인계)
  const presetCode = (params && params.c) ? params.c : sessionStorage.getItem("inkclass:joinCode");
  if (presetCode) codeInput.value = presetCode.toUpperCase();
  // 입력은 항상 대문자로 정규화
  codeInput.addEventListener("input", () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6); });

  v.querySelector("#s-submit").onclick = () => {
    const code = (codeInput.value || "").toUpperCase().trim();
    const grade = parseInt(v.querySelector("#s-grade").value);
    const classNum = parseInt(v.querySelector("#s-class").value);
    const num = parseInt(v.querySelector("#s-num").value);
    const name = v.querySelector("#s-name").value.trim();
    const err = v.querySelector("#s-err");
    err.textContent = "";
    if (!code) { err.textContent = "수업 코드를 입력해 주세요. (선생님이 화면 또는 QR로 안내한 6자리)"; return; }
    if (!grade || !classNum || !num || !name) { err.textContent = "학년·반·번호·이름을 모두 입력해 주세요."; return; }

    const target = store.state.sessions.find(s => s.status === "live" && (s.joinCode || "").toUpperCase() === code);
    if (!target) { err.textContent = "해당 코드의 진행 중인 수업을 찾지 못했어요. 코드를 다시 확인해 주세요."; return; }

    let me = store.state.students.find(x => x.grade === grade && x.classNum === classNum && x.num === num && x.name === name);
    if (!me) {
      me = { id: store.newId("s"), grade, classNum, num, name };
      store.set(st => st.students.push(me));
    }
    store.set(st => {
      st.whoStudent = me.id;
      const ss = st.sessions.find(x => x.id === target.id);
      if (ss && !ss.participants.includes(me.id)) ss.participants.push(me.id);
    });
    sessionStorage.removeItem("inkclass:joinCode");
    go("/student/live/" + target.id);
  };
});

// QR-driven student join: /student/join?c=<joinCode> (legacy: ?t=<teacherId>)
route("/student/join", (params) => {
  let code = (params.c || "").toUpperCase();
  // 레거시 t= 파라미터 지원: 해당 교사의 LIVE 세션 코드를 찾아 사용
  if (!code && params.t) {
    const live = store.state.sessions.find(s => s.teacherId === params.t && s.status === "live");
    if (live) code = (live.joinCode || "").toUpperCase();
  }

  const me = store.state.students.find(x => x.id === store.state.whoStudent);
  if (!me) {
    if (code) sessionStorage.setItem("inkclass:joinCode", code);
    go("/student-login");
    return;
  }
  const target = code
    ? store.state.sessions.find(s => s.status === "live" && (s.joinCode || "").toUpperCase() === code)
    : store.state.sessions.find(s => s.status === "live"); // 코드 없으면 진행 중인 아무 LIVE
  if (target) {
    if (!target.participants.includes(me.id)) {
      target.participants.push(me.id);
      store.set(s => s);
    }
    go("/student/live/" + target.id);
  } else {
    alert("해당 코드의 진행 중인 수업이 없습니다.\n선생님께 코드를 확인해 주세요.");
    go("/student");
  }
});

// Teacher dashboard
route("/teacher", () => {
  if (!store.state.whoTeacher) { go("/teacher-login"); return; }
  return teacherDashboard();
});

// Teacher dashboard tabs (live shortcut)
route("/teacher/live", () => {
  if (!store.state.whoTeacher) { go("/teacher-login"); return; }
  const cleanup = teacherDashboard();
  // simulate tab click
  setTimeout(() => {
    const btn = document.querySelector('.nav-item[data-tab="live"]');
    if (btn) btn.click();
  }, 0);
  return cleanup;
});

// Editor
route("/editor/:id", (p) => {
  if (!store.state.whoTeacher) { go("/teacher-login"); return; }
  editorView(p);
});

// Student dashboard
route("/student", () => {
  if (!store.state.whoStudent) { go("/student-login"); return; }
  return studentDashboard();
});
route("/student/live/:id", (p) => {
  if (!store.state.whoStudent) { go("/student-login"); return; }
  studentLive(p);
});

start();
