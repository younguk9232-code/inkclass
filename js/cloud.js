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
  store.set(s => {
    s.teachers = (teachers || []).map(t => ({ id: t.id, name: t.name, password: "" /* not synced */ }));
    s.students = (students || []).map(x => ({ id: x.id, grade: x.grade, classNum: x.class_num, num: x.num, name: x.name }));
    s.lessons = [...lessonMap.values()];
    s.sessions = [...sessionMap.values()];
  });
  subscribeRealtime();
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
export async function cloudUpsertTeacher(t) {
  if (!isCloud) return t;
  const { data } = await supa.from("teachers").upsert({ id: t.id, name: t.name, password_hash: await sha(t.password || "") }, { onConflict: "id" }).select().single();
  return data || t;
}
export async function cloudUpsertStudent(s) {
  if (!isCloud) return s;
  const { data } = await supa.from("students").upsert({ id: s.id, grade: s.grade, class_num: s.classNum, num: s.num, name: s.name }, { onConflict: "id" }).select().single();
  return data || s;
}
export async function cloudInsertLesson(l) {
  if (!isCloud) return;
  await supa.from("lessons").insert({ id: l.id, teacher_id: l.teacherId, title: l.title });
  for (let i = 0; i < l.slides.length; i++) {
    const s = l.slides[i];
    await supa.from("slides").insert({
      id: s.id, lesson_id: l.id, position: i,
      bg_url: s.bg, gs_embed: s.gsEmbed || null, mode: s.mode,
      base_strokes: s.strokes || [], base_texts: s.texts || []
    });
  }
}
export async function cloudUpsertSession(ss) {
  if (!isCloud) return;
  await supa.from("sessions").upsert({
    id: ss.id, lesson_id: ss.lessonId, teacher_id: ss.teacherId, title: ss.title,
    status: ss.status, flow: ss.flow, current_slide: ss.currentSlide,
    slides_snapshot: ss.slidesSnapshot, groups: ss.groups,
    started_at: new Date(ss.startedAt).toISOString(),
    ended_at: ss.endedAt ? new Date(ss.endedAt).toISOString() : null,
  });
}
export async function cloudAddParticipant(sid, stuId) {
  if (!isCloud) return;
  await supa.from("session_participants").upsert({ session_id: sid, student_id: stuId });
}
export async function cloudWriteRecord(sessionId, slideId, scope, scopeId, payload) {
  if (!isCloud) return;
  await supa.from("slide_records").upsert({
    session_id: sessionId, slide_id: slideId, scope, scope_id: scopeId,
    strokes: payload.strokes || [], texts: payload.texts || [],
    updated_at: new Date().toISOString(),
  }, { onConflict: "session_id,slide_id,scope,scope_id" });
}

async function sha(s) {
  const buf = new TextEncoder().encode(s);
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}
