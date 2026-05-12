// Local persistence + simple reactive store
const KEY = "inkclass:v1";

const initial = {
  teachers: [], // {id, name, password}
  students: [], // {id, grade, classNum, num, name}
  lessons: [],  // {id, teacherId, title, createdAt, slides:[{id, bg, mode, strokes, texts}]}
  sessions: [], // {id, lessonId, teacherId, title, status, flow, currentSlide, startedAt, endedAt,
                //   participants:[studentId], groups:[{id,name,memberIds:[]}], records:{studentId:{slideId:{strokes:[],texts:[]}}}}
  whoTeacher: null,
  whoStudent: null,
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(initial);
    return { ...structuredClone(initial), ...JSON.parse(raw) };
  } catch (e) { return structuredClone(initial); }
}
function save(state) {
  // strip very large data urls? keep as-is for now
  localStorage.setItem(KEY, JSON.stringify(state));
}

export const store = {
  state: load(),
  listeners: new Set(),
  set(updater) {
    if (typeof updater === "function") updater(this.state);
    else Object.assign(this.state, updater);
    save(this.state);
    this.listeners.forEach(fn => fn(this.state));
  },
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  // helpers
  newId(prefix = "id") { return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36)}`; },
  // 교사 고유 6자리 수업 코드 (혼동 쉬운 0/O, 1/I 제거). 한 번 발급되면 변경되지 않음.
  newJoinCode() {
    const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const used = new Set((this.state.teachers || []).map(t => (t.joinCode || "").toUpperCase()).filter(Boolean));
    for (let tries = 0; tries < 100; tries++) {
      let c = "";
      for (let i = 0; i < 6; i++) c += A[Math.floor(Math.random() * A.length)];
      if (!used.has(c)) return c;
    }
    return Date.now().toString(36).toUpperCase().slice(-6);
  },
  // 코드로 교사 찾기
  findTeacherByCode(code) {
    const c = (code || "").toUpperCase().trim();
    if (!c) return null;
    return (this.state.teachers || []).find(t => (t.joinCode || "").toUpperCase() === c) || null;
  },
};

export function getActiveSession(state = store.state) {
  return state.sessions.find(s => s.status === "live") || null;
}

export function findLesson(id, state = store.state) {
  return state.lessons.find(l => l.id === id);
}
export function findSession(id, state = store.state) {
  return state.sessions.find(s => s.id === id);
}
export function findStudent(id, state = store.state) {
  return state.students.find(s => s.id === id);
}
export function studentLabel(s) {
  if (!s) return "—";
  return `${s.grade}-${s.classNum}-${s.num} ${s.name}`;
}

// Make available from devtools
window.__store = store;
