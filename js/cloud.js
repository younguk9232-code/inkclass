// Optional Supabase cloud adapter.
// Activated when window.INKCLASS_SUPABASE_URL & ANON_KEY are present (set in /env.js).
// Otherwise the app gracefully falls back to localStorage + BroadcastChannel only,
// so the deployed app is fully functional in single-browser demo mode out of the box.

import { store } from "./store.js";

let supa = null;
let liveCh = null;     // realtime channel for the current live session
let isCloud = false;

// 🆔 이 클라이언트의 고유 식별자 (탭 단위로 유지). 자기 자신의 echo 무시용.
const CLIENT_ID = (() => {
  try {
    let id = sessionStorage.getItem("inkclass:cid");
    if (!id) {
      id = "cli_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      sessionStorage.setItem("inkclass:cid", id);
    }
    return id;
  } catch (_) {
    return "cli_" + Math.random().toString(36).slice(2, 10);
  }
})();
export function clientId() { return CLIENT_ID; }

export function cloudEnabled() { return isCloud; }

export async function initCloud() {
  const url = window.INKCLASS_SUPABASE_URL;
  const key = window.INKCLASS_SUPABASE_ANON;
  if (!url || !key || url.includes("YOUR_")) return false;
  try {
    const mod = await import("https://esm.sh/@supabase/supabase-js@2");
    supa = mod.createClient(url, key, { realtime: { params: { eventsPerSecond: 30 } } });
    isCloud = true;
    await pullSnapshot();
    return true;
  } catch (e) {
    console.warn("Supabase init failed, staying in local mode:", e);
    return false;
  }
}

// One-time pull of the full state on boot.
async function pullSnapshot() {
  const [{ data: teachers }, { data: students }, { data: lessons }, { data: slides }, { data: sessions }, { data: parts }, { data: records }] = await Promise.all([
    supa.from("teachers").select("*"),
    supa.from("students").select("*"),
    supa.from("lessons").select("*"),
    supa.from("slides").select("*").order("position", { ascending: true }),
    supa.from("sessions").select("*"),
    supa.from("session_participants").select("*"),
    supa.from("slide_records").select("*"),
  ]);
  // Reshape to client-side shape
  const lessonMap = new Map();
  (lessons || []).forEach(l => lessonMap.set(l.id, {
    id: l.id, teacherId: l.teacher_id, title: l.title, createdAt: +new Date(l.created_at),
    slides: [],
  }));
  (slides || []).forEach(s => {
    const l = lessonMap.get(s.lesson_id);
    if (!l) return;
    l.slides[s.position] = {
      id: s.id, bg: s.bg_url, gsEmbed: s.gs_embed, mode: s.mode,
      strokes: s.base_strokes || [], texts: s.base_texts || [],
    };
  });
  const sessionMap = new Map();
  (sessions || []).forEach(s => sessionMap.set(s.id, {
    id: s.id, lessonId: s.lesson_id, teacherId: s.teacher_id, title: s.title, status: s.status,
    flow: s.flow, currentSlide: s.current_slide,
    slidesSnapshot: s.slides_snapshot || [], groups: s.groups || [],
    startedAt: +new Date(s.started_at), endedAt: s.ended_at ? +new Date(s.ended_at) : null,
    participants: [], records: {},
  }));
  (parts || []).forEach(p => {
    const ss = sessionMap.get(p.session_id);
    if (ss && !ss.participants.includes(p.student_id)) ss.participants.push(p.student_id);
  });
  (records || []).forEach(r => {
    const ss = sessionMap.get(r.session_id);
    if (!ss) return;
    if (r.scope === "whole") {
      ss.records.__whole ||= {};
      ss.records.__whole[r.slide_id] = { strokes: r.strokes || [], texts: r.texts || [] };
    } else if (r.scope === "individual") {
      ss.records[r.scope_id] ||= {};
      ss.records[r.scope_id][r.slide_id] = { strokes: r.strokes || [], texts: r.texts || [] };
    } else if (r.scope === "group") {
      ss.records.__groups ||= {};
      ss.records.__groups[r.scope_id] ||= {};
      ss.records.__groups[r.scope_id][r.slide_id] = { strokes: r.strokes || [], texts: r.texts || [] };
    }
  });
  const cloudEmpty = (teachers || []).length === 0 && (lessons || []).length === 0 && (sessions || []).length === 0;
  const localHasData = (store.state.teachers || []).length > 0 || (store.state.lessons || []).length > 0 || (store.state.sessions || []).length > 0;

  if (cloudEmpty && localHasData) {
    // 🛡️ 안전장치: 클라우드가 비어있는데 로컬에 데이터가 있다 = 첫 클라우드 활성화.
    // 로컬을 보존하고 오히려 클라우드로 푸시 (마이그레이션).
    console.info("Inkclass: cloud is empty, migrating local data to cloud…");
    await migrateLocalToCloud();
    subscribeRealtime();
    return;
  }

  store.set(s => {
    s.teachers = (teachers || []).map(t => ({
      id: t.id,
      name: t.name,
      passwordHash: t.password_hash || "",
      joinCode: t.join_code || null,
    }));
    s.students = (students || []).map(x => ({ id: x.id, grade: x.grade, classNum: x.class_num, num: x.num, name: x.name }));
    s.lessons = [...lessonMap.values()];
    s.sessions = [...sessionMap.values()];
  });
  subscribeRealtime();
}

// 로컬 → 클라우드 일회성 마이그레이션 (첫 활성화 시)
async function migrateLocalToCloud() {
  const st = store.state;
  for (const t of (st.teachers || [])) {
    await cloudUpsertTeacher(t).catch(e => console.warn("migrate teacher fail:", e));
  }
  for (const s of (st.students || [])) {
    await cloudUpsertStudent(s).catch(e => console.warn("migrate student fail:", e));
  }
  for (const l of (st.lessons || [])) {
    await cloudInsertLesson(l).catch(e => console.warn("migrate lesson fail:", e));
  }
  for (const ss of (st.sessions || [])) {
    await cloudUpsertSession(ss).catch(e => console.warn("migrate session fail:", e));
    for (const stuId of (ss.participants || [])) {
      await cloudAddParticipant(ss.id, stuId).catch(() => {});
    }
    // records flatten
    const recs = ss.records || {};
    if (recs.__whole) {
      for (const [slideId, payload] of Object.entries(recs.__whole)) {
        await cloudWriteRecord(ss.id, slideId, "whole", null, payload).catch(() => {});
      }
    }
    for (const [k, v] of Object.entries(recs)) {
      if (k === "__whole" || k === "__groups") continue;
      // individual scope
      for (const [slideId, payload] of Object.entries(v)) {
        await cloudWriteRecord(ss.id, slideId, "individual", k, payload).catch(() => {});
      }
    }
    if (recs.__groups) {
      for (const [gid, slidesMap] of Object.entries(recs.__groups)) {
        for (const [slideId, payload] of Object.entries(slidesMap)) {
          await cloudWriteRecord(ss.id, slideId, "group", gid, payload).catch(() => {});
        }
      }
    }
  }
  console.info("Inkclass: migration complete.");
}

let _subscribed = false;
function subscribeRealtime() {
  // Supabase 채널은 한 번만 subscribe 가능. 중복 호출 시 throw.
  if (_subscribed) return;
  _subscribed = true;
  supa.channel("ink-global")
    .on("postgres_changes", { event: "*", schema: "public", table: "sessions" }, refreshIfOther)
    .on("postgres_changes", { event: "*", schema: "public", table: "slide_records" }, refreshIfOther)
    .on("postgres_changes", { event: "*", schema: "public", table: "session_participants" }, refresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "lessons" }, refresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "slides" }, refresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "teachers" }, refresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "students" }, refresh)
    .subscribe();
}

// 🚫 자기 자신이 마지막 writer면 refresh 하지 않음 (필기 끊김 방지의 핵심)
function refreshIfOther(payload) {
  const writer = payload?.new?.last_writer || payload?.old?.last_writer;
  if (writer && writer === CLIENT_ID) return; // echo
  refresh();
}

let _refreshTimer = null;
function refresh() {
  clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(() => pullSnapshot(), 300);
}

// ── Write helpers (best-effort, no-op if cloud disabled) ──
function logErr(label, err) {
  if (err) console.error(`[cloud] ${label} 실패:`, err.message || err, err);
}

// 이름으로 교사를 클라우드에서 직접 조회 (로그인 시 로컬 stale 회피)
export async function cloudFetchTeacherByName(name) {
  if (!isCloud) return null;
  const { data, error } = await supa.from("teachers").select("*").eq("name", name).maybeSingle();
  logErr("fetchTeacherByName", error);
  if (!data) return null;
  return { id: data.id, name: data.name, passwordHash: data.password_hash || "", joinCode: data.join_code || null };
}

export async function cloudUpsertTeacher(t) {
  if (!isCloud) return t;
  // passwordHash가 있으면 그대로, 아니면 password 평문을 해시
  const ph = t.passwordHash || (t.password ? await sha(t.password) : "");
  const payload = { id: t.id, name: t.name, password_hash: ph };
  if (t.joinCode) payload.join_code = t.joinCode;
  const { data, error } = await supa.from("teachers").upsert(payload, { onConflict: "id" }).select().single();
  logErr("upsertTeacher", error);
  return data || t;
}
export async function cloudUpsertStudent(s) {
  if (!isCloud) return s;
  const { data, error } = await supa.from("students").upsert({ id: s.id, grade: s.grade, class_num: s.classNum, num: s.num, name: s.name }, { onConflict: "id" }).select().single();
  logErr("upsertStudent", error);
  return data || s;
}
export async function cloudInsertLesson(l) {
  if (!isCloud) return;
  const { error: e1 } = await supa.from("lessons").upsert({ id: l.id, teacher_id: l.teacherId, title: l.title }, { onConflict: "id" });
  logErr("upsertLesson", e1);
  for (let i = 0; i < l.slides.length; i++) {
    const s = l.slides[i];
    const { error: e2 } = await supa.from("slides").upsert({
      id: s.id, lesson_id: l.id, position: i,
      bg_url: s.bg, gs_embed: s.gsEmbed || null, mode: s.mode,
      base_strokes: s.strokes || [], base_texts: s.texts || []
    }, { onConflict: "id" });
    logErr(`upsertSlide#${i}`, e2);
  }
}
// 일부 컬럼(last_writer)이 DB에 없을 수도 있으므로 동적으로 시도 후 fallback.
// 한 번 fail 하면 localStorage에 결과 캐시 → 새로고침해도 첫 시도부터 우회.
let _sessionsHasLastWriter = localStorage.getItem("inkclass:lw_sessions") !== "no";
let _recordsHasLastWriter = localStorage.getItem("inkclass:lw_records") !== "no";
function markNoLW(which) {
  if (which === "sessions") { _sessionsHasLastWriter = false; try { localStorage.setItem("inkclass:lw_sessions", "no"); } catch (_) {} }
  if (which === "records") { _recordsHasLastWriter = false; try { localStorage.setItem("inkclass:lw_records", "no"); } catch (_) {} }
}

export async function cloudUpsertSession(ss) {
  if (!isCloud) return;
  const base = {
    id: ss.id, lesson_id: ss.lessonId, teacher_id: ss.teacherId, title: ss.title,
    status: ss.status, flow: ss.flow, current_slide: ss.currentSlide,
    slides_snapshot: ss.slidesSnapshot, groups: ss.groups,
    started_at: new Date(ss.startedAt).toISOString(),
    ended_at: ss.endedAt ? new Date(ss.endedAt).toISOString() : null,
  };
  const payload = _sessionsHasLastWriter ? { ...base, last_writer: CLIENT_ID } : base;
  let { error } = await supa.from("sessions").upsert(payload, { onConflict: "id" });
  if (error && (error.code === "PGRST204" || /last_writer/.test(error.message || ""))) {
    markNoLW("sessions");
    ({ error } = await supa.from("sessions").upsert(base, { onConflict: "id" }));
  }
  logErr("upsertSession", error);
}
export async function cloudAddParticipant(sid, stuId) {
  if (!isCloud) return;
  const { error } = await supa.from("session_participants").upsert({ session_id: sid, student_id: stuId });
  logErr("addParticipant", error);
}
export async function cloudWriteRecord(sessionId, slideId, scope, scopeId, payload) {
  if (!isCloud) return;
  const base = {
    session_id: sessionId, slide_id: slideId, scope, scope_id: scopeId,
    strokes: payload.strokes || [], texts: payload.texts || [],
    updated_at: new Date().toISOString(),
  };
  const body = _recordsHasLastWriter ? { ...base, last_writer: CLIENT_ID } : base;
  let { error } = await supa.from("slide_records").upsert(body, { onConflict: "session_id,slide_id,scope,scope_id" });
  if (error && (error.code === "PGRST204" || /last_writer/.test(error.message || ""))) {
    markNoLW("records");
    ({ error } = await supa.from("slide_records").upsert(base, { onConflict: "session_id,slide_id,scope,scope_id" }));
  }
  logErr("writeRecord", error);
}

export async function sha(s) {
  const buf = new TextEncoder().encode(s);
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}
