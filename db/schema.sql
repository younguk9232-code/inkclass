-- Inkclass schema v1.6 — text-id 기반 (클라이언트 store.newId() 형식과 호환)
-- ⚠️ 기존 uuid 기반 테이블이 있다면 DROP 후 재생성합니다 (현재 데이터는 사실상 비어 있어서 안전).
-- Run in Supabase SQL Editor.

-- ── 옛 테이블 제거 (cascade) ─────────────────────────────────
drop table if exists slide_records cascade;
drop table if exists session_participants cascade;
drop table if exists sessions cascade;
drop table if exists slides cascade;
drop table if exists lessons cascade;
drop table if exists students cascade;
drop table if exists teachers cascade;

-- ── Teachers (text id, 클라이언트 발급) ─────────────────────
create table teachers (
  id text primary key,
  name text not null unique,
  password_hash text not null default '',
  join_code text unique,
  created_at timestamptz not null default now()
);

-- ── Students ────────────────────────────────────────────────
create table students (
  id text primary key,
  grade int not null,
  class_num int not null,
  num int not null,
  name text not null,
  created_at timestamptz not null default now(),
  unique (grade, class_num, num, name)
);

-- ── Lessons (slide decks) ───────────────────────────────────
create table lessons (
  id text primary key,
  teacher_id text not null references teachers(id) on delete cascade,
  title text not null,
  created_at timestamptz not null default now()
);

create table slides (
  id text primary key,
  lesson_id text not null references lessons(id) on delete cascade,
  position int not null,
  bg_path text,
  bg_url text,
  gs_embed text,
  mode text not null default 'none' check (mode in ('none','whole','individual','group')),
  base_strokes jsonb not null default '[]'::jsonb,
  base_texts jsonb not null default '[]'::jsonb,
  unique (lesson_id, position)
);
create index idx_slides_lesson on slides(lesson_id);

-- ── Sessions (live class instances) ─────────────────────────
create table sessions (
  id text primary key,
  lesson_id text not null references lessons(id) on delete cascade,
  teacher_id text not null references teachers(id) on delete cascade,
  title text not null,
  status text not null default 'live' check (status in ('live','completed','stopped')),
  flow text not null default 'teacher' check (flow in ('teacher','student')),
  current_slide int not null default 0,
  slides_snapshot jsonb not null default '[]'::jsonb,
  groups jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index idx_sessions_teacher on sessions(teacher_id);
create index idx_sessions_status on sessions(status);

create table session_participants (
  session_id text not null references sessions(id) on delete cascade,
  student_id text not null references students(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (session_id, student_id)
);

-- ── Records: per-slide-per-scope ────────────────────────────
-- scope = 'whole' | 'individual' | 'group'
-- scope_id = student_id (individual) | group id (group) | NULL (whole)
create table slide_records (
  id bigserial primary key,
  session_id text not null references sessions(id) on delete cascade,
  slide_id text not null,
  scope text not null check (scope in ('whole','individual','group')),
  scope_id text,
  strokes jsonb not null default '[]'::jsonb,
  texts jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  unique (session_id, slide_id, scope, scope_id)
);
create index idx_records_session on slide_records(session_id);
create index idx_records_lookup on slide_records(session_id, slide_id, scope, scope_id);

-- ── Realtime publication ────────────────────────────────────
do $$
begin
  perform 1 from pg_publication where pubname = 'supabase_realtime';
  if found then
    begin execute 'alter publication supabase_realtime add table teachers'; exception when others then null; end;
    begin execute 'alter publication supabase_realtime add table students'; exception when others then null; end;
    begin execute 'alter publication supabase_realtime add table lessons'; exception when others then null; end;
    begin execute 'alter publication supabase_realtime add table slides'; exception when others then null; end;
    begin execute 'alter publication supabase_realtime add table sessions'; exception when others then null; end;
    begin execute 'alter publication supabase_realtime add table session_participants'; exception when others then null; end;
    begin execute 'alter publication supabase_realtime add table slide_records'; exception when others then null; end;
  end if;
end$$;

-- ── Row Level Security: anon read/write 허용 (프로토타입) ──
alter table teachers enable row level security;
alter table students enable row level security;
alter table lessons enable row level security;
alter table slides enable row level security;
alter table sessions enable row level security;
alter table session_participants enable row level security;
alter table slide_records enable row level security;

create policy anon_all_teachers on teachers for all using (true) with check (true);
create policy anon_all_students on students for all using (true) with check (true);
create policy anon_all_lessons on lessons for all using (true) with check (true);
create policy anon_all_slides on slides for all using (true) with check (true);
create policy anon_all_sessions on sessions for all using (true) with check (true);
create policy anon_all_participants on session_participants for all using (true) with check (true);
create policy anon_all_records on slide_records for all using (true) with check (true);

-- ── Storage bucket (수동) ──────────────────────────────────
-- Dashboard > Storage > New bucket: name=slides, public=true
