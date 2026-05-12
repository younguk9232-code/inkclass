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

// Student login
route("/student-login", (params) => {
  const v = template("tpl-student-login");
  mount(v);
  v.querySelector(".back").onclick = () => go("/");
  v.querySelector("#s-submit").onclick = () => {
    const grade = parseInt(v.querySelector("#s-grade").value);
    const classNum = parseInt(v.querySelector("#s-class").value);
    const num = parseInt(v.querySelector("#s-num").value);
    const name = v.querySelector("#s-name").value.trim();
    const err = v.querySelector("#s-err");
    err.textContent = "";
    if (!grade || !classNum || !num || !name) { err.textContent = "모든 항목을 입력해 주세요."; return; }
    let s = store.state.students.find(x => x.grade === grade && x.classNum === classNum && x.num === num && x.name === name);
    if (!s) {
      s = { id: store.newId("s"), grade, classNum, num, name };
      store.set(st => st.students.push(s));
    }
    store.set(st => st.whoStudent = s.id);
    go("/student");
  };
});

// QR-driven student join: /student/join?t=<teacherId>
route("/student/join", (params) => {
  // If already logged in, attempt to enter that teacher's live session
  const me = store.state.students.find(x => x.id === store.state.whoStudent);
  if (!me) { go("/student-login"); return; }
  const target = store.state.sessions.find(s => s.teacherId === params.t && s.status === "live");
  if (target) {
    if (!target.participants.includes(me.id)) {
      target.participants.push(me.id);
      store.set(s => s);
    }
    go("/student/live/" + target.id);
  } else {
    alert("진행 중인 수업이 없습니다.");
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
