-- ============================================================
--  ToolReup Video — Schema khởi tạo (Supabase / Postgres)
--  Ánh xạ theo sơ đồ kiến trúc 10 khối:
--    1,2,7  Nguồn & theo dõi kênh / page
--    2,3,4  Video & sản xuất
--    5,9    Hàng đợi & lịch đăng
--    6      Affiliate
--    8      Đo lường
--  Auth dùng Supabase (auth.users). RLS: mỗi user chỉ thấy dữ liệu của mình.
--  Chạy: dán vào Supabase SQL Editor, hoặc `supabase db push`.
-- ============================================================

create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- ---------- ENUMS ----------
do $$ begin
  create type platform_source as enum ('douyin','tiktok','youtube','xiaohongshu','facebook');
exception when duplicate_object then null; end $$;

do $$ begin
  create type platform_target as enum ('facebook','instagram','tiktok','youtube');
exception when duplicate_object then null; end $$;

do $$ begin
  create type video_status as enum ('new','queued','processing','done','failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type job_kind as enum ('ingest','process','upload','comment');
exception when duplicate_object then null; end $$;

do $$ begin
  create type job_status as enum ('pending','running','done','failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type schedule_status as enum ('pending','publishing','posted','failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type comment_status as enum ('pending','commented','failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type affiliate_platform as enum ('shopee','lazada','tiktok_shop','web','other');
exception when duplicate_object then null; end $$;

-- ---------- TRIGGER: tự cập nhật updated_at ----------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ============================================================
--  KHỐI 1,2,7 — Nguồn theo dõi & Page đăng
-- ============================================================

-- Kênh NGUỒN để cào về (Douyin/TikTok/YouTube/Xiaohongshu/Facebook)
create table if not exists channels (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users(id) on delete cascade,
  platform       platform_source not null,
  channel_ref    text not null,                 -- link kênh hoặc sec_user_id / handle
  display_name   text,
  is_monitored   boolean not null default false,-- có cào tự động hằng ngày không
  crawl_freq     text not null default 'daily', -- daily | hourly | manual
  last_crawled_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (owner_id, platform, channel_ref)
);

-- Page/Kênh ĐÍCH để đăng lên (khác channels: nơi đăng, không phải nơi lấy)
create table if not exists pages (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users(id) on delete cascade,
  platform       platform_target not null,
  page_name      text not null,
  credential_ref text,                          -- id/khóa cấu hình đăng (vd tài khoản upload-post)
  group_name     text,                          -- phân nhóm page/kênh
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ============================================================
--  KHỐI 2,3,4 — Video nguồn & Video thành phẩm
-- ============================================================

-- Video CÀO VỀ từ một kênh nguồn (thay thế manifest.json)
create table if not exists source_videos (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users(id) on delete cascade,
  channel_id        uuid references channels(id) on delete set null,
  platform          platform_source not null,
  platform_video_id text not null,              -- aweme_id / video id gốc
  descr             text,
  cover_url         text,
  original_url      text,
  drive_id          text,                        -- file gốc trên Google Drive
  duration          numeric,
  selected          boolean not null default false,
  status            video_status not null default 'new',
  crawled_at        timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (owner_id, platform, platform_video_id)
);

-- Video ĐÃ XỬ LÝ (dịch + lồng tiếng + ghép) — output chờ đăng
create table if not exists processed_videos (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users(id) on delete cascade,
  source_video_id  uuid not null references source_videos(id) on delete cascade,
  final_path       text,
  final_drive_id   text,
  target_lang      text not null default 'vi',
  voice_id         text,
  has_subtitle     boolean not null default false,
  category         text,                         -- phân loại chủ đề (khối 4)
  status           video_status not null default 'new',
  produced_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ============================================================
--  KHỐI 5,9 — Hàng đợi tác vụ & Lịch đăng
-- ============================================================

create table if not exists jobs (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  kind         job_kind not null,
  payload      jsonb not null default '{}'::jsonb,
  status       job_status not null default 'pending',
  progress     int not null default 0,          -- 0..100
  current_step text,
  error        text,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz
);

create table if not exists schedules (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references auth.users(id) on delete cascade,
  processed_video_id uuid not null references processed_videos(id) on delete cascade,
  page_id            uuid not null references pages(id) on delete cascade,
  caption            text,
  publish_at         timestamptz not null,
  status             schedule_status not null default 'pending',
  posted_at          timestamptz,
  post_ref           text,                        -- id bài đăng trả về từ nền tảng
  error              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ============================================================
--  KHỐI 6 — Affiliate
-- ============================================================

create table if not exists affiliate_links (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  url        text not null,
  platform   affiliate_platform not null default 'shopee',
  keywords   text[],                              -- gợi ý gắn theo chủ đề/từ khóa
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Comment gắn link affiliate sau khi đăng
create table if not exists post_comments (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references auth.users(id) on delete cascade,
  schedule_id        uuid not null references schedules(id) on delete cascade,
  affiliate_link_id  uuid references affiliate_links(id) on delete set null,
  comment_text       text,
  status             comment_status not null default 'pending',
  commented_at       timestamptz,
  error              text,
  created_at         timestamptz not null default now()
);

-- ============================================================
--  KHỐI 8 — Đo lường & báo cáo
-- ============================================================

create table if not exists metrics (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references auth.users(id) on delete cascade,
  schedule_id        uuid references schedules(id) on delete cascade,
  processed_video_id uuid references processed_videos(id) on delete cascade,
  page_id            uuid references pages(id) on delete set null,
  views              bigint not null default 0,
  likes              bigint not null default 0,
  shares             bigint not null default 0,
  comments           bigint not null default 0,
  ctr                numeric,                      -- CTR link affiliate
  revenue            numeric not null default 0,   -- doanh số affiliate
  collected_at       timestamptz not null default now()
);

-- ============================================================
--  INDEXES
-- ============================================================
create index if not exists idx_channels_owner        on channels(owner_id);
create index if not exists idx_channels_monitored     on channels(owner_id, is_monitored);
create index if not exists idx_pages_owner            on pages(owner_id);
create index if not exists idx_source_videos_owner    on source_videos(owner_id);
create index if not exists idx_source_videos_channel  on source_videos(channel_id);
create index if not exists idx_source_videos_status   on source_videos(owner_id, status);
create index if not exists idx_processed_owner        on processed_videos(owner_id);
create index if not exists idx_processed_source       on processed_videos(source_video_id);
create index if not exists idx_jobs_owner_status      on jobs(owner_id, status);
create index if not exists idx_schedules_owner        on schedules(owner_id);
create index if not exists idx_schedules_due          on schedules(status, publish_at);
create index if not exists idx_affiliate_owner        on affiliate_links(owner_id);
create index if not exists idx_comments_schedule      on post_comments(schedule_id);
create index if not exists idx_metrics_owner          on metrics(owner_id);
create index if not exists idx_metrics_schedule       on metrics(schedule_id);

-- ============================================================
--  TRIGGERS updated_at
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array[
    'channels','pages','source_videos','processed_videos','schedules','affiliate_links'
  ] loop
    execute format(
      'drop trigger if exists trg_%1$s_updated on %1$s;
       create trigger trg_%1$s_updated before update on %1$s
       for each row execute function set_updated_at();', t);
  end loop;
end $$;

-- ============================================================
--  ROW LEVEL SECURITY — mỗi user chỉ thao tác trên dữ liệu của mình
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array[
    'channels','pages','source_videos','processed_videos','jobs',
    'schedules','affiliate_links','post_comments','metrics'
  ] loop
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists owner_all on %I;', t);
    execute format(
      'create policy owner_all on %I
         for all
         using (owner_id = auth.uid())
         with check (owner_id = auth.uid());', t);
  end loop;
end $$;

-- Hết migration 0001.
