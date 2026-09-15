-- ============================================================
-- Reliability migration — run in Supabase SQL Editor
-- ============================================================

-- 1. Add updated_at to syllabus_topics for conflict resolution (last-write-wins)
alter table syllabus_topics
  add column if not exists updated_at timestamptz not null default now();

-- 2. Auto-update trigger on syllabus_topics
create or replace function update_updated_at_column()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_syllabus_topics_updated_at on syllabus_topics;
create trigger trg_syllabus_topics_updated_at
  before update on syllabus_topics
  for each row execute function update_updated_at_column();

-- 3. Enable Realtime for syllabus and timer tables
--    (needed for cross-tab/cross-device live sync in app.js initRealtime())
--    Note: Realtime must also be enabled in Supabase dashboard → Database → Replication
do $$ begin
  alter publication supabase_realtime add table syllabus_topics;
exception when duplicate_object then
  raise notice 'syllabus_topics already in supabase_realtime publication — skipping';
end $$;

do $$ begin
  alter publication supabase_realtime add table timer_sessions;
exception when duplicate_object then
  raise notice 'timer_sessions already in supabase_realtime publication — skipping';
end $$;

-- 4. Increase Supabase Storage bucket size limits
--    (Cloudflare R2 is the primary large-file backend now, but keep Supabase
--     storage working for legacy/small files and users without R2 configured)
insert into storage.buckets (id, name, public, file_size_limit)
values
  ('personal-files', 'personal-files', true, 524288000),
  ('group-files',    'group-files',    true, 524288000)
on conflict (id) do update
  set public = true,
      file_size_limit = 524288000;  -- 500 MB per object (requires Pro plan)

-- ============================================================
-- Cloudflare R2 CORS configuration (must be set in Cloudflare dashboard)
-- Bucket → Settings → CORS Policy → paste and save:
-- [
--   {
--     "AllowedOrigins": ["*"],
--     "AllowedMethods": ["GET", "PUT"],
--     "AllowedHeaders": ["*"],
--     "ExposeHeaders": ["ETag"],
--     "MaxAgeSeconds": 3600
--   }
-- ]
-- Without this, browser PUT to presigned URLs will fail with a CORS error.
-- ============================================================
