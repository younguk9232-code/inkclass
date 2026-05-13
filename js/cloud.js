// Optional Supabase cloud adapter.
// Activated when window.INKCLASS_SUPABASE_URL & ANON_KEY are present (set in /env.js).
// Otherwise the app gracefully falls back to localStorage + BroadcastChannel only,
// so the deployed app is fully functional in single-browser demo mode out of the box.

import { store } from "./store.js";

let supa = null;
let liveCh = null;     // realtime channel for the current live session
let isCloud = false;

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
    s.teachers = (teachers || []).map(t => ({ id: t.id, name: t.name, password: "" /* not synced */, joinCode: t.join_code || null }));
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

function subscribeRealtime() {
  // Subscribe to all mutating tables and refresh on change.
  supa.channel("ink-global")
    .on("postgres_changes", { event: "*", schema: "public", table: "sessions" }, refresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "slide_records" }, refresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "session_participants" }, refresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "lessons" }, refresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "slides" }, refresh)
    .subscribe();
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

export async function cloudUpsertTeacher(t) {
  if (!isCloud) return t;
  const payload = { id: t.id, name: t.name, password_hash: await sha(t.password || "") };
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
export async function cloudUpsertSession(ss) {
  if (!isCloud) return;
  const { error } = await supa.from("sessions").upsert({
    id: ss.id, lesson_id: ss.lessonId, teacher_id: ss.teacherId, title: ss.title,
    status: ss.status, flow: ss.flow, current_slide: ss.currentSlide,
    slides_snapshot: ss.slidesSnapshot, groups: ss.groups,
    started_at: new Date(ss.startedAt).toISOString(),
    ended_at: ss.endedAt ? new Date(ss.endedAt).toISOString() : null,
  }, { onConflict: "id" });
  logErr("upsertSession", error);
}
export async function cloudAddParticipant(sid, stuId) {
  if (!isCloud) return;
  const { error } = await supa.from("session_participants").upsert({ session_id: sid, student_id: stuId });
  logErr("addParticipant", error);
}
export async function cloudWriteRecord(sessionId, slideId, scope, scopeId, payload) {
  if (!isCloud) return;
  const { error } = await supa.from("slide_records").upsert({
    session_id: sessionId, slide_id: slideId, scope, scope_id: scopeId,
    strokes: payload.strokes || [], texts: payload.texts || [],
    updated_at: new Date().toISOString(),
  }, { onConflict: "session_id,slide_id,scope,scope_id" });
  logErr("writeRecord", error);
}

async function sha(s) {
  const buf = new TextEncoder().encode(s);
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}
