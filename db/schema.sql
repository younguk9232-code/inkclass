-- Inkclass v1.0 Supabase schema
-- Run in Supabase SQL Editor (or `supabase db push`).

create extension if not exists pgcrypto;

-- ── Teachers ────────────────────────────────────────────────
create table if not exists teachers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  password_hash text not null,
  join_code text unique,
  created_at timestamptz not null default now()
);
-- 이미 테이블이 존재하던 환경에서도 컬럼 보장
alter table teachers add column if not exists join_code text;
do $$ begin
  create unique index teachers_join_code_uk on teachers(join_code);
exception when duplicate_table then null; when duplicate_object then null; end $$;

-- ── Students ────────────────────────────────────────────────
create table if not exists students (
  id uuid primary key default gen_random_uuid(),
  grade int not null,
  class_num int not null,
  num int not null,
  name text not null,
  created_at timestamptz not null default now(),
  unique (grade, class_num, num, name)
);

-- ── Lessons (slide decks) ───────────────────────────────────
create table if not exists lessons (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references teachers(id) on delete cascade,
  title text not null,
  created_at timestamptz not null default now()
);

create table if not exists slides (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references lessons(id) on delete cascade,
  position int not null,
  bg_path text,         -- supabase storage object path
  bg_url text,          -- public URL or data URL fallback
  gs_embed text,        -- google slides url (optional)
  mode text not null default 'none' check (mode in ('none','whole','individual','group')),
  base_strokes jsonb not null default '[]'::jsonb,
  base_texts jsonb not null default '[]'::jsonb,
  unique (lesson_id, position)
);
create index if not exists idx_slides_lesson on slides(lesson_id);

-- ── Sessions (live class instances) ─────────────────────────
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references lessons(id) on delete cascade,
  teacher_id uuid not null references teachers(id) on delete cascade,
  title text not null,
  status text not null default 'live' check (status in ('live','completed','stopped')),
  flow text not null default 'teacher' check (flow in ('teacher','student')),
  current_slide int not null default 0,
  slides_snapshot jsonb not null default '[]'::jsonb,
  groups jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists idx_sessions_teacher on sessions(teacher_id);
create index if not exists idx_sessions_status on sessions(status);

create table if not exists session_participants (
  session_id uuid not null references sessions(id) on delete cascade,
  student_id uuid not null references students(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (session_id, student_id)
);

-- ── Records: per-slide-per-scope (committed strokes & texts) ─
-- scope = 'whole' | 'individual' | 'group'
-- scope_id = student_id (individual) | group uuid (group) | null (whole)
create table if not exists slide_records (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  slide_id uuid not null,
  scope text not null check (scope in ('whole','individual','group')),
  scope_id uuid,
  strokes jsonb not null default '[]'::jsonb,
  texts jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  unique (session_id, slide_id, scope, scope_id)
);
create index if not exists idx_records_session on slide_records(session_id);
create index if not exists idx_records_lookup on slide_records(session_id, slide_id, scope, scope_id);

-- ── Realtime publication ────────────────────────────────────
-- Enable in Supabase dashboard: Database > Replication > supabase_realtime
-- Add tables: sessions, slide_records, session_participants
do $$
begin
  perform 1 from pg_publication where pubname = 'supabase_realtime';
  if found then
    begin execute 'alter publication supabase_realtime add table sessions'; exception when others then null; end;
    begin execute 'alter publication supabase_realtime add table slide_records'; exception when others then null; end;
    begin execute 'alter publication supabase_realtime add table session_participants'; exception when others then null; end;
    begin execute 'alter publication supabase_realtime add table teachers'; exception when others then null; end;
    begin execute 'alter publication supabase_realtime add table students'; exception when others then null; end;
    begin execute 'alter publication supabase_realtime add table lessons'; exception when others then null; end;
    begin execute 'alter publication supabase_realtime add table slides'; exception when others then null; end;
  end if;
end$$;

-- ── Row Level Security ──────────────────────────────────────
-- For this prototype, allow anon read/write (teacher/student auth lives client-side).
-- For production, switch to Supabase Auth and tighten policies per role.
alter table teachers enable row level security;
alter table students enable row level security;
alter table lessons enable row level security;
alter table slides enable row level security;
alter table sessions enable row level security;
alter table session_participants enable row level security;
alter table slide_records enable row level security;

do $$ begin
  create policy anon_all_teachers on teachers for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy anon_all_students on students for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy anon_all_lessons on lessons for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy anon_all_slides on slides for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy anon_all_sessions on sessions for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy anon_all_participants on session_participants for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy anon_all_records on slide_records for all using (true) with check (true);
exception when duplicate_object then null; end $$;

-- ── Storage bucket for slide backgrounds ────────────────────
-- Run once in dashboard: Storage > New bucket: name=slides, public=true
