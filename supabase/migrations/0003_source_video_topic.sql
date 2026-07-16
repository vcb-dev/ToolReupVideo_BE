-- ============================================================
--  0003 — Chủ đề (topic) cho video nguồn
--  Cho phép lọc/gắn chủ đề thủ công từng video ở tab Xưởng video.
--  Dán vào Supabase SQL Editor rồi chạy.
-- ============================================================

alter table source_videos add column if not exists topic text;

-- Lọc nhanh theo chủ đề trong kho lớn.
create index if not exists source_videos_topic_idx
  on source_videos (owner_id, topic);
