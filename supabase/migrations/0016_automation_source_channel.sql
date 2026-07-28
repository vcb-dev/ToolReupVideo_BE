-- ============================================================
--  0016 — Tab "Tự động": nguồn video THEO KÊNH đã theo dõi.
--
--  Bổ sung cách chọn nguồn thứ tư cho quy tắc produce/reup:
--    channel — chỉ lấy video của ĐÚNG 1 kênh nguồn (channels) đã theo dõi.
--
--  Dùng cho luồng reup "một kênh Douyin -> tự sản xuất -> tự đăng": kênh được
--  cào tự động hằng ngày (cron 3h sáng, cần bật is_monitored) đổ video vào Kho,
--  quy tắc reup lọc theo channel_id + lấy video mới nhất trong cửa sổ recency.
--  Dán vào Supabase SQL Editor.
-- ============================================================

alter table automation_rules
  add column if not exists source_channel_id uuid
  references channels(id) on delete set null;

alter table automation_rules
  drop constraint if exists automation_rules_pick_mode_check;
alter table automation_rules
  add constraint automation_rules_pick_mode_check
  check (pick_mode in ('any', 'topics', 'videos', 'channel'));

-- Hết migration 0016.
