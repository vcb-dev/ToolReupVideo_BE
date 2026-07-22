-- ============================================================
--  0014 — Ngày ĐĂNG GỐC của video nguồn (published_at).
--
--  Trước đây source_videos chỉ có `crawled_at` (lúc cào về Kho). Quy tắc "Reup"
--  cần biết video được ĐĂNG khi nào trên kênh nguồn để chọn "video mới nhất
--  trong N ngày gần nhất". Crawler AI nay bắt `create_time` từ API nguồn và BE
--  ghi vào cột này. Video cào TRƯỚC migration này để null (không xét reup được).
--  Dán vào Supabase SQL Editor.
-- ============================================================

alter table source_videos add column if not exists published_at timestamptz;

-- Reup lọc theo cửa sổ thời gian + sắp mới nhất trước -> index (owner, ngày desc).
create index if not exists idx_source_videos_published
  on source_videos (owner_id, published_at desc);

-- Hết migration 0014.
