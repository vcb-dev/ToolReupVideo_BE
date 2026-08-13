-- ============================================================
--  0020 — Thư mục chủ đề (topics)
--  Trước đây "thư mục" chỉ được suy ra từ cột source_videos.topic, nên KHÔNG
--  tạo được thư mục rỗng và cũng không xoá được thư mục. Bảng này lưu tên thư
--  mục độc lập với video: tạo trước rồi cào vào sau, hoặc xoá thư mục mà vẫn
--  giữ video (video rơi về "Chưa phân loại").
--  Dán vào Supabase SQL Editor rồi chạy.
-- ============================================================

create table if not exists topics (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Mỗi user không có 2 thư mục trùng tên (chống tạo lặp khi bấm nhanh 2 lần).
create unique index if not exists topics_owner_name_key
  on topics (owner_id, name);

drop trigger if exists trg_topics_updated on topics;
create trigger trg_topics_updated before update on topics
  for each row execute function set_updated_at();

-- RLS: mỗi user chỉ thấy thư mục của mình.
alter table topics enable row level security;
drop policy if exists owner_all on topics;
create policy owner_all on topics
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Backfill: các chủ đề đang có trên video thành thư mục thật, nếu không danh
-- sách thư mục sau khi đổi sang bảng này sẽ trống trơn.
insert into topics (owner_id, name)
select distinct owner_id, btrim(topic)
from source_videos
where topic is not null and btrim(topic) <> ''
on conflict (owner_id, name) do nothing;

-- Hết migration 0020.
